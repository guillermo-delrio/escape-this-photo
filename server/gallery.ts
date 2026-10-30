// The gallery: the rooms we chose to show, listed in DATA/gallery.json ({"rooms": [ids]}, written by hand or a deploy script).
// A room drops off by itself once it is hidden by reports or taken down, because its room.json is gone.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Room } from "../src/engine/types";

export interface GalleryRoom {
  id: string;
  title: string;
  src: string; // thumb.jpg when the room folder has one, else the first photo
  width: number;
  height: number;
  credit?: string;
  walls: number;
  painted: number;
}

const chosen = (data: string): string[] => {
  const file = join(data, "gallery.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { rooms: string[] }).rooms : [];
};

// Rooms we chose and checked by hand can't be reported: the button is hidden and the server refuses.
export const curated = (data: string, id: string) => chosen(data).includes(id);

export function gallery(data: string): GalleryRoom[] {
  return chosen(data).flatMap((id) => {
    const f = join(data, id, "room.json");
    if (!/^[0-9a-f]{10}$/.test(id) || !existsSync(f)) return [];
    const room = JSON.parse(readFileSync(f, "utf8")) as Room;
    const thumb = existsSync(join(data, id, "thumb.jpg"));
    const walls = room.walls ?? [];
    return [{
      id,
      title: room.title,
      src: thumb ? `/data/${id}/thumb.jpg` : room.image.src,
      width: room.image.width,
      height: room.image.height,
      credit: room.image.credit,
      walls: 1 + walls.length,
      painted: walls.filter((w) => w.painted).length,
    }];
  });
}

// The pictures a room may serve, by name. Every name the pipeline paints must match (gallery.test.ts reads them from
// pipeline.ts), or the game is handed the app page instead of the picture.
export const PICTURE = /^\/data\/([0-9a-f]{10})\/((?:photo(?:-[2-4])?|wall-[2-4]|thumb|interior-[a-z0-9-]+|detail-[a-z0-9-]+|note-[a-z0-9-]+)\.(jpg|png))$/i;
