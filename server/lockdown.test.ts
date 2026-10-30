// The rule: nothing public may reach the Meta key unless the switch is on and the caller has a code.
// Unit tests of both locks, then the real server and sam.py run against a local stub of the Meta API that counts
// every request it gets: with either lock shut it must get none. A positive control shows the stub is reachable.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { admit, hashCode, MAX_BAD_TRIES, resetBadTries, spendOffReason } from "./lockdown";
import { book, paint, sparkJSON, SpendCapError, STOP_AT } from "./meta";

// The rooms a test built: a fresh data folder also holds the sample rooms the server seeds from samples/.
const SAMPLES = new URL("../samples", import.meta.url).pathname;
const built = (data: string) => readdirSync(data).filter((d) => !existsSync(join(SAMPLES, d)));

const dir = mkdtempSync(join(tmpdir(), "lockdown-"));
const NOW = Date.parse("2026-11-05T12:00:00Z");
const ON = "2026-11-09T06:00:00Z";
const CODE = "judge-code-0123456789ab";
const codes = (over: object = {}) => JSON.stringify([{ id: "judges", sha256: hashCode(CODE), rooms: 3, perDay: 2, until: ON, ...over }]);
const clean = () => {
  for (const k of ["META_OFF", "META_SPEND_UNTIL", "ACCESS_CODES", "ACCESS_LEDGER", "META_POOL", "META_LEDGER", "META_TOTAL_USD", "META_DAILY_USD"]) delete process.env[k];
};
let n = 0;

describe("spend switch", () => {
  beforeEach(clean);
  it("is off when META_SPEND_UNTIL is missing, unreadable or past", () => {
    expect(spendOffReason(STOP_AT, NOW)).toMatch(/no META_SPEND_UNTIL/);
    process.env.META_SPEND_UNTIL = "next week";
    expect(spendOffReason(STOP_AT, NOW)).toMatch(/no META_SPEND_UNTIL/);
    process.env.META_SPEND_UNTIL = "2026-11-05T11:59:59Z";
    expect(spendOffReason(STOP_AT, NOW)).toMatch(/has passed/);
  });
  it("is on only before its time, and never after the event or with META_OFF", () => {
    process.env.META_SPEND_UNTIL = ON;
    expect(spendOffReason(STOP_AT, NOW)).toBeNull();
    expect(spendOffReason(STOP_AT, Date.parse(ON))).toMatch(/has passed/);
    process.env.META_SPEND_UNTIL = "2027-01-01T00:00:00Z";
    expect(spendOffReason(STOP_AT, Date.parse(STOP_AT))).toMatch(/event is over/);
    process.env.META_OFF = "1";
    expect(spendOffReason(STOP_AT, NOW)).toMatch(/META_OFF/);
  });
});

describe("paid calls with the switch off", () => {
  beforeEach(() => {
    clean();
    Object.assign(process.env, { META_POOL: "local", META_LEDGER: join(dir, `ledger-${++n}.json`), META_API_KEY: "stub" });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("book, Spark and Muse Image refuse before any request leaves", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => book(0.01)).toThrow(SpendCapError);
    await expect(sparkJSON([{ role: "user", content: "hi" }], "x", {})).rejects.toThrow(SpendCapError);
    await expect(paint("a key", "data:image/png;base64,")).rejects.toThrow(SpendCapError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("access codes", () => {
  beforeEach(() => {
    clean();
    resetBadTries();
    Object.assign(process.env, { ACCESS_CODES: codes(), ACCESS_LEDGER: join(dir, `access-${++n}.json`) });
  });
  it("refuses no code, a wrong code, an expired code and unreadable code lists", () => {
    expect(admit(undefined, "a", NOW)).toMatchObject({ ok: false, status: 403 });
    expect(admit("guess", "a", NOW)).toMatchObject({ ok: false, status: 403 });
    expect(admit(CODE, "a", Date.parse(ON))).toMatchObject({ ok: false, error: /expired/ });
    process.env.ACCESS_CODES = "{not json";
    expect(admit(CODE, "a", NOW)).toMatchObject({ ok: false, status: 403 });
    process.env.ACCESS_CODES = JSON.stringify([{ id: "x", sha256: CODE, rooms: 9, perDay: 9, until: ON }]); // a bare code, not a hash
    expect(admit(CODE, "a", NOW)).toMatchObject({ ok: false, status: 403 });
  });
  it("holds each code to its rooms a day and in all", () => {
    expect(admit(CODE, "a", NOW)).toEqual({ ok: true, id: "judges" });
    expect(admit(CODE, "b", NOW)).toEqual({ ok: true, id: "judges" });
    expect(admit(CODE, "c", NOW)).toMatchObject({ ok: false, error: /today/ });
    expect(admit(CODE, "c", NOW + 864e5)).toEqual({ ok: true, id: "judges" });
    expect(admit(CODE, "c", NOW + 2 * 864e5)).toMatchObject({ ok: false, error: /all its rooms/ });
  });
  it("locks out an address after too many wrong codes, even with the right one", () => {
    for (let i = 0; i < MAX_BAD_TRIES; i++) admit(`guess-${i}`, "a", NOW);
    expect(admit(CODE, "a", NOW)).toMatchObject({ ok: false, status: 429 });
    expect(admit(CODE, "b", NOW)).toEqual({ ok: true, id: "judges" });
    expect(admit(CODE, "a", NOW + 3.6e6)).toEqual({ ok: true, id: "judges" });
  });
});

// --- Stub network: the real entry points, with META_BASE_URL pointed at a local server that counts requests. ---

let stub: Server;
let stubUrl = "";
let hits = 0;
let paths: string[] = [];
// What the stub answers: an error by default; a case can make Spark's reply a refusing content check.
let reply: { status: number; body: string } = { status: 500, body: '{"error":"stub"}' };
// A 1×1 PNG: enough for the server's type check and for sam.py's Pillow.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

beforeAll(async () => {
  stub = createServer((req, res) => {
    hits++;
    paths.push(req.url ?? "");
    req.resume();
    res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}/v1`;
});
afterAll(() => new Promise<void>((r) => stub.close(() => r())));

// Only what each case sets: the parent's own switch or key never leaks in.
const baseEnv = () => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, META_BASE_URL: stubUrl, META_API_KEY: "stub-key", META_POOL: "local", META_DAILY_USD: "5" });

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

// npx starts tsx, which starts node: killing npx alone left the servers running after every test run. Each server gets
// its own process group, and stop() ends the whole group.
const stop = (proc: ChildProcess) => {
  try {
    process.kill(-proc.pid!, "SIGTERM");
  } catch {
    // already gone
  }
};

async function startServer(env: Record<string, string>): Promise<{ url: string; proc: ChildProcess; data: string }> {
  const tag = ++n;
  const data = join(dir, `data-${tag}`);
  const proc = spawn("npx", ["tsx", "server/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    detached: true,
    env: { ...baseEnv(), PORT: String(await freePort()), DATA: data, META_LEDGER: join(dir, `sl-${tag}.json`), ACCESS_LEDGER: join(dir, `sa-${tag}.json`), ...env },
  });
  const port = await new Promise<number>((resolve, reject) => {
    proc.stdout!.on("data", (d) => {
      const m = String(d).match(/on :(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  return { url: `http://127.0.0.1:${port}`, proc, data };
}

const post = (url: string, code?: string) =>
  fetch(`${url}/api/rooms`, { method: "POST", body: PNG, headers: { "content-type": "image/png", ...(code ? { "x-access-code": code } : {}) } });

describe("stub network: the server", () => {
  const live = `${new Date(Date.now() + 3.6e6).toISOString().slice(0, 19)}Z`;
  const cases: [string, Record<string, string>, string | undefined][] = [
    ["switch missing, right code", { ACCESS_CODES: codes({ until: STOP_AT }) }, CODE],
    ["switch past, right code", { META_SPEND_UNTIL: "2026-01-01T00:00:00Z", ACCESS_CODES: codes({ until: STOP_AT }) }, CODE],
    ["META_OFF=1, switch on, right code", { META_OFF: "1", META_SPEND_UNTIL: live, ACCESS_CODES: codes({ until: STOP_AT }) }, CODE],
    ["switch on, no code", { META_SPEND_UNTIL: live, ACCESS_CODES: codes({ until: STOP_AT }) }, undefined],
    ["switch on, wrong code", { META_SPEND_UNTIL: live, ACCESS_CODES: codes({ until: STOP_AT }) }, "judge-code-0123456789ac"],
    ["switch on, expired code", { META_SPEND_UNTIL: live, ACCESS_CODES: codes({ until: "2026-01-01T00:00:00Z" }) }, CODE],
    ["switch on, no code list", { META_SPEND_UNTIL: live }, CODE],
  ];
  for (const [name, env, code] of cases)
    it(`sends nothing to Meta: ${name}`, async () => {
      const { url, proc } = await startServer(env);
      try {
        hits = 0;
        const res = await post(url, code);
        expect([403, 429, 503]).toContain(res.status);
        expect(hits).toBe(0);
      } finally {
        stop(proc);
      }
    }, 30_000);

  it("positive control: switch on and the right code reach the stub", async () => {
    const { url, proc } = await startServer({ META_SPEND_UNTIL: live, ACCESS_CODES: codes({ until: STOP_AT }) });
    try {
      hits = 0;
      const res = await post(url, CODE);
      expect(res.status).toBe(422); // the stub answers every call with an error, so the content check refuses the photo
      expect(hits).toBeGreaterThan(0);
    } finally {
      stop(proc);
    }
  }, 30_000);
});

describe("stub network: sam.py on its own", () => {
  const live = `${new Date(Date.now() + 3.6e6).toISOString().slice(0, 19)}Z`;
  const photo = join(dir, "one.png");
  beforeAll(async () => (await import("node:fs")).writeFileSync(photo, PNG));
  const sam = (env: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const p = spawn("uv", ["run", "-q", new URL("./sam.py", import.meta.url).pathname, photo, "a bed"], { env: { ...baseEnv(), ...env } });
      p.on("exit", (c) => resolve(c ?? -1));
    });
  it("sends nothing when run by hand, with the switch off, or with META_OFF", async () => {
    hits = 0;
    expect(await sam({ META_SPEND_UNTIL: live })).not.toBe(0); // not booked by pipeline.ts
    expect(await sam({ META_SAM_BOOKED: "1" })).not.toBe(0);
    expect(await sam({ META_SAM_BOOKED: "1", META_SPEND_UNTIL: "2026-01-01T00:00:00Z" })).not.toBe(0);
    expect(await sam({ META_SAM_BOOKED: "1", META_SPEND_UNTIL: live, META_OFF: "1" })).not.toBe(0);
    expect(hits).toBe(0);
  }, 120_000);
  it("positive control: booked and switched on, it reaches the stub", async () => {
    hits = 0;
    expect(await sam({ META_SAM_BOOKED: "1", META_SPEND_UNTIL: live })).toBe(0); // a failed phrase drops the object
    expect(hits).toBeGreaterThan(0);
  }, 120_000);
});

describe("stub network: content check and reports", () => {
  const live = `${new Date(Date.now() + 3.6e6).toISOString().slice(0, 19)}Z`;
  afterEach(() => {
    reply = { status: 500, body: '{"error":"stub"}' };
  });

  it("a refused photo builds nothing: one check, no listing, SAM or painting, and only the log is kept", async () => {
    const verdict = JSON.stringify({ allowed: false, reason: "The photo shows a person; use a photo of an empty room." });
    reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: verdict } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) };
    const { url, proc, data } = await startServer({ META_SPEND_UNTIL: live, ACCESS_CODES: codes({ until: STOP_AT }) });
    try {
      paths = [];
      const res = await fetch(`${url}/api/rooms`, { method: "POST", body: PNG, headers: { "content-type": "image/png", "x-access-code": CODE, "x-paint-walls": "1" } });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/shows a person/);
      expect(paths).toEqual(["/v1/chat/completions"]);
      const [room] = built(data);
      expect(readdirSync(join(data, room))).toEqual(["log.json"]);
    } finally {
      stop(proc);
    }
  }, 30_000);

  it("an empty answer from the check is retried once, then refuses the photo: no crash, nothing built", async () => {
    reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: {} }) };
    const { url, proc, data } = await startServer({ META_SPEND_UNTIL: live, ACCESS_CODES: codes({ until: STOP_AT }) });
    try {
      paths = [];
      const res = await fetch(`${url}/api/rooms`, { method: "POST", body: PNG, headers: { "content-type": "image/png", "x-access-code": CODE } });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/couldn't be checked/);
      expect(paths).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
      const [room] = built(data);
      expect(readdirSync(join(data, room))).toEqual(["log.json"]);
    } finally {
      stop(proc);
    }
  }, 30_000);

  it("three reports from different addresses hide a room; repeats from one address count once", async () => {
    const { url, proc, data } = await startServer({});
    const id = "0123456789";
    mkdirSync(join(data, id), { recursive: true });
    writeFileSync(join(data, id, "room.json"), "{}");
    writeFileSync(join(data, id, "photo.png"), PNG);
    hits = 0;
    const report = (ip: string) => fetch(`${url}/api/rooms/${id}/report`, { method: "POST", headers: { "x-forwarded-for": ip } });
    try {
      for (const ip of ["1.1.1.1", "2.2.2.2", "2.2.2.2", "1.1.1.1"]) expect((await report(ip)).status).toBe(200);
      expect((await fetch(`${url}/api/rooms/${id}`)).status).toBe(200);
      expect((await report("3.3.3.3")).status).toBe(200);
      expect((await fetch(`${url}/api/rooms/${id}`)).status).toBe(404);
      expect((await fetch(`${url}/data/${id}/photo.png`)).status).toBe(404);
      expect((await report("4.4.4.4")).status).toBe(404);
      expect(hits).toBe(0);
    } finally {
      stop(proc);
    }
  }, 30_000);
});
