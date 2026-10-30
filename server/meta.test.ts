// The rule: no Meta usage outside the $150 free credits. These tests hold the ledger to it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { book, BUDGET_USD, POOLS, settle, SpendCapError, spent, STOP_AT } from "./meta";

const dir = mkdtempSync(join(tmpdir(), "ledger-"));
let n = 0;
// Switches to one spender: its pool and its own ledger file, as Cloud Run and a local PC each have.
const as = (pool: string, ledger: string, env: Record<string, string> = {}) => {
  for (const k of ["META_OFF", "META_TOTAL_USD", "META_DAILY_USD"]) delete process.env[k];
  // The spend switch on (server/lockdown.ts), so these tests reach the ledger.
  Object.assign(process.env, { META_POOL: pool, META_LEDGER: join(dir, ledger), META_DAILY_USD: "1000", META_SPEND_UNTIL: "2027-01-01T00:00:00Z", ...env });
};

describe("Meta spend ledger", () => {
  let cloud: string, local: string;
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-27T12:00:00Z"), toFake: ["Date"] });
    n++;
    cloud = `cloud-${n}.json`;
    local = `local-${n}.json`;
  });
  afterEach(() => vi.useRealTimers());

  it("pools add up to the budget, which stays well under the $150 credits", () => {
    expect(POOLS.cloud + POOLS.local).toBe(BUDGET_USD);
    expect(BUDGET_USD).toBeLessThanOrEqual(130);
  });

  it("refuses the second spender at the cap, so both together never pass the budget", () => {
    as("cloud", cloud);
    for (let i = 0; i < 100; i++) book(1);
    expect(() => book(0.01)).toThrow(SpendCapError);
    as("local", local);
    for (let i = 0; i < 30; i++) book(1);
    expect(() => book(0.01)).toThrow(SpendCapError);
    as("cloud", cloud);
    const c = spent().total;
    as("local", local);
    expect(c + spent().total).toBeLessThanOrEqual(BUDGET_USD);
  });

  it("lets an env var lower a pool but never raise it", () => {
    as("local", local, { META_TOTAL_USD: "1000" });
    book(30);
    expect(() => book(0.01)).toThrow(SpendCapError);
    as("cloud", cloud, { META_TOTAL_USD: "2" });
    book(2);
    expect(() => book(0.01)).toThrow(SpendCapError);
    as("other", "x.json");
    expect(() => book(0.01)).toThrow(SpendCapError);
  });

  it("books before the call: a refused booking writes nothing, a booking stays if the call dies", () => {
    as("local", local, { META_DAILY_USD: "1" });
    book(0.9);
    expect(() => book(0.2)).toThrow(SpendCapError);
    expect(spent().total).toBe(0.9);
    settle(0.9, 0.3); // the call reported its real cost
    expect(spent().total).toBe(0.3);
    settle(0.1, 0.5); // never books less than the worst case already held
    expect(spent().total).toBe(0.3);
  });

  it("refuses everything with META_OFF and after the event", () => {
    as("cloud", cloud, { META_OFF: "1" });
    expect(() => book(0.01)).toThrow(SpendCapError);
    as("cloud", cloud);
    vi.setSystemTime(new Date(STOP_AT));
    expect(() => book(0.01)).toThrow(/event is over/);
  });
});
