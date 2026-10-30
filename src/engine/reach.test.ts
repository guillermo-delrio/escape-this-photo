import { describe, expect, it } from "vitest";
import { groundingIssues } from "./grounding";
import { dedupeTwins, layer, reachIssues } from "./reach";
import type { Point, Room } from "./types";

const box = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// A 1000×1000 wall: a wide doorway the exit code opens, and a second label SAM gave the same shape, drawn on top.
function room(): Room {
  return {
    id: "t",
    title: "t",
    intro: "",
    image: { src: "", width: 1000, height: 1000 },
    goal: "escaped",
    objects: [
      { id: "doorway", label: "open doorway", polygon: box(100, 100, 400, 900) },
      { id: "sign", label: "sign", polygon: box(600, 600, 640, 620) },
      { id: "desk", label: "desk", polygon: box(500, 500, 900, 900) },
      { id: "door", label: "closed door", polygon: box(105, 100, 400, 900) },
    ],
    items: [],
    facts: [],
    actions: [
      { id: "exit", kind: "code", target: "doorway", code: "", derivedFrom: [], effect: { message: "Out.", sets: ["escaped"] } },
      { id: "read", kind: "inspect", target: "sign", effect: { message: "A sign." } },
    ],
  };
}

describe("every target can be tapped", () => {
  it("flags a target hidden under a twin and under a larger shape", () => {
    expect(reachIssues(room()).map((i) => i.split(":")[0])).toEqual(["object doorway", "object sign"]);
    expect(groundingIssues(room()).some((i) => i.startsWith("object doorway"))).toBe(true);
  });

  it("draws larger shapes first and drops the unused twin", () => {
    const r = room();
    layer(r);
    expect(dedupeTwins(r)).toEqual(["door"]);
    expect(r.objects.map((o) => o.id)).toEqual(["doorway", "desk", "sign"]);
    expect(reachIssues(r)).toEqual([]);
  });

  it("keeps both twins when both are used, and still flags the lower one", () => {
    const r = room();
    r.actions.push({ id: "knock", kind: "inspect", target: "door", effect: { message: "Knock." } });
    layer(r);
    expect(dedupeTwins(r)).toEqual([]);
    expect(reachIssues(r).map((i) => i.split(":")[0])).toEqual(["object doorway"]);
  });
});
