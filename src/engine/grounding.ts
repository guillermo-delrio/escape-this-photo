import { changes, plain } from "./engine";
import { reachIssues } from "./reach";
import type { Point, Room } from "./types";

// Shoelace area of a polygon in image pixels.
export function area(poly: Point[]) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

// A plain tap's words live in one place, the object's description. An ungated look (an inspect that only says
// something) is folded into it, unless the writer gave the object a description of its own (a hint for a tool):
// a blind play-through never saw "something long with a hook could catch it", because the look's words replaced it.
export function foldPlainLooks(room: Room, described: Set<string>): string[] {
  const folded: string[] = [];
  room.actions = room.actions.filter((a) => {
    if (a.kind !== "inspect" || a.when || !plain(a)) return true;
    const o = room.objects.find((x) => x.id === a.target);
    if (o && !described.has(o.id) && a.effect.message.trim()) o.description = a.effect.message;
    folded.push(a.id);
    return false;
  });
  return folded;
}

// Does a text name the thing called `label`? Any of its words longer than two letters, ignoring a plural s.
const names = (text: string | undefined, label: string) =>
  !!text && label.toLowerCase().split(/\s+/).some((w) => w.length > 2 && text.toLowerCase().includes(w.replace(/s$/, "")));

// Every claim a room makes about its photo, checked against the segmentation. Each problem is one line of the
// failure log ("key larger than drawer").
export function groundingIssues(room: Room): string[] {
  const issues: string[] = [];
  const obj = new Map(room.objects.map((o) => [o.id, o]));
  const item = new Map(room.items.map((i) => [i.id, i]));
  const fact = new Map(room.facts.map((f) => [f.id, f]));
  const needObj = (id: string, where: string) => obj.has(id) || !issues.push(`${where}: no object "${id}"`);
  const needItem = (id: string, where: string) => item.has(id) || !issues.push(`${where}: no item "${id}"`);

  for (const f of room.facts) {
    f.value = String(f.value); // models write counts as numbers
    if (/^\$?\d{1,3}(?:[.,]\d{3})+$/.test(f.value)) f.value = f.value.replace(/[$.,]/g, ""); // "2,500" is the number 2500
    const [a, b] = f.objectIds;
    if (!f.objectIds.every((id) => needObj(id, `fact ${f.id}`))) continue;
    const o = obj.get(a)!;
    if (f.kind === "count") {
      const n = o.instances?.length ?? 0;
      if (String(n) !== f.value) issues.push(`fact ${f.id}: says ${f.value} ${o.label} but ${n} were segmented`);
      else if (n < 2) issues.push(`fact ${f.id}: there is only one ${o.label}; counting one thing is no puzzle, count a group`);
      else if (o.uncertain) issues.push(`fact ${f.id}: the segmenter was unsure of some ${o.label}, so counting them is not fair`);
    } else if (f.kind === "text") {
      // A number read off the photo is the whole number written there, thousands separators dropped: "$2,500" gives
      // 2500, never "500" or "2".
      const numbers = (o.text ?? "").match(/\d+(?:[.,]\d{3})*/g)?.map((n) => n.replace(/[.,]/g, "")) ?? [];
      if (/^\d+$/.test(f.value) && !numbers.includes(f.value) && o.text?.includes(f.value))
        issues.push(`fact ${f.id}: ${f.value} is only part of a longer number in "${o.text}"; use the whole number as written`);
      else if (/^\d+$/.test(f.value) ? !numbers.includes(f.value) : !o.text?.toLowerCase().includes(f.value.toLowerCase()))
        issues.push(`fact ${f.id}: "${f.value}" is not in the text read from ${o.label}`);
    } else if (f.kind === "colorOrder") {
      if ((o.colors ?? []).join(",") !== f.value)
        issues.push(`fact ${f.id}: colour order ${f.value} differs from ${o.label}'s (${(o.colors ?? []).join(",")})`);
    } else if (f.kind === "fits") {
      const c = obj.get(b)!;
      if (area(o.polygon) >= area(c.polygon)) issues.push(`fact ${f.id}: ${o.label} is larger than ${c.label}`);
    }
  }

  for (const i of room.items) {
    if (i.objectId) needObj(i.objectId, `item ${i.id}`);
    if (i.hiddenIn && needObj(i.hiddenIn, `item ${i.id}`) && i.objectId && obj.has(i.objectId)) {
      if (area(obj.get(i.objectId)!.polygon) >= area(obj.get(i.hiddenIn)!.polygon))
        issues.push(`item ${i.id}: ${i.name} is larger than ${obj.get(i.hiddenIn)!.label}, so it can't hide there`);
    }
  }

  // A counted thing's plain tap must not say a number: it would give the count away, or contradict it.
  const NUMBER = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|pair|couple|dozen|single|both)\b/i;
  for (const id of new Set(room.facts.filter((f) => f.kind === "count").map((f) => f.objectIds[0]))) {
    const d = obj.get(id)?.description;
    if (d && NUMBER.test(d))
      issues.push(`object ${id}: a tap on it says "${d}", which states a number of a counted thing; give it a new description in "describe", with no number`);
  }

  // A count must be counted by the player, so the inspect that reveals it shows the object and doesn't say the number.
  for (const a of room.actions)
    for (const fid of a.effect.reveals ?? []) {
      const f = fact.get(fid);
      if (f?.kind !== "count") continue;
      if (a.effect.closeup !== f.objectIds[0]) issues.push(`action ${a.id}: reveals a count, so its closeup must be ${f.objectIds[0]}`);
      const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
      if (new RegExp(`\\b(${f.value}|${words[Number(f.value)] ?? f.value})\\b`, "i").test(a.effect.message))
        issues.push(`action ${a.id}: its message gives away the count (${f.value}); let the player count`);
    }

  // Text follows state: whatever an action changes says how it looks afterwards, so a tap never describes the past.
  for (const a of room.actions)
    if (a.kind !== "combine" && changes(a) && !a.effect.sets?.includes(room.goal) && !a.effect.after?.trim())
      issues.push(`action ${a.id}: it changes the ${obj.get(a.target)?.label ?? a.target}, so give effect.after, one sentence on how it looks from then on`);

  // A note that sends the player counting says why: it names the lock the numbers open, in order, as written words.
  for (const code of room.actions) {
    if (code.kind !== "code") continue;
    const lock = obj.get(code.target)?.label.toLowerCase() ?? code.target;
    const notes = new Set(
      room.actions
        .filter((a) => (a.effect.reveals ?? []).some((f) => code.derivedFrom.includes(f)))
        .flatMap((a) => a.when?.items ?? []),
    );
    // A tool that reaches what is counted (a grabber) isn't a note: it is made or used, a note only read.
    for (const n of [...notes])
      if (room.actions.some((a) => (a.kind === "use" && a.item === n) || (a.kind === "combine" && (a.items.includes(n) || a.effect.gives?.includes(n)))))
        notes.delete(n);
    for (const n of notes) {
      const it = item.get(n);
      if (!it) continue;
      if (!it.text?.trim()) issues.push(`item ${n}: it is a note, so give it text: the words written on it`);
      else if (!names(it.text, lock))
        issues.push(`item ${n}: its text never names the ${lock} its numbers open; say what they are for`);
    }
    // No note gates the clues: some note must still name the lock, or nothing tells the player how its code is made.
    if (!notes.size && !room.items.some((i) => names(i.text, lock)))
      issues.push(`action ${code.id}: no note names the ${lock}, so nothing tells the player how its code is made; add a note whose text names it and says what each digit is, in order`);
  }

  // What a blind player needs, the screen shows (blind plays, 28 Oct):
  // - every code lock has a note that names it, so the player knows which numbers open it (checked above);
  // - one group is counted once: two digits over the same cushions under two wordings is a guess, not a puzzle;
  const countedTwice = room.facts.filter((f, i) => f.kind === "count" && room.facts.findIndex((g) => g.kind === "count" && g.objectIds[0] === f.objectIds[0]) !== i);
  for (const f of countedTwice) issues.push(`fact ${f.id}: the ${obj.get(f.objectIds[0])?.label ?? f.objectIds[0]} are already counted by another fact; count a different group`);
  // - a number read off the photo is shown: the look that reveals it quotes it as written;
  for (const a of room.actions)
    for (const fid of a.effect.reveals ?? []) {
      const f = fact.get(fid);
      if (f?.kind !== "text") continue;
      const shown = (a.effect.message.match(/\d+(?:[.,]\d{3})*/g) ?? []).map((n) => n.replace(/[.,]/g, ""));
      if (/^\d+$/.test(f.value) ? !shown.includes(f.value) : !a.effect.message.toLowerCase().includes(f.value.toLowerCase()))
        issues.push(`action ${a.id}: it reveals "${f.value}" but its message never shows it; quote the words as written on the ${obj.get(f.objectIds[0])?.label ?? "object"}`);
    }
  // - a tool's target says on a plain tap that something is there: no look that does something else speaks for it;
  const toolTargets = new Set(room.actions.flatMap((a) => (a.kind === "use" && !a.effect.sets?.includes(room.goal) ? [a.target] : [])));
  for (const a of room.actions)
    if (a.kind === "inspect" && toolTargets.has(a.target) && !a.when)
      issues.push(`action ${a.id}: a tap on the ${obj.get(a.target)?.label ?? a.target} runs it, so the player never reads the hint that a tool is needed there; gate it or move what it does elsewhere`);
  // - the way out reads as shut on a plain tap.
  const exit = room.actions.find((a) => a.effect.sets?.includes(room.goal));
  const exitText = exit && exit.kind !== "combine" ? obj.get(exit.target)?.description : undefined;
  if (exitText && /\b(open|ajar|stands? wide)\b/i.test(exitText))
    issues.push(`object ${exit!.kind !== "combine" && exit!.target}: it is the way out but a tap says "${exitText}"; describe it as shut, locked or blocked`);

  const labels = room.objects.map((o) => o.label.toLowerCase());
  labels.forEach((l, i) => labels.indexOf(l) !== i && issues.push(`two objects are both called "${l}"; give them different labels`));

  // What the logic needs, a finger must reach: no target hidden under another object's shape.
  issues.push(...reachIssues(room));

  const revealed = new Set(room.actions.flatMap((a) => a.effect.reveals ?? []));
  for (const a of room.actions) {
    const where = `action ${a.id}`;
    if (a.kind !== "combine") needObj(a.target, where);
    if (a.kind === "use") needItem(a.item, where);
    if (a.kind === "combine") a.items.forEach((i) => needItem(i, where));
    [...(a.effect.gives ?? []), ...(a.effect.takes ?? []), ...(a.when?.items ?? [])].forEach((i) => needItem(i, where));
    (a.effect.reveals ?? []).forEach((f) => fact.has(f) || issues.push(`${where}: reveals unknown fact "${f}"`));
    if (a.effect.closeup) needObj(a.effect.closeup, where);
    if (a.kind === "code") {
      a.code = String(a.code);
      if (/^[\d.,]+$/.test(a.code)) a.code = a.code.replace(/[.,]/g, ""); // "22,500": the dial takes digits only
      if (!/^\d+$/.test(a.code)) issues.push(`${where}: code "${a.code}" must be digits only`);
      const parts = a.derivedFrom.map((f) => fact.get(f));
      if (parts.some((p) => !p)) issues.push(`${where}: code built from an unknown fact`);
      else if (parts.map((p) => p!.value).join("") !== a.code)
        issues.push(`${where}: code ${a.code} is not ${parts.map((p) => p!.value).join(" + ")}`);
      a.derivedFrom.forEach((f) => revealed.has(f) || issues.push(`${where}: nothing in the room reveals fact ${f}`));
    }
  }
  return issues;
}
