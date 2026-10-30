// The count checks. SAM counts every match for a phrase, and nothing in the logic checks says each match is the thing
// a clue names: a room once asked for "framed flower pictures" with code 4 while the wall held one. Two Spark checks
// close that gap:
//  1. checkInstances, before the room is written: Spark sees each group's SAM instances, numbered on the picture and
//     cropped on a sheet, and says which are one of the named thing. Others are dropped; a group where one box holds
//     several, or some are missed, can't be counted (uncertain).
//  2. blindCounts, after: for each count fact, Spark sees only what the player sees (the clue words and the close-up
//     crop) and counts. A count that doesn't come out at the fact's value sends the room back for a rewrite.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { closeupBox, hullOf } from "../src/engine/shapes";
import type { Room, RoomObject } from "../src/engine/types";
import { sparkJSON } from "./meta";

const run = promisify(execFile);
const sheetPy = new URL("./sheet.py", import.meta.url).pathname;
const jpeg = (path: string) => ({ type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${readFileSync(path).toString("base64")}` } });

type Verdict = "one" | "several" | "part" | "other";
interface InstanceCheck {
  boxes: { n: number; verdict: Verdict }[];
  missed: number;
}
const INSTANCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["boxes", "missed"],
  properties: {
    boxes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "verdict"],
        properties: { n: { type: "integer" }, verdict: { type: "string", enum: ["one", "several", "part", "other"] } },
      },
    },
    missed: { type: "integer" },
  },
};

const INSTANCE_PROMPT = (o: RoomObject, phrase: string | undefined, n: number) => `A segmentation model looked for "${phrase ?? o.label}" in this picture${o.description ? ` (described as: ${o.description})` : ""} and found ${n} regions. The first image shows them outlined and numbered on the picture; the second shows each one cropped, with the same numbers.
A player will be asked to count these, so each region must be exactly one of them, as the words describe them, including any words about where they are ("in a row", "on the desk", "in the painting").
For each number 1 to ${n}, give a verdict:
- "one": exactly one of them, matching the words.
- "several": more than one of them inside this one region (for example a stack of books outlined as one).
- "part": only part of one, or the same thing as another number.
- "other": something else, or one that the words' position rules out.
Then "missed": how many more of them, matching the words, are clearly visible in the picture with no number. Be strict; when unsure, say so through the verdict rather than "one".`;

// Mutates the objects: drops instances Spark rejects, and marks groups it can't vouch for as uncertain. Checks every
// object with two or more instances; an object of one can't be counted anyway. Returns what it cost and one line per
// change, for the log.
export async function checkInstances(objects: RoomObject[], picturePath: (o: RoomObject) => string, phrase: (o: RoomObject) => string | undefined = () => undefined): Promise<{ usd: number; changes: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  const changes: string[] = [];
  let usd = 0;
  try {
    await Promise.all(
      objects.map(async (o) => {
        const inst = o.instances ?? [];
        if (inst.length < 2) return;
        const prefix = join(dir, o.id);
        writeFileSync(`${prefix}.json`, JSON.stringify(inst));
        await run("uv", ["run", "-q", sheetPy, "instances", picturePath(o), prefix, `${prefix}.json`]);
        const { data, usd: u } = await sparkJSON<InstanceCheck>(
          [{ role: "user", content: [{ type: "text", text: INSTANCE_PROMPT(o, phrase(o), inst.length) }, jpeg(`${prefix}-marked.jpg`), jpeg(`${prefix}-sheet.jpg`)] }],
          "instances",
          INSTANCE_SCHEMA,
          12000, // high effort reasons at length; only what it uses is charged
          "high",
        );
        usd += u;
        const verdict = new Map(data.boxes.map((b) => [b.n, b.verdict]));
        const keep = inst.filter((_, i) => verdict.get(i + 1) === "one");
        const merged = inst.some((_, i) => verdict.get(i + 1) === "several");
        const unsure = merged || data.missed > 0 || keep.length < 2;
        const before = inst.length;
        if (keep.length < before) o.segmented = before;
        if (keep.length && keep.length < before) {
          o.instances = keep;
          o.polygon = keep.length === 1 ? keep[0] : hullOf(keep.flat());
        }
        if (unsure && !o.uncertain) o.uncertain = true;
        if (keep.length < before || unsure)
          changes.push(`${o.id}: ${before} found, ${keep.length} confirmed${merged ? ", some regions hold several" : ""}${data.missed ? `, ${data.missed} missed` : ""}${unsure ? " → not countable" : ""}`);
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { usd, changes };
}

interface BlindCount {
  counting: string;
  count: number;
}
const COUNT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["counting", "count"],
  properties: { counting: { type: "string" }, count: { type: "integer" } },
};

const COUNT_PROMPT = (clues: string, label: string, message: string) => `You are playing an escape room built from a photo. You know only what the room has told you:
${clues}

You tapped the ${label} and saw: "${message}" The image is the close-up you see now.
The clues ask you to count something here. Say what you are counting ("counting"), then count it carefully in the close-up, exactly as the clue words describe it ("count").`;

// What the player knows when they count: the intro, every note's words, and the message of the tap that shows the
// close-up. Returns one issue per count the close-up doesn't support.
export async function blindCounts(room: Room, picturePath: (o: RoomObject) => string): Promise<{ usd: number; issues: string[]; counted: NonNullable<Room["made"]>["counted"] }> {
  const dir = mkdtempSync(join(tmpdir(), "count-"));
  const issues: string[] = [];
  const counted: NonNullable<Room["made"]>["counted"] = [];
  let usd = 0;
  const objects = new Map(room.objects.map((o) => [o.id, o]));
  const pictures = [room.image, ...(room.walls ?? [])];
  const notes = room.items.filter((i) => i.text?.trim());
  const clues = [`- The room's introduction: "${room.intro}"`, ...notes.map((n) => `- A note, "${n.name}", reads: "${n.text}"`)].join("\n");
  try {
    await Promise.all(
      room.facts
        .filter((f) => f.kind === "count")
        .map(async (f) => {
          const o = objects.get(f.objectIds[0]);
          const reveal = room.actions.find((a) => a.effect.reveals?.includes(f.id));
          if (!o || !reveal) return; // the grounding checks report these
          const pic = pictures[o.wall ?? 0];
          const out = join(dir, `${f.id.replace(/[^a-z0-9_-]/gi, "")}.jpg`);
          await run("uv", ["run", "-q", sheetPy, "closeup", picturePath(o), out, ...closeupBox(o.polygon, pic.width, pic.height).map(String)]);
          const { data, usd: u } = await sparkJSON<BlindCount>(
            [{ role: "user", content: [{ type: "text", text: COUNT_PROMPT(clues, o.label, reveal.effect.message) }, jpeg(out)] }],
            "count",
            COUNT_SCHEMA,
            12000,
            "high",
          );
          usd += u;
          counted.push({ fact: f.id, counting: data.counting, count: data.count });
          if (String(data.count) !== String(f.value))
            issues.push(`fact ${f.id}: a player who reads the clues and looks at the close-up of the ${o.label} counts ${data.count} (${data.counting}), not ${f.value}; make the clue name exactly the ${f.value} segmented ${o.label}, or count something else`);
        }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { usd, issues, counted };
}
