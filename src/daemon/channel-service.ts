/**
 * Channel Service — External Communication Channels
 *
 * Manages Telegram, Discord (and future) channel adapters.
 * Routes all external messages through the same AgentService (same brain),
 * persists conversations to the vault, one per sender and chat (#884), and
 * handles proactive broadcasts to all connected channels.
 */

import type { Service, ServiceStatus } from './services.ts';
import type { AgentService } from './agent-service.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { ChannelAdapter, ChannelMessage, SendOptions } from '../comms/channels/telegram.ts';
import type { STTProvider } from '../comms/voice.ts';

import { ChannelManager } from '../comms/index.ts';
import { TelegramAdapter } from '../comms/channels/telegram.ts';
import { channelAllowList } from '../comms/channels/allow-list.ts';
import { createSTTProvider } from '../comms/voice.ts';
import { effectiveSttForBinding, usejarvisVoiceCredentials } from './usejarvis-ai.ts';
import { getOrCreateConversation, addMessage } from '../vault/conversations.ts';
import { getSettingsByPrefix, setSetting } from '../vault/settings.ts';
import { classifyErrorString } from '../llm/provider.ts';
import { runWithOrigin } from '../llm/origin.ts';
import { checkpointExecution } from '../actions/execution-scope.ts';

/** Settings-table key prefix for persisted per-channel broadcast recipients. */
const LAST_RECIPIENT_PREFIX = 'channel.lastRecipient.';

/**
 * Where a channel's broadcasts go, and who put them there (#852): `to` is the
 * chat the sender wrote from, `userId` the sender. Broadcasts go to `to` only
 * while the channel's allow-list names `userId` (`getBroadcastRecipient`), so
 * removing someone from the list stops their copies at once.
 */
export type BroadcastRecipient = { to: string; userId: string };

/**
 * A persisted recipient, or null when it cannot be trusted (#852).
 *
 * Current values are JSON `{to, userId}`. Older ones are the bare chat id,
 * saved for whoever messaged last -- with an empty allow-list that was any
 * stranger -- and say nothing about who sent it. One case still names its
 * sender: a Telegram private chat's id IS the user's id (a group's is
 * negative), so a bare positive Telegram id is kept as that user and is used
 * only while the list names them. Anything else is dropped, and the owner
 * seeds it again by messaging the bot once.
 */
export function parsePersistedRecipient(channel: string, value: string): BroadcastRecipient | null {
  try {
    const parsed = JSON.parse(value) as { to?: unknown; userId?: unknown } | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.to === 'string' && parsed.to
      && typeof parsed.userId === 'string' && parsed.userId) {
      return { to: parsed.to, userId: parsed.userId };
    }
  } catch {
    // not JSON: an older bare chat id, below
  }
  if (channel === 'telegram' && /^[1-9][0-9]*$/.test(value)) return { to: value, userId: value };
  return null;
}

export type ApprovalCommandHandler = (action: 'approve' | 'deny', shortId: string, channel: string) => Promise<string>;

export type DeliveryFailureHandler = (failure: { channel: string; attempts: number; error: string }) => void;

export class ChannelService implements Service {
  name = 'channels';
  private _status: ServiceStatus = 'stopped';
  private config: JarvisConfig;
  private agentService: AgentService;
  private manager: ChannelManager;
  private sttProvider: STTProvider | null = null;
  /**
   * The last allow-listed sender per channel, for proactive broadcasts and
   * notify (#852). Persisted to the settings table (see
   * {@link LAST_RECIPIENT_PREFIX}) and reloaded on start, so a daemon restart
   * doesn't drop the recipient and silently break notifications until the
   * user re-messages the bot. Read through `getBroadcastRecipient`, never
   * directly.
   */
  private lastRecipients = new Map<string, BroadcastRecipient>();
  /**
   * The last Telegram update an adapter started handling, kept across the
   * stop/start a settings save does (#882), per bot token: update ids are
   * numbered per bot, so another token starts over, and switching back to a
   * token picks up where that bot left off.
   *
   * Never the adapter's poll offset. That also counts updates an old adapter
   * fetched but left unhandled once it was disconnected (#860), which must
   * reach the new adapter so they are judged against the new allow-list.
   */
  private telegramTaken = new Map<string, number>();
  /** Handler for approval commands (approve/deny) from external channels */
  private approvalHandler: ApprovalCommandHandler | null = null;
  /** Notified when a send has exhausted its retries (e.g. to alert the dashboard). */
  private deliveryFailureHandler: DeliveryFailureHandler | null = null;

  constructor(config: JarvisConfig, agentService: AgentService) {
    this.config = config;
    this.agentService = agentService;
    this.manager = new ChannelManager();
  }

  setApprovalHandler(handler: ApprovalCommandHandler): void {
    this.approvalHandler = handler;
  }

  setDeliveryFailureHandler(handler: DeliveryFailureHandler): void {
    this.deliveryFailureHandler = handler;
  }

  private reportDeliveryFailure(channel: string, result: { attempts: number; error: string }): void {
    console.error(`[ChannelService] Failed to send to ${channel} after ${result.attempts} attempt(s): ${result.error}`);
    try {
      this.deliveryFailureHandler?.({ channel, attempts: result.attempts, error: result.error });
    } catch (err) {
      console.error('[ChannelService] Delivery failure handler threw:', err);
    }
  }

  async start(): Promise<void> {
    this._status = 'starting';

    try {
      // 0. Restore persisted broadcast recipients so notifications keep
      //    working across daemon restarts (the in-memory map alone would be
      //    empty until the user re-messages each bot).
      this.loadPersistedRecipients();

      // 1. Create STT provider if configured. The binding view (not the raw
      // user section) picks the hosted Usejarvis AI default when the user
      // never chose a provider; the proxy credentials ride as a separate
      // argument so they never touch the persisted cfg.stt.
      const sttBinding = effectiveSttForBinding(this.config);
      if (sttBinding) {
        this.sttProvider = createSTTProvider(sttBinding, usejarvisVoiceCredentials(this.config));
        if (this.sttProvider) {
          console.log(`[ChannelService] STT provider: ${sttBinding.provider}`);
        } else {
          console.log('[ChannelService] STT configured but no valid credentials — voice messages disabled');
        }
      }

      // 2. Create & register adapters from config. An empty allowed_users
      // lets anyone who can reach the bot chat, but lets nobody approve or
      // deny from that channel (#811, ChannelConfig, senderAllowListed).
      const channels = this.config.channels;

      if (channels?.telegram?.enabled && channels.telegram.bot_token) {
        warnAllowListProblems('telegram', channels.telegram.allowed_users);
        const token = channels.telegram.bot_token;
        const taken = this.telegramTaken.get(token);
        const telegram = new TelegramAdapter(token, {
          sttProvider: this.sttProvider ?? undefined,
          allowedUsers: channels.telegram.allowed_users,
          ...(taken !== undefined ? { startOffset: taken + 1 } : {}),
          onUpdateTaken: (updateId) => {
            this.telegramTaken.set(token, Math.max(updateId, this.telegramTaken.get(token) ?? 0));
          },
        });
        this.manager.register(telegram);
      }

      if (channels?.discord?.enabled && channels.discord.bot_token) {
        // Lazy-loaded: discord.js costs ~38MB RSS, only pay it when the
        // Discord channel is actually enabled.
        warnAllowListProblems('discord', channels.discord.allowed_users);
        const { DiscordAdapter } = await import('../comms/channels/discord.ts');
        const discord = new DiscordAdapter(channels.discord.bot_token, {
          sttProvider: this.sttProvider ?? undefined,
          allowedUsers: channels.discord.allowed_users,
          guildId: channels.discord.guild_id,
        });
        this.manager.register(discord);
      }

      // 3. Set unified message handler — same brain for all channels
      this.manager.setHandler(async (msg: ChannelMessage): Promise<string> => {
        return this.handleChannelMessage(msg);
      });

      // 4. Connect all registered channels (Promise.allSettled — one failure doesn't block others)
      const channelList = this.manager.listChannels();
      if (channelList.length > 0) {
        await this.manager.connectAll();
        console.log(`[ChannelService] Active channels: ${channelList.join(', ')}`);
      } else {
        console.log('[ChannelService] No channels configured — enable in Dashboard Settings or config.yaml');
      }

      this._status = 'running';
      console.log('[ChannelService] Started');
    } catch (error) {
      this._status = 'error';
      throw error;
    }
  }

  async stop(): Promise<void> {
    this._status = 'stopping';
    await this.manager.disconnectAll();
    // Drop the adapters, not just their connections: start() only registers
    // adapters for channels that are ENABLED in the current config, so a
    // stop/start cycle (settings hot reload) must not leave a stale adapter
    // for a now-disabled channel in the map — connectAll() would reconnect
    // it with the old token, allowlist, and STT provider.
    this.manager.unregisterAll();
    this._status = 'stopped';
    console.log('[ChannelService] Stopped');
  }

  status(): ServiceStatus {
    return this._status;
  }

  /** Expose manager for direct adapter access if needed */
  getManager(): ChannelManager {
    return this.manager;
  }

  /** Get connection status of all channels */
  getChannelStatus(): Record<string, boolean> {
    return this.manager.getStatus();
  }

  /**
   * Send a message to a specific channel.
   * Used for targeted proactive notifications.
   */
  async sendToChannel(channelName: string, recipientId: string, text: string): Promise<void> {
    const adapter = this.manager.getChannel(channelName);
    if (!adapter || !adapter.isConnected()) {
      console.warn(`[ChannelService] Cannot send to ${channelName}: not connected`);
      return;
    }
    const result = await sendWithRetry(adapter, recipientId, text);
    if (!result.ok) {
      this.reportDeliveryFailure(channelName, result);
    }
  }

  /**
   * Broadcast a message to ALL connected external channels.
   * Uses the last known recipient per channel (from most recent inbound message).
   */
  async broadcastToAll(text: string, options?: SendOptions): Promise<void> {
    // Channels are sent concurrently so one channel's retry backoff can't
    // delay delivery of a time-boxed message (e.g. an approval request) to
    // the others.
    const sends: Promise<void>[] = [];
    for (const name of this.manager.listChannels()) {
      const adapter = this.manager.getChannel(name);
      if (!adapter?.isConnected()) continue;

      const lastRecipient = this.getBroadcastRecipient(name);
      if (!lastRecipient) {
        console.log(`[ChannelService] No allow-listed recipient for ${name}, skipping broadcast`);
        continue;
      }

      sends.push(
        sendWithRetry(adapter, lastRecipient, text, options ? { send: options } : undefined).then((result) => {
          if (!result.ok) {
            this.reportDeliveryFailure(name, result);
          }
        }),
      );
    }
    await Promise.allSettled(sends);
  }

  /**
   * Send a message to a specific set of channels and report per-channel
   * delivery. Used by the workflow notifier piece so a flow that says
   * "deliver via telegram only" actually targets telegram, not every
   * connected adapter.
   *
   * See `routePerChannel` (below) for the routing rules; this method just
   * wires the live manager + recipients into the pure helper.
   */
  async tryBroadcastToChannels(
    channels: string[],
    text: string,
  ): Promise<{ delivered: string[]; failed: { channel: string; error: string }[] }> {
    return routePerChannel(channels, text, {
      getAdapter: (name) => this.manager.getChannel(name) ?? null,
      getLastRecipient: (name) => this.getBroadcastRecipient(name),
    });
  }

  /**
   * Where this channel's broadcasts go: the chat of the last sender the
   * allow-list named, and only while it still names them (#852). So a channel
   * with an empty list has no recipient and gets no approval card or other
   * broadcast: everyone may chat there, nobody may decide there, and a card
   * telling a stranger to "Reply with: approve <id>" helped no one. Read
   * against the live config, so removing a user from the list stops their
   * copies without a restart.
   *
   * Workflows resolve it once, before approval, and never switch to a later
   * sender.
   */
  getBroadcastRecipient(channel: string): string | null {
    const recipient = this.lastRecipients.get(channel);
    return recipient && this.allowListNames(channel, recipient.userId) ? recipient.to : null;
  }

  /**
   * Whether the channel's allow-list, as configured right now, names this
   * user. Empty names nobody, and so does an entry that is not a valid id for
   * the channel (#883): the adapters ignore those entries, and a list must not
   * name someone here whom the adapter would turn away.
   */
  private allowListNames(channel: string, userId: unknown): boolean {
    if ((typeof userId !== 'string' && typeof userId !== 'number') || userId === '') return false;
    const channels = this.config?.channels;
    const raw: unknown = channel === 'telegram' ? channels?.telegram?.allowed_users
      : channel === 'discord' ? channels?.discord?.allowed_users
        : undefined;
    const list = channelAllowList(channel, raw);
    return !!list && list.ids.some((id) => String(id) === String(userId));
  }

  /**
   * Send a workflow notification to the recipient resolved before approval
   * (`getBroadcastRecipient` in the notify step's prepare), and only while it
   * is still this channel's recipient (#860 review). The step can wait hours
   * for approval, or across a restart, and removing that user from the
   * allow-list in the meantime must stop it like every other broadcast. It is
   * not re-resolved to a later sender either: a different recipient refuses,
   * as an ordinary failed delivery the workflow reports.
   */
  async sendWorkflowNotification(channel: string, recipient: string | null, text: string): Promise<void> {
    const adapter = this.manager.getChannel(channel);
    if (!adapter?.isConnected()) throw new Error(`Channel ${channel} is unavailable`);
    if (!recipient) throw new Error(`No approved recipient for ${channel}`);
    if (this.getBroadcastRecipient(channel) !== recipient) {
      throw new Error(`The approved recipient for ${channel} is no longer an allow-listed recipient, so nothing was sent`);
    }
    // Last gate before the adapter hands the message off. The governed caller
    // installs its Authority/emergency checkpoint in the execution scope.
    checkpointExecution();
    await adapter.sendMessage(recipient, text);
  }

  /**
   * Load broadcast recipients persisted by a previous run. Keys are
   * `${LAST_RECIPIENT_PREFIX}<channel>`; only non-empty values are restored.
   */
  private loadPersistedRecipients(): void {
    try {
      const rows = getSettingsByPrefix(LAST_RECIPIENT_PREFIX);
      let restored = 0;
      for (const [key, value] of Object.entries(rows)) {
        const channel = key.slice(LAST_RECIPIENT_PREFIX.length);
        if (!channel || !value) continue;
        const recipient = parsePersistedRecipient(channel, value);
        if (!recipient) {
          console.log(`[ChannelService] Not restoring the ${channel} broadcast recipient: it was saved without its sender, so it may not be on the allow-list. Message the bot once from a listed account to set it again.`);
          continue;
        }
        this.lastRecipients.set(channel, recipient);
        restored++;
      }
      if (restored > 0) {
        console.log(`[ChannelService] Restored ${restored} broadcast recipient(s) from settings`);
      }
    } catch (err) {
      // Non-fatal: a missing/locked settings table just means recipients seed
      // fresh on the next inbound message, the pre-persistence behavior.
      console.error('[ChannelService] Failed to restore recipients:', err);
    }
  }

  /** Record a channel's broadcast recipient both in memory and on disk. */
  private recordRecipient(channelTag: string, recipient: BroadcastRecipient): void {
    this.lastRecipients.set(channelTag, recipient);
    try {
      setSetting(`${LAST_RECIPIENT_PREFIX}${channelTag}`, JSON.stringify(recipient));
    } catch (err) {
      // Persistence is best-effort; the in-memory value still works this run.
      console.error(`[ChannelService] Failed to persist recipient for ${channelTag}:`, err);
    }
  }

  /**
   * Core message handler: receives from any channel, routes to AgentService,
   * persists to vault (unified history), returns response.
   */
  private async handleChannelMessage(msg: ChannelMessage): Promise<string> {
    const channelTag = msg.channel; // 'telegram' | 'discord'

    // Track recipient for future broadcasts (in-memory + persisted), but only
    // a sender the allow-list names (#852). This ran for every sender, so with
    // an empty list whoever messaged last -- any stranger who found the bot --
    // became the channel's recipient and received every approval card, and
    // the owner stopped receiving them.
    //
    // The adapter's own answer is not enough on its own (#860): it holds the
    // list it was built with, and a Telegram adapter's long poll can deliver
    // a batch after a settings save replaced it. So the list as configured
    // right now must name the sender too, and a user removed from it can
    // neither decide nor become the recipient from that moment.
    //
    // And only from a private chat with the bot (#852 review). Where the
    // message was typed is where the cards go, so a listed user writing in a
    // Telegram group or a Discord server channel made every member of it a
    // reader of every approval card. A message there still gets its reply
    // and leaves the recipient as it was.
    const userId = msg.metadata.userId;
    const allowListed = msg.senderAllowListed === true && this.allowListNames(channelTag, userId);
    if (allowListed && isPrivateChat(msg)) {
      const to = String(msg.metadata.chatId ?? msg.metadata.channelId ?? msg.from);
      this.recordRecipient(channelTag, { to, userId: String(userId) });
    }

    // Check for approval commands: "approve <id>" or "deny <id>"
    const decision = this.approvalHandler ? channelDecisionCommand(msg.text) : null;
    if (this.approvalHandler && decision) {
      // Only someone the allow-list names may decide (#811). An empty list lets
      // anyone who can reach the bot chat -- any member of the guild on
      // Discord, anyone on Telegram -- and that must not extend to approving
      // a gated action.
      if (!allowListed) return channelDecisionNeedsAllowList(channelTag);
      try {
        return await this.approvalHandler(decision.action, decision.shortId, channelTag);
      } catch (err) {
        return `Error processing approval: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 1. Persist inbound user message to vault, in this sender's own
    //    conversation (#884). Every sender used to share the channel's one
    //    conversation, so on a channel anyone may message (an empty list,
    //    #811) a stranger could ask about the owner's earlier turns.
    const sender = conversationSender(msg);
    if (!sender) return "Sorry, I can't tell who sent this message, so I can't answer it.";
    const conversation = getOrCreateConversation(channelTag, { sender });
    addMessage(conversation.id, { role: 'user', content: msg.text });

    // 2. Route to AgentService (non-streaming — external channels are
    //    request/response), on that conversation's history alone. A sender the
    //    list does not name does not teach the agent anything either: what it
    //    learns goes into every later turn's prompt, the owner's included.
    const response = await runWithOrigin('user', () => this.agentService.handleThreadMessage(
      msg.text, channelTag, { conversationId: conversation.id, contextKey: `channel:${channelTag}:${sender}`, learn: allowListed },
    ));

    // 3. Persist assistant response to vault
    addMessage(conversation.id, { role: 'assistant', content: response });

    return response;
  }
}

/**
 * Say, at startup and after every settings save, which `allowed_users`
 * entries name nobody (#883). They are ignored, and a list made only of them
 * lets nobody in, which an owner would otherwise discover only as a bot that
 * never answers.
 */
function warnAllowListProblems(channel: string, raw: unknown): void {
  const list = channelAllowList(channel, raw);
  for (const problem of list?.problems ?? []) {
    console.warn(`[ChannelService] ${channel} allowed_users: ${problem}`);
  }
  if (list && list.restricted && list.ids.length === 0) {
    console.warn(`[ChannelService] ${channel} allowed_users names nobody, so nobody can message the bot. Fix it in Settings > Channels.`);
  }
}

/**
 * Whose conversation a channel message belongs to (#884): the sender, in the
 * chat they wrote from. Keyed by the chat too, so what someone said in a
 * private chat is not the history of a reply the bot posts in a group, where
 * every member reads it. Null when the adapter did not say who sent it, which
 * is answered without the agent rather than filed under a shared key.
 */
export function conversationSender(msg: Pick<ChannelMessage, 'metadata'>): string | null {
  const userId = msg.metadata.userId;
  const chat = msg.metadata.chatId ?? msg.metadata.channelId;
  const id = (v: unknown) => (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v));
  if (!id(userId) || !id(chat)) return null;
  return `user:${String(userId)}/chat:${String(chat)}`;
}

/**
 * Whether a message was written in a private chat with the bot, the only
 * place a broadcast recipient is taken from (#852 review). Telegram says so in
 * `chatType`; a Discord message with no guild is a DM. Any other channel, or
 * one that does not say, is not private.
 */
export function isPrivateChat(msg: Pick<ChannelMessage, 'channel' | 'metadata'>): boolean {
  if (msg.channel === 'telegram') return msg.metadata.chatType === 'private';
  if (msg.channel === 'discord') return msg.metadata.isDM === true;
  return false;
}

/**
 * The answer to an `approve <id>` or `deny <id>` from a sender the channel's
 * allow-list does not name (#811), which is every sender while the list is
 * empty. Nothing is decided.
 */
export function channelDecisionNeedsAllowList(channel: string): string {
  return `Approvals can only be decided from ${channel} by a user listed under Allowed user IDs in Jarvis Settings > Channels, and that list is empty or does not include you. Nothing was approved or denied. Open the Jarvis dashboard to decide.`;
}

/**
 * A chat message that is an `approve <id>` or `deny <id>` reply, or null for
 * ordinary chat (#810).
 *
 * The id is the whole word after the verb, trailing punctuation dropped, and
 * it counts as an attempt at an id when it is made only of hex digits and
 * hyphens. Whether it is the RIGHT length is not decided here:
 * `channelApprovalReply` answers a wrong one with a refusal, so `approve a`
 * is told it named nothing rather than handed to the agent as chat.
 *
 * This used to take the longest hex run at the start of the word, with no
 * end, so `approve all of them` sent the id `a` and `deny deadline` sent
 * `dead`; with a prefix lookup that took the first match, either decided
 * whichever pending request happened to start that way. A word that is not
 * hex (`approve the email`) is chat, as it always was.
 */
export function channelDecisionCommand(text: string): { action: 'approve' | 'deny'; shortId: string } | null {
  const m = /^(approve|deny)\s+(\S+)/.exec(text.trim().toLowerCase());
  if (!m) return null;
  // Trailing punctuation dropped by a scan from the end, not `/[.,;:!?]+$/`,
  // which retries from every start and is quadratic on a run of punctuation
  // from a sender nobody has vetted yet (#810 review).
  let end = m[2]!.length;
  while (end > 0 && '.,;:!?'.includes(m[2]![end - 1]!)) end--;
  const word = m[2]!.slice(0, end);
  if (!/^[0-9a-f-]+$/.test(word)) return null;
  return { action: m[1] as 'approve' | 'deny', shortId: word };
}

/**
 * Pure routing helper used by `ChannelService.tryBroadcastToChannels`.
 * Lifted out so tests can drive it with stub getters without standing up a
 * real ChannelService + ChannelManager + AgentService.
 *
 * Per-channel rules:
 *   - Adapter missing             -> failed("not configured").
 *   - Adapter present but offline -> failed("not connected").
 *   - No known recipient yet      -> failed("no known recipient ...").
 *   - sendMessage throws          -> failed with the exception message.
 *   - sendMessage resolves        -> delivered.
 *
 * Duplicate entries are de-duped silently; first-occurrence wins.
 */
export interface ChannelRouterServices {
  getAdapter: (name: string) => ChannelAdapter | null;
  getLastRecipient: (name: string) => string | null;
}

export async function routePerChannel(
  channels: string[],
  text: string,
  services: ChannelRouterServices,
): Promise<{ delivered: string[]; failed: { channel: string; error: string }[] }> {
  const delivered: string[] = [];
  const failed: { channel: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const name of channels) {
    if (seen.has(name)) continue;
    seen.add(name);

    const adapter = services.getAdapter(name);
    if (!adapter) {
      failed.push({ channel: name, error: `channel "${name}" is not configured` });
      continue;
    }
    if (!adapter.isConnected()) {
      failed.push({ channel: name, error: `channel "${name}" is not connected` });
      continue;
    }
    const lastRecipient = services.getLastRecipient(name);
    if (!lastRecipient) {
      failed.push({
        channel: name,
        error: `no known recipient for "${name}" -- message Jarvis once from an account listed under Allowed user IDs for that channel to seed it`,
      });
      continue;
    }
    try {
      checkpointExecution();
      await adapter.sendMessage(lastRecipient, text);
      delivered.push(name);
    } catch (err) {
      failed.push({ channel: name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { delivered, failed };
}

export const SEND_RETRY_MAX_ATTEMPTS = 4;
export const SEND_RETRY_BASE_DELAY_MS = 2_000;
/** Cap on a single wait, even when the provider asks for more. */
export const SEND_RETRY_MAX_DELAY_MS = 30_000;
/**
 * Total sleep budget across all retries. Kept well under the 2-minute
 * orchestrator approval window so a retried approval message still leaves
 * the user time to reply.
 */
export const SEND_RETRY_BUDGET_MS = 60_000;

export interface SendRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  isTransient?: (err: unknown) => boolean;
  /** Passed to every attempt's `sendMessage`, e.g. `{ literal: true }` for an approval card. */
  send?: SendOptions;
}

export type SendRetryResult =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; error: string };

/** Runtime error codes for connection-level failures (Node + Bun spellings). */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'ConnectionRefused', 'ConnectionClosed', 'FailedToOpenSocket',
]);

function defaultIsTransient(err: unknown): boolean {
  // An explicit retry-after from the provider always means "try again",
  // regardless of how the error message is worded.
  if (typeof (err as { retryAfterMs?: unknown })?.retryAfterMs === 'number') return true;
  if (err instanceof Error) {
    // AbortError is fetchWithTimeout's timeout. Retrying a timed-out send can
    // duplicate a message that was actually delivered (Telegram has no
    // idempotency key) — accepted: a duplicate beats a silently dropped
    // approval request.
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    const errCode = (err as { code?: unknown }).code;
    if (typeof errCode === 'string' && TRANSIENT_ERROR_CODES.has(errCode)) return true;
  }
  const code = classifyErrorString(err instanceof Error ? err.message : String(err));
  return code === 'rate_limit' || code === 'network' || code === 'server';
}

/**
 * Send a message through an adapter, retrying transient failures (rate
 * limits, network errors, timeouts) with exponential backoff. An explicit
 * retryAfterMs on the thrown error (e.g. Telegram 429 retry_after) is
 * honored even beyond the per-wait cap, which only bounds the synthetic
 * backoff. The budget is a wall-clock deadline covering sleeps and attempt
 * duration: if the required wait doesn't fit before the deadline, it fails
 * immediately instead of stalling the caller.
 *
 * If a thrown error carries a remainingText string (set by adapters whose
 * sendMessage chunks long texts and fails mid-way), retries resume with
 * only the unsent portion instead of duplicating already-sent chunks.
 * Discord rarely gets here at all — discord.js queues 429s internally, and
 * the adapter's own errors (not connected, invalid channel) are
 * non-transient.
 */
export async function sendWithRetry(
  adapter: Pick<ChannelAdapter, 'name' | 'sendMessage'>,
  recipient: string,
  text: string,
  opts?: SendRetryOptions,
): Promise<SendRetryResult> {
  const maxAttempts = opts?.maxAttempts ?? SEND_RETRY_MAX_ATTEMPTS;
  const baseDelayMs = opts?.baseDelayMs ?? SEND_RETRY_BASE_DELAY_MS;
  const maxDelayMs = opts?.maxDelayMs ?? SEND_RETRY_MAX_DELAY_MS;
  const sleep = opts?.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts?.now ?? Date.now;
  const isTransient = opts?.isTransient ?? defaultIsTransient;
  const deadline = now() + (opts?.budgetMs ?? SEND_RETRY_BUDGET_MS);
  let currentText = text;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (opts?.send) await adapter.sendMessage(recipient, currentText, opts.send);
      else await adapter.sendMessage(recipient, currentText);
      return { ok: true, attempts: attempt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === maxAttempts || !isTransient(err)) {
        return { ok: false, attempts: attempt, error: message };
      }
      const remaining = (err as { remainingText?: unknown }).remainingText;
      if (typeof remaining === 'string' && remaining.length > 0) {
        currentText = remaining;
      }

      const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs;
      const backoff = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const delay = Math.max(typeof retryAfterMs === 'number' ? retryAfterMs : 0, backoff);
      if (now() + delay > deadline) {
        return { ok: false, attempts: attempt, error: message };
      }

      console.warn(`[ChannelService] Send to ${adapter.name} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms: ${message}`);
      await sleep(delay);
    }
  }
  // Unreachable: the loop always returns on the last attempt.
  return { ok: false, attempts: maxAttempts, error: 'unreachable' };
}
