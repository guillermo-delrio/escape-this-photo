// Copies a blind play-through's result (scripts/blind.mjs writes local/blind/<id>/result.json) into the room, for the
// "how this room was made" panel. The harness's record is used, not the player's own report.
//   npx tsx server/blind-record.ts <id> …
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Room } from "../src/engine/types";

const LOCAL = new URL("../local", import.meta.url).pathname;

for (const id of process.argv.slice(2)) {
  const result = join(LOCAL, "blind", id, "result.json");
  const file = join(LOCAL, "data", id, "room.json");
  if (!existsSync(result)) {
    console.log(`${id}: no blind play-through yet`);
    continue;
  }
  const r = JSON.parse(readFileSync(result, "utf8")) as { escaped: boolean; steps: number; wrongTries: Record<string, number> };
  const room = JSON.parse(readFileSync(file, "utf8")) as Room;
  const wrongCodes = Object.values(r.wrongTries).reduce((a, b) => a + b, 0);
  room.made = { drafts: 1, failed: [], counted: [], ...room.made, blindPlay: { escaped: r.escaped, commands: r.steps, wrongCodes, date: statSync(result).mtime.toISOString().slice(0, 10) } };
  writeFileSync(file, JSON.stringify(room));
  console.log(`${id}: ${r.escaped ? "escaped" : "NOT escaped"} in ${r.steps} commands, ${wrongCodes} wrong code(s)`);
}
