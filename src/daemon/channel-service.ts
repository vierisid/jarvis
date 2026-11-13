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
import { TELEGRAM_CHANNEL_OFF_DROPPED_REPLY, TELEGRAM_CHANNEL_OFF_MAYBE_DROPPED_REPLY, TELEGRAM_SHUTDOWN_DROPPED_REPLY, TELEGRAM_SHUTDOWN_MAYBE_DROPPED_REPLY, TelegramAdapter, type TelegramResumePoint } from '../comms/channels/telegram.ts';
import { activeTurns } from './active-turns.ts';
import { channelAllowList, channelOwnerId } from '../comms/channels/allow-list.ts';
import { LITERAL_TEXT_CHANNELS } from '../authority/approval-delivery.ts';
import { createSTTProvider } from '../comms/voice.ts';
import { effectiveSttForBinding, usejarvisVoiceCredentials } from './usejarvis-ai.ts';
import { getOrCreateConversation, addMessage, markForwarded, FORWARD_WINDOW_MESSAGES } from '../vault/conversations.ts';
import { getDb } from '../vault/schema.ts';
import { getSettingsByPrefix, setSetting } from '../vault/settings.ts';
import { NotSentError, partlySent, requestMayHaveArrived, sendMayHaveArrived, sendRetryable } from '../comms/delivery.ts';
import { runWithOrigin } from '../llm/origin.ts';
import { checkpointExecution, withExecutionScope } from '../actions/execution-scope.ts';
import { channelThreadTitle } from '../brief/conversation-title.ts';

/**
 * How many channel turns, every chat on every channel together, run at once
 * (#1155). Telegram runs one turn per chat at a time but any number of chats
 * at once, and Discord runs every message as it arrives, so a busy group or a
 * few listed users could start as many model loops as they sent messages.
 * The same number as background agent tasks (`MAX_RUNNING_TASKS`), on purpose
 * but counted apart: each turn is a model loop of the same kind, five is past
 * what one person follows, and a full task queue must not stop the channels.
 * A turn waiting on an approval card keeps its slot meanwhile; approve and
 * deny replies never need one.
 */
export const CHANNEL_MAX_CONCURRENT_TURNS = 5;

/**
 * How many channel turns may wait for a free slot (#1155). The bound Telegram
 * already keeps per adapter on what waits in its lanes
 * (`TELEGRAM_UPDATES_LIMIT`); past it the sender is told to send it again.
 */
export const CHANNEL_MAX_WAITING_TURNS = 100;

/**
 * How many turns one guest gets in `GUEST_TURN_WINDOW_MS` (#1155). A guest's
 * turn is billed to the owner, and on the hosted platform it runs under the
 * owner's account, so a listed guest must not be able to spend without
 * bound. Thirty an hour is a message every two minutes, sustained: a real
 * conversation, not a script. A policy choice, not a measurement.
 */
export const GUEST_TURNS_PER_WINDOW = 30;
export const GUEST_TURN_WINDOW_MS = 60 * 60 * 1000;

/** What a sender is told when every slot is taken and the queue is full. */
export const CHANNEL_BUSY_REPLY = 'Jarvis is answering too many messages right now, so this one was not read. Send it again in a few minutes.';

/** What a guest is told when they write again before their last message was answered. */
export const GUEST_ONE_AT_A_TIME_REPLY = 'I am still answering your last message, so this one was not read. Send it again once I have replied.';

/** What a guest is told past `GUEST_TURNS_PER_WINDOW`. */
export const GUEST_CAP_REPLY = 'You have sent as many messages as a guest may in an hour, so this one was not answered. Try again later.';

/**
 * Raised at a dispatch checkpoint of a channel turn whose sender the
 * allow-list no longer admits as they were admitted when it started (#1155):
 * removed, or no longer the owner. The rest of the turn's tool calls are
 * refused before any approval card is raised, nothing is learned from it, and
 * its reply is not sent. A model call already in flight is not stopped, and a
 * background agent task the turn started before then keeps running, as every
 * background task does (#988); it can be stopped from the dashboard.
 */
export class ChannelSenderRevokedError extends Error {
  constructor(channel: string) {
    super(`The ${channel} sender of this turn is no longer allowed to use Jarvis as they were when it started, so nothing more is run for them.`);
    this.name = 'ChannelSenderRevokedError';
  }
}

/** Settings-table key prefix for persisted per-channel broadcast recipients. */
const LAST_RECIPIENT_PREFIX = 'channel.lastRecipient.';

/**
 * Where a channel's broadcasts go, and who put them there (#852): `to` is the
 * chat the sender wrote from, `userId` the sender. Broadcasts go to `to` only
 * while `userId` is the channel's owner, the first entry of its allow-list
 * (#916, `getBroadcastRecipient`), so removing or replacing the owner stops
 * their copies at once.
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

/** See `ChannelService.getRecipientStatus` (#890, #916). */
export type RecipientStatus =
  | { hasRecipient: true }
  | { hasRecipient: false; reason: 'empty_list' | 'no_owner' | 'no_direct_message' };

/**
 * What to tell the owner about channels that have nowhere to send approval
 * requests and notifications (#890), or null when every connected one does.
 */
export function recipientWarning(status: Record<string, RecipientStatus>): string | null {
  const label = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
  const lines: string[] = [];
  for (const [name, s] of Object.entries(status)) {
    if (s.hasRecipient) continue;
    lines.push(s.reason === 'empty_list'
      ? `${label(name)} will not receive approval requests or notifications: no user ID is listed for it.`
      : s.reason === 'no_owner'
        ? `${label(name)} will not receive approval requests or notifications: the first allowed user ID, which is the channel's owner, is not a valid ID.`
        : `${label(name)} will not receive approval requests or notifications until the channel's owner, the first allowed user ID, sends the bot a direct message (again, if they did before). A bot cannot start a chat with someone who has never messaged it.`);
  }
  return lines.length ? lines.join(' ') : null;
}

/** `deciderId` is the channel user id of whoever typed the reply, recorded with the decision (#1155). */
export type ApprovalCommandHandler = (action: 'approve' | 'deny', shortId: string, channel: string, deciderId?: string) => Promise<string>;

/**
 * A send that did not complete. `mayHaveArrived` (Q-19): the channel may have
 * taken the message before the failure, so it must never be reported as not
 * sent, and it is never sent again on its own.
 */
export interface DeliveryFailure { channel: string; attempts: number; error: string; mayHaveArrived: boolean }
export type DeliveryFailureHandler = (failure: DeliveryFailure) => void;

/** Per-channel receipts. `unknown`: the channel may have taken it; see `DeliveryFailure`. */
export interface ChannelDeliveryReport {
  delivered: string[];
  failed: { channel: string; error: string }[];
  unknown: { channel: string; error: string }[];
}

export class ChannelService implements Service {
  name = 'channels';
  private _status: ServiceStatus = 'stopped';
  private config: JarvisConfig;
  private agentService: AgentService;
  private manager: ChannelManager;
  private sttProvider: STTProvider | null = null;
  /**
   * The owner's private chat per channel, for proactive broadcasts and
   * notify (#852, #916). Only the channel's owner is recorded; a value saved
   * by an older version for another listed user is loaded but never used.
   * Persisted to the settings table (see
   * {@link LAST_RECIPIENT_PREFIX}) and reloaded on start, so a daemon restart
   * doesn't drop the recipient and silently break notifications until the
   * user re-messages the bot. Read through `getBroadcastRecipient`, never
   * directly.
   */
  private lastRecipients = new Map<string, BroadcastRecipient>();
  /**
   * Where the last Telegram adapter left off, kept across the stop/start a
   * settings save does (#882), per bot token: update ids are numbered per
   * bot, so another token starts over, and switching back to a token picks up
   * where that bot left off.
   *
   * It carries what the old adapter had fetched but not started (#910), so
   * the new adapter judges that against the new allow-list (#860). See
   * `TelegramResumePoint`.
   */
  private telegramResume = new Map<string, TelegramResumePoint>();
  /** The Telegram adapter this service last built, and for which token. */
  private telegram: { adapter: TelegramAdapter; token: string } | null = null;
  /**
   * The last Telegram adapter built, kept while the channel is off too
   * (#1155): its turns run on after it stops, and the next adapter, for this
   * bot or another, must not start a chat's next message before that chat's
   * turn ends. A chat's conversation is its sender's in that chat whichever
   * bot carried it (#884).
   */
  private lastTelegramAdapter: TelegramAdapter | null = null;
  /** Handler for approval commands (approve/deny) from external channels */
  private approvalHandler: ApprovalCommandHandler | null = null;
  /** Notified when a send has exhausted its retries (e.g. to alert the dashboard). */
  private deliveryFailureHandler: DeliveryFailureHandler | null = null;

  /** Channel turns running now, and the turns waiting for a slot, in order (#1155). */
  private turnsRunning = 0;
  private turnQueue: Array<() => void> = [];
  /** When each guest's recent turns started, per `channel:userId` (#1155). */
  private guestTurns = new Map<string, number[]>();
  /** Guests with a turn running or waiting for a slot, per `channel:userId` (#1155). */
  private guestInFlight = new Map<string, number>();
  private now: () => number;

  /** Whether the daemon is shutting down rather than reloading settings (#911). */
  private shuttingDown: () => boolean;

  constructor(config: JarvisConfig, agentService: AgentService, opts?: { shuttingDown?: () => boolean; now?: () => number }) {
    this.config = config;
    this.now = opts?.now ?? Date.now;
    this.agentService = agentService;
    this.manager = new ChannelManager();
    // A shutdown quiesces turns before it stops services; a settings save does not.
    this.shuttingDown = opts?.shuttingDown ?? (() => activeTurns.isDraining);
  }

  setApprovalHandler(handler: ApprovalCommandHandler): void {
    this.approvalHandler = handler;
  }

  setDeliveryFailureHandler(handler: DeliveryFailureHandler): void {
    this.deliveryFailureHandler = handler;
  }

  private reportDeliveryFailure(channel: string, result: { attempts: number; error: string; mayHaveArrived: boolean }): void {
    console.error(result.mayHaveArrived
      ? `[ChannelService] Send to ${channel} unconfirmed after ${result.attempts} attempt(s); it may have arrived and will not be resent: ${result.error}`
      : `[ChannelService] Failed to send to ${channel} after ${result.attempts} attempt(s): ${result.error}`);
    try {
      this.deliveryFailureHandler?.({ channel, attempts: result.attempts, error: result.error, mayHaveArrived: result.mayHaveArrived });
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

      // 2. Create & register adapters from config.
      //
      // An enabled channel whose allow-list is empty is NOT started (#908).
      // The API refuses to save that state, but a config saved before #908, or
      // edited by hand, can still hold it -- and starting it would be shell
      // access for anyone who can reach the bot. At the default authority level
      // an unlisted sender's turn gets run_command, read_file, write_file and
      // browser_navigate with requiresApproval false, and taint gating does not
      // engage because their message IS the user turn.
      //
      // Refusing loudly rather than silently: the daemon still starts, and the
      // log says which channel was skipped and what to do, because a channel
      // that quietly stopped working is its own support problem.
      const channels = this.config.channels;
      const refuseOpen = (name: 'telegram' | 'discord', allowed: readonly unknown[] | undefined): boolean => {
        if ((allowed ?? []).length > 0) return false;
        console.error(
          `[ChannelService] ${name} is enabled but its allowed_users list is empty, so it was NOT started (#908). ` +
          `Anyone who could reach the bot would be able to run commands and read or write files with your ` +
          `authority. Add at least one user ID in Settings > Channels to enable it.`,
        );
        return true;
      };

      const telegramOn = !!(channels?.telegram?.enabled && channels.telegram.bot_token
        && !refuseOpen('telegram', channels.telegram.allowed_users));
      // What waited behind a turn goes to the adapter built right after it
      // (#910), and to no other: a message the owner sent before turning the
      // channel off, or before switching to another bot, must not run when
      // they switch back hours later. The offsets are kept (#882).
      const nextToken = telegramOn ? channels!.telegram!.bot_token : null;
      const previous = this.telegram;
      this.telegram = null;
      // Their senders are told, once and with no retry (Q-07). Only the
      // adapter built last can hold any: every other bot's were dropped when
      // it stopped being that one.
      if (previous && previous.token !== nextToken) {
        await previous.adapter.dropWaiting(
          { read: TELEGRAM_CHANNEL_OFF_DROPPED_REPLY, maybe: TELEGRAM_CHANNEL_OFF_MAYBE_DROPPED_REPLY },
          (userId) => this.allowListNames('telegram', userId),
        );
        // A shutdown does not wait for a settings reload in progress, so its
        // stop() may have run during that wait. Building adapters after it
        // would leave one polling, and confirming updates, after teardown.
        if (this._status !== 'starting') {
          console.log('[ChannelService] Stopped while starting; not starting the channels');
          return;
        }
      }
      for (const [token, point] of this.telegramResume) {
        if (token === nextToken || point.waiting.length === 0) continue;
        console.log(`[ChannelService] Dropping ${point.waiting.length} Telegram message(s) that were waiting for an answer when that bot was turned off or switched away from.`);
        this.telegramResume.set(token, { ...point, waiting: [] });
      }

      // Kept only while it still has turns a later adapter must wait for.
      if (!telegramOn && this.lastTelegramAdapter && this.lastTelegramAdapter.runningLaneWork().size === 0) this.lastTelegramAdapter = null;

      if (telegramOn) {
        warnAllowListProblems('telegram', channels!.telegram!.allowed_users);
        const token = channels!.telegram!.bot_token!;
        const resume = this.telegramResume.get(token);
        // A chat's next message waits for the turn an earlier adapter is
        // still answering in that chat (#910): one turn at a time per chat.
        // Whichever bot it was, and across the channel being off (#1155); the
        // last adapter's work carries what it inherited, so a chain of saves
        // keeps it.
        const stillRunning = this.lastTelegramAdapter?.runningLaneWork() ?? new Map<string, Promise<void>>();
        const telegram = new TelegramAdapter(token, {
          sttProvider: this.sttProvider ?? undefined,
          allowedUsers: channels!.telegram!.allowed_users,
          ...(resume ? { resume } : {}),
          waitFor: stillRunning,
          onResumePoint: (point) => { this.telegramResume.set(token, point); },
          // An approval decision does not wait behind its chat's turn in
          // progress (#910): it touches no conversation, and the approval it
          // decides may expire while the turn runs. The same test as
          // handleChannelMessage's, handler included: without a handler the
          // text is chat, and chat waits its turn.
          //
          // Only the owner's (#916). Anyone else's `approve <id>` is refused,
          // and must not fill the lane the owner's decisions wait in: it waits
          // in its chat's lane like other chat, and is refused there.
          isDecision: (text, userId) => this.approvalHandler !== null && channelDecisionCommand(text) !== null
            && this.isOwner('telegram', userId),
        });
        this.telegram = { adapter: telegram, token };
        this.lastTelegramAdapter = telegram;
        this.manager.register(telegram);
      }

      if (channels?.discord?.enabled && channels.discord.bot_token
        && !refuseOpen('discord', channels.discord.allowed_users)) {
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
    // On a shutdown, what waited behind a turn is not handed on: the next
    // process starts with nothing in memory. Its senders are told (#911).
    // After the disconnect, so nothing newer is fetched meanwhile.
    if (this.shuttingDown()) {
      await this.telegram?.adapter.dropWaiting(
        { read: TELEGRAM_SHUTDOWN_DROPPED_REPLY, maybe: TELEGRAM_SHUTDOWN_MAYBE_DROPPED_REPLY },
        (userId) => this.allowListNames('telegram', userId),
      );
    }
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
  async broadcastToAll(text: string, options?: SendOptions, delivery?: BroadcastDelivery): Promise<void> {
    // Channels are sent concurrently so one channel's retry backoff can't
    // delay delivery of a time-boxed message (e.g. an approval request) to
    // the others.
    const sends: Promise<void>[] = [];
    for (const name of this.manager.listChannels()) {
      const adapter = this.manager.getChannel(name);
      if (!adapter?.isConnected()) continue;
      // An approval card goes only where it is read exactly as written, the
      // channels that may also approve by reply (#814). Elsewhere it would
      // tell the reader to reply `approve <id>` and then refuse it.
      if (delivery?.approvalCard && !LITERAL_TEXT_CHANNELS.has(name)) {
        console.log(`[ChannelService] ${name} cannot send literal text, skipping the approval card`);
        continue;
      }

      const lastRecipient = this.getBroadcastRecipient(name);
      if (!lastRecipient) {
        console.log(`[ChannelService] No owner chat for ${name} yet, skipping broadcast`);
        continue;
      }

      sends.push(
        sendWithRetry(adapter, lastRecipient, text, {
          ...(options ? { send: options } : {}),
          // Owner decision (Q-19): an approval card gets one retry even when
          // the first send may have arrived, so an approval is not silently
          // lost to a timeout. Every other message is never resent.
          ...(delivery?.approvalCard ? { uncertainRetries: APPROVAL_CARD_UNCERTAIN_RETRIES } : {}),
          ...(delivery?.shouldContinue ? { shouldContinue: delivery.shouldContinue } : {}),
        }).then((result) => {
          // Held by its sender: not a delivery failure to report.
          if (!result.ok && result.held) {
            console.log(`[ChannelService] Send to ${name} held: its sender stopped${result.mayHaveArrived ? ' (an earlier attempt may have arrived)' : ''}`);
          } else if (!result.ok) {
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
    options: RoutePerChannelOptions = {},
  ): Promise<ChannelDeliveryReport> {
    return routePerChannel(channels, text, {
      getAdapter: (name) => this.manager.getChannel(name) ?? null,
      getLastRecipient: (name) => this.getBroadcastRecipient(name),
    }, options);
  }

  /**
   * Where this channel's broadcasts go: the private chat of the channel's
   * owner, the first entry of its allow-list (#916), and only while they are
   * still the owner. It used to be the chat of whichever listed user sent the
   * last direct message (#852), so with `[owner, spouse]` the spouse took over
   * every approval card just by saying hello.
   *
   * The owner's chat is learned from a direct message they sent: a bot cannot
   * open a chat with someone who never messaged it (Telegram refuses one with
   * 403 until the user has pressed Start), so until then there is no
   * recipient, the card stays on the dashboard, and `getRecipientStatus` says
   * why. Read against the live config, so changing the owner or removing them
   * stops their copies without a restart.
   *
   * Workflows resolve it once, before approval, and never switch to a later
   * sender.
   */
  getBroadcastRecipient(channel: string): string | null {
    const recipient = this.lastRecipients.get(channel);
    return recipient && this.isOwner(channel, recipient.userId) ? recipient.to : null;
  }

  /**
   * Whether each connected channel has somewhere to send approval requests
   * and notifications, and if not, why (#890). Since #852 that is only the
   * private chat of a user the allow-list names, so after a revocation, or
   * on a list nobody has messaged from yet, broadcasts are skipped with a log
   * line nobody reads. The dashboard shows this so the owner finds out before
   * a notification goes nowhere.
   *
   *   - `empty_list`: the saved list names nobody, so there can be no
   *     recipient;
   *   - `no_owner`: the list names someone, but its first entry, the owner
   *     (#916), is not a valid id, so nobody owns the channel;
   *   - `no_direct_message`: the owner has not sent the bot a direct message
   *     since becoming the owner (or ever), so there is no chat to send to.
   */
  getRecipientStatus(): Record<string, RecipientStatus> {
    const out: Record<string, RecipientStatus> = {};
    for (const name of this.manager.listChannels()) {
      if (!this.manager.getChannel(name)?.isConnected()) continue;
      if (this.getBroadcastRecipient(name) !== null) {
        out[name] = { hasRecipient: true };
        continue;
      }
      const list = channelAllowList(name, this.rawAllowList(name));
      out[name] = {
        hasRecipient: false,
        reason: !list || list.ids.length === 0 ? 'empty_list'
          : this.ownerOf(name) === null ? 'no_owner'
            : 'no_direct_message',
      };
    }
    return out;
  }

  /** The channel's `allowed_users` as configured right now, in whatever shape. */
  private rawAllowList(channel: string): unknown {
    const channels = this.config?.channels;
    return channel === 'telegram' ? channels?.telegram?.allowed_users
      : channel === 'discord' ? channels?.discord?.allowed_users
        : undefined;
  }

  /**
   * Whether the channel's allow-list, as configured right now, names this
   * user. Empty names nobody, and so does an entry that is not a valid id for
   * the channel (#883): the adapters ignore those entries, and a list must not
   * name someone here whom the adapter would turn away.
   */
  private allowListNames(channel: string, userId: unknown): boolean {
    if ((typeof userId !== 'string' && typeof userId !== 'number') || userId === '') return false;
    const list = channelAllowList(channel, this.rawAllowList(channel));
    return !!list && list.ids.some((id) => String(id) === String(userId));
  }

  /** The channel's owner as configured right now (#909, #916); see `channelOwnerId`. */
  private ownerOf(channel: string): number | string | null {
    return channelOwnerId(channel, this.rawAllowList(channel));
  }

  /**
   * Whether this user is the channel's owner as configured right now: the
   * first entry of its allow-list (#909, #916). Only the owner's turns get the
   * owner's private context, only the owner may approve or deny from the
   * channel, and only the owner's private chat receives approval cards.
   */
  isOwner(channel: string, userId: unknown): boolean {
    if (!this.allowListNames(channel, userId)) return false;
    const owner = this.ownerOf(channel);
    return owner !== null && String(owner) === String(userId);
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
    if (!adapter?.isConnected()) throw new NotSentError(`Channel ${channel} is unavailable`);
    if (!recipient) throw new NotSentError(`No approved recipient for ${channel}`);
    if (this.getBroadcastRecipient(channel) !== recipient) {
      throw new NotSentError(`The approved recipient for ${channel} is no longer an allow-listed recipient, so nothing was sent`);
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
    //
    // And only the channel's owner (#916): the first entry of the list. Any
    // other listed user's direct message leaves the recipient where it was,
    // so they cannot take over the owner's cards by saying hello.
    const userId = msg.metadata.userId;
    const allowListed = msg.senderAllowListed === true && this.allowListNames(channelTag, userId);
    const owner = allowListed && this.isOwner(channelTag, userId);
    if (owner && isPrivateChat(msg)) {
      const to = String(msg.metadata.chatId ?? msg.metadata.channelId ?? msg.from);
      this.recordRecipient(channelTag, { to, userId: String(userId) });
    }

    // Check for approval commands: "approve <id>" or "deny <id>"
    const decision = this.approvalHandler ? channelDecisionCommand(msg.text) : null;
    if (this.approvalHandler && decision) {
      // Only someone the allow-list names may decide (#811). An enabled
      // channel needs a list (#918), but the adapter's answer can be stale
      // (#860), so the list as configured now is what counts here.
      if (!allowListed) return channelDecisionNeedsAllowList(channelTag);
      // And only the owner (#916). The card went to the owner's chat; another
      // listed user may chat with the bot but does not decide for the owner.
      if (!owner) return channelDecisionNotOwner(channelTag);
      // A forward carries someone else's words (#914). Forwarding is a quick
      // action, and the text need not look like a command to the person
      // forwarding it, so it is never their decision.
      if (msg.forwarded === true) return channelDecisionForwarded(channelTag);
      // And only from the owner's private chat with the bot (#1155): the
      // card was sent there, and a decision typed in a group or server
      // channel runs the owner's tool and posts its result to every member.
      if (!isPrivateChat(msg)) return channelDecisionNotPrivate(channelTag);
      try {
        return await this.approvalHandler(decision.action, decision.shortId, channelTag, String(userId));
      } catch (err) {
        return `Error processing approval: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const sender = conversationSender(msg);
    if (!sender) return "Sorry, I can't tell who sent this message, so I can't answer it.";

    // Only the owner, the first entry of the list, gets the owner's
    // assistant (#909), and only in a private chat with the bot (owner
    // decision, #1155); see step 2.
    const who = owner ? (isPrivateChat(msg) ? 'owner' : 'shared') : 'guest';
    // A guest has one turn running or waiting at a time (#1155), as one
    // Telegram chat does, so a burst from one guest (Discord runs every
    // message as it arrives) cannot fill the queue everyone else waits in;
    // and one already past their cap does not wait at all. Counted below.
    const guestKey = `${channelTag}:${String(userId)}`;
    if (who === 'guest') {
      if ((this.guestInFlight.get(guestKey) ?? 0) > 0) return GUEST_ONE_AT_A_TIME_REPLY;
      if (this.guestRecentTurns(channelTag, userId).length >= GUEST_TURNS_PER_WINDOW) return GUEST_CAP_REPLY;
      this.guestInFlight.set(guestKey, 1);
    }
    try {
      return await this.runInSlot(msg, channelTag, sender, who, allowListed, userId);
    } finally {
      if (who === 'guest') this.guestInFlight.delete(guestKey);
    }
  }

  /** A turn in a slot among every channel's turns, behind its dispatch fence (#1155). */
  private async runInSlot(
    msg: ChannelMessage,
    channelTag: string,
    sender: string,
    who: 'owner' | 'shared' | 'guest',
    allowListed: boolean,
    userId: unknown,
  ): Promise<string> {
    // Waiting keeps arrival order, and Telegram's lanes already keep each chat's.
    const release = await this.acquireTurnSlot();
    if (!release) return CHANNEL_BUSY_REPLY;
    try {
      // The turn holds what it was started with only while the live list
      // still admits its sender that way (#1155): removed from the list, or
      // no longer its owner, every later dispatch the turn makes is refused,
      // and its reply is not sent. A settings save cannot stop a model call
      // in flight, but every tool call checks here first.
      // A guest the list did not name when the turn started (only a stale
      // adapter can deliver one, #860) has nothing to revoke: no tools, and
      // the reply is the one it was always going to get.
      const stillAdmitted = () => who === 'owner'
        ? this.isOwner(channelTag, userId)
        : !allowListed || this.allowListNames(channelTag, userId);
      // Re-checked after the wait for a slot: the list may have changed.
      if (!stillAdmitted()) return '';
      // A guest's turns are billed to the owner, so they are capped (#1155).
      // Counted only for a turn that runs: a busy refusal costs them nothing.
      if (who === 'guest' && !this.takeGuestTurn(channelTag, userId)) return GUEST_CAP_REPLY;
      return await withExecutionScope(() => {
        if (!stillAdmitted()) throw new ChannelSenderRevokedError(channelTag);
      }, () => this.runChannelTurn(msg, channelTag, sender, who, stillAdmitted));
    } catch (err) {
      // The turn ended at its first dispatch after the revocation; there is
      // nobody to tell (#1155).
      if (err instanceof ChannelSenderRevokedError) {
        console.log(`[ChannelService] Ended a ${channelTag} turn: ${err.message}`);
        return '';
      }
      throw err;
    } finally {
      release();
    }
  }

  /** The turn itself, inside its slot and its dispatch fence (#1155). */
  private async runChannelTurn(
    msg: ChannelMessage,
    channelTag: string,
    sender: string,
    who: 'owner' | 'shared' | 'guest',
    stillAdmitted: () => boolean,
  ): Promise<string> {
    // 1. Persist inbound user message to vault, in this sender's own
    //    conversation (#884). Every sender used to share the channel's one
    //    conversation, so on a channel anyone may message (an empty list,
    //    #811) a stranger could ask about the owner's earlier turns.
    // Titled after its sender (#1313 follow-up), so closed threads can be told apart.
    const label = channelThreadTitle(channelTag, msg.from, who, { privateChat: isPrivateChat(msg), startedAt: Date.now() });
    const conversation = getOrCreateConversation(channelTag, { sender, ...(label ? { label } : {}) });
    // A forward is marked in the same transaction (#1155): stored unmarked,
    // it would read as the owner's own words on every later turn.
    getDb().transaction(() => {
      const stored = addMessage(conversation.id, { role: 'user', content: msg.text });
      if (msg.forwarded === true) markForwarded(conversation.id, stored.id);
    })();

    // 2. Route to AgentService (non-streaming — external channels are
    //    request/response), on that conversation's history alone. Only the
    //    channel's owner, the first entry of its list, gets the owner's
    //    assistant (#909): their private context, their tools, and learning
    //    from the turn. Any other sender is a guest; see
    //    AgentService.handleGuestMessage for exactly what a guest gets.
    //    And only in a private chat with the bot (owner decision, #1155): in
    //    a Telegram group or a Discord server channel every member reads the
    //    reply, so the owner's turn there gets a guest's treatment too.
    //    A guest's turn still runs under origin 'user': the owner chose to
    //    list them, the turn is foreground, and a separate origin would need
    //    the hosted platform to weigh it (owner decision, #1155). What bounds
    //    a guest's spend instead: the cap above, a cap on the reply's length,
    //    and no background compaction of their conversation.
    //    A forward carries someone else's words (#1155): the owner's turn
    //    reads it as quoted outside content, see handleThreadMessage.
    const response = await runWithOrigin('user', () => this.agentService.handleThreadMessage(
      msg.text, channelTag, {
        conversationId: conversation.id, contextKey: `channel:${channelTag}:${sender}`, sender: who,
        ...(msg.forwarded === true ? { forwarded: true } : {}),
      },
    ));

    // The sender was removed, or stopped being the owner, while the turn ran
    // (#1155): the reply was built for who they were, so it is not sent.
    if (!stillAdmitted()) {
      console.log(`[ChannelService] Not sending a ${channelTag} reply: its sender is no longer allowed to use Jarvis as they were when the turn started.`);
      return '';
    }

    // 3. Persist assistant response to vault
    addMessage(conversation.id, { role: 'assistant', content: response });

    return response;
  }

  /**
   * A slot among every channel's running turns (#1155), waiting in arrival
   * order for one when all are taken. Null when the wait is full too. The
   * returned release frees the slot, or hands it to the next waiter, once.
   */
  private async acquireTurnSlot(): Promise<(() => void) | null> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.turnQueue.shift();
      if (next) next();
      else this.turnsRunning--;
    };
    if (this.turnsRunning < CHANNEL_MAX_CONCURRENT_TURNS) {
      this.turnsRunning++;
      return release;
    }
    if (this.turnQueue.length >= CHANNEL_MAX_WAITING_TURNS) {
      console.warn(`[ChannelService] ${CHANNEL_MAX_CONCURRENT_TURNS} channel turns are running and ${CHANNEL_MAX_WAITING_TURNS} wait; not reading another`);
      return null;
    }
    await new Promise<void>((resolve) => this.turnQueue.push(resolve));
    return release;
  }

  /** A guest's turns still inside the window, after dropping every guest's older ones (#1155). */
  private guestRecentTurns(channel: string, userId: unknown): number[] {
    const now = this.now();
    for (const [key, times] of this.guestTurns) {
      const recent = times.filter((t) => now - t < GUEST_TURN_WINDOW_MS);
      if (recent.length === 0) this.guestTurns.delete(key);
      else this.guestTurns.set(key, recent);
    }
    return this.guestTurns.get(`${channel}:${String(userId)}`) ?? [];
  }

  /** Count a guest's turn, or false when they are past `GUEST_TURNS_PER_WINDOW` (#1155). */
  private takeGuestTurn(channel: string, userId: unknown): boolean {
    const times = this.guestRecentTurns(channel, userId);
    if (times.length >= GUEST_TURNS_PER_WINDOW) return false;
    times.push(this.now());
    this.guestTurns.set(`${channel}:${String(userId)}`, times);
    return true;
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
 * The answer to an `approve <id>` or `deny <id>` from a listed user who is not
 * the channel's owner (#916). Nothing is decided.
 */
export function channelDecisionNotOwner(channel: string): string {
  return `Approvals can only be decided from ${channel} by this channel's owner, the first user listed under Allowed user IDs in Jarvis Settings > Channels, and that is not you. Nothing was approved or denied.`;
}

/**
 * The answer to an `approve <id>` or `deny <id>` the owner typed in a group or
 * server channel (#1155). Nothing is decided.
 */
export function channelDecisionNotPrivate(channel: string): string {
  return `Approvals can only be decided from your private chat with the bot on ${channel}, where the card was sent, not from a group or server channel that other people read. Nothing was approved or denied.`;
}

/**
 * The answer to an `approve <id>` or `deny <id>` found in a forwarded message
 * (#914). Nothing is decided.
 */
export function channelDecisionForwarded(channel: string): string {
  return `That approve or deny is in a forwarded message, so it was written by someone else and does not count as your decision. Nothing was approved or denied. Type the reply yourself in ${channel}, or open the Jarvis dashboard to decide.`;
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
 *   - sendMessage throws          -> failed with the exception message, or
 *                                    unknown when the channel may have taken
 *                                    it (Q-19: a timeout, a dropped
 *                                    connection, a partly sent message).
 *   - sendMessage resolves        -> delivered.
 *
 * Duplicate entries are de-duped silently; first-occurrence wins.
 */
export interface ChannelRouterServices {
  getAdapter: (name: string) => ChannelAdapter | null;
  getLastRecipient: (name: string) => string | null;
}

/**
 * `shouldContinue` is asked before each send (#1314 review): a caller whose
 * permission to send can lapse while one channel is tried (screen awareness
 * turned off during an opportunity's delivery) stops before the next one.
 * A channel not tried is reported failed, so nothing reads as sent.
 */
export interface RoutePerChannelOptions { shouldContinue?: () => boolean }

export async function routePerChannel(
  channels: string[],
  text: string,
  services: ChannelRouterServices,
  options: RoutePerChannelOptions = {},
): Promise<ChannelDeliveryReport> {
  const delivered: string[] = [];
  const failed: { channel: string; error: string }[] = [];
  const unknown: { channel: string; error: string }[] = [];
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
    } catch (err) {
      failed.push({ channel: name, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (options.shouldContinue && !options.shouldContinue()) {
      failed.push({ channel: name, error: 'held: the sender stopped before this channel was tried' });
      continue;
    }
    try {
      await adapter.sendMessage(lastRecipient, text);
      delivered.push(name);
    } catch (err) {
      (sendMayHaveArrived(err) ? unknown : failed).push({ channel: name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { delivered, failed, unknown };
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

/** How a broadcast is delivered. */
export interface BroadcastDelivery {
  /** An approval card (ApprovalDelivery): one retry after a send that may have arrived. */
  approvalCard?: boolean;
  /**
   * Asked before each channel's first send and before each retry (#1314
   * follow-up): a sender whose permission can lapse (a screen-derived
   * suggestion once awareness is turned off) sends nothing more after it does.
   */
  shouldContinue?: () => boolean;
}

/** Owner decision (Q-19): "no retry, except approval cards", which get exactly one. */
export const APPROVAL_CARD_UNCERTAIN_RETRIES = 1;

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
  /**
   * How many times a send that may have arrived (timeout, drop, 5xx) is tried
   * again. 0 by default: a retry could deliver it twice. Only approval cards
   * set it (owner decision), accepting a possible duplicate card over a lost one.
   */
  uncertainRetries?: number;
  /** Asked before every attempt, the first included; false stops with `held` (#1314 follow-up). */
  shouldContinue?: () => boolean;
}

export type SendRetryResult =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; error: string; mayHaveArrived: boolean; held?: true };

/**
 * Send a message through an adapter, retrying failures that left nothing
 * sent and can pass (rate limits, connections never made) with exponential
 * backoff. A failure after which the message may have arrived (a timeout, a
 * dropped connection, a server error; see `comms/delivery.ts`) is never
 * retried (Q-19): Telegram has no idempotency key, so a retry could send it
 * twice. It is reported with `mayHaveArrived` instead. An explicit
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
  const isTransient = opts?.isTransient ?? sendRetryable;
  const deadline = now() + (opts?.budgetMs ?? SEND_RETRY_BUDGET_MS);
  let currentText = text;
  // Part of the message reached the channel on an earlier attempt.
  let sentPart = false;
  let uncertainRetriesLeft = opts?.uncertainRetries ?? 0;

  const stopped = () => opts?.shouldContinue !== undefined && !opts.shouldContinue();
  const held = (attempts: number): SendRetryResult =>
    ({ ok: false, attempts, error: 'held: the sender stopped before this attempt', mayHaveArrived: sentPart, held: true });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (stopped()) return held(attempt - 1);
    try {
      if (opts?.send) await adapter.sendMessage(recipient, currentText, opts.send);
      else await adapter.sendMessage(recipient, currentText);
      return { ok: true, attempts: attempt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const mayHaveArrived = sentPart || sendMayHaveArrived(err);
      // Resuming the unsent remainder after a refused chunk is safe; resending
      // a request that may have been taken is not, whatever `isTransient` says.
      const uncertain = requestMayHaveArrived(err);
      const retryUncertain = uncertain && uncertainRetriesLeft > 0;
      if (attempt === maxAttempts || (uncertain && !retryUncertain) || (!uncertain && !isTransient(err))) {
        return { ok: false, attempts: attempt, error: message, mayHaveArrived };
      }
      if (retryUncertain) {
        uncertainRetriesLeft--;
        // It may have arrived: whatever happens next, never report it as not sent.
        sentPart = true;
      }
      if (partlySent(err)) {
        currentText = (err as { remainingText: string }).remainingText;
        sentPart = true;
      }

      const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs;
      const backoff = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const delay = Math.max(typeof retryAfterMs === 'number' ? retryAfterMs : 0, backoff);
      if (now() + delay > deadline) {
        return { ok: false, attempts: attempt, error: message, mayHaveArrived: sentPart };
      }

      // Not worth the wait when the sender has already stopped.
      if (stopped()) return held(attempt);
      console.warn(`[ChannelService] Send to ${adapter.name} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms: ${message}`);
      await sleep(delay);
    }
  }
  // Unreachable: the loop always returns on the last attempt.
  return { ok: false, attempts: maxAttempts, error: 'unreachable', mayHaveArrived: sentPart };
}

/** The untrusted-content source a dashboard turn on a channel guest's conversation is tainted with (#1155). */
export const CHANNEL_GUEST_CONVERSATION_SOURCE = 'channel guest conversation';

/**
 * Whether a conversation holds words a channel's owner did not write (#1155):
 * one a Telegram or Discord sender other than the channel's current owner
 * had with the bot, one holding a message the owner forwarded, or a channel
 * conversation saved before #884 without its sender, which every sender
 * shared. The dashboard lists these, and the owner
 * continuing one there runs a turn with their tools on that history.
 */
export function isChannelGuestConversation(conversationId: string, channels: JarvisConfig['channels']): boolean {
  return channelConversationHolds(conversationId, channels, true);
}

/**
 * Whether a conversation is a channel thread whose sender is not the
 * channel's current owner, or has none (saved before #884): its rows not
 * written in Brief are a guest's (#1313 follow-up). Unlike
 * isChannelGuestConversation, a forward in the owner's own thread does not
 * count: the forward is framed on its own, and the owner's words stay theirs.
 */
export function isChannelGuestThread(conversationId: string, channels: JarvisConfig['channels']): boolean {
  return channelConversationHolds(conversationId, channels, false);
}

function channelConversationHolds(conversationId: string, channels: JarvisConfig['channels'], countForwards: boolean): boolean {
  let row: { channel: string; sender: string | null; forwards: number } | null;
  try {
    row = getDb().query(`SELECT channel, sender,
      EXISTS (SELECT 1 FROM conversation_forwards f JOIN (SELECT id FROM conversation_messages
        WHERE conversation_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT ${FORWARD_WINDOW_MESSAGES}) m ON m.id = f.message_id) AS forwards
      FROM conversations c WHERE c.id = ?`).get(conversationId) as typeof row;
  } catch (err) {
    // Fail closed: tainting a turn only makes its gated actions ask first.
    console.warn('[ChannelService] Could not read whose conversation this is; treating it as holding outside words:', err);
    return true;
  }
  if (!row || (row.channel !== 'telegram' && row.channel !== 'discord')) return false;
  // A message the owner forwarded is someone else's words too (#1155 review),
  // while it is among the messages a turn reads back. A Brief turn is also
  // tainted by the transport from the very rows its history read
  // (ChatTurnRepository.historyWithForwards), so a framed forward never
  // reaches the untainted conv path, whose compactor would cut it.
  if (!row.sender || (countForwards && row.forwards)) return true;
  const userId = /^user:([^/]+)\//.exec(row.sender)?.[1];
  const raw = row.channel === 'telegram' ? channels?.telegram?.allowed_users : channels?.discord?.allowed_users;
  const owner = channelOwnerId(row.channel, raw);
  return userId === undefined || owner === null || String(owner) !== userId;
}

/**
 * A dashboard chat turn, tainted from the start when it continues a channel
 * guest's conversation (owner decision on #1155): the owner keeps their tools,
 * but what changes the machine or contacts someone stops for approval, as
 * after reading a web page, since the history carries a guest's words.
 */
export function withChannelConversationTaint<T extends { conversationId: string; untrustedSources?: string[] }>(
  input: T, channels: JarvisConfig['channels'],
): T {
  if (!isChannelGuestConversation(input.conversationId, channels)) return input;
  return { ...input, untrustedSources: [...(input.untrustedSources ?? []), CHANNEL_GUEST_CONVERSATION_SOURCE] };
}
