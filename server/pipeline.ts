// Photo → escape room. Spark lists objects, SAM 3.1 segments them (instance counts and mask areas become facts), Spark
// confirms each counted instance is the named thing, Spark writes puzzles from grounded patterns, and the room is
// accepted only when the grounding checks, the solver and a blind count of every close-up pass (server/verify.ts).
// Failures go back to Spark with the problems listed, up to twice; every attempt is kept for the failure log.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { area, foldPlainLooks, groundingIssues } from "../src/engine/grounding";
import { dedupeTwins, layer } from "../src/engine/reach";
import { hullOf } from "../src/engine/shapes";
import { solve, type SolveReport } from "../src/engine/solver";
import type { Picture, Point, Room, RoomObject } from "../src/engine/types";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { book, paint, PRICE, sparkJSON, type Message } from "./meta";
import { screen } from "./screen";
import { blindCounts, checkInstances } from "./verify";

const run = promisify(execFile);
const MAX_OBJECTS = 12;
const MAX_REWRITES = 2;
const MAX_INTERIORS = 2;
const MAX_NOTES = 2;
const MAX_DETAILS = 4;
const MAX_WALLS = 4;
const UNSURE = 0.5; // SAM confidence below which an instance makes its count unfair

export interface Attempt {
  room?: Room; // kept so a failure can be re-checked offline
  issues: string[];
  solve?: SolveReport;
}
export interface PipelineResult {
  room?: Room;
  attempts: Attempt[];
  usd: number;
  ms: number;
  stage: string; // where it stopped
  found?: Record<string, number | null>; // instances SAM found per phrase; null = the call failed
  refused?: string; // the content check refused a photo; shown to the uploader
}

export interface Photo {
  path: string; // on disk, for SAM and the crops
  dataUrl: string; // for Spark and Muse Image
  src: string; // what the game loads
  credit?: string;
  painted?: boolean;
}

export interface Options {
  paintWalls?: number; // with a single photo, invent this many more walls with Muse Image (each checked like an upload)
  onStage?: (stage: string) => void; // told as each step starts, for the progress line the uploader sees
}

interface Listed {
  setting: string;
  objects: { phrase: string; label: string; text?: string; colors?: string[]; description: string }[];
}

const LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["setting", "objects"],
  properties: {
    setting: { type: "string" },
    objects: {
      type: "array",
      maxItems: MAX_OBJECTS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phrase", "label", "description"],
        properties: {
          phrase: { type: "string" },
          label: { type: "string" },
          text: { type: "string" },
          colors: { type: "array", items: { type: "string" } },
          description: { type: "string" },
        },
      },
    },
  },
};

const LIST_PROMPT = (wall: number, walls: number, taken: string[]) => `You are building a point-and-click escape room from ${walls > 1 ? `${walls} pictures, one per wall of the same room; this is wall ${wall + 1}` : "this photo"}. List up to ${MAX_OBJECTS} visible things a player could tap.
Rules:
- "phrase" is a short noun phrase a segmentation model can find, singular for one thing ("wooden chair") or plural for a group ("books on the shelf"). One phrase per entry, no commas.
- Prefer: groups you can count (books, frames, cushions, bottles), containers (drawer, box, cabinet, vase, bag), anything with readable text or a clock (put the exact text in "text", a clock as "10:10"), and rows of clearly coloured things (put colour names left to right in "colors").
- ${wall === 0 ? "Include the way out (a door, or a window if there is no door)." : `Labels already used on other walls, never reuse them: ${taken.join(", ") || "none"}.`}
- Never list the same thing twice, and never list a part of something already listed as a separate group ("chair" and "chairs").
- "label" is what the player sees ("bookshelf"); labels are all different ("left door", "right door"). "description" is one plain sentence a player hears on tapping it.
- Never list people or faces.`;

const ROOM_SCHEMA = {
  type: "object",
  required: ["title", "intro", "items", "facts", "actions"],
  properties: {
    describe: { type: "array", items: { type: "object", required: ["id", "description"], properties: { id: { type: "string" }, description: { type: "string" } } } },
    title: { type: "string" },
    intro: { type: "string" },
    items: { type: "array", items: { type: "object" } },
    facts: { type: "array", items: { type: "object" } },
    actions: { type: "array", items: { type: "object" } },
  },
};

const ROOM_PROMPT = (objects: string) => `Write an escape room for this photo. These objects were segmented in it (ids, counts and sizes are measured, not guessed):
${objects}

Return JSON with title, intro (2 sentences, second person, says where the way out is), items, facts and actions, in this format:
- describe: {id, description} replaces an object's plain-tap sentence. Required for every object a "use" action targets: the sentence
  hints that something is there and what kind of thing would help, without naming the item ("Something brass glints behind the carved
  lattice, too deep for fingers."). A counted object's sentence never states a number.
- items: {id, name, description, icon (one emoji), hiddenIn? (object id it is hidden in), text? (the words written on it, for a note)}
- facts: {id, kind: "count"|"text"|"colorOrder", objectIds: [object id], value} — a count's value MUST equal the measured instance count; text MUST appear in the object's text; colorOrder MUST equal its colours joined by ",".
- actions, each {id, kind, when?: {items?, flags?, notFlags?}, effect: {message, gives?, takes?, sets?, reveals? (fact ids), closeup? (object id), after?}}:
  - {kind:"inspect", target: object id} — tapping an object
  - {kind:"use", item, target: object id} — using an item on an object
  - {kind:"combine", items: [item id, item id]}
  - {kind:"code", target: object id, code, derivedFrom: [fact ids]} — code MUST be the derivedFrom facts' values joined with no separator, digits only.
- The final action sets the flag "escaped" and targets the way out. The way out is shut until then: the intro, every message and its
  "describe" sentence call it closed, locked or blocked, never open, even if it is open in the photo. Every other door, doorway,
  hallway or entry gets a "describe" sentence that says why it is no way out, so the player never mistakes it for the exit.
- A look that only says something (no gives, reveals or closeup) is not an action: put its words in "describe".
- Every code lock is named by a note that says what each digit is, in order. A number or text read off the photo is quoted, as
  written, in the message of the inspect that reveals it ("Chalked on the board: $2,500 - Rent").
- A counted thing is named so only one group in the whole room fits, on any wall: the painted walls repeat similar things. Place it
  only by objects on its own wall.
Use 3 to 5 puzzles chained from these patterns, grounded in the measured objects:
1 count instances of a group for a digit; 2 read real text or a clock for digits; 3 a code from two facts; 4 a small item hidden in a container
(only objects whose size is at least 1% of the photo can hide things); 5 a key-like item opens a container; 6 combine two items into a tool;
7 a note found mid-way tells the player what to count (gate the counting inspects with when.items); 8 a colour order read left to right.
Every fact a code uses must be revealed by an inspect action. An inspect that reveals a count sets closeup to that object and must NOT
state the number: the player counts in the close-up. Its message describes stepping up to look ("You step up to the coats on the rack."), never an order.
When a note gates the counting, the note item has text: the words someone who lived here wrote, which name the lock and where it is, how many
digits it takes, and what each digit counts, in the code's derivedFrom order ("The padlock on the chest takes two digits: the first is how many
coats hang on the rack, the second how many..."). A player who reads only the note knows what it is for. Its description says what it looks like.
Name what is counted naturally, never as a label ("how many chairs stand round the table", not "count the kitchen chairs"); never count one thing.
Every action whose effect gives, takes or sets something on an object (opening, unlocking, taking something out) has effect.after: one sentence
on how that object looks from then on ("The drawer hangs open, empty."), so a later tap never describes it as it was. Each puzzle must be needed to escape. Messages: one or two short sentences,
concrete, about what is in the photo. Never mention people.`;

const DOORLIKE = /\b(door|doors|doorway|hallway|exit|entry|entrance|gate|archway|passage)\b/i;

// Models sometimes write a one-element list as a bare string; fix that shape before the checks judge the content.
const list = (v: unknown) => (v === undefined || Array.isArray(v) ? v : [v]);
function normalize<T extends Pick<Room, "items" | "facts" | "actions">>(r: T): T {
  for (const a of r.actions ?? []) {
    const e = (a.effect ??= { message: "" });
    for (const k of ["gives", "takes", "sets", "reveals"] as const) e[k] = list(e[k]) as string[] | undefined;
    if (a.when) for (const k of ["items", "flags", "notFlags"] as const) a.when[k] = list(a.when[k]) as string[] | undefined;
    if (a.kind === "code") a.derivedFrom = list(a.derivedFrom) as string[];
  }
  for (const f of r.facts ?? []) f.objectIds = list(f.objectIds) as string[];
  return r;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "thing";

interface SamOut {
  width: number;
  height: number;
  calls: number;
  objects: Record<string, { outline: Point[]; area: number; confidence: number | null }[] | null>;
}

export async function segment(imagePath: string, phrases: string[]): Promise<SamOut> {
  book(phrases.length * 2 * PRICE.sam); // booked up front, twice over: sam.py retries each failed call once
  const script = new URL("./sam.py", import.meta.url).pathname;
  // META_SAM_BOOKED tells sam.py the calls are booked; run on its own, it refuses (server/lockdown.ts).
  const env = { ...process.env, META_SAM_BOOKED: "1" };
  const { stdout, stderr } = await run("uv", ["run", "-q", script, imagePath, ...phrases], { maxBuffer: 64 << 20, timeout: 90_000, env });
  if (stderr.trim()) console.error(stderr.trim()); // per-phrase failures; sam.py drops the object and carries on
  const out = JSON.parse(stdout) as SamOut;
  return out;
}

export async function generateRoom(photos: Photo[], id: string, opts: Options = {}): Promise<PipelineResult> {
  const t0 = Date.now();
  let usd = 0;
  const attempts: Attempt[] = [];
  let found: PipelineResult["found"];
  let refused: string | undefined;
  const done = (stage: string, room?: Room): PipelineResult => ({ room, attempts, usd: +usd.toFixed(4), ms: Date.now() - t0, stage, found, refused });
  photos = photos.slice(0, MAX_WALLS);
  const stage = opts.onStage ?? (() => {});

  // Nothing is listed, segmented or painted from a photo the content check hasn't passed.
  stage("Muse Spark is checking the photo");
  const verdicts = await Promise.all(photos.map((p, i) => screen(p.dataUrl, "upload", i > 0)));
  usd += verdicts.reduce((x, v) => x + v.usd, 0);
  const bad = verdicts.find((v) => !v.allowed);
  if (bad) {
    refused = bad.reason;
    return done("photo refused");
  }
  if (photos.length === 1 && opts.paintWalls) {
    stage("Muse Image is painting the other three walls");
    const painted = await paintWalls(photos[0], Math.min(opts.paintWalls, MAX_WALLS - 1));
    usd += painted.usd;
    photos = [photos[0], ...painted.walls];
  }

  // List each wall's objects in turn (so labels stay distinct across walls), then segment every wall at once.
  stage("Muse Spark is listing what's in the room");
  const lists: Listed["objects"][] = [];
  for (let w = 0; w < photos.length; w++) {
    const taken = lists.flat().map((o) => o.label);
    const listed = await sparkJSON<Listed>([{ role: "user", content: [{ type: "text", text: LIST_PROMPT(w, photos.length, taken) }, { type: "image_url", image_url: { url: photos[w].dataUrl } }] }], "objects", LIST_SCHEMA, 4000, "low");
    usd += listed.usd;
    lists.push(listed.data.objects.slice(0, MAX_OBJECTS).filter((o) => !taken.includes(o.label)));
  }
  if (lists[0].length < 3) return done("too few objects");
  stage("SAM 3.1 is outlining each thing");
  const sams = await Promise.all(photos.map((p, w) => segment(p.path, lists[w].map((o) => o.phrase))));
  usd += sams.reduce((x, s) => x + s.calls * PRICE.sam, 0);
  found = Object.fromEntries(sams.flatMap((s, w) => Object.entries(s.objects).map(([k, v]) => [w ? `wall ${w + 1}: ${k}` : k, v ? v.length : null])));

  const pictures: Picture[] = [];
  const objects: RoomObject[] = [];
  const keep: Photo[] = [];
  const phrases = new Map<string, string>();
  sams.forEach((sam, w) => {
    const mine: RoomObject[] = [];
    for (const o of lists[w]) {
      const hits = sam.objects[o.phrase];
      if (!hits?.length) continue;
      const base = slug(o.label);
      const oid = [...objects, ...mine].some((x) => x.id === base) ? `${base}-${objects.length + mine.length}` : base;
      phrases.set(oid, o.phrase);
      mine.push({
        id: oid,
        label: o.label,
        polygon: hits.length === 1 ? hits[0].outline : hullOf(hits.flatMap((f) => f.outline)),
        instances: hits.map((f) => f.outline),
        text: o.text,
        colors: o.colors,
        description: o.description,
        uncertain: hits.some((f) => f.confidence !== null && f.confidence < UNSURE),
      });
    }
    // A wall with almost nothing to tap is dropped rather than left as scenery; the first wall must hold up the room.
    if (w > 0 && mine.length < 2) return;
    const index = pictures.length;
    for (const o of mine) if (index) o.wall = index;
    objects.push(...mine);
    pictures.push({ src: photos[w].src, width: sam.width, height: sam.height, credit: photos[w].credit, painted: photos[w].painted });
    keep.push(photos[w]);
  });
  // Two labels SAM gave one shape ("closed door", "open doorway") would leave one untappable: keep one, and draw
  // larger shapes first so small things on them stay on top.
  const scene = { objects, image: pictures[0], walls: pictures.slice(1), items: [], facts: [], actions: [] } as unknown as Room;
  layer(scene);
  dedupeTwins(scene);
  objects.splice(0, objects.length, ...scene.objects);
  if (objects.filter((o) => !o.wall).length < 3) return done("segmentation found too little");

  // Every counted instance must be the thing named, or the count is a trap (server/verify.ts).
  stage("Muse Spark is checking each thing SAM counted");
  const checked = await checkInstances(objects, (o) => keep[o.wall ?? 0].path, (o) => phrases.get(o.id));
  usd += checked.usd;
  if (checked.changes.length) console.error(`instances: ${checked.changes.join("; ")}`);

  const written = await writeRoom(id, objects, pictures, keep, attempts, stage);
  usd += written.usd;
  return done(written.room ? "ok" : "checks failed after rewrites", written.room);
}

// Spark writes the puzzles over measured objects; the grounding checks, the solver and the blind counts judge each
// draft, and failures go back with the problems listed. Exported for server/recount.ts, which rewrites gallery rooms
// whose counts changed.
export async function writeRoom(id: string, objects: RoomObject[], pictures: Picture[], keep: Photo[], attempts: Attempt[], stage: (s: string) => void = () => {}): Promise<{ room?: Room; usd: number }> {
  let usd = 0;
  const summary = objects
    .map((o) => {
      const pic = pictures[o.wall ?? 0];
      return `- ${o.id} ("${o.label}")${pictures.length > 1 ? `, wall ${(o.wall ?? 0) + 1}` : ""}: ${o.instances!.length} instance(s)${o.uncertain ? " (count unsure: don't count these)" : ""}, ${((area(o.polygon) / (pic.width * pic.height)) * 100).toFixed(1)}% of the picture${o.text ? `, text "${o.text}"` : ""}${o.colors ? `, colours ${o.colors.join(",")}` : ""}`;
    })
    .join("\n");
  // Say outright which groups can be counted, so a room with none is built from keys, hiding and combining instead.
  const countable = objects.filter((o) => (o.instances?.length ?? 0) >= 2 && !o.uncertain).map((o) => `${o.id} (${o.instances!.length})`);
  const countNote = countable.length
    ? `\nThe only groups a count fact may use: ${countable.join(", ")}. Nothing else may be counted.`
    : "\nNothing in this room can be counted: use no count facts. Build the chain from hidden items, keys, combining and any real text.";
  const wallsNote = countNote + (pictures.length > 1 ? `\nThe room has ${pictures.length} walls, shown in order; the player turns between them. Spread the puzzles over every wall, so the player has to turn around to escape.` : "");
  const images = keep.map((p) => ({ type: "image_url" as const, image_url: { url: p.dataUrl } }));
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: ROOM_PROMPT(summary) + wallsNote }, ...images] }];

  for (let i = 0; i <= MAX_REWRITES; i++) {
    stage(i ? `The checks sent the puzzles back; Muse Spark is rewriting them (draft ${i + 1})` : "Muse Spark is writing the puzzles");
    const written = await sparkJSON<Pick<Room, "title" | "intro" | "items" | "facts" | "actions"> & { describe?: { id: string; description: string }[] }>(messages, "room", ROOM_SCHEMA, 16000);
    usd += written.usd;
    const { describe, ...draft } = written.data;
    // Each draft may reword objects' plain-tap sentences; start each from the measured objects.
    const objs = structuredClone(objects);
    for (const d of (list(describe) as typeof describe) ?? []) {
      const o = objs.find((x) => x.id === d.id);
      if (o && d.description?.trim()) o.description = d.description;
    }
    const room: Room = { ...normalize(draft), id, image: pictures[0], ...(pictures.length > 1 ? { walls: pictures.slice(1) } : {}), objects: objs, goal: "escaped" };
    // A blind player can't guess where a tool goes: each target of a "use" must hint at it on a plain tap.
    const described = new Set(((list(describe) as typeof describe) ?? []).map((d) => d.id));
    const unhinted = [...new Set(room.actions.flatMap((a) => (a.kind === "use" && !a.effect.sets?.includes("escaped") ? [a.target] : [])))].filter((t) => !described.has(t));
    // Only the way out may look like one: a blind player tried an open doorway for 100 taps and never found the exit.
    const exit = room.actions.find((a) => a.effect.sets?.includes("escaped"));
    const exitId = exit && exit.kind !== "combine" ? exit.target : undefined;
    const decoys = room.objects.filter((o) => o.id !== exitId && DOORLIKE.test(o.label) && !described.has(o.id)).map((o) => o.id);
    foldPlainLooks(room, described);
    let issues: string[];
    let report: SolveReport | undefined;
    try {
      issues = groundingIssues(room);
      for (const t of unhinted) issues.push(`object ${t}: something is used on it, so give it a "describe" sentence that hints something is there and what would help`);
      for (const t of decoys) issues.push(`object ${t}: it looks like a way out but isn't one; give it a "describe" sentence that says why (shut for good, only a cupboard, leads nowhere)`);
      report = solve(room);
      if (!report.complete) issues.push(`the room has over ${report.states} states, too many to prove; make it smaller`);
      else if (!report.solvable) issues.push("the solver found no way to escape");
      if (report.deadEnds) issues.push(`${report.deadEnds} soft-lock state(s), e.g. after ${report.deadEndExample!.join(" → ")}`);
      if (report.solution.length < 4) issues.push(`only ${report.solution.length} steps to escape; make 3 to 5 chained puzzles`);
    } catch (e) {
      issues = [`the room doesn't follow the format: ${(e as Error).message}`];
    }
    // The blind count costs a Spark call per count, so it runs only on drafts that pass everything else.
    if (!issues.length) {
      stage("The solver found a way out; Muse Spark is counting each close-up blind");
      const counted = await blindCounts(room, (o) => keep[o.wall ?? 0].path);
      usd += counted.usd;
      issues.push(...counted.issues);
      room.made = { drafts: i + 1, failed: attempts.map((a) => a.issues), counted: counted.counted };
    }
    attempts.push({ room, issues, solve: report });
    if (!issues.length) {
      stage("Muse Image is painting what you'll find");
      const [a, b, c] = await Promise.all([paintInteriors(room, keep), paintDetails(room, keep), paintNotes(room, keep)]);
      usd += a + b + c;
      return { room, usd };
    }
    messages.push({ role: "assistant", content: written.raw }, { role: "user", content: `The checks failed:\n- ${issues.join("\n- ")}\nReturn the whole corrected room.` });
  }
  return { usd };
}

const py = (script: string, ...args: string[]) => run("uv", ["run", "-q", new URL(`./${script}`, import.meta.url).pathname, ...args]);

// Paints a picture, checks it like an upload, and saves it as a JPEG next to the room's photo. A new name prefix must
// also join the /data/ route's list in index.ts, or the game gets the app page instead of the picture. Returns its path and src
// (null when Muse Image fails or the check refuses it) and what it cost.
async function paintChecked(prompt: string, reference: string, first: Photo, name: string, width: number): Promise<{ path: string; src: string; dataUrl: string } | null> {
  const { png } = await paint(prompt, reference);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const verdict = await screen(dataUrl, "painting");
  if (!verdict.allowed) {
    console.error(`painting ${name} refused: ${verdict.reason}`);
    return null;
  }
  const base = join(dirname(first.path), name);
  writeFileSync(`${base}.png`, png);
  await py("shrink.py", `${base}.png`, `${base}.jpg`, String(width));
  rmSync(`${base}.png`);
  return { path: `${base}.jpg`, src: `${dirname(first.src)}/${name}.jpg`, dataUrl };
}
const PAINT_COST = PRICE.image + 0.005; // the painting plus its content check (about)

// Muse Image invents the walls the photo doesn't show, from the photo itself. Each is checked like an upload; a wall
// that fails is left out.
// In turning order: the game's › button turns right, so wall 2 is to the right of the photo (src/engine/types.ts).
const WALL_VIEWS = ["the wall to the right of the one in this picture", "the wall behind the photographer, facing the one in this picture", "the wall to the left of the one in this picture"];
async function paintWalls(photo: Photo, n: number): Promise<{ walls: Photo[]; usd: number }> {
  const views = n === 1 ? [WALL_VIEWS[1]] : WALL_VIEWS.slice(0, n);
  const walls = await Promise.all(
    views.map(async (view, i) => {
      const prompt = `The same room as in this picture, seen from inside it: ${view}. Same room, same period furniture and style, same medium, palette, light and camera height, as if the photographer turned around. Furnished with several distinct things a visitor could look at (furniture, a cabinet or chest, pictures, objects on surfaces). No people, no text, no numbers.`;
      try {
        const p = await paintChecked(prompt, photo.dataUrl, photo, `wall-${i + 2}`, 1600);
        return p && { ...p, painted: true, credit: "Painted by Meta's Muse Image from the photo." };
      } catch (e) {
        console.error(`wall ${i + 2}: ${(e as Error).message}`);
        return null;
      }
    }),
  );
  return { walls: walls.filter((w): w is NonNullable<typeof w> => !!w), usd: views.length * PAINT_COST };
}

// Muse Image paints what the photo can't show: the inside of a container the player opens, holding what they find.
// Close-ups of things the player counts stay crops of the real photo. A failed painting leaves the step text-only.
async function paintInteriors(room: Room, photos: Photo[]): Promise<number> {
  const label = new Map(room.objects.map((o) => [o.id, o]));
  const name = new Map(room.items.map((i) => [i.id, i.name]));
  const opens = room.actions.filter((a) => a.kind !== "combine" && a.effect.gives?.length && !a.effect.closeup).slice(0, MAX_INTERIORS);
  await Promise.all(
    opens.map(async (a) => {
      if (a.kind === "combine") return;
      const target = label.get(a.target);
      const what = a.effect.gives!.map((g) => name.get(g) ?? g).join(" and ");
      const prompt = `A close-up of the inside of the ${target?.label ?? a.target} from this picture, opened, with ${what} inside. Same medium, palette and lighting as the picture. No people, no text.`;
      try {
        const p = await paintChecked(prompt, photos[target?.wall ?? 0].dataUrl, photos[0], `interior-${a.id.replace(/[^a-z0-9-]/gi, "")}`, 720);
        if (p) a.effect.image = p.src;
      } catch (e) {
        console.error(`interior for ${a.id}: ${(e as Error).message}`);
      }
    }),
  );
  return opens.length * PAINT_COST;
}

// A closer look at things that are only scenery: tapping them shows a painted close-up made from a crop of the real
// picture. Never for an object a fact or a code depends on, so nothing the player must read or count is invented.
async function paintDetails(room: Room, photos: Photo[]): Promise<number> {
  const used = new Set(room.facts.flatMap((f) => f.objectIds));
  for (const a of room.actions) if (a.kind !== "combine") used.add(a.target);
  const pick = room.objects.filter((o) => !used.has(o.id) && (o.instances?.length ?? 1) === 1).slice(0, MAX_DETAILS);
  await Promise.all(
    pick.map(async (o) => {
      const photo = photos[o.wall ?? 0];
      const xs = o.polygon.map((p) => p[0]);
      const ys = o.polygon.map((p) => p[1]);
      const crop = join(dirname(photos[0].path), `crop-${o.id}.jpg`);
      try {
        await py("crop.py", photo.path, crop, ...[Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(String));
        const reference = `data:image/jpeg;base64,${readFileSync(crop).toString("base64")}`;
        const prompt = `A close, detailed view of the ${o.label} in this picture: ${o.description ?? ""} Show its texture, materials and small details as if the viewer leaned in. Same object, same medium, palette and lighting. No people, no writing, no numbers, no symbols.`;
        const p = await paintChecked(prompt, reference, photos[0], `detail-${o.id}`, 720);
        if (p) o.detail = p.src;
      } catch (e) {
        console.error(`detail for ${o.id}: ${(e as Error).message}`);
      } finally {
        rmSync(crop, { force: true });
      }
    }),
  );
  return pick.length * PAINT_COST;
}

// The page a note is written on, painted blank in the room's own look; the game sets the exact words on it, since a
// painted hand can't be trusted to spell a clue. A failed painting leaves the note on plain paper.
export async function paintNotes(room: Room, photos: Photo[]): Promise<number> {
  const notes = room.items.filter((i) => i.text).slice(0, MAX_NOTES);
  await Promise.all(
    notes.map(async (i) => {
      const prompt = `The ${i.name} found in this room (${i.description}), unfolded and seen straight from above so the paper fills the whole frame edge to edge. Its paper, age, creases and stains suit the room and its era. The page is completely blank: no writing, no letters, no numbers, no marks, no symbols, nothing on it. Soft even light.`;
      try {
        const p = await paintChecked(prompt, photos[0].dataUrl, photos[0], `note-${i.id.replace(/[^a-z0-9-]/gi, "")}`, 720);
        if (p) i.paper = p.src;
      } catch (e) {
        console.error(`paper for ${i.id}: ${(e as Error).message}`);
      }
    }),
  );
  return notes.length * PAINT_COST;
}
