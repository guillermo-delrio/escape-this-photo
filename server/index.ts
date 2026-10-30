// HTTP server: the built game, the room API and the photos. Rooms live on disk under DATA (one folder per room).
// usage: npx tsx server/index.ts   (env: META_API_KEY, PORT=8080, DATA, META_DAILY_USD, META_TOTAL_USD, META_OFF,
// META_SPEND_UNTIL and ACCESS_CODES: new rooms need both, see server/lockdown.ts)
import { randomBytes } from "node:crypto";
import { stripMetadata } from "./exif";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { curated, gallery, PICTURE } from "./gallery";
import { admit, spendOffReason } from "./lockdown";
import { SpendCapError, spent, STOP_AT } from "./meta";
import { generateRoom, type Photo } from "./pipeline";

const PORT = Number(process.env.PORT ?? 8080);
const DATA = process.env.DATA ?? new URL("../local/data", import.meta.url).pathname;
const DIST = new URL("../dist", import.meta.url).pathname;
const MAX_PHOTO = 20 << 20; // all photos of one room together
const ROOMS_PER_IP_PER_DAY = Number(process.env.ROOMS_PER_IP ?? 3);
const MAX_PARALLEL = 2;
const MAX_WALLS = 4;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json" };

// A fresh clone has no rooms: the first start copies the sample rooms shipped in samples/ (with their gallery list),
// so the gallery works without a Meta key.
const SAMPLES = new URL("../samples", import.meta.url).pathname;
if (!existsSync(DATA) && existsSync(SAMPLES)) cpSync(SAMPLES, DATA, { recursive: true });
mkdirSync(DATA, { recursive: true });
const perIp = new Map<string, { day: string; n: number }>();
let running = 0;
// What each build is doing now, by a token the uploading page chooses (one instance, so memory is enough).
const progress = new Map<string, { stage: string; since: number }>();

const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": code === 200 && type !== "application/json" ? "public, max-age=3600" : "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : (body as Buffer));
};

// Cloud Run appends the real address last; earlier entries are whatever the visitor sent.
const clientIp = (req: IncomingMessage) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",").at(-1)!.trim();

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_PHOTO) return undefined;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function createRoom(req: IncomingMessage, res: ServerResponse) {
  const ip = clientIp(req);
  const day = new Date().toISOString().slice(0, 10);
  const used = perIp.get(ip)?.day === day ? perIp.get(ip)!.n : 0;
  if (spendOffReason(STOP_AT)) return send(res, 503, { error: "Making new rooms is paused right now. Every room already made is free to play." });
  if (used >= ROOMS_PER_IP_PER_DAY) return send(res, 429, { error: `You can make ${ROOMS_PER_IP_PER_DAY} new rooms a day. Every room already made stays free to play.` });
  if (running >= MAX_PARALLEL) return send(res, 503, { error: "Two rooms are being built right now. Try again in a minute." });
  // One to four photos, one per wall, sent back to back; x-photo-sizes gives their byte lengths in order.
  const body = await readBody(req);
  const sizes = String(req.headers["x-photo-sizes"] ?? body?.length ?? "").split(",").map(Number).slice(0, MAX_WALLS);
  const parts: { bytes: Buffer; png: boolean }[] = [];
  let at = 0;
  for (const n of sizes) {
    const bytes = body?.subarray(at, at + n);
    at += n;
    const jpeg = bytes?.[0] === 0xff && bytes[1] === 0xd8;
    const png = bytes?.subarray(0, 4).toString("hex") === "89504e47";
    if (!bytes || !n || bytes.length !== n || !(jpeg || png)) return send(res, 400, { error: `Send one to ${MAX_WALLS} JPEG or PNG photos, under 8 MB each.` });
    parts.push({ bytes: stripMetadata(bytes), png });
  }
  if (!parts.length || at !== body!.length) return send(res, 400, { error: `Send one to ${MAX_WALLS} JPEG or PNG photos, under 8 MB each.` });
  const access = admit(String(req.headers["x-access-code"] ?? "") || undefined, ip);
  if (!access.ok) return send(res, access.status, { error: access.error });

  const id = randomBytes(5).toString("hex");
  const dir = join(DATA, id);
  mkdirSync(dir);
  const photos: Photo[] = parts.map((p, i) => {
    const name = `${i ? `photo-${i + 1}` : "photo"}.${p.png ? "png" : "jpg"}`;
    writeFileSync(join(dir, name), p.bytes);
    return { path: join(dir, name), src: `/data/${id}/${name}`, dataUrl: `data:image/${p.png ? "png" : "jpeg"};base64,${p.bytes.toString("base64")}` };
  });
  perIp.set(ip, { day, n: used + 1 });
  running++;
  const token = String(req.headers["x-build-token"] ?? "");
  const onStage = /^[a-z0-9]{8,32}$/.test(token) ? (stage: string) => progress.set(token, { stage, since: Date.now() }) : undefined;
  let kept = false;
  try {
    const result = await generateRoom(photos, id, { paintWalls: photos.length === 1 && req.headers["x-paint-walls"] === "1" ? 3 : 0, onStage });
    writeFileSync(join(dir, "log.json"), JSON.stringify(result, null, 2));
    if (result.refused) return send(res, 422, { error: `${result.refused} Nothing from it was kept.` });
    if (!result.room) return send(res, 422, { error: "This photo didn't make a fair room, so it was thrown away.", stage: result.stage, attempts: result.attempts });
    writeFileSync(join(dir, "room.json"), JSON.stringify(result.room));
    kept = true;
    send(res, 200, { id, usd: result.usd, ms: result.ms, rewrites: result.attempts.length - 1 });
  } catch (e) {
    if (e instanceof SpendCapError) return send(res, 503, { error: `${e.message} Rooms already made stay free to play.` });
    console.error(e);
    send(res, 500, { error: "Building the room failed. Try another photo." });
  } finally {
    running--;
    setTimeout(() => progress.delete(token), 60_000);
    // A room that wasn't made keeps only its log: its photos and anything painted from them are deleted.
    if (!kept) for (const f of readdirSync(dir)) if (f !== "log.json") rmSync(join(dir, f), { force: true });
  }
}

// "Report this room": three reports from different addresses hide a room until the operator looks (deleting the
// folder removes it for good). Reports are kept in DATA/reports.jsonl.
const REPORTS_TO_HIDE = 3;
function reportRoom(id: string, req: IncomingMessage, res: ServerResponse) {
  const dir = join(DATA, id);
  if (!existsSync(join(dir, "room.json"))) return send(res, 404, { error: "No such room." });
  if (curated(DATA, id)) return send(res, 403, { error: "This room is one of ours and can't be reported." });
  const ip = clientIp(req);
  const file = join(DATA, "reports.jsonl");
  const all = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; ip: string }) : [];
  if (!all.some((r) => r.id === id && r.ip === ip)) appendFileSync(file, JSON.stringify({ id, ip, at: new Date().toISOString() }) + "\n");
  const by = new Set([...all.filter((r) => r.id === id).map((r) => r.ip), ip]);
  if (by.size >= REPORTS_TO_HIDE) renameSync(join(dir, "room.json"), join(dir, "room.hidden.json"));
  send(res, 200, { ok: true });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  if (req.method === "POST" && p === "/api/rooms") return createRoom(req, res);
  const r = p.match(/^\/api\/rooms\/([0-9a-f]{10})\/report$/);
  if (req.method === "POST" && r) return reportRoom(r[1], req, res);
  if (p === "/api/health") return send(res, 200, { ok: true, making: !spendOffReason(STOP_AT), spentToday: spent().days[new Date().toISOString().slice(0, 10)] ?? 0 });
  if (p === "/api/gallery") return send(res, 200, gallery(DATA));
  const build = p.match(/^\/api\/builds\/([a-z0-9]{8,32})$/);
  if (build) return send(res, 200, progress.get(build[1]) ?? { stage: "" });
  let m = p.match(/^\/api\/rooms\/([0-9a-f]{10})(\/log)?$/);
  if (m) {
    const f = join(DATA, m[1], m[2] ? "log.json" : "room.json");
    if (!existsSync(f)) return send(res, 404, { error: "No such room." });
    const body = JSON.parse(readFileSync(f, "utf8"));
    return send(res, 200, m[2] ? body : { ...body, curated: curated(DATA, m[1]) });
  }
  m = p.match(PICTURE);
  if (m) {
    // Pictures are served only once their room exists: never while it is being built or checked, never after a takedown.
    const f = join(DATA, m[1], m[2]);
    return existsSync(f) && existsSync(join(DATA, m[1], "room.json")) ? send(res, 200, readFileSync(f), TYPES[`.${m[3]}`]) : send(res, 404, { error: "No such photo." });
  }
  // The built game; any other path is the single page.
  const f = join(DIST, p.replace(/\.\.+/g, ""));
  if (p !== "/" && existsSync(f) && extname(f)) return send(res, 200, readFileSync(f), TYPES[extname(f)] ?? "application/octet-stream");
  const index = join(DIST, "index.html");
  return existsSync(index) ? send(res, 200, readFileSync(index), "text/html") : send(res, 404, { error: "Run npm run build first." });
}).listen(PORT, () => console.log(`escape-this-photo on :${PORT}`));
