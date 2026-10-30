// SAM outlines for a hand-made room (src/rooms/*.ts): books the calls like the pipeline, then prints each phrase's
// instances as JSON, in the image's own pixels. Needs META_API_KEY and META_SPEND_UNTIL.
//   npx tsx server/segment.ts <image> "<phrase>" ["<phrase>" …] > out.json
import { segment } from "./pipeline";

const [image, ...phrases] = process.argv.slice(2);
if (!image || !phrases.length) throw new Error('usage: segment.ts <image> "<phrase>" …');
console.log(JSON.stringify(await segment(image, phrases)));
