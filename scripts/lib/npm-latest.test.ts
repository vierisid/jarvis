import { describe, expect, test } from "bun:test";
import {
  createNpmClient,
  resolveVersion,
  NPM_MAX_ATTEMPTS,
  NPM_RETRY_AFTER_MAX_MS,
  type NpmFetchResult,
} from "./npm-latest";

/**
 * Fake clock: `sleep` advances time instantly and records every wait, so
 * cooldown behavior is fully deterministic and the tests finish in ms.
 */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

function res(status: number, body = "{}", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

/** Build a client whose fetch pops responses (or throws Errors) off a queue. */
function clientWith(queue: Array<Response | Error>) {
  const clock = fakeClock();
  const calls: string[] = [];
  const client = createNpmClient({
    fetch: ((url: string) => {
      calls.push(url);
      const next = queue.shift();
      if (!next) throw new Error("fetch queue exhausted");
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    }) as unknown as typeof fetch,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0, // no jitter -- deterministic waits
  });
  return { client, calls, sleeps: clock.sleeps };
}

describe("fetchLatest", () => {
  test("200 resolves ok with the version", async () => {
    const { client, calls } = clientWith([res(200, JSON.stringify({ version: "1.2.3" }))]);
    const r = await client.fetchLatest("@activepieces/piece-spotify");
    expect(r).toEqual({ kind: "ok", version: "1.2.3" });
    expect(calls).toEqual(["https://registry.npmjs.org/@activepieces/piece-spotify/latest"]);
  });

  test("404 resolves not-published without retrying", async () => {
    const { client, calls } = clientWith([res(404)]);
    const r = await client.fetchLatest("@activepieces/piece-unreleased");
    expect(r).toEqual({ kind: "not-published" });
    expect(calls).toHaveLength(1);
  });

  test("persistent 429 exhausts the budget and resolves transient (not not-published)", async () => {
    const { client, calls } = clientWith(
      Array.from({ length: NPM_MAX_ATTEMPTS }, () => res(429)),
    );
    const r = await client.fetchLatest("@activepieces/piece-spotify");
    expect(r).toEqual({ kind: "transient", error: "HTTP 429" });
    expect(calls).toHaveLength(NPM_MAX_ATTEMPTS);
  });

  test("429 then 200 recovers", async () => {
    const { client } = clientWith([res(429), res(200, JSON.stringify({ version: "2.0.0" }))]);
    const r = await client.fetchLatest("@activepieces/piece-slack");
    expect(r).toEqual({ kind: "ok", version: "2.0.0" });
  });

  test("5xx then 200 recovers", async () => {
    const { client } = clientWith([res(503), res(200, JSON.stringify({ version: "3.0.0" }))]);
    const r = await client.fetchLatest("@activepieces/piece-github");
    expect(r).toEqual({ kind: "ok", version: "3.0.0" });
  });

  test("network error then 200 recovers", async () => {
    const { client } = clientWith([
      new Error("connection reset"),
      res(200, JSON.stringify({ version: "4.0.0" })),
    ]);
    const r = await client.fetchLatest("@activepieces/piece-gmail");
    expect(r).toEqual({ kind: "ok", version: "4.0.0" });
  });

  test("429 Retry-After is honoured beyond the 10s generic cap", async () => {
    const { client, sleeps } = clientWith([
      res(429, "", { "retry-after": "45" }),
      res(200, JSON.stringify({ version: "1.0.0" })),
    ]);
    await client.fetchLatest("@activepieces/piece-spotify");
    expect(Math.max(...sleeps)).toBe(45_000);
  });

  test("429 Retry-After is capped at NPM_RETRY_AFTER_MAX_MS", async () => {
    const { client, sleeps } = clientWith([
      res(429, "", { "retry-after": "600" }),
      res(200, JSON.stringify({ version: "1.0.0" })),
    ]);
    await client.fetchLatest("@activepieces/piece-spotify");
    expect(Math.max(...sleeps)).toBe(NPM_RETRY_AFTER_MAX_MS);
  });

  test("a 429 pauses subsequent requests on the same client (fleet cooldown)", async () => {
    const { client, sleeps } = clientWith([
      res(429, "", { "retry-after": "30" }),
      res(200, JSON.stringify({ version: "1.0.0" })),
      // Second package: served instantly, but only after the cooldown passed.
      res(200, JSON.stringify({ version: "2.0.0" })),
    ]);
    await client.fetchLatest("@activepieces/piece-a");
    const sleepsBefore = sleeps.length;
    const r = await client.fetchLatest("@activepieces/piece-b");
    expect(r).toEqual({ kind: "ok", version: "2.0.0" });
    // The first call's own retry sleep consumed the cooldown on the fake
    // clock, so the second call must NOT have had to wait again...
    expect(sleeps.length).toBe(sleepsBefore);
  });

  test("cooldown makes a later caller wait out the rate-limit window", async () => {
    // Piece A's LAST attempt gets a 429 with a long Retry-After: the cooldown
    // is extended but A itself never sleeps it off (no retries left). Piece B
    // must then wait the full window before its first request.
    const clock = fakeClock();
    const queues = new Map<string, Array<Response>>([
      [
        "https://registry.npmjs.org/@activepieces/piece-a/latest",
        [
          ...Array.from({ length: NPM_MAX_ATTEMPTS - 1 }, () => res(429)),
          res(429, "", { "retry-after": "30" }),
        ],
      ],
      [
        "https://registry.npmjs.org/@activepieces/piece-b/latest",
        [res(200, JSON.stringify({ version: "9.9.9" }))],
      ],
    ]);
    const requestTimes: Array<{ url: string; t: number }> = [];
    const client = createNpmClient({
      fetch: ((url: string) => {
        requestTimes.push({ url, t: clock.now() });
        return Promise.resolve(queues.get(url)!.shift()!);
      }) as unknown as typeof fetch,
      sleep: clock.sleep,
      now: clock.now,
      random: () => 0,
    });

    const a = await client.fetchLatest("@activepieces/piece-a");
    expect(a.kind).toBe("transient");
    const cooldownSetAt = clock.now();

    const b = await client.fetchLatest("@activepieces/piece-b");
    expect(b).toEqual({ kind: "ok", version: "9.9.9" });
    const bRequest = requestTimes.find((r) => r.url.includes("piece-b"))!;
    expect(bRequest.t).toBeGreaterThanOrEqual(cooldownSetAt + 30_000);
  });
});

describe("resolveVersion", () => {
  const transient: NpmFetchResult = { kind: "transient", error: "HTTP 429" };

  test("ok uses the npm version", () => {
    expect(resolveVersion({ kind: "ok", version: "1.2.3" }, "1.0.0")).toEqual({
      action: "use",
      version: "1.2.3",
    });
  });

  test("404 skips as non-transient even when a previous entry exists", () => {
    expect(resolveVersion({ kind: "not-published" }, "1.0.0")).toEqual({
      action: "skip",
      reason: "no npm release (404)",
      transient: false,
    });
  });

  // The PR #285 regression: a rate-limited run must carry the piece forward,
  // never remove it.
  test("transient failure with a previous entry carries the old version forward", () => {
    expect(resolveVersion(transient, "0.4.4")).toEqual({
      action: "carry-forward",
      version: "0.4.4",
    });
  });

  test("transient failure with no previous entry skips and is flagged transient", () => {
    const r = resolveVersion(transient, null);
    expect(r.action).toBe("skip");
    if (r.action === "skip") {
      expect(r.transient).toBe(true);
      expect(r.reason).toContain("HTTP 429");
    }
  });
});
