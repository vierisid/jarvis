/**
 * Coverage for the per-channel routing helper used by the workflow
 * notifier piece. The full ChannelService class needs a live agent + STT
 * stack, so we test the routing logic directly through its public surface.
 */

import { describe, expect, test } from "bun:test";
import { routePerChannel, sendWithRetry, type ChannelRouterServices } from "./channel-service";
import type { ChannelAdapter, ChannelMessage } from "../comms/channels/telegram";

class FakeAdapter implements ChannelAdapter {
  name = "fake";
  private connected: boolean;
  private throwOnSend: Error | null;
  public sent: Array<{ to: string; text: string }> = [];

  constructor(opts: { connected: boolean; throwOnSend?: Error }) {
    this.connected = opts.connected;
    this.throwOnSend = opts.throwOnSend ?? null;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async sendMessage(to: string, text: string): Promise<void> {
    if (this.throwOnSend) throw this.throwOnSend;
    this.sent.push({ to, text });
  }
  onMessage(_handler: (msg: ChannelMessage) => Promise<string>): void {
    // not exercised
  }
  isConnected(): boolean {
    return this.connected;
  }
}

function makeServices(opts: {
  adapters: Record<string, ChannelAdapter | null>;
  recipients: Record<string, string | null>;
}): ChannelRouterServices {
  return {
    getAdapter: (name) => opts.adapters[name] ?? null,
    getLastRecipient: (name) => opts.recipients[name] ?? null,
  };
}

describe("routePerChannel", () => {
  test("delivers to a single connected channel with a known recipient", async () => {
    const tg = new FakeAdapter({ connected: true });
    const res = await routePerChannel(["telegram"], "hi", makeServices({
      adapters: { telegram: tg },
      recipients: { telegram: "user-123" },
    }));
    expect(res.delivered).toEqual(["telegram"]);
    expect(res.failed).toEqual([]);
    expect(tg.sent).toEqual([{ to: "user-123", text: "hi" }]);
  });

  test("targets ONLY the requested channels (no fan-out)", async () => {
    // Regression for the previous broadcastToAll behavior where asking for
    // telegram delivered to every connected channel.
    const tg = new FakeAdapter({ connected: true });
    const discord = new FakeAdapter({ connected: true });
    const res = await routePerChannel(["telegram"], "private msg", makeServices({
      adapters: { telegram: tg, discord },
      recipients: { telegram: "tg-user", discord: "dc-user" },
    }));
    expect(res.delivered).toEqual(["telegram"]);
    expect(tg.sent).toHaveLength(1);
    expect(discord.sent).toEqual([]);
  });

  test("missing channel -> failed with 'not configured'", async () => {
    const res = await routePerChannel(["slack"], "hi", makeServices({
      adapters: {},
      recipients: {},
    }));
    expect(res.delivered).toEqual([]);
    expect(res.failed).toEqual([
      { channel: "slack", error: 'channel "slack" is not configured' },
    ]);
  });

  test("adapter present but offline -> failed with 'not connected'", async () => {
    const tg = new FakeAdapter({ connected: false });
    const res = await routePerChannel(["telegram"], "hi", makeServices({
      adapters: { telegram: tg },
      recipients: { telegram: "user" },
    }));
    expect(res.delivered).toEqual([]);
    expect(res.failed[0]?.error).toMatch(/not connected/);
    expect(tg.sent).toEqual([]);
  });

  test("no last-known recipient -> failed with guidance to seed it", async () => {
    const tg = new FakeAdapter({ connected: true });
    const res = await routePerChannel(["telegram"], "hi", makeServices({
      adapters: { telegram: tg },
      recipients: {},
    }));
    expect(res.delivered).toEqual([]);
    expect(res.failed[0]?.error).toMatch(/no known recipient/);
    expect(tg.sent).toEqual([]);
  });

  test("adapter throws -> failed with the exception message", async () => {
    const tg = new FakeAdapter({ connected: true, throwOnSend: new Error("rate limited") });
    const res = await routePerChannel(["telegram"], "hi", makeServices({
      adapters: { telegram: tg },
      recipients: { telegram: "user" },
    }));
    expect(res.delivered).toEqual([]);
    expect(res.failed[0]?.error).toBe("rate limited");
  });

  test("partial failure -> each channel reported independently", async () => {
    const tg = new FakeAdapter({ connected: true });
    const discord = new FakeAdapter({ connected: false }); // offline
    const res = await routePerChannel(["telegram", "discord", "slack"], "hi", makeServices({
      adapters: { telegram: tg, discord },
      recipients: { telegram: "tg-user", discord: "dc-user" },
    }));
    expect(res.delivered).toEqual(["telegram"]);
    expect(res.failed).toHaveLength(2);
    const errsByChannel = Object.fromEntries(res.failed.map((f) => [f.channel, f.error]));
    expect(errsByChannel.discord).toMatch(/not connected/);
    expect(errsByChannel.slack).toMatch(/not configured/);
  });

  test("de-dupes repeated channel names", async () => {
    const tg = new FakeAdapter({ connected: true });
    const res = await routePerChannel(["telegram", "telegram", "telegram"], "hi", makeServices({
      adapters: { telegram: tg },
      recipients: { telegram: "user" },
    }));
    expect(res.delivered).toEqual(["telegram"]);
    expect(tg.sent).toHaveLength(1);
  });
});

/** Adapter that fails with each scripted error in turn, then succeeds. */
class ScriptedAdapter {
  name = "scripted";
  public sent: Array<{ to: string; text: string }> = [];
  constructor(private failures: unknown[]) {}

  async sendMessage(to: string, text: string): Promise<void> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push({ to, text });
  }
}

function makeSleepRecorder(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

function rateLimitError(retryAfterMs?: number): Error & { retryAfterMs?: number } {
  const err = new Error("Telegram API error 429: Too Many Requests") as Error & { retryAfterMs?: number };
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}

describe("sendWithRetry", () => {
  test("first-try success makes one attempt and never sleeps", async () => {
    const adapter = new ScriptedAdapter([]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep });

    expect(res).toEqual({ ok: true, attempts: 1 });
    expect(adapter.sent).toEqual([{ to: "user", text: "hi" }]);
    expect(sleeps).toEqual([]);
  });

  test("retries transient failures with exponential backoff", async () => {
    const adapter = new ScriptedAdapter([rateLimitError(), rateLimitError()]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep, baseDelayMs: 2_000 });

    expect(res).toEqual({ ok: true, attempts: 3 });
    expect(sleeps).toEqual([2_000, 4_000]);
  });

  test("an explicit retryAfterMs larger than the backoff wins", async () => {
    const adapter = new ScriptedAdapter([rateLimitError(7_000)]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep, baseDelayMs: 2_000 });

    expect(res).toEqual({ ok: true, attempts: 2 });
    expect(sleeps).toEqual([7_000]);
  });

  test("a retryAfterMs smaller than the backoff loses to the backoff", async () => {
    const adapter = new ScriptedAdapter([rateLimitError(500)]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep, baseDelayMs: 2_000 });

    expect(res).toEqual({ ok: true, attempts: 2 });
    expect(sleeps).toEqual([2_000]);
  });

  test("non-transient errors are not retried", async () => {
    const adapter = new ScriptedAdapter([new Error("Telegram API error: Bad Request: chat not found")]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep });

    expect(res).toEqual({ ok: false, attempts: 1, error: "Telegram API error: Bad Request: chat not found" });
    expect(sleeps).toEqual([]);
    expect(adapter.sent).toEqual([]);
  });

  test("fails immediately when the provider demands a wait beyond the budget", async () => {
    const adapter = new ScriptedAdapter([rateLimitError(120_000)]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep, budgetMs: 60_000 });

    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("gives up after maxAttempts on persistent transient failure", async () => {
    const adapter = new ScriptedAdapter([
      rateLimitError(), rateLimitError(), rateLimitError(), rateLimitError(),
    ]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep, maxAttempts: 4, baseDelayMs: 2_000 });

    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(4);
    expect(sleeps).toEqual([2_000, 4_000, 8_000]);
  });

  test("caps a single wait at maxDelayMs even when retryAfterMs asks for more", async () => {
    const adapter = new ScriptedAdapter([rateLimitError(45_000)]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep, maxDelayMs: 30_000 });

    expect(res).toEqual({ ok: true, attempts: 2 });
    expect(sleeps).toEqual([30_000]);
  });
});
