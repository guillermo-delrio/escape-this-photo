// Reruns the pipeline's tap fixes on rooms built before them: larger shapes drawn first, and one of each pair of
// objects SAM gave the same shape dropped (src/engine/reach.ts). Words, facts and codes are untouched; the grounding
// checks and the solver run again on the result. Keeps room.pre-dedupe.json once. No Meta calls.
// Then copy the room folder to wherever the server reads DATA from.
//   npx tsx server/dedupe.ts <id> …
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groundingIssues } from "../src/engine/grounding";
import { dedupeTwins, layer } from "../src/engine/reach";
import { solve } from "../src/engine/solver";
import type { Room } from "../src/engine/types";

const DATA = new URL("../local/data", import.meta.url).pathname;

for (const id of process.argv.slice(2)) {
  const file = join(DATA, id, "room.json");
  const room: Room = JSON.parse(readFileSync(file, "utf8"));
  const before = groundingIssues(structuredClone(room));
  layer(room);
  const dropped = dedupeTwins(room);
  const issues = groundingIssues(room);
  const proof = solve(room);
  if (!proof.solvable || proof.deadEnds) issues.push("the solver found no way out");
  const fixed = before.filter((i) => !issues.includes(i));
  if (!existsSync(join(DATA, id, "room.pre-dedupe.json"))) copyFileSync(file, join(DATA, id, "room.pre-dedupe.json"));
  writeFileSync(file, JSON.stringify(room));
  console.log(`${id}: dropped ${dropped.join(", ") || "none"}; fixed ${fixed.length}; left: ${issues.join("; ") || "none"}`);
}
