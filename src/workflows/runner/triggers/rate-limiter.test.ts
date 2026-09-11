import { test, expect, describe } from "bun:test";
import { KeyedRateLimiter } from "./rate-limiter.ts";
import { WebhookManager, WEBHOOK_MAX_BODY_BYTES } from "./webhook.ts";

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("KeyedRateLimiter", () => {
  test("allows up to the budget per key per window, then refuses", () => {
    let t = 0;
    const rl = new KeyedRateLimiter(1000, 3, () => t);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
    expect(rl.allow("b")).toBe(true); // independent key
    expect(rl.retryAfterSeconds("a")).toBe(1);
    t = 1001;
    expect(rl.allow("a")).toBe(true); // window slid
  });

  test("check does not charge; record does", () => {
    const rl = new KeyedRateLimiter(1000, 1, () => 0);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(true);
    rl.record("k");
    expect(rl.check("k")).toBe(false);
  });

  test("retryAfterSeconds reports when the refusing key regains capacity", () => {
    let t = 0;
    const rl = new KeyedRateLimiter(60_000, 1, () => t);
    rl.record("k");
    t = 55_000;
    expect(rl.retryAfterSeconds("k")).toBe(5);
  });
});

describe("WebhookManager rate limiting", () => {
  const post = (wm: WebhookManager, id: string, init: RequestInit = {}) =>
    wm.handleRequest(id, new Request(`http://x/api/webhooks/${id}`, { method: "POST", body: "{}", ...init }));

  test("returns 429 with Retry-After once a flow exceeds its budget, without firing", async () => {
    const wm = new WebhookManager();
    let t = 0;
    wm.setRateLimiters(new KeyedRateLimiter(60_000, 2, () => t), new KeyedRateLimiter(60_000, 100, () => t));
    wm.register("flow1");
    const fired: string[] = [];
    wm.setTriggerCallback((id) => { fired.push(id); });

    expect((await post(wm, "flow1")).status).toBe(200);
    expect((await post(wm, "flow1")).status).toBe(200);
    const limited = await post(wm, "flow1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(fired.length).toBe(2);
  });

  test("Retry-After comes from the budget that refused, and a refusal charges nothing", async () => {
    let t = 0;
    const perFlow = new KeyedRateLimiter(60_000, 100, () => t);
    const global = new KeyedRateLimiter(60_000, 1, () => t);
    const wm = new WebhookManager();
    wm.setRateLimiters(perFlow, global);
    wm.register("a");
    wm.register("b");
    expect((await post(wm, "a")).status).toBe(200);
    t = 55_000; // global's one hit leaves the window in 5s
    const res = await post(wm, "b");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    // b's per-flow budget was not charged by the refused attempt.
    expect(perFlow.check("b")).toBe(true);
  });

  test("unsigned junk to a secret-protected flow cannot exhaust the signed sender's budget", async () => {
    let t = 0;
    const wm = new WebhookManager();
    wm.setRateLimiters(
      new KeyedRateLimiter(60_000, 2, () => t),
      new KeyedRateLimiter(60_000, 100, () => t),
      new KeyedRateLimiter(60_000, 3, () => t),
    );
    wm.register("sec", "s3cret");
    const fired: string[] = [];
    wm.setTriggerCallback((id) => { fired.push(id); });

    // Three unsigned requests: 401 each, then the bad-signature budget is spent.
    for (let i = 0; i < 3; i++) expect((await post(wm, "sec")).status).toBe(401);
    expect((await post(wm, "sec")).status).toBe(429);

    // The legitimate signed sender still has its full budget.
    const body = JSON.stringify({ hello: "world" });
    const sig = await hmacHex("s3cret", body);
    const signed = () => post(wm, "sec", { body, headers: { "X-Jarvis-Signature": sig } });
    expect((await signed()).status).toBe(200);
    expect((await signed()).status).toBe(200);
    expect((await signed()).status).toBe(429);
    expect(fired.length).toBe(2);
  });

  test("a backed-up queue answers 503 with Retry-After instead of ok", async () => {
    const wm = new WebhookManager();
    wm.register("flow1");
    const fired: string[] = [];
    wm.setTriggerCallback((id) => { fired.push(id); });
    wm.setCapacityCheck(() => false);
    const res = await post(wm, "flow1");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(fired.length).toBe(0);
    wm.setCapacityCheck(() => true);
    expect((await post(wm, "flow1")).status).toBe(200);
  });

  test("oversized bodies are refused with 413 before anything is queued", async () => {
    const wm = new WebhookManager();
    wm.register("flow1");
    const fired: string[] = [];
    wm.setTriggerCallback((id) => { fired.push(id); });
    const declared = await wm.handleRequest("flow1", new Request("http://x/", {
      method: "POST", body: "{}", headers: { "Content-Length": String(WEBHOOK_MAX_BODY_BYTES + 1) },
    }));
    expect(declared.status).toBe(413);
    const actual = await wm.handleRequest("flow1", new Request("http://x/", {
      method: "POST", body: "x".repeat(WEBHOOK_MAX_BODY_BYTES + 1),
    }));
    expect(actual.status).toBe(413);
    expect(fired.length).toBe(0);
  });

  test("a malformed signature is refused without firing", async () => {
    const wm = new WebhookManager();
    wm.register("sec", "s3cret");
    const fired: string[] = [];
    wm.setTriggerCallback((id) => { fired.push(id); });
    const res = await wm.handleRequest("sec", new Request("http://x/", {
      method: "POST", body: "{}", headers: { "X-Jarvis-Signature": "not-hex" },
    }));
    expect(res.status).toBe(401);
    expect(fired.length).toBe(0);
  });

  test("unknown flows are 404 before any budget is spent", async () => {
    const wm = new WebhookManager();
    const res = await wm.handleRequest("nope", new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(404);
  });
});
