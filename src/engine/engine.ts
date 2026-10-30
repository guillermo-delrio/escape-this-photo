import type { Action, Cond, Room, State } from "./types";

export const initialState = (): State => ({ items: [], flags: [] });

export const stateKey = (s: State) => s.items.join(",") + "|" + s.flags.join(",");

const holds = (s: State, c: Cond | undefined) =>
  !c ||
  ((c.items ?? []).every((i) => s.items.includes(i)) &&
    (c.flags ?? []).every((f) => s.flags.includes(f)) &&
    (c.notFlags ?? []).every((f) => !s.flags.includes(f)));

// What an action needs beyond its own `when`: the items it uses, and for a code the facts it is built from, so a
// player can never be expected to guess.
export function requirement(a: Action): Cond {
  const items = [...(a.when?.items ?? [])];
  const flags = [...(a.when?.flags ?? [])];
  if (a.kind === "use") items.push(a.item);
  if (a.kind === "combine") items.push(...a.items);
  if (a.kind === "code") flags.push(...a.derivedFrom.map((f) => `knows:${f}`));
  return { items, flags, notFlags: [...(a.when?.notFlags ?? []), `done:${a.id}`] };
}

export const applicable = (s: State, a: Action) => holds(s, requirement(a));

export function apply(s: State, a: Action): State {
  const e = a.effect;
  const items = new Set(s.items);
  (e.takes ?? []).forEach((i) => items.delete(i));
  (e.gives ?? []).forEach((i) => items.add(i));
  const flags = new Set(s.flags);
  (e.sets ?? []).forEach((f) => flags.add(f));
  (e.reveals ?? []).forEach((f) => flags.add(`knows:${f}`));
  // Actions that change something happen once; a pure description can be read again.
  if (e.gives?.length || e.takes?.length || e.sets?.length || e.reveals?.length) flags.add(`done:${a.id}`);
  return { items: [...items].sort(), flags: [...flags].sort() };
}

export const won = (room: Room, s: State) => s.flags.includes(room.goal);

// What happens when the player taps an object, optionally with an item selected.
// A plain look (an inspect that changes and reveals nothing) never hides a code lock on the same object: a blind
// play-through tapped a bolted exit for ever and only ever read "closed and bolted".
export function tap(room: Room, s: State, target: string, item?: string): Action | undefined {
  const a = room.actions.find(
    (a) =>
      ((item === undefined && a.kind === "inspect" && a.target === target) ||
        (item !== undefined && a.kind === "use" && a.item === item && a.target === target)) &&
      applicable(s, a),
  );
  return a && item === undefined && plain(a) && codeLock(room, s, target) ? undefined : a;
}

// An inspect that only says something: no item, flag, fact, close-up or painted interior.
export const plain = (a: Action) => a.kind === "inspect" && !changes(a) && !a.effect.reveals?.length && !a.effect.closeup && !a.effect.image;

export function codeLock(room: Room, s: State, target: string) {
  return room.actions.find(
    (a): a is Extract<Action, { kind: "code" }> =>
      a.kind === "code" && a.target === target && holds(s, { ...a.when, notFlags: [...(a.when?.notFlags ?? []), `done:${a.id}`] }),
  );
}

export function combine(room: Room, s: State, x: string, y: string) {
  return room.actions.find(
    (a) => a.kind === "combine" && a.items.includes(x) && a.items.includes(y) && x !== y && applicable(s, a),
  );
}

// What a plain tap on an object says now: once an action has changed it, its own "after" line, never the description
// of how it was before ("the lid is shut" after it was opened).
export function objectText(room: Room, s: State, id: string): { text: string; changed: boolean; closeup?: string } {
  const o = room.objects.find((x) => x.id === id)!;
  const changers = room.actions.filter(
    (a) => a.kind !== "combine" && a.target === id && s.flags.includes(`done:${a.id}`) && changes(a),
  );
  // A clue once found stays readable: tapping its object again repeats it, close-up included, so a player can
  // read the number again or recount (a blind play-through lost "$2,500 - Rent" to the plain description).
  const clue = room.actions.filter((a) => a.kind === "inspect" && a.target === id && s.flags.includes(`done:${a.id}`) && a.effect.reveals?.length).at(-1);
  if (!changers.length && clue) return { text: clue.effect.message, changed: false, closeup: clue.effect.closeup };
  if (!changers.length) return { text: o.description ?? `The ${o.label}. Nothing more to it.`, changed: false };
  return { text: changers.at(-1)!.effect.after ?? `Nothing more to find in the ${o.label}.`, changed: true };
}

// An action that changes the world (not one that only reveals a fact): its target looks different afterwards.
export const changes = (a: Action) => !!(a.effect.gives?.length || a.effect.takes?.length || a.effect.sets?.length);

// Every wall of the room, the first one being the photo the room is named after.
export const roomWalls = (room: Room) => [room.image, ...(room.walls ?? [])];

// Would a player's tap run this action now? The solver walks only these, so a room it passes is one the game can
// finish: an action that another one on the same tap always pre-empts (a look over a lock) doesn't count.
export function triggered(room: Room, s: State, a: Action) {
  if (!applicable(s, a)) return false;
  if (a.kind === "inspect") return tap(room, s, a.target) === a;
  if (a.kind === "use") return tap(room, s, a.target, a.item) === a;
  if (a.kind === "combine") return combine(room, s, a.items[0], a.items[1]) === a;
  return !tap(room, s, a.target) && codeLock(room, s, a.target) === a;
}
