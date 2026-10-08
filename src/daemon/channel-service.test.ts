/**
 * Coverage for the per-channel routing helper used by the workflow
 * notifier piece. The full ChannelService class needs a live agent + STT
 * stack, so we test the routing logic directly through its public surface.
 */

import { describe, expect, test } from "bun:test";
import { ChannelService, channelDecisionCommand, channelDecisionNeedsAllowList, isPrivateChat, parsePersistedRecipient, routePerChannel, sendWithRetry, type ChannelRouterServices } from "./channel-service";
import type { ChannelAdapter, ChannelMessage } from "../comms/channels/telegram";
import { initDatabase } from "../vault/schema";
import { getSetting, setSetting } from "../vault/settings";

class FakeAdapter implements ChannelAdapter {
  name: string;
  private connected: boolean;
  private throwOnSend: Error | null;
  public sent: Array<{ to: string; text: string }> = [];

  constructor(opts: { connected: boolean; throwOnSend?: Error; name?: string }) {
    this.connected = opts.connected;
    this.throwOnSend = opts.throwOnSend ?? null;
    this.name = opts.name ?? "fake";
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

/**
 * A config whose channels have these allow-lists and nothing else. start()
 * registers no adapter for it (no channel is enabled), so tests register
 * their own fakes under the channel's name.
 */
function allowListConfig(lists: { telegram?: number[]; discord?: string[] }): never {
  return {
    channels: {
      telegram: { enabled: false, bot_token: "", allowed_users: lists.telegram ?? [] },
      discord: { enabled: false, bot_token: "", allowed_users: lists.discord ?? [] },
    },
  } as never;
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
    // Since #852 it must also be a user the channel's allow-list names.
    initDatabase(":memory:");
    setSetting("channel.lastRecipient.discord", JSON.stringify({ to: "c1", userId: "u1" }));
    const svc = new ChannelService(allowListConfig({ discord: ["u1"] }), {} as never);
    await svc.start();
    const failing = new FakeAdapter({
      connected: true,
      name: "discord",
      throwOnSend: new Error("Telegram API error: Bad Request: chat not found"),
    });
    svc.getManager().register(failing);
    const failures: Array<{ channel: string; attempts: number; error: string }> = [];
    svc.setDeliveryFailureHandler((f) => failures.push(f));

    await svc.broadcastToAll("hi");

    expect(failures).toEqual([
      { channel: "discord", attempts: 1, error: "Telegram API error: Bad Request: chat not found" },
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

/**
 * #718. The approval card asks for literal text; that has to reach the
 * adapter on the first attempt and on every retry.
 */
describe("#718: send options reach the adapter", () => {
  class OptionsAdapter {
    name = "discord";
    public calls: unknown[][] = [];
    constructor(private failures = 1) {}
    isConnected() { return true; }
    async sendMessage(...args: unknown[]): Promise<void> {
      this.calls.push(args);
      if (this.failures-- > 0) throw rateLimitError();
    }
  }

  test("sendWithRetry passes them on every attempt, and passes nothing when given none", async () => {
    const adapter = new OptionsAdapter();
    const { sleep } = makeSleepRecorder();
    await sendWithRetry(adapter, "user", "card", { sleep, send: { literal: true } });
    expect(adapter.calls).toEqual([["user", "card", { literal: true }], ["user", "card", { literal: true }]]);

    const plain = new OptionsAdapter();
    await sendWithRetry(plain, "user", "hi", { sleep });
    expect(plain.calls).toEqual([["user", "hi"], ["user", "hi"]]);
  });

  test("broadcastToAll hands them to each channel", async () => {
    initDatabase(":memory:");
    setSetting("channel.lastRecipient.discord", JSON.stringify({ to: "user-1", userId: "u1" }));
    const svc = new ChannelService(allowListConfig({ discord: ["u1"] }), {} as never);
    await svc.start();
    const adapter = new OptionsAdapter(0);
    svc.getManager().register(adapter as unknown as ChannelAdapter);

    await svc.broadcastToAll("card", { literal: true });

    expect(adapter.calls).toEqual([["user-1", "card", { literal: true }]]);
  });
});

/**
 * #811. An empty allow-list lets anyone chat, and nobody decide an approval.
 */
describe("#811: an approve or deny needs a sender the allow-list names", () => {
  const message = (text: string, senderAllowListed?: boolean): ChannelMessage => ({
    id: "m1", channel: "discord", from: "someone", text, timestamp: 0,
    metadata: { channelId: "c1" },
    ...(senderAllowListed === undefined ? {} : { senderAllowListed }),
  });
  const setup = () => {
    initDatabase(":memory:");
    const decisions: unknown[][] = [];
    const chats: string[] = [];
    const agent = { handleMessage: async (text: string) => { chats.push(text); return "chat reply"; } };
    const svc = new ChannelService({} as never, agent as never);
    svc.setApprovalHandler(async (...args) => { decisions.push(args); return "decided"; });
    const handle = (msg: ChannelMessage) =>
      (svc as unknown as { handleChannelMessage(m: ChannelMessage): Promise<string> }).handleChannelMessage(msg);
    return { decisions, chats, handle };
  };

  test("a sender let in by an empty list cannot approve or deny, and the reply says why", async () => {
    const { decisions, chats, handle } = setup();
    for (const allowListed of [false, undefined]) {
      expect(await handle(message("approve 1a2b3c4d", allowListed))).toBe(channelDecisionNeedsAllowList("discord"));
      expect(await handle(message("deny 1a2b3c4d", allowListed))).toBe(channelDecisionNeedsAllowList("discord"));
    }
    expect(decisions).toEqual([]);
    // Refused outright, not handed to the agent as chat either.
    expect(chats).toEqual([]);
  });

  test("a sender the list names decides as before", async () => {
    const { decisions, handle } = setup();
    expect(await handle(message("approve 1a2b3c4d", true))).toBe("decided");
    expect(decisions).toEqual([["approve", "1a2b3c4d", "discord"]]);
  });

  test("ordinary chat from the same sender still works", async () => {
    const { decisions, chats, handle } = setup();
    expect(await handle(message("what is on my calendar", false))).toBe("chat reply");
    expect(chats).toEqual(["what is on my calendar"]);
    expect(decisions).toEqual([]);
  });
});

/**
 * #810. The id is the whole word after the verb. It used to be the longest
 * hex run at the start of it, so ordinary English named an id.
 */
describe("#810: channelDecisionCommand", () => {
  test("ordinary sentences no longer carry a one-letter id", () => {
    // Each of these used to parse, with the id shown, and decide whichever
    // pending request first started with it.
    for (const text of ["approve all of them", "Approve anything you like", "deny deadline extension", "approve everything"]) {
      expect(channelDecisionCommand(text)).toBeNull();
    }
  });

  test("a whole hex word is an id attempt, whatever its length, so a short one is refused rather than chatted", () => {
    expect(channelDecisionCommand("approve a")).toEqual({ action: "approve", shortId: "a" });
    expect(channelDecisionCommand("deny add")).toEqual({ action: "deny", shortId: "add" });
  });

  test("the card's reply still parses, with case, outer space, punctuation and trailing words", () => {
    expect(channelDecisionCommand("approve 1a2b3c4d")).toEqual({ action: "approve", shortId: "1a2b3c4d" });
    expect(channelDecisionCommand("  APPROVE 1A2B3C4D.  ")).toEqual({ action: "approve", shortId: "1a2b3c4d" });
    expect(channelDecisionCommand("deny 1a2b3c4d please")).toEqual({ action: "deny", shortId: "1a2b3c4d" });
  });

  test("a long run of punctuation costs nothing to parse (#810 review)", () => {
    // Measured: the old `/[.,;:!?]+$/` took 1851ms on this input, the scan 0.002ms.
    const t0 = performance.now();
    expect(channelDecisionCommand(`approve ${".".repeat(65_536)}x`)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(50);
  });

  test("anything else is chat", () => {
    expect(channelDecisionCommand("approve the email")).toBeNull();
    expect(channelDecisionCommand("approved 1a2b3c4d")).toBeNull();
    expect(channelDecisionCommand("please approve 1a2b3c4d")).toBeNull();
    expect(channelDecisionCommand("approve")).toBeNull();
  });
});

/**
 * #852. The broadcast recipient was saved for every sender before any
 * allow-list check, so with an empty list whoever messaged last received
 * every approval card.
 */
describe("#852: only a sender the allow-list names becomes the broadcast recipient", () => {
  const msg = (channel: "telegram" | "discord", userId: string | number, chat: string, senderAllowListed: boolean, inPrivate = true): ChannelMessage => ({
    id: "m", channel, from: "someone", text: "hello", timestamp: 0,
    metadata: channel === "telegram"
      ? { chatId: chat, userId, chatType: inPrivate ? "private" : "supergroup" }
      : { channelId: chat, userId, isDM: inPrivate, guildId: inPrivate ? null : "g1" },
    senderAllowListed,
  });
  type LiveConfig = { channels: { telegram: { allowed_users: number[] }; discord: { allowed_users: string[] } } };
  const setup = async (lists: { telegram?: number[]; discord?: string[] }) => {
    const config = allowListConfig(lists) as unknown as LiveConfig;
    const agent = { handleMessage: async () => "chat reply" };
    const svc = new ChannelService(config as never, agent as never);
    await svc.start();
    const telegram = new FakeAdapter({ connected: true, name: "telegram" });
    const discord = new FakeAdapter({ connected: true, name: "discord" });
    svc.getManager().register(telegram);
    svc.getManager().register(discord);
    const handle = (m: ChannelMessage) =>
      (svc as unknown as { handleChannelMessage(m: ChannelMessage): Promise<string> }).handleChannelMessage(m);
    return { svc, config, telegram, discord, handle };
  };

  test("with an empty list, a stranger who messages gets a reply but no approval card, and nothing is saved", async () => {
    initDatabase(":memory:");
    const { svc, telegram, discord, handle } = await setup({});
    expect(await handle(msg("telegram", 999, "999", false))).toBe("chat reply");
    expect(await handle(msg("discord", "stranger", "guild-channel", false))).toBe("chat reply");

    await svc.broadcastToAll("approval card", { literal: true });

    expect(telegram.sent).toEqual([]);
    expect(discord.sent).toEqual([]);
    expect(svc.getBroadcastRecipient("telegram")).toBeNull();
    expect(svc.getBroadcastRecipient("discord")).toBeNull();
    expect(getSetting("channel.lastRecipient.telegram")).toBeNull();
    expect(getSetting("channel.lastRecipient.discord")).toBeNull();
  });

  test("a listed sender becomes the recipient, and an unlisted one after them does not take it over", async () => {
    initDatabase(":memory:");
    const { svc, discord, handle } = await setup({ discord: ["owner"] });
    await handle(msg("discord", "owner", "owner-dm", true));
    await handle(msg("discord", "stranger", "stranger-dm", false));

    await svc.broadcastToAll("approval card");

    expect(discord.sent).toEqual([{ to: "owner-dm", text: "approval card" }]);
    expect(JSON.parse(getSetting("channel.lastRecipient.discord")!)).toEqual({ to: "owner-dm", userId: "owner" });
  });

  test("removing the recipient from the list stops their copies at once, with no restart", async () => {
    initDatabase(":memory:");
    const { svc, config, telegram, handle } = await setup({ telegram: [42] });
    await handle(msg("telegram", 42, "42", true));
    await svc.broadcastToAll("first");
    expect(telegram.sent).toEqual([{ to: "42", text: "first" }]);

    config.channels.telegram.allowed_users = [];
    await svc.broadcastToAll("second");
    expect(telegram.sent).toEqual([{ to: "42", text: "first" }]);
    const routed = await svc.tryBroadcastToChannels(["telegram"], "third");
    expect(routed.delivered).toEqual([]);
    expect(routed.failed[0]?.error).toMatch(/no known recipient/);
    expect(svc.getBroadcastRecipient("telegram")).toBeNull();
  });

  test("#852 review: a listed user writing in a group or server channel does not send the cards there", async () => {
    initDatabase(":memory:");
    const { svc, telegram, discord, handle } = await setup({ telegram: [42], discord: ["owner"] });
    await handle(msg("telegram", 42, "42", true));
    await handle(msg("discord", "owner", "owner-dm", true));
    // Then the same users write in a group and a guild channel.
    expect(await handle(msg("telegram", 42, "-100123", true, false))).toBe("chat reply");
    expect(await handle(msg("discord", "owner", "guild-channel", true, false))).toBe("chat reply");

    await svc.broadcastToAll("approval card");

    expect(telegram.sent).toEqual([{ to: "42", text: "approval card" }]);
    expect(discord.sent).toEqual([{ to: "owner-dm", text: "approval card" }]);
  });

  test("#852 review: with only group messages, there is no recipient at all", async () => {
    initDatabase(":memory:");
    const { svc, telegram, handle } = await setup({ telegram: [42] });
    await handle(msg("telegram", 42, "-100123", true, false));
    await svc.broadcastToAll("approval card");
    expect(telegram.sent).toEqual([]);
    expect(getSetting("channel.lastRecipient.telegram")).toBeNull();
  });

  test("isPrivateChat reads each channel's own marker, and anything unknown is not private", () => {
    const m = (channel: string, metadata: Record<string, unknown>) => isPrivateChat({ channel, metadata });
    expect(m("telegram", { chatType: "private" })).toBe(true);
    for (const chatType of ["group", "supergroup", "channel", undefined]) expect(m("telegram", { chatType })).toBe(false);
    expect(m("discord", { isDM: true })).toBe(true);
    expect(m("discord", { isDM: false })).toBe(false);
    expect(m("discord", {})).toBe(false);
    expect(m("fake", { chatType: "private", isDM: true })).toBe(false);
  });

  test("a stranger saved by an older version is not restored on an empty-list channel", async () => {
    initDatabase(":memory:");
    // Bare chat ids are what the old code saved for whoever messaged last.
    setSetting("channel.lastRecipient.telegram", "999");
    setSetting("channel.lastRecipient.discord", "guild-channel");
    const { svc, telegram, discord } = await setup({});

    await svc.broadcastToAll("approval card");

    expect(telegram.sent).toEqual([]);
    expect(discord.sent).toEqual([]);
  });

  test("an older bare Telegram private-chat id is kept for that user while the list names them", async () => {
    initDatabase(":memory:");
    setSetting("channel.lastRecipient.telegram", "42");
    // A Discord channel id names no user, so it cannot be checked and is dropped.
    setSetting("channel.lastRecipient.discord", "owner-dm");
    const { svc, telegram, discord } = await setup({ telegram: [42], discord: ["owner"] });

    await svc.broadcastToAll("approval card");

    expect(telegram.sent).toEqual([{ to: "42", text: "approval card" }]);
    expect(discord.sent).toEqual([]);
  });
});

describe("#852: parsePersistedRecipient", () => {
  test("reads the current form, and keeps an older value only when it names its sender", () => {
    expect(parsePersistedRecipient("discord", JSON.stringify({ to: "c", userId: "u" }))).toEqual({ to: "c", userId: "u" });
    expect(parsePersistedRecipient("telegram", "42")).toEqual({ to: "42", userId: "42" });
    // A group chat (negative id), a Discord channel, or junk names nobody.
    expect(parsePersistedRecipient("telegram", "-100123")).toBeNull();
    expect(parsePersistedRecipient("discord", "123456789")).toBeNull();
    expect(parsePersistedRecipient("telegram", JSON.stringify({ to: "42" }))).toBeNull();
    expect(parsePersistedRecipient("telegram", JSON.stringify({ to: "", userId: "42" }))).toBeNull();
    expect(parsePersistedRecipient("telegram", "null")).toBeNull();
  });
});
