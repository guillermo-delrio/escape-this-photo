// Reruns the pipeline's count checks (server/verify.ts) on rooms built before them. The room's own segmentation and
// walls are reused, nothing is segmented or painted again except what a rewrite needs:
//  1. each group's instances are confirmed by Spark; wrong ones are dropped, doubtful groups become uncountable;
//  2. Spark rewrites the puzzles over the corrected objects with the pipeline's own writer and checks (up to 2
//     rewrites); what the old room failed is listed in the log.
// A room that still fails is left as it was and reported, to be dropped from the gallery. Keeps room.pre-recount.json once.
// Then copy the room folder to wherever the server reads DATA from.
//   set -a; . ./.env; set +a; export META_SPEND_UNTIL=$(date -u -d '+1 hour' +%FT%TZ); npx tsx server/recount.ts <id> …
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groundingIssues } from "../src/engine/grounding";
import { solve } from "../src/engine/solver";
import type { Room, RoomObject } from "../src/engine/types";
import { writeRoom, type Attempt, type Photo } from "./pipeline";
import { checkInstances } from "./verify";

const DATA = new URL("../local/data", import.meta.url).pathname;
const onDisk = (src: string) => join(DATA, src.replace(/^\/data\//, ""));

for (const id of process.argv.slice(2)) {
  const file = join(DATA, id, "room.json");
  const backup = join(DATA, id, "room.pre-recount.json");
  if (!existsSync(backup)) copyFileSync(file, backup);
  const room: Room = JSON.parse(readFileSync(backup, "utf8"));
  const pictures = [room.image, ...(room.walls ?? [])];
  const keep: Photo[] = pictures.map((p) => {
    const path = onDisk(p.src);
    const mime = path.endsWith(".png") ? "image/png" : "image/jpeg";
    return { path, src: p.src, credit: p.credit, painted: p.painted, dataUrl: `data:${mime};base64,${readFileSync(path).toString("base64")}` };
  });
  const pathOf = (o: RoomObject) => keep[o.wall ?? 0].path;
  let usd = 0;

  // The instance check is kept per room (objects.checked.json), so a rerun doesn't pay for it twice.
  const cache = join(DATA, id, "objects.checked.json");
  const checked = existsSync(cache) ? { usd: 0, changes: ["(from the earlier check)"] } : await checkInstances(room.objects, pathOf);
  if (existsSync(cache)) room.objects = JSON.parse(readFileSync(cache, "utf8"));
  else writeFileSync(cache, JSON.stringify(room.objects));
  usd += checked.usd;
  const issues = groundingIssues(room);
  const proof = solve(room);
  if (!proof.solvable || proof.deadEnds) issues.push("the solver found no way out");
  const head = `${id} (${room.title}): instances ${checked.changes.join("; ") || "all confirmed"}`;
  // Every room is rewritten, even one that passes as it stands: rooms written before the hint and shut-exit rules
  // passed their checks and still stumped a blind player (28 Oct).
  if (!issues.length) issues.push("written before the current rules");
  // Painted close-ups belong to the old puzzles; the writer paints new ones for whatever stays scenery.
  for (const o of room.objects) delete o.detail;
  const attempts: Attempt[] = [];
  const written = await writeRoom(id, room.objects, pictures, keep, attempts);
  usd += written.usd;
  if (!written.room) {
    writeFileSync(join(DATA, id, "recount-attempts.json"), JSON.stringify(attempts, null, 1));
    console.log(`${head}\n   was: ${issues.join("; ")}\n   FAILED after rewrites, left as it was (drop it): ${attempts.at(-1)?.issues.join("; ")} ($${usd.toFixed(3)})`);
    continue;
  }
  writeFileSync(file, JSON.stringify(written.room));
  const counts = written.room.facts.filter((f) => f.kind === "count").map((f) => `${f.objectIds[0]}=${f.value}`);
  console.log(`${head}\n   was: ${issues.join("; ")}\n   rewritten in ${attempts.length} draft(s): "${written.room.title}", counts ${counts.join(", ") || "none"} ($${usd.toFixed(3)})`);
}
