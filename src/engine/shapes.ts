import type { Point } from "./types";

// The close-up's view box: the object's bounds plus a margin, kept inside the image. The game shows exactly this,
// and the blind count check (server/verify.ts) crops exactly this, so the check counts what the player sees.
export function closeupBox(poly: Point[], w: number, h: number, pad = 0.08): [number, number, number, number] {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const px = (Math.max(...xs) - Math.min(...xs)) * pad;
  const py = (Math.max(...ys) - Math.min(...ys)) * pad;
  const [x1, y1] = [Math.max(0, Math.min(...xs) - px), Math.max(0, Math.min(...ys) - py)];
  const [x2, y2] = [Math.min(w, Math.max(...xs) + px), Math.min(h, Math.max(...ys) + py)];
  return [x1, y1, x2 - x1, y2 - y1];
}

// Convex hull, for an object's outline when it is a group of instances.
export function hullOf(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (ps: Point[]) => {
    const h: Point[] = [];
    for (const p of ps) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    return h.slice(0, -1);
  };
  return pts.length < 3 ? pts : [...half(pts), ...half([...pts].reverse())];
}
