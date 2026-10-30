import { apply, initialState, stateKey, triggered, won } from "./engine";
import type { Room, State } from "./types";

export interface SolveReport {
  solvable: boolean;
  solution: string[]; // shortest list of action ids that escapes
  states: number; // reachable states explored
  complete: boolean; // false when the search stopped at MAX_STATES; unexplored states then count as dead ends
  deadEnds: number; // reachable states from which the goal can no longer be reached (soft-locks)
  deadEndExample?: string[]; // a path into one, for the failure log
  neverUsed: string[]; // actions no reachable state can take
}

const MAX_STATES = 200_000;

// Breadth-first search over every state a player can reach. A room passes only if the goal is reachable and no
// reachable state is a soft-lock, so any order of play can still finish.
export function solve(room: Room): SolveReport {
  const start = initialState();
  const seen = new Map<string, { state: State; prev?: string; via?: string }>([[stateKey(start), { state: start }]]);
  const edges = new Map<string, string[]>();
  const used = new Set<string>();
  const queue = [stateKey(start)];
  let goalKey: string | undefined;

  while (queue.length && seen.size < MAX_STATES) {
    const key = queue.shift()!;
    const { state } = seen.get(key)!;
    const next: string[] = [];
    if (won(room, state)) {
      goalKey ??= key;
      edges.set(key, next);
      continue;
    }
    for (const a of room.actions) {
      if (!triggered(room, state, a)) continue;
      const s2 = apply(state, a);
      const k2 = stateKey(s2);
      if (k2 === key) continue;
      used.add(a.id);
      next.push(k2);
      if (!seen.has(k2)) {
        seen.set(k2, { state: s2, prev: key, via: a.id });
        queue.push(k2);
      }
    }
    edges.set(key, next);
  }

  const pathTo = (k: string) => {
    const path: string[] = [];
    for (let n = seen.get(k); n?.via; n = seen.get(n.prev!)) path.unshift(n.via);
    return path;
  };

  // States that can still reach a goal: walk the edges backwards from every winning state.
  const reverse = new Map<string, string[]>();
  for (const [from, tos] of edges) for (const to of tos) reverse.set(to, [...(reverse.get(to) ?? []), from]);
  const alive = new Set([...seen.keys()].filter((k) => won(room, seen.get(k)!.state)));
  const stack = [...alive];
  while (stack.length) for (const p of reverse.get(stack.pop()!) ?? []) if (!alive.has(p)) alive.add(p), stack.push(p);
  const dead = [...seen.keys()].filter((k) => !alive.has(k));

  return {
    solvable: goalKey !== undefined,
    solution: goalKey ? pathTo(goalKey) : [],
    states: seen.size,
    complete: queue.length === 0,
    deadEnds: dead.length,
    deadEndExample: dead.length ? pathTo(dead[0]) : undefined,
    neverUsed: room.actions.filter((a) => !used.has(a.id)).map((a) => a.id),
  };
}
