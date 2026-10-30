// Run the pipeline on local photos, without the server (needs META_API_KEY and META_SPEND_UNTIL):
//   npx tsx server/try.ts <photo> [<more walls> ...] [--paint-walls N] [--name NAME]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { generateRoom } from "./pipeline";

const args = process.argv.slice(2);
const flag = (f: string) => (args.includes(f) ? args.splice(args.indexOf(f), 2)[1] : undefined);
const paintWalls = Number(flag("--paint-walls") ?? 0);
const name = flag("--name") ?? basename(args[0]).replace(/\.\w+$/, "");
const photos = args.map((path, i) => {
  const data = readFileSync(path);
  return { path, src: `/try/${i ? `photo-${i + 1}` : "photo"}.${data[0] === 0x89 ? "png" : "jpg"}`, dataUrl: `data:${data[0] === 0x89 ? "image/png" : "image/jpeg"};base64,${data.toString("base64")}` };
});
const out = new URL(`../local/try/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const r = await generateRoom(photos, name, { paintWalls });
writeFileSync(`${out}${name}.json`, JSON.stringify({ ...r, photos: args }, null, 2)); // server/stage.ts makes it playable
console.log(`${r.stage}${r.refused ? ` (${r.refused})` : ""}: $${r.usd} in ${(r.ms / 1000).toFixed(0)} s, ${r.attempts.length} attempt(s)`);
r.attempts.forEach((a, i) => console.log(`attempt ${i + 1}: ${a.issues.length ? a.issues.join(" | ") : "passed"}${a.solve ? `; solution ${a.solve.solution.length} steps, ${a.solve.states} states` : ""}`));
