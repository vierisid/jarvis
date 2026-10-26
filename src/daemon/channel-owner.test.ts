/**
 * #916. A channel's approval cards followed whoever sent the bot the last
 * direct message, so with `allowed_users: [owner, spouse]` the spouse took
 * over every card by saying hello, and could approve or deny the owner's
 * gated actions. The owner is now the FIRST entry of the list (owner decision
 * for #909/#916): cards go only to the owner's private chat, and only the
 * owner may decide from the channel.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChannelService, channelDecisionNotOwner, recipientWarning } from "./channel-service";
import type { ChannelAdapter, ChannelMessage } from "../comms/channels/telegram";
import { channelOwnerId } from "../comms/channels/allow-list";
import { closeDb, initDatabase } from "../vault/schema";
import { getSetting, setSetting } from "../vault/settings";

const OWNER = "100000000000000002";
const SPOUSE = "100000000000000004";

class FakeAdapter implements ChannelAdapter {
  sent: Array<{ to: string; text: string }> = [];
  constructor(public name: string) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendMessage(to: string, text: string): Promise<void> { this.sent.push({ to, text }); }
  onMessage(): void {}
  isConnected(): boolean { return true; }
}

type Lists = { telegram: unknown[]; discord: unknown[] };

function setup(lists: Partial<Lists>) {
  const config = {
    channels: {
      telegram: { enabled: false, bot_token: "", allowed_users: lists.telegram ?? [] },
      discord: { enabled: false, bot_token: "", allowed_users: lists.discord ?? [] },
    },
  };
  const decisions: unknown[][] = [];
  const chats: string[] = [];
  const agent = { handleThreadMessage: async (text: string) => { chats.push(text); return "chat reply"; } };
  const svc = new ChannelService(config as never, agent as never);
  svc.setApprovalHandler(async (...args) => { decisions.push(args); return "decided"; });
  const telegram = new FakeAdapter("telegram");
  const discord = new FakeAdapter("discord");
  svc.getManager().register(telegram);
  svc.getManager().register(discord);
  const handle = (m: ChannelMessage) =>
    (svc as unknown as { handleChannelMessage(m: ChannelMessage): Promise<string> }).handleChannelMessage(m);
  return { svc, config, decisions, chats, telegram, discord, handle };
}

const tg = (userId: number, text = "hello", chatType = "private"): ChannelMessage => ({
  id: "m", channel: "telegram", from: "someone", text, timestamp: 0,
  metadata: { chatId: chatType === "private" ? userId : -100123, userId, chatType },
  senderAllowListed: true,
});
const dc = (userId: string, dm: string, text = "hello"): ChannelMessage => ({
  id: "m", channel: "discord", from: "someone", text, timestamp: 0,
  metadata: { channelId: dm, userId, isDM: true },
  senderAllowListed: true,
});

describe("#916: approval cards go to the channel's owner, the first allowed ID", () => {
  beforeEach(() => initDatabase(":memory:"));
  afterEach(() => closeDb());

  test("another listed user's direct message does not take the owner's cards over", async () => {
    const { svc, telegram, discord, handle } = setup({ telegram: [42, 7], discord: [OWNER, SPOUSE] });
    await handle(tg(42));
    await handle(dc(OWNER, "owner-dm"));
    // The spouse writes last, on both channels.
    expect(await handle(tg(7))).toBe("chat reply");
    expect(await handle(dc(SPOUSE, "spouse-dm"))).toBe("chat reply");

    await svc.broadcastToAll("approval card", { literal: true }, { approvalCard: true });

    expect(telegram.sent).toEqual([{ to: "42", text: "approval card" }]);
    expect(discord.sent).toEqual([{ to: "owner-dm", text: "approval card" }]);
    expect(JSON.parse(getSetting("channel.lastRecipient.discord")!)).toEqual({ to: "owner-dm", userId: OWNER });
    // Workflow notifications follow the same recipient.
    const routed = await svc.tryBroadcastToChannels(["telegram"], "workflow done");
    expect(routed.delivered).toEqual(["telegram"]);
    expect(telegram.sent.at(-1)).toEqual({ to: "42", text: "workflow done" });
  });

  test("until the owner has messaged the bot there is no recipient, and the status says the owner must", async () => {
    const { svc, telegram, handle } = setup({ telegram: [42, 7] });
    await handle(tg(7));
    await svc.broadcastToAll("approval card");
    expect(telegram.sent).toEqual([]);
    expect(svc.getBroadcastRecipient("telegram")).toBeNull();
    expect(getSetting("channel.lastRecipient.telegram")).toBeNull();
    expect(svc.getRecipientStatus().telegram).toEqual({ hasRecipient: false, reason: "no_direct_message" });

    await handle(tg(42));
    expect(svc.getRecipientStatus().telegram).toEqual({ hasRecipient: true });
    await svc.broadcastToAll("approval card");
    expect(telegram.sent).toEqual([{ to: "42", text: "approval card" }]);
  });

  test("a recipient an older version saved for another listed user is not used", async () => {
    setSetting("channel.lastRecipient.telegram", JSON.stringify({ to: "7", userId: "7" }));
    setSetting("channel.lastRecipient.discord", JSON.stringify({ to: "spouse-dm", userId: SPOUSE }));
    const { svc, telegram, discord } = setup({ telegram: [42, 7], discord: [OWNER, SPOUSE] });
    await svc.start();
    await svc.broadcastToAll("approval card");
    expect(telegram.sent).toEqual([]);
    expect(discord.sent).toEqual([]);
    await svc.stop();
  });

  test("an older saved recipient that IS the owner keeps working, so a one-user install changes nothing", async () => {
    setSetting("channel.lastRecipient.telegram", JSON.stringify({ to: "42", userId: "42" }));
    const { svc, telegram } = setup({ telegram: [42, 7] });
    await svc.start();
    await svc.broadcastToAll("approval card");
    expect(telegram.sent).toEqual([{ to: "42", text: "approval card" }]);
    await svc.stop();
  });

  test("moving another ID to the front makes it the owner at once: the old owner's copies stop", async () => {
    const { svc, config, telegram, handle } = setup({ telegram: [42, 7] });
    await handle(tg(42));
    config.channels.telegram.allowed_users = [7, 42];
    await svc.broadcastToAll("approval card");
    expect(telegram.sent).toEqual([]);
    expect(svc.getRecipientStatus().telegram).toEqual({ hasRecipient: false, reason: "no_direct_message" });
    await handle(tg(7));
    await svc.broadcastToAll("approval card");
    expect(telegram.sent).toEqual([{ to: "7", text: "approval card" }]);
  });

  test("a first entry that is not a valid ID makes nobody the owner; the second does not inherit it", async () => {
    const { svc, decisions, telegram, handle } = setup({ telegram: ["42", 7] });
    await handle(tg(7));
    expect(await handle(tg(7, "approve 1a2b3c4d"))).toBe(channelDecisionNotOwner("telegram"));
    expect(decisions).toEqual([]);
    await svc.broadcastToAll("approval card");
    expect(telegram.sent).toEqual([]);
    expect(svc.getRecipientStatus().telegram).toEqual({ hasRecipient: false, reason: "no_owner" });
  });

  test("the owner writing in a group does not move the cards there", async () => {
    const { svc, telegram, handle } = setup({ telegram: [42, 7] });
    await handle(tg(42, "hello", "supergroup"));
    await svc.broadcastToAll("approval card");
    expect(telegram.sent).toEqual([]);
  });
});

describe("#916: only the owner may approve or deny from the channel", () => {
  beforeEach(() => initDatabase(":memory:"));
  afterEach(() => closeDb());

  test("another listed user's approve or deny is refused, says why, and is not chat either", async () => {
    const { decisions, chats, handle } = setup({ telegram: [42, 7], discord: [OWNER, SPOUSE] });
    expect(await handle(tg(7, "approve 1a2b3c4d"))).toBe(channelDecisionNotOwner("telegram"));
    expect(await handle(tg(7, "deny 1a2b3c4d"))).toBe(channelDecisionNotOwner("telegram"));
    expect(await handle(dc(SPOUSE, "spouse-dm", "approve 1a2b3c4d"))).toBe(channelDecisionNotOwner("discord"));
    expect(decisions).toEqual([]);
    expect(chats).toEqual([]);
  });

  test("the owner still decides, from either channel", async () => {
    const { decisions, handle } = setup({ telegram: [42, 7], discord: [OWNER, SPOUSE] });
    expect(await handle(tg(42, "approve 1a2b3c4d"))).toBe("decided");
    expect(await handle(dc(OWNER, "owner-dm", "deny 1a2b3c4d"))).toBe("decided");
    expect(decisions).toEqual([["approve", "1a2b3c4d", "telegram"], ["deny", "1a2b3c4d", "discord"]]);
  });

  test("ordinary chat from another listed user is still answered", async () => {
    const { chats, handle } = setup({ telegram: [42, 7] });
    expect(await handle(tg(7, "what is the capital of France"))).toBe("chat reply");
    expect(chats).toEqual(["what is the capital of France"]);
  });
});

describe("#916: channelOwnerId", () => {
  test("is the first entry when it is a valid ID for the channel, and nobody otherwise", () => {
    expect(channelOwnerId("telegram", [42, 7])).toBe(42);
    expect(channelOwnerId("discord", [OWNER, SPOUSE])).toBe(OWNER);
    expect(channelOwnerId("telegram", [])).toBeNull();
    expect(channelOwnerId("telegram", undefined)).toBeNull();
    expect(channelOwnerId("telegram", "42")).toBeNull();
    // A bad first entry is not skipped over.
    expect(channelOwnerId("telegram", ["42", 7])).toBeNull();
    expect(channelOwnerId("telegram", [-5, 7])).toBeNull();
    expect(channelOwnerId("discord", [123, SPOUSE])).toBeNull();
    expect(channelOwnerId("whatsapp", ["x"])).toBeNull();
  });
});

describe("#916: recipientWarning", () => {
  test("names the owner as the one who must message the bot, and says when there is no owner", () => {
    expect(recipientWarning({ telegram: { hasRecipient: false, reason: "no_direct_message" } }))
      .toBe("Telegram will not receive approval requests or notifications until the channel's owner, the first allowed user ID, sends the bot a direct message (again, if they did before). A bot cannot start a chat with someone who has never messaged it.");
    expect(recipientWarning({ discord: { hasRecipient: false, reason: "no_owner" } }))
      .toBe("Discord will not receive approval requests or notifications: the first allowed user ID, which is the channel's owner, is not a valid ID.");
  });
});

describe("#916 review: only the owner's decision takes Telegram's decision lane", () => {
  beforeEach(() => initDatabase(":memory:"));
  afterEach(() => closeDb());

  test("another listed user's approve waits in their chat lane, so it cannot fill the owner's", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { username: "bot" } });
      await Bun.sleep(5);
      return Response.json({ ok: true, result: [] });
    }) as typeof fetch;
    const config = { channels: { telegram: { enabled: true, bot_token: "t", allowed_users: [42, 7] } } };
    const svc = new ChannelService(config as never, {} as never);
    svc.setApprovalHandler(async () => "decided");
    try {
      await svc.start();
      const adapter = (svc as unknown as { telegram: { adapter: { isDecision: (text: string, userId: number) => boolean } } }).telegram.adapter;
      expect(adapter.isDecision("approve 1a2b3c4d", 42)).toBe(true);
      expect(adapter.isDecision("approve 1a2b3c4d", 7)).toBe(false);
      expect(adapter.isDecision("hello", 42)).toBe(false);
      // Read against the live list: a reorder moves the lane with the owner.
      config.channels.telegram.allowed_users = [7, 42];
      expect(adapter.isDecision("approve 1a2b3c4d", 7)).toBe(true);
      expect(adapter.isDecision("approve 1a2b3c4d", 42)).toBe(false);
    } finally {
      await svc.stop();
      globalThis.fetch = originalFetch;
    }
  });
});
