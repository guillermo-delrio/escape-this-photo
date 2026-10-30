import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { curated, gallery, PICTURE } from "./gallery";

function room(data: string, id: string, walls: { painted?: boolean }[]) {
  mkdirSync(join(data, id));
  const image = { src: `/data/${id}/photo.jpg`, width: 1600, height: 1200 };
  writeFileSync(join(data, id, "room.json"), JSON.stringify({ title: `Room ${id}`, image, walls: walls.map((w) => ({ ...image, ...w })) }));
}

describe("gallery", () => {
  it("lists only chosen rooms that still exist, in the chosen order", () => {
    const data = mkdtempSync(join(tmpdir(), "gallery-"));
    room(data, "aaaaaaaaaa", [{ painted: true }, { painted: true }, {}]);
    room(data, "bbbbbbbbbb", []);
    room(data, "cccccccccc", []); // made by a visitor, never chosen
    room(data, "dddddddddd", []);
    renameSync(join(data, "dddddddddd", "room.json"), join(data, "dddddddddd", "room.hidden.json")); // hidden by reports
    writeFileSync(join(data, "bbbbbbbbbb", "thumb.jpg"), "");
    writeFileSync(join(data, "gallery.json"), JSON.stringify({ rooms: ["bbbbbbbbbb", "dddddddddd", "aaaaaaaaaa", "eeeeeeeeee", "../x"] }));
    const g = gallery(data);
    expect(g.map((r) => r.id)).toEqual(["bbbbbbbbbb", "aaaaaaaaaa"]);
    expect(g[0].src).toBe("/data/bbbbbbbbbb/thumb.jpg");
    expect(g[1]).toMatchObject({ src: "/data/aaaaaaaaaa/photo.jpg", walls: 4, painted: 2 });
    expect(curated(data, "bbbbbbbbbb")).toBe(true);
    expect(curated(data, "cccccccccc")).toBe(false);
  });

  it("is empty without a gallery file", () => {
    expect(gallery(mkdtempSync(join(tmpdir(), "gallery-")))).toEqual([]);
  });
});

describe("pictures the pipeline paints", () => {
  it("are all served by the /data/ route", () => {
    const src = readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
    const prefixes = [...src.matchAll(/paintChecked\([^`]*`([a-z]+)-/g)].map((m) => m[1]);
    expect(prefixes.length).toBeGreaterThanOrEqual(4);
    for (const p of prefixes) expect(PICTURE.test(`/data/0123456789/${p}-2.jpg`), `${p}-… pictures`).toBe(true);
  });
});
