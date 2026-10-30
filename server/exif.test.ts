import { describe, expect, it } from "vitest";
import { stripMetadata } from "./exif";

const seg = (marker: number, body: string) => {
  const data = Buffer.from(body, "latin1");
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
};

describe("uploaded photos lose their metadata (GPS) before they are stored", () => {
  it("drops EXIF/XMP and comments from a JPEG, keeps JFIF and the image data", () => {
    const scan = Buffer.from([0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, "JFIF\0"), seg(0xe1, "Exif\0\0GPS 40.4N 3.7W"), seg(0xfe, "a comment"), seg(0xdb, "table"), scan]);
    const out = stripMetadata(jpeg);
    expect(out.includes(Buffer.from("GPS"))).toBe(false);
    expect(out.includes(Buffer.from("a comment"))).toBe(false);
    expect(out.includes(Buffer.from("JFIF"))).toBe(true);
    expect(out.includes(Buffer.from("table"))).toBe(true);
    expect(out.subarray(-scan.length).equals(scan)).toBe(true);
  });

  it("drops eXIf and text chunks from a PNG", () => {
    const chunk = (type: string, body: string) => {
      const data = Buffer.from(body, "latin1");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", "hdr"), chunk("eXIf", "GPS"), chunk("tEXt", "Location"), chunk("IDAT", "pixels"), chunk("IEND", "")]);
    const out = stripMetadata(png);
    expect(out.includes(Buffer.from("GPS"))).toBe(false);
    expect(out.includes(Buffer.from("Location"))).toBe(false);
    expect(out.includes(Buffer.from("pixels"))).toBe(true);
  });
});
