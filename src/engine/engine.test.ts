import { describe, expect, it } from "vitest";
import { vanGogh } from "../rooms/vanGogh";
import { apply, objectText, tap } from "./engine";
import { foldPlainLooks, groundingIssues } from "./grounding";
import { solve } from "./solver";
import type { Room } from "./types";

const clone = (r: Room): Room => structuredClone(r);

describe("Van Gogh's Bedroom", () => {
  it("is grounded in its segmentation", () => expect(groundingIssues(vanGogh)).toEqual([]));

  it("is solvable with no soft-locks", () => {
    const r = solve(vanGogh);
    expect(r.solvable).toBe(true);
    expect(r.deadEnds).toBe(0);
    expect(r.solution).toEqual(["find-key", "open-drawer", "count-pictures", "count-pillows", "unlock-door"]);
  });
});

describe("the checks catch broken rooms", () => {
  it("a count the segmentation doesn't support", () => {
    const r = clone(vanGogh);
    r.facts[0].value = "6";
    Object.assign(r.actions.find((a) => a.id === "unlock-door")!, { code: "62" });
    expect(groundingIssues(r)).toEqual(["fact pictures-count: says 6 pictures but 5 were segmented"]);
  });

  it("a code that doesn't match its facts", () => {
    const r = clone(vanGogh);
    Object.assign(r.actions.find((a) => a.id === "unlock-door")!, { code: "25" });
    expect(groundingIssues(r)[0]).toMatch(/code 25 is not 5 \+ 2/);
  });

  it("a number that is only part of a longer one on the photo", () => {
    const r = clone(vanGogh);
    r.objects[0].text = "$2,500 - Rent";
    r.facts.push({ id: "rent", kind: "text", objectIds: [r.objects[0].id], value: "500" });
    expect(groundingIssues(r)).toContain('fact rent: 500 is only part of a longer number in "$2,500 - Rent"; use the whole number as written');
    r.facts[r.facts.length - 1].value = "2";
    expect(groundingIssues(r).some((i) => i.startsWith("fact rent"))).toBe(true);
    r.facts[r.facts.length - 1].value = "2500";
    expect(groundingIssues(r).some((i) => i.startsWith("fact rent"))).toBe(false);
    r.objects[0].text = "Rent 500 due";
    r.facts[r.facts.length - 1].value = "500";
    expect(groundingIssues(r).some((i) => i.startsWith("fact rent"))).toBe(false);
  });

  it("a counted thing whose plain tap says a number", () => {
    const r = clone(vanGogh);
    const counted = r.objects.find((o) => o.id === r.facts.find((f) => f.kind === "count")!.objectIds[0])!;
    counted.description = "Five little pictures hang above the bed.";
    expect(groundingIssues(r).some((i) => i.startsWith(`object ${counted.id}: a tap on it says`))).toBe(true);
    counted.description = "Little pictures hang above the bed.";
    expect(groundingIssues(r)).toEqual([]);
  });

  it("a found clue reads again on the next tap, close-up included", () => {
    const count = vanGogh.actions.find((a) => a.kind === "inspect" && a.effect.reveals?.length && a.effect.closeup)!;
    const target = (count as { target: string }).target;
    const s = { items: [], flags: [`done:${count.id}`] };
    expect(objectText(vanGogh, s, target)).toEqual({ text: count.effect.message, changed: false, closeup: count.effect.closeup });
  });

  it("an item larger than where it hides", () => {
    const r = clone(vanGogh);
    r.items.push({ id: "chair", name: "chair", description: "", objectId: "chair-left", hiddenIn: "drawer" });
    expect(groundingIssues(r)).toContain("item chair: chair is larger than table drawer, so it can't hide there");
  });

  it("a room with no way out", () => {
    const r = clone(vanGogh);
    r.actions = r.actions.filter((a) => a.id !== "find-key");
    expect(solve(r).solvable).toBe(false);
  });

  it("a soft-lock: the key can be spent where it doesn't help", () => {
    const r = clone(vanGogh);
    r.actions.push({ id: "jam-window", kind: "use", item: "key", target: "window", effect: { message: "It snaps.", takes: ["key"] } });
    const rep = solve(r);
    expect(rep.solvable).toBe(true);
    expect(rep.deadEnds).toBeGreaterThan(0);
    expect(rep.deadEndExample).toEqual(["find-key", "jam-window"]);
  });

  it("a message that gives the count away", () => {
    const r = clone(vanGogh);
    r.actions.find((a) => a.id === "count-pillows")!.effect.message = "Two pillows, side by side.";
    expect(groundingIssues(r)).toEqual(["action count-pillows: its message gives away the count (2); let the player count"]);
  });

  it("two objects with the same label", () => {
    const r = clone(vanGogh);
    r.objects.find((o) => o.id === "chair-table")!.label = "straw chair";
    expect(groundingIssues(r)).toEqual(['two objects are both called "straw chair"; give them different labels']);
  });

  it("a code nothing in the room reveals", () => {
    const r = clone(vanGogh);
    r.actions = r.actions.filter((a) => a.id !== "count-pillows");
    expect(groundingIssues(r)).toContain("action unlock-door: nothing in the room reveals fact pillows-count");
    expect(solve(r).solvable).toBe(false);
  });

  it("a change with no after line, so a tap would describe the past", () => {
    const r = clone(vanGogh);
    delete r.actions.find((a) => a.id === "open-drawer")!.effect.after;
    expect(groundingIssues(r)).toEqual([
      "action open-drawer: it changes the table drawer, so give effect.after, one sentence on how it looks from then on",
    ]);
  });

  it("a note with no written words, or words that don't say what they open", () => {
    const r = clone(vanGogh);
    const note = r.items.find((i) => i.id === "note")!;
    note.text = "Count the pictures, then the pillows.";
    expect(groundingIssues(r)).toEqual(["item note: its text never names the door its numbers open; say what they are for"]);
    delete note.text;
    expect(groundingIssues(r)).toEqual(["item note: it is a note, so give it text: the words written on it"]);
  });
});

describe("a tool is not a note", () => {
  it("a grabber made from two items, needed to reach what is counted, needs no written text", () => {
    const r = clone(vanGogh);
    r.items.push({ id: "hook", name: "hook", description: "" }, { id: "stick", name: "stick", description: "" }, { id: "grabber", name: "grabber", description: "" });
    r.actions.push({ id: "make-grabber", kind: "combine", items: ["hook", "stick"], effect: { message: "A grabber.", gives: ["grabber"] } });
    r.actions.find((a) => a.id === "count-pillows")!.when = { items: ["note", "grabber"] };
    expect(groundingIssues(r).filter((i) => i.startsWith("item "))).toEqual([]);
  });
});

describe("what a tap says follows the room's state", () => {
  const act = (id: string) => vanGogh.actions.find((a) => a.id === id)!;
  it("the drawer is locked, then open", () => {
    expect(objectText(vanGogh, { items: [], flags: [] }, "drawer").text).toBe("A small drawer. Locked.");
    const s = apply(apply({ items: [], flags: [] }, act("find-key")), act("open-drawer"));
    expect(objectText(vanGogh, s, "drawer")).toEqual({ text: "The drawer hangs open, empty now.", changed: true });
  });

  it("an older room with no after line still drops the old description", () => {
    const r = clone(vanGogh);
    delete r.actions.find((a) => a.id === "open-drawer")!.effect.after;
    const s = apply(apply({ items: [], flags: [] }, act("find-key")), act("open-drawer"));
    expect(objectText(r, s, "drawer").text).toBe("Nothing more to find in the table drawer.");
  });
});

// Each case is a fault a blind play-through hit on 28 Oct (scripts/blind.mjs), in a room the solver had passed.
describe("what a blind player needs, the screen shows", () => {
  it("a plain look on the exit never hides its code lock", () => {
    const r = clone(vanGogh);
    r.actions.push({ id: "look-door", kind: "inspect", target: "door", effect: { message: "Closed and bolted." } });
    expect(tap(r, { items: [], flags: [] }, "door")).toBeUndefined();
    r.actions.find((a) => a.id === "look-door")!.effect.gives = ["key"];
    expect(tap(r, { items: [], flags: [] }, "door")?.id).toBe("look-door");
  });

  it("a plain look is folded into the description, unless the writer gave a hint there", () => {
    const r = clone(vanGogh);
    r.actions.push({ id: "look-drawer", kind: "inspect", target: "drawer", effect: { message: "A plain drawer." } });
    r.actions.push({ id: "look-door", kind: "inspect", target: "door", effect: { message: "Closed and bolted." } });
    r.objects.find((o) => o.id === "drawer")!.description = "Something rattles inside; it wants a small key.";
    expect(foldPlainLooks(r, new Set(["drawer"]))).toEqual(["look-pictures", "look-pillows", "look-drawer", "look-door"]);
    expect(r.objects.find((o) => o.id === "drawer")!.description).toBe("Something rattles inside; it wants a small key.");
    expect(r.objects.find((o) => o.id === "door")!.description).toBe("Closed and bolted.");
  });

  it("a code no note names", () => {
    const r = clone(vanGogh);
    r.actions.forEach((a) => delete a.when);
    r.items.find((i) => i.id === "note")!.text = "Count the pictures, then the pillows.";
    expect(groundingIssues(r)).toContain(
      "action unlock-door: no note names the door, so nothing tells the player how its code is made; add a note whose text names it and says what each digit is, in order",
    );
  });

  it("a number read off the photo that the screen never shows", () => {
    const r = clone(vanGogh);
    r.objects.find((o) => o.id === "mirror")!.text = "$2,500 - Rent";
    r.facts.push({ id: "rent", kind: "text", objectIds: ["mirror"], value: "2500" });
    r.actions.push({ id: "read-mirror", kind: "inspect", target: "mirror", effect: { message: "Figures are scrawled on it.", reveals: ["rent"] } });
    expect(groundingIssues(r)).toContain('action read-mirror: it reveals "2500" but its message never shows it; quote the words as written on the mirror');
    r.actions.at(-1)!.effect.message = "Scrawled on it: $2,500 - Rent.";
    expect(groundingIssues(r).some((i) => i.startsWith("action read-mirror"))).toBe(false);
    r.facts.at(-1)!.value = "2,500"; // written with its comma, still the number 2500
    expect(groundingIssues(r).some((i) => i.startsWith("action read-mirror"))).toBe(false);
    expect(r.facts.at(-1)!.value).toBe("2500");
  });

  it("a look on a tool's target that speaks over its hint", () => {
    const r = clone(vanGogh);
    r.actions.push({ id: "drawer-note", kind: "inspect", target: "drawer", effect: { message: "A slip pokes out.", reveals: ["pillows-count"], closeup: "pillows" } });
    expect(groundingIssues(r).some((i) => i.startsWith("action drawer-note: a tap on the table drawer runs it"))).toBe(true);
  });

  it("an exit that reads as open", () => {
    const r = clone(vanGogh);
    r.objects.find((o) => o.id === "door")!.description = "An open doorway to the stairs.";
    expect(groundingIssues(r).some((i) => i.startsWith("object door: it is the way out"))).toBe(true);
  });
});

describe("the solver plays by the game's taps", () => {
  it("a look that always pre-empts the exit's lock makes the room unsolvable", () => {
    const r = clone(vanGogh);
    r.actions.unshift({ id: "look-door", kind: "inspect", target: "door", effect: { message: "Closed and bolted.", image: "/door.jpg" } });
    expect(solve(r).solvable).toBe(false);
  });
});

describe("one group, one count", () => {
  it("two facts counting the same pillows", () => {
    const r = clone(vanGogh);
    r.facts.find((f) => f.id === "pictures-count")!.objectIds = ["pillows"];
    r.facts.find((f) => f.id === "pictures-count")!.value = "2";
    expect(groundingIssues(r)).toContain("fact pillows-count: the pillows are already counted by another fact; count a different group");
  });
});

describe("a code is digits", () => {
  it("separators are dropped from a code and its facts alike, so the dial never takes a comma", () => {
    const r = clone(vanGogh);
    const door = r.actions.find((a) => a.id === "unlock-door")! as Extract<Room["actions"][number], { kind: "code" }>;
    r.facts.find((f) => f.id === "pillows-count")!.value = "2,500";
    door.code = "52,500";
    expect(groundingIssues(r).filter((i) => i.includes("code"))).toEqual([]);
    expect(door.code).toBe("52500");
    door.code = "5-2";
    expect(groundingIssues(r)).toContain('action unlock-door: code "5-2" must be digits only');
  });
});
