// The two locks in front of every paid Meta call.
// 1. Spend switch: Meta calls run only while META_SPEND_UNTIL holds a future time. Missing, unreadable or past means
//    off, so a fresh deploy, a typo or a forgotten switch all fail closed. The operator sets it in the service env; the
//    server can't change its own env, so nothing a visitor sends can turn it on.
// 2. Access codes: making a new room needs a code. ACCESS_CODES (a Secret Manager secret) lists each code's SHA-256,
//    its own room allowance and an end time; a visitor without a code plays the rooms already made, for $0.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Why the switch is off right now, or null when paid calls may run. `stopAt` is the event's own end, after which
// nothing runs whatever the switch says.
export function spendOffReason(stopAt: string, now = Date.now()): string | null {
  if (process.env.META_OFF === "1") return "Meta calls are switched off (META_OFF=1).";
  const until = Date.parse(process.env.META_SPEND_UNTIL ?? "");
  if (Number.isNaN(until)) return "Meta calls are switched off (no META_SPEND_UNTIL).";
  if (now >= until) return "Meta calls are switched off (META_SPEND_UNTIL has passed).";
  if (now >= Date.parse(stopAt)) return "The event is over, so Meta calls are switched off.";
  return null;
}

export interface AccessCode {
  id: string; // a label, e.g. "judges" or "testers"
  sha256: string; // hex SHA-256 of the code; the code itself is never stored
  rooms: number; // new rooms this code may make in all
  perDay: number; // and per day
  until: string; // ISO time after which the code stops working
}

export const hashCode = (code: string) => createHash("sha256").update(code.trim()).digest("hex");

// Unreadable or missing ACCESS_CODES means no code works.
export function accessCodes(): AccessCode[] {
  try {
    const list = JSON.parse(process.env.ACCESS_CODES ?? "[]");
    return Array.isArray(list) ? list.filter((c) => typeof c?.sha256 === "string" && /^[0-9a-f]{64}$/.test(c.sha256)) : [];
  } catch {
    return [];
  }
}

const usagePath = () => process.env.ACCESS_LEDGER ?? new URL("../local/access.json", import.meta.url).pathname;
type Usage = Record<string, { total: number; days: Record<string, number> }>;
const readUsage = (): Usage => (existsSync(usagePath()) ? JSON.parse(readFileSync(usagePath(), "utf8")) : {});

// Wrong codes per address per hour; past this every attempt from that address is refused without checking.
export const MAX_BAD_TRIES = 10;
const badTries = new Map<string, { hour: number; n: number }>();

export type Admit = { ok: true; id: string } | { ok: false; status: number; error: string };

// Checks a code and books one room against it. A refusal books nothing.
export function admit(code: string | undefined, ip: string, now = Date.now()): Admit {
  const hour = Math.floor(now / 3.6e6);
  const bad = badTries.get(ip)?.hour === hour ? badTries.get(ip)!.n : 0;
  if (bad >= MAX_BAD_TRIES) return { ok: false, status: 429, error: "Too many wrong codes. Try again in an hour." };
  if (!code) return { ok: false, status: 403, error: "Making new rooms needs an access code. Every room already made is free to play." };
  const given = Buffer.from(hashCode(code), "hex");
  const match = accessCodes().find((c) => timingSafeEqual(Buffer.from(c.sha256, "hex"), given));
  if (!match) {
    badTries.set(ip, { hour, n: bad + 1 });
    return { ok: false, status: 403, error: "That access code isn't valid." };
  }
  if (!(now < Date.parse(match.until))) return { ok: false, status: 403, error: "That access code has expired." };
  const day = new Date(now).toISOString().slice(0, 10);
  const usage = readUsage();
  const u = usage[match.id] ?? { total: 0, days: {} };
  if (u.total >= match.rooms) return { ok: false, status: 429, error: "This access code has made all its rooms." };
  if ((u.days[day] ?? 0) >= match.perDay) return { ok: false, status: 429, error: "This access code has made today's rooms. Try again tomorrow." };
  u.total++;
  u.days[day] = (u.days[day] ?? 0) + 1;
  usage[match.id] = u;
  mkdirSync(dirname(usagePath()), { recursive: true });
  writeFileSync(usagePath(), JSON.stringify(usage, null, 2));
  return { ok: true, id: match.id };
}

// Tests only.
export const resetBadTries = () => badTries.clear();
