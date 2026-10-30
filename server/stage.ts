// Turns a try.ts run into a playable room folder: DATA/<id>/room.json plus its pictures, with every src rewritten to
// /data/<id>/…. View it with the local server (DATA=… npm run server); a deploy copies the folder to the server's DATA.
//   npx tsx server/stage.ts <try json> <id> [DATA] [--credit "<first photo's credit>" --credit "<second's>" …]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PipelineResult } from "./pipeline";

const args = process.argv.slice(2);
const credits: string[] = [];
for (let i; (i = args.indexOf("--credit")) >= 0; ) credits.push(args.splice(i, 2)[1]);
const [json, id, data = new URL("../local/data", import.meta.url).pathname] = args;
if (!json || !/^[0-9a-f]{10}$/.test(id ?? "")) throw new Error("usage: stage.ts <try json> <10-hex id> [DATA]");
const r = JSON.parse(readFileSync(json, "utf8")) as PipelineResult & { photos?: string[] };
if (!r.room) throw new Error(`${json} has no room (stage: ${r.stage})`);
// Real photos get their credits in order; paintings keep the pipeline's own.
const real = [r.room.image, ...(r.room.walls ?? [])].filter((p) => !p.painted);
credits.forEach((c, i) => real[i] && (real[i].credit = c));
const out = join(data, id);
mkdirSync(out, { recursive: true });
// try.ts records the photos in wall order (/try/photo.jpg, /try/photo-2.jpg, …); paintings sit next to the first.
const photos = r.photos ?? [];
const text = JSON.stringify(r.room).replace(/"\/try\/([^"]+)"/g, (_, f: string) => {
  const n = f.match(/^photo(?:-(\d))?\./);
  copyFileSync(n ? photos[Number(n[1] ?? 1) - 1] : join(dirname(photos[0]), f), join(out, f));
  return `"/data/${id}/${f}"`;
});
writeFileSync(join(out, "room.json"), text);
console.log(`${out}: ${JSON.parse(text).objects.length} objects, ${1 + (JSON.parse(text).walls?.length ?? 0)} walls`);
