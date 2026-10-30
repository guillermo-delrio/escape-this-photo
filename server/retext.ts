// Rewrites the words of rooms built before the text rules (notes that say what they open, hints that describe instead
// of ordering, an "after" line for everything an action changes), then paints each note's blank page. Ids, facts,
// codes and the puzzle chain are never touched, so the solver's proof still holds; the grounding checks run again on
// the result. Keeps room.orig.json once. Then copy the room folder to wherever the server reads DATA from.
//   set -a; . ./.env; set +a; export META_SPEND_UNTIL=$(date -u -d '+1 hour' +%FT%TZ); npx tsx server/retext.ts <id> …
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groundingIssues } from "../src/engine/grounding";
import { solve } from "../src/engine/solver";
import type { Room } from "../src/engine/types";
import { sparkJSON, type Message } from "./meta";
import { paintNotes } from "./pipeline";

const DATA = new URL("../local/data", import.meta.url).pathname;

interface Patch {
  items: { id: string; text?: string; description?: string }[];
  actions: { id: string; message?: string; after?: string }[];
}
const SCHEMA = {
  type: "object",
  required: ["items", "actions"],
  properties: {
    items: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" }, text: { type: "string" }, description: { type: "string" } } } },
    actions: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" }, message: { type: "string" }, after: { type: "string" } } } },
  },
};

const PROMPT = (room: Room) => `This escape room was built from the photo. Rewrite only its words; never change ids, facts, codes or what each action does.
Room (JSON): ${JSON.stringify({ title: room.title, intro: room.intro, objects: room.objects.map(({ id, label, description }) => ({ id, label, description })), items: room.items, facts: room.facts, actions: room.actions })}

Return {items, actions} with only the fields you change:
- A note (an item that a counting inspect needs in when.items) gets text: the words someone who lived here wrote. They name the lock and where it is,
  how many digits it takes, and what each digit counts, in the code's derivedFrom order. A player who reads only the note knows what it is for.
  Name what is counted naturally ("how many chairs stand round the table"), never as a label. Its description says what the note looks like.
- An inspect that reveals a count: its message describes stepping up to look ("You step up to the coats on the rack."), never an order, never the number.
- Every action that gives, takes or sets something on an object, except the final escape: after, one sentence on how that object looks from then on
  ("The drawer hangs open, empty.").
Plain, concrete sentences about what is in the photo. Never mention people.`;

for (const id of process.argv.slice(2)) {
  const file = join(DATA, id, "room.json");
  const orig = join(DATA, id, "room.orig.json");
  if (!existsSync(orig)) copyFileSync(file, orig);
  const before = JSON.parse(readFileSync(orig, "utf8")) as Room;
  const photoPath = join(DATA, id, "photo.jpg");
  const dataUrl = `data:image/jpeg;base64,${readFileSync(photoPath).toString("base64")}`;
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: PROMPT(before) }, { type: "image_url", image_url: { url: dataUrl } }] }];
  let room = before;
  let issues: string[] = [];
  let usd = 0;
  let structural: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, usd: u, raw } = await sparkJSON<Patch>(messages, "retext", SCHEMA, 6000);
    usd += u;
    room = structuredClone(before);
    for (const p of data.items ?? []) {
      const it = room.items.find((i) => i.id === p.id);
      if (it) Object.assign(it, p.text && { text: p.text }, p.description && { description: p.description });
    }
    for (const p of data.actions ?? []) {
      const a = room.actions.find((x) => x.id === p.id);
      if (a) Object.assign(a.effect, p.message && { message: p.message }, p.after && { after: p.after });
    }
    // A count of one thing is the puzzle's fault, not the words': it is reported, not sent back to be reworded.
    const all = groundingIssues(room);
    issues = all.filter((i) => !i.includes("counting one thing"));
    structural = all.filter((i) => i.includes("counting one thing"));
    const proof = solve(room);
    if (!proof.solvable || proof.deadEnds) issues.push("the room no longer solves; change only words");
    if (!issues.length) break;
    messages.push({ role: "assistant", content: raw }, { role: "user", content: `The checks failed:\n- ${issues.join("\n- ")}\nReturn the whole corrected patch.` });
  }
  if (issues.length) {
    console.log(`${id}: kept as it was, checks still fail: ${issues.join("; ")} ($${usd.toFixed(3)})`);
    continue;
  }
  usd += await paintNotes(room, [{ path: photoPath, dataUrl, src: before.image.src }]);
  writeFileSync(file, JSON.stringify(room));
  const notes = room.items.filter((i) => i.text);
  if (structural.length) console.log(`${id}: puzzle still counts one thing (rebuild or drop): ${structural.join("; ")}`);
  console.log(`${id}: rewritten, ${notes.length} note(s)${notes.some((n) => n.paper) ? " on painted paper" : ""} ($${usd.toFixed(3)})`);
  for (const n of notes) console.log(`   ${n.name}: ${n.text}`);
}
