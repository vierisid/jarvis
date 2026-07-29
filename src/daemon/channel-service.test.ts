/**
 * Coverage for the per-channel routing helper used by the workflow
 * notifier piece. The full ChannelService class needs a live agent + STT
 * stack, so we test the routing logic directly through its public surface.
 */

import { describe, expect, test } from "bun:test";
import { ChannelService, routePerChannel, sendWithRetry, type ChannelRouterServices } from "./channel-service";
import type { ChannelAdapter, ChannelMessage } from "../comms/channels/telegram";
import { initDatabase } from "../vault/schema";
import { setSetting } from "../vault/settings";

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

  test("honors an explicit retryAfterMs beyond the per-wait cap when it fits the budget", async () => {
    // Sleeping only the capped 30s would retry inside Telegram's stated
    // penalty window and burn an attempt on a guaranteed 429.
    const adapter = new ScriptedAdapter([rateLimitError(45_000)]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep, maxDelayMs: 30_000, budgetMs: 60_000 });

    expect(res).toEqual({ ok: true, attempts: 2 });
    expect(sleeps).toEqual([45_000]);
  });

  test("caps the synthetic backoff at maxDelayMs", async () => {
    const adapter = new ScriptedAdapter([rateLimitError(), rateLimitError()]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep, baseDelayMs: 20_000, maxDelayMs: 30_000 });

    expect(res).toEqual({ ok: true, attempts: 3 });
    expect(sleeps).toEqual([20_000, 30_000]);
  });

  test("depletes the budget across attempts, counting elapsed wall-clock time", async () => {
    const adapter = new ScriptedAdapter([rateLimitError(), rateLimitError(), rateLimitError()]);
    let clock = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    };

    const res = await sendWithRetry(adapter, "user", "hi", {
      sleep,
      now: () => clock,
      baseDelayMs: 2_000,
      budgetMs: 10_000,
    });

    // Backoff wants 2s, 4s, then 8s — but after 6s of sleeping only 4s of
    // budget remains, so the third retry fails fast instead of sleeping.
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(3);
    expect(sleeps).toEqual([2_000, 4_000]);
  });

  test("retries a fetch timeout (AbortError)", async () => {
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    const adapter = new ScriptedAdapter([abortError]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep, baseDelayMs: 2_000 });

    expect(res).toEqual({ ok: true, attempts: 2 });
    expect(sleeps).toEqual([2_000]);
  });

  test("retries connection-level failures identified by error code", async () => {
    const connError = new Error("Unable to connect") as Error & { code?: string };
    connError.code = "ConnectionRefused";
    const adapter = new ScriptedAdapter([connError]);
    const { sleeps, sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "hi", { sleep, baseDelayMs: 2_000 });

    expect(res).toEqual({ ok: true, attempts: 2 });
    expect(sleeps).toEqual([2_000]);
  });

  test("resumes from the error's remainingText instead of resending sent chunks", async () => {
    class ResumeAdapter {
      name = "resume";
      public sent: string[] = [];
      private calls = 0;
      async sendMessage(_to: string, text: string): Promise<void> {
        this.calls++;
        if (this.calls === 1) {
          const err = rateLimitError() as Error & { remainingText?: string };
          err.remainingText = "tail";
          throw err;
        }
        this.sent.push(text);
      }
    }
    const adapter = new ResumeAdapter();
    const { sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "head-and-tail", { sleep });

    expect(res).toEqual({ ok: true, attempts: 2 });
    expect(adapter.sent).toEqual(["tail"]);
  });

  test("resends the full text when the error carries no remainingText", async () => {
    class RecordingAdapter {
      name = "recording";
      public sent: string[] = [];
      private failures = 1;
      async sendMessage(_to: string, text: string): Promise<void> {
        if (this.failures-- > 0) throw rateLimitError();
        this.sent.push(text);
      }
    }
    const adapter = new RecordingAdapter();
    const { sleep } = makeSleepRecorder();

    const res = await sendWithRetry(adapter, "user", "full message", { sleep });

    expect(res).toEqual({ ok: true, attempts: 2 });
    expect(adapter.sent).toEqual(["full message"]);
  });
});

describe("stop() drops adapters (settings hot reload restart-in-place)", () => {
  test("a disabled channel's adapter does not survive a stop/start cycle", async () => {
    initDatabase(":memory:");
    const svc = new ChannelService({} as never, {} as never);
    const adapter = new FakeAdapter({ connected: true });
    svc.getManager().register(adapter);

    await svc.stop();

    // Regression: stop() used to only disconnect, so connectAll() in the
    // next start() reconnected the stale adapter even though the channel
    // was disabled in the fresh config.
    expect(adapter.isConnected()).toBe(false);
    expect(svc.getManager().listChannels()).toEqual([]);

    // start() with a config that enables no channels stays empty.
    await svc.start();
    expect(svc.getManager().listChannels()).toEqual([]);
  });
});

describe("delivery failure handler", () => {
  function makeService(adapter: ChannelAdapter): ChannelService {
    // Constructor only stores deps and creates the manager; the live
    // agent/STT stack is needed only by start(), which we don't call.
    const svc = new ChannelService({} as never, {} as never);
    svc.getManager().register(adapter);
    return svc;
  }

  test("broadcastToAll notifies the handler when a channel exhausts its retries", async () => {
    // broadcastToAll needs a last-known recipient, which is only loaded from
    // the settings table during start() — seed it through an in-memory vault.
    initDatabase(":memory:");
    setSetting("channel.lastRecipient.fake", "user-1");
    const svc = new ChannelService({} as never, {} as never);
    await svc.start();
    const failing = new FakeAdapter({
      connected: true,
      throwOnSend: new Error("Telegram API error: Bad Request: chat not found"),
    });
    svc.getManager().register(failing);
    const failures: Array<{ channel: string; attempts: number; error: string }> = [];
    svc.setDeliveryFailureHandler((f) => failures.push(f));

    await svc.broadcastToAll("hi");

    expect(failures).toEqual([
      { channel: "fake", attempts: 1, error: "Telegram API error: Bad Request: chat not found" },
    ]);
  });

  test("notifies the handler when a send exhausts its retries", async () => {
    const failing = new FakeAdapter({
      connected: true,
      throwOnSend: new Error("Telegram API error: Bad Request: chat not found"),
    });
    const svc = makeService(failing);
    const failures: Array<{ channel: string; attempts: number; error: string }> = [];
    svc.setDeliveryFailureHandler((f) => failures.push(f));

    await svc.sendToChannel("fake", "user", "hi");

    expect(failures).toEqual([
      { channel: "fake", attempts: 1, error: "Telegram API error: Bad Request: chat not found" },
    ]);
  });

  test("does not notify the handler on success", async () => {
    const healthy = new FakeAdapter({ connected: true });
    const svc = makeService(healthy);
    const failures: unknown[] = [];
    svc.setDeliveryFailureHandler((f) => failures.push(f));

    await svc.sendToChannel("fake", "user", "hi");

    expect(failures).toEqual([]);
    expect(healthy.sent).toEqual([{ to: "user", text: "hi" }]);
  });

  test("a throwing handler does not break the send path", async () => {
    const failing = new FakeAdapter({
      connected: true,
      throwOnSend: new Error("Telegram API error: Bad Request: chat not found"),
    });
    const svc = makeService(failing);
    svc.setDeliveryFailureHandler(() => {
      throw new Error("handler boom");
    });

    await expect(svc.sendToChannel("fake", "user", "hi")).resolves.toBeUndefined();
  });
});
