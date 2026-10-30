import { area } from "./grounding";
import type { Point, Room, RoomObject } from "./types";

// What a finger can reach. The game draws each wall's objects in list order, later ones on top, and a group is tapped
// on its instances. Two objects whose SAM shapes coincide ("closed door" over "open doorway") leave the lower one
// untappable, so the logic proves a room the player can't finish. These helpers measure that and remove the twins.

export const tapShapes = (o: RoomObject) => ((o.instances?.length ?? 0) > 1 ? o.instances! : [o.polygon]);

function inside(poly: Point[], x: number, y: number) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const hits = (o: RoomObject, x: number, y: number) => tapShapes(o).some((p) => inside(p, x, y));

interface Cover {
  own: Map<string, number>; // grid points inside each object's tap shapes
  top: Map<string, number>; // of those, the points where it is the topmost object
  both: Map<string, number>; // "a|b": points inside both a and b
  wall: Map<string, number>; // grid points on the object's wall
}

// Samples each wall on a grid of about 200×200 points.
function cover(room: Room): Cover {
  const own = new Map<string, number>();
  const top = new Map<string, number>();
  const both = new Map<string, number>();
  const wall = new Map<string, number>();
  const pics = [room.image, ...(room.walls ?? [])];
  pics.forEach((pic, w) => {
    const objs = room.objects.filter((o) => (o.wall ?? 0) === w);
    const step = Math.max(pic.width, pic.height) / 200;
    const points = Math.ceil(pic.width / step - 0.5) * Math.ceil(pic.height / step - 0.5);
    objs.forEach((o) => wall.set(o.id, points));
    for (let y = step / 2; y < pic.height; y += step)
      for (let x = step / 2; x < pic.width; x += step) {
        const at = objs.filter((o) => hits(o, x, y));
        at.forEach((o) => own.set(o.id, (own.get(o.id) ?? 0) + 1));
        if (at.length) top.set(at[at.length - 1].id, (top.get(at[at.length - 1].id) ?? 0) + 1);
        for (let i = 0; i < at.length; i++)
          for (let j = i + 1; j < at.length; j++) {
            const k = `${at[i].id}|${at[j].id}`;
            both.set(k, (both.get(k) ?? 0) + 1);
          }
      }
  });
  return { own, top, both, wall };
}

// Objects the player must tap: every action's target.
export function tapped(room: Room) {
  return new Set(room.actions.flatMap((a) => (a.kind === "combine" ? [] : [a.target])));
}

// Each object's tap area left uncovered by the objects drawn over it: as a share of its own area, and of its wall.
export function reach(room: Room) {
  const c = cover(room);
  return new Map(
    room.objects.map((o) => {
      const top = c.top.get(o.id) ?? 0;
      return [o.id, { share: top / Math.max(1, c.own.get(o.id) ?? 0), ofWall: top / Math.max(1, c.wall.get(o.id) ?? 0) }];
    }),
  );
}

// A target is reachable when a quarter of it is uncovered, or an uncovered patch the size of a small object (a big
// wardrobe mostly hidden behind a chest still leaves a wide patch).
export const MIN_SHARE = 0.25;
export const MIN_OF_WALL = 0.005;

export function reachIssues(room: Room): string[] {
  const r = reach(room);
  const label = new Map(room.objects.map((o) => [o.id, o.label]));
  return [...tapped(room)]
    .filter((id) => r.has(id) && r.get(id)!.share < MIN_SHARE && r.get(id)!.ofWall < MIN_OF_WALL)
    .map((id) => `object ${id}: only ${Math.round(r.get(id)!.share * 100)}% of the ${label.get(id)} can be tapped; other objects cover it`);
}

export const TWIN_IOU = 0.7;

// Drops one of every pair of objects on a wall whose tap shapes overlap by IoU > TWIN_IOU. The one the room uses (an
// action target, a fact, an item's crop or a closeup) is kept; between two unused ones, the earlier. Two used twins
// are both kept and left to reachIssues. Returns the dropped ids.
export function dedupeTwins(room: Room): string[] {
  const used = new Set([
    ...tapped(room),
    ...room.facts.flatMap((f) => f.objectIds),
    ...room.items.flatMap((i) => [i.objectId, i.hiddenIn].filter((x): x is string => !!x)),
    ...room.actions.map((a) => a.effect.closeup).filter((x): x is string => !!x),
  ]);
  const c = cover(room);
  const dropped = new Set<string>();
  const ids = room.objects.map((o) => o.id);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i], ids[j]];
      if (dropped.has(a) || dropped.has(b)) continue;
      const inter = c.both.get(`${a}|${b}`) ?? 0;
      const union = (c.own.get(a) ?? 0) + (c.own.get(b) ?? 0) - inter;
      if (!union || inter / union <= TWIN_IOU) continue;
      if (used.has(a) && used.has(b)) continue;
      dropped.add(used.has(b) ? a : b);
    }
  room.objects = room.objects.filter((o) => !dropped.has(o.id));
  return [...dropped];
}

// Draws larger objects first, so a small thing on a big one (a sign on a desk) sits on top and both stay tappable.
// The sort is stable and only changes drawing order.
export function layer(room: Room) {
  const size = (o: RoomObject) => tapShapes(o).reduce((s, p) => s + area(p), 0);
  room.objects = [...room.objects].sort((a, b) => size(b) - size(a));
}
