// Meta Model API client with a spend ledger. Every paid call books its worst case through `book` *before* it runs,
// and `book` refuses once the day's or the pool's cap would be passed, so a bug or a crowd can't spend past the credits.
// The rule: no Meta usage outside the $150 free credits. Meta has no hard cap of its own, so this ledger is the cap.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spendOffReason } from "./lockdown";

// Overridable only so the lockdown tests can point every call at a local stub that counts requests.
const BASE = process.env.META_BASE_URL ?? "https://api.meta.ai/v1";
export const SPARK = "muse-spark-1.3";
export const IMAGE = "muse-image-1.0";

// USD; Spark per token from dev.meta.ai pricing (Oct 2026), SAM per image, Muse Image per image (upper estimate).
export const PRICE = { sparkIn: 1.25e-6, sparkOut: 4.25e-6, sam: 0.0025, image: 0.02 };

// One budget of $130 of the $150 credits ($20 left for anything the ledger misses), split into fixed pools because
// each spender keeps its own ledger: Cloud Run (bucket ledger) and runs on a local PC (local/spend.json). The pools
// add up to the budget, so the ledgers together can't pass it. Env vars can lower a pool, never raise it.
export const POOLS = { cloud: 100, local: 30 } as const;
export const BUDGET_USD = 130;
// After judging (4–8 Nov) and the bonus prizes (~10 Nov) every Meta call is refused, whatever the env says.
export const STOP_AT = "2026-11-11T00:00:00Z";

const pool = () => {
  const p = process.env.META_POOL ?? "local";
  if (!(p in POOLS)) throw new SpendCapError(`Unknown META_POOL "${p}".`);
  return p as keyof typeof POOLS;
};
const totalCap = () => Math.min(POOLS[pool()], Number(process.env.META_TOTAL_USD ?? Infinity));
const dailyCap = () => Number(process.env.META_DAILY_USD ?? 5);
const ledgerPath = () => process.env.META_LEDGER ?? new URL("../local/spend.json", import.meta.url).pathname;

interface Ledger {
  total: number;
  days: Record<string, number>;
}

const today = () => new Date().toISOString().slice(0, 10);
const readLedger = (): Ledger => (existsSync(ledgerPath()) ? JSON.parse(readFileSync(ledgerPath(), "utf8")) : { total: 0, days: {} });

export class SpendCapError extends Error {}

function canSpend(estimate: number) {
  const off = spendOffReason(STOP_AT);
  if (off) throw new SpendCapError(off);
  const l = readLedger();
  if (l.total + estimate > totalCap()) throw new SpendCapError(`The event budget of $${totalCap()} is used up.`);
  if ((l.days[today()] ?? 0) + estimate > dailyCap()) throw new SpendCapError(`Today's budget of $${dailyCap()} is used up.`);
}

function add(usd: number) {
  const l = readLedger();
  l.total = +(l.total + usd).toFixed(6);
  l.days[today()] = +((l.days[today()] ?? 0) + usd).toFixed(6);
  mkdirSync(dirname(ledgerPath()), { recursive: true });
  writeFileSync(ledgerPath(), JSON.stringify(l, null, 2));
}

// Books a call's worst case before it runs, or throws SpendCapError. A call that fails or times out stays booked.
export function book(usd: number) {
  canSpend(usd);
  add(usd);
}

// After a call, swaps its booking for what it really cost, if that is known and lower.
export function settle(booked: number, actual: number) {
  if (actual < booked) add(actual - booked);
}

export const spent = () => readLedger();

function key() {
  const k = process.env.META_API_KEY;
  if (!k) throw new Error("META_API_KEY is not set (put it in .env; see the README).");
  return k;
}

export type Content = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
export interface Message {
  role: "system" | "user" | "assistant";
  content: Content;
}

// One Spark call that must return JSON matching `schema`. Returns the parsed JSON and the call's cost.
export async function sparkJSON<T>(messages: Message[], name: string, schema: object, maxTokens = 6000, effort: "low" | "medium" | "high" = "medium"): Promise<{ data: T; usd: number; raw: string }> {
  // Worst case: every output token, plus a generous allowance for the prompt and one photo.
  const booked = maxTokens * PRICE.sparkOut + 0.02;
  book(booked);
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key()}` },
    body: JSON.stringify({
      model: SPARK,
      messages,
      max_tokens: maxTokens,
      reasoning_effort: effort,
      response_format: { type: "json_schema", json_schema: { name, schema } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Spark ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const u = body.usage ?? {};
  const usd = (u.prompt_tokens ?? 0) * PRICE.sparkIn + (u.completion_tokens ?? 0) * PRICE.sparkOut;
  settle(booked, usd);
  const raw = body.choices?.[0]?.message?.content ?? "";
  if (!raw) throw new Error(`Spark returned no content (finish_reason ${body.choices?.[0]?.finish_reason}).`);
  return { data: JSON.parse(raw) as T, usd, raw };
}

// Muse Image: paint a picture from a prompt and a reference image (the room photo), PNG bytes back.
export async function paint(prompt: string, referenceDataUrl: string): Promise<{ png: Buffer; usd: number }> {
  book(PRICE.image);
  const res = await fetch(`${BASE}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key()}` },
    body: JSON.stringify({
      model: IMAGE,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: referenceDataUrl }] }],
      tools: [{ type: "image_generation", output_format: "png" }],
      store: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Muse Image ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const out = (body.output ?? []).find((o: { type: string }) => o.type === "image_generation_call");
  if (!out?.result) throw new Error("Muse Image returned no image.");
  return { png: Buffer.from(out.result, "base64"), usd: PRICE.image };
}
