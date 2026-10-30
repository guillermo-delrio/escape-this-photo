// Drops a photo's metadata before it is stored or served: phone photos carry GPS in EXIF, and an uploaded room is
// served at /data/<id>/photo.jpg to anyone with its link. JPEG: removes APP1–APP15 and comment segments (EXIF, XMP,
// GPS); APP0 (JFIF) stays. PNG: removes eXIf, tEXt, iTXt and zTXt chunks. Anything else comes back unchanged.
// The page already redraws photos on a canvas (rotation applied, metadata gone); this is the server's own guarantee.
export function stripMetadata(bytes: Buffer): Buffer {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return stripJpeg(bytes);
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return stripPng(bytes);
  return bytes;
}

function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda) break; // start of scan: the rest is image data
    const len = b.readUInt16BE(i + 2);
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  out.push(b.subarray(i));
  return Buffer.concat(out);
}

function stripPng(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString("latin1");
    const end = i + 12 + len;
    if (!["eXIf", "tEXt", "iTXt", "zTXt"].includes(type)) out.push(b.subarray(i, end));
    i = end;
  }
  return Buffer.concat(out);
}
