import type { STTProvider } from '../voice.ts';
import { telegramAllowList, type AllowList } from './allow-list.ts';

export type ChannelMessage = {
  id: string;
  channel: string;
  from: string;
  text: string;
  timestamp: number;
  metadata: Record<string, unknown>;
  /**
   * True only when the channel's `allowed_users` list is non-empty and names
   * this sender (#811). An empty list admits everyone, which is a convenience
   * for chatting and the wrong default for deciding an approval, so
   * `approve <id>` and `deny <id>` replies are refused unless this is true.
   * Absent means false: an adapter that does not say is not trusted to decide.
   */
  senderAllowListed?: boolean;
};

export type ChannelHandler = (message: ChannelMessage) => Promise<string>;

/**
 * How a message is rendered. By default a channel renders its own markup
 * (Telegram Markdown, Discord markdown), which is what a chat reply wants.
 *
 * `literal` is for text a person must read exactly as written before acting
 * on it -- the approval card (#718). The channel shows every character as
 * sent: no markup is interpreted (a `[text](url)` no longer shows only its
 * text, a `||spoiler||` no longer hides a clause, `_`/`*` pairs no longer
 * vanish), no mention notifies or renders as a name, and no link preview is
 * attached, since a preview shows text the linked page chose beside the card.
 */
export type SendOptions = { literal?: boolean };

export interface ChannelAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(to: string, text: string, options?: SendOptions): Promise<void>;
  onMessage(handler: ChannelHandler): void;
  isConnected(): boolean;
  /** Credential/session evidence for read models; activity flags alone are not authentication. */
  authenticationState?(): 'verified' | 'rejected' | 'unknown';
}

export class TelegramSendError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, opts?: { status?: number; retryAfterMs?: number }) {
    super(message);
    this.name = 'TelegramSendError';
    this.status = opts?.status;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

/**
 * Map a Telegram sendMessage HTTP response to an error, or null on success.
 * On 429 the retry_after from the response body (seconds) is surfaced as
 * retryAfterMs, and the message always contains "429" so string-based
 * transient-error classification still works after the error is stringified.
 */
export function telegramErrorFromResponse(status: number, body: unknown): TelegramSendError | null {
  const data = body as { ok?: boolean; error_code?: number; description?: string; parameters?: { retry_after?: unknown } } | null;
  if (data?.ok === true) return null;

  const description = data?.description ?? `HTTP ${status}`;
  if (status === 429 || data?.error_code === 429) {
    const retryAfter = data?.parameters?.retry_after;
    const retryAfterMs = typeof retryAfter === 'number' && Number.isFinite(retryAfter)
      ? retryAfter * 1000
      : undefined;
    return new TelegramSendError(`Telegram API error 429: ${description}`, { status: 429, retryAfterMs });
  }
  return new TelegramSendError(`Telegram API error: ${description}`, { status });
}

/**
 * The `sendMessage` body. Literal text omits `parse_mode`, which is the only
 * way to stop Telegram interpreting markup: with no `parse_mode` it shows the
 * text exactly as sent, so there is nothing to escape. Link previews are off
 * for it too (`link_preview_options`, Bot API 7.0).
 */
export function telegramSendBody(chatId: string, text: string, options?: SendOptions): Record<string, unknown> {
  return options?.literal
    ? { chat_id: chatId, text, link_preview_options: { is_disabled: true } }
    : { chat_id: chatId, text, parse_mode: 'Markdown' };
}

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    /**
     * Optional in the Bot API. For a message sent on behalf of a chat it is a
     * placeholder shared by every such sender (`GroupAnonymousBot`,
     * `Channel_Bot`), never the person (#885).
     */
    from?: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
    };
    /** Set when the message was sent on behalf of a chat: an anonymous group admin, or a channel (#885). */
    sender_chat?: { id: number; type: string; title?: string };
    chat: {
      id: number;
      type: string;
    };
    date: number;
    text?: string;
    voice?: {
      duration: number;
      mime_type: string;
      file_id: string;
      file_unique_id: string;
      file_size?: number;
    };
    audio?: {
      duration: number;
      mime_type: string;
      file_id: string;
      file_unique_id: string;
      file_size?: number;
    };
  };
};

type TelegramGetUpdatesResponse = {
  ok: boolean;
  result: TelegramUpdate[];
};

/**
 * The most updates one `getUpdates` returns: the Bot API's `limit` maximum,
 * and its default, sent explicitly. It is also the most messages each kind of
 * lane may hold waiting to start (#910). Before #910 the loop held one whole
 * batch in memory while it worked through it, so this bound is no looser
 * than that.
 */
export const TELEGRAM_UPDATES_LIMIT = 100;

/**
 * Bound on the call `disconnect()` makes to confirm what was taken (#911).
 * A fresh-connection `getUpdates` with `timeout: 0` to api.telegram.org took
 * 0.11 to 0.28s over 10 runs (curl, TLS handshake included, 2026-10-20), so
 * this is 10x the worst seen. Waited for, so the call is made before a
 * shutdown exits and before a reload's new adapter polls; it delays a stop
 * this long only when Telegram does not answer.
 */
export const TELEGRAM_CONFIRM_TIMEOUT_MS = 3_000;

/**
 * Where a new adapter for the same bot picks up after a settings save (#882,
 * #910). `offset` is one past the last update the old adapter fetched and
 * kept, so the new one is never handed again an update the old one took, even
 * one it is still answering. `waiting` is what the old adapter fetched but had
 * not started: the new adapter screens it again, against its own allow-list
 * (#860), before anything it polls.
 *
 * Never the raw poll position. An update fetched after disconnect() (#860)
 * is not counted, so Telegram hands it to the new adapter instead.
 */
export type TelegramResumePoint = {
  offset: number;
  waiting: TelegramUpdate[];
  savedAt: number;
  /** The offset Telegram is known to have been told (#911), so a new adapter does not assume an old one's failed confirm landed. */
  confirmed?: number;
};

/**
 * How old a resume point may be and still be used: 7 days. The Bot API says
 * that after at least a week with no new updates the next update id is
 * chosen at random instead of in sequence, so an older offset may lie above
 * every new id and skip them all. An older point is dropped and the new
 * adapter starts from Telegram's own record.
 */
export const TELEGRAM_RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * At most one busy reply per chat in this long (#910). The Bot API FAQ asks
 * bots to send no more than one message per second to a chat and no more
 * than 20 a minute to a group; one a minute stays under both, so a listed
 * user's flood cannot run the bot into flood control and delay the approval
 * cards it sends.
 */
export const TELEGRAM_BUSY_REPLY_INTERVAL_MS = 60_000;

/** What `screen` admits, for the asynchronous part of the handling. */
type TelegramWork = {
  message: NonNullable<TelegramUpdate['message']>;
  from: NonNullable<NonNullable<TelegramUpdate['message']>['from']>;
};

/** What a sender is told when their message would wait behind more than `TELEGRAM_UPDATES_LIMIT` others (#910). */
export const TELEGRAM_BUSY_REPLY = 'Too many messages are already waiting for an answer, so this one was not read. Send it again once Jarvis has caught up.';

/**
 * What a sender is told, once per chat, when the daemon shuts down while
 * their messages still wait behind a turn (#911). They are not handed to the
 * next process: Telegram has been told they were read.
 */
export const TELEGRAM_SHUTDOWN_DROPPED_REPLY = 'Jarvis is restarting, so the messages you sent while it was still answering were not read. Send them again in a minute.';

/** What a sender is told when the daemon is shutting down and refuses new turns. */
export const TELEGRAM_RESTARTING_REPLY = 'Jarvis is restarting, so this message was not answered. Send it again in a minute.';

export class TelegramAdapter implements ChannelAdapter {
  name = 'telegram';
  private token: string;
  private handler: ChannelHandler | null = null;
  private polling: boolean = false;
  private authentication: 'verified' | 'rejected' | 'unknown' = 'unknown';
  /**
   * The next `getUpdates` offset: one past the last update this adapter
   * fetched and kept. Telegram confirms an update only when a later call
   * passes an offset above it, so this is also what decides which updates
   * are delivered again.
   *
   * It moves past updates still waiting in a lane (#910). Holding it back for
   * them kept every later update unconfirmed too, a stranger's included, so
   * a flood could fill the 100-update window and keep the owner's
   * `approve <id>` from being fetched at all. What waits is kept here
   * instead, and handed to the next adapter on a settings save; a restart
   * loses it (see `disconnect`).
   */
  private offset: number = 0;
  /** The highest offset a `getUpdates` was answered for: Telegram has been told everything below it is done (#911). */
  private confirmedOffset: number = 0;
  /**
   * Updates waiting to start, by lane (#910). A lane is one chat's ordinary
   * messages, which run one at a time and in order since each turn reads and
   * writes that chat's conversation (in a group, every member's messages wait
   * for each other, though each has their own conversation), or one chat's
   * approval decisions, which touch no conversation and so do not wait
   * behind a long turn.
   */
  private lanes = new Map<string, Array<{ update: TelegramUpdate; work: TelegramWork }>>();
  /** How many updates wait in chat lanes and in decision lanes, each bounded by `TELEGRAM_UPDATES_LIMIT`. */
  private waitingChat = 0;
  private waitingDecisions = 0;
  /** Lanes with a worker running. */
  private runningLanes = new Set<string>();
  /** Handed over by the previous adapter, screened at connect(). */
  private carried: TelegramUpdate[] = [];
  /** Each running lane's worker, for `runningLaneWork`. */
  private laneRuns = new Map<string, Promise<void>>();
  /**
   * What a chat lane waits for before its first start: that chat's turn
   * still running in an earlier adapter (#910). Kept until it settles and
   * passed on in `runningLaneWork`, so a second settings save during the
   * same turn still waits for it.
   */
  private inherited = new Map<string, Promise<void>>();
  /** When each chat was last sent the busy reply. */
  private busyRepliedAt = new Map<string, number>();
  /** The long poll in flight, aborted by disconnect() (#882). */
  private pollAbort: AbortController | null = null;
  /** Told where a new adapter for this bot would pick up, whenever that changes (#882, #910). */
  private onResumePoint: ((point: TelegramResumePoint) => void) | null = null;
  /** Whether a typed message is an approval decision, which gets its own lane (#910). */
  private isDecision: ((text: string) => boolean) | null = null;
  private baseUrl: string;
  private pollingInterval: number = 1000;
  private sttProvider: STTProvider | null = null;
  /** Parsed, never the raw setting: a string there was a substring match (#883). */
  private allowList: AllowList<number>;

  /**
   * `resume` (#882): where the last adapter for this bot left off. A new
   * adapter used to start at 0, and Telegram had not been told the old one
   * took the update it was in the middle of (that is only said by the NEXT
   * call), so a settings save re-ran that update: the same message answered,
   * or the same action requested, twice. The channel service passes what an
   * adapter last reported through `onResumePoint`.
   *
   * `isDecision` (#910): typed text it is true for runs in its chat's decision
   * lane rather than behind that chat's turn in progress.
   */
  constructor(token: string, opts?: {
    sttProvider?: STTProvider;
    allowedUsers?: unknown;
    resume?: TelegramResumePoint;
    onResumePoint?: (point: TelegramResumePoint) => void;
    isDecision?: (text: string) => boolean;
    waitFor?: Map<string, Promise<void>>;
    now?: () => number;
  }) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.sttProvider = opts?.sttProvider ?? null;
    this.allowList = telegramAllowList(opts?.allowedUsers);
    this.now = opts?.now ?? Date.now;
    const resume = opts?.resume;
    if (resume && this.now() - resume.savedAt > TELEGRAM_RESUME_MAX_AGE_MS) {
      console.log('[TelegramAdapter] Not resuming from a point saved more than a week ago: Telegram may have renumbered its updates since.');
    } else if (resume && Number.isSafeInteger(resume.offset) && resume.offset > 0) {
      this.offset = resume.offset;
      const confirmed = resume.confirmed;
      if (confirmed !== undefined && Number.isSafeInteger(confirmed) && confirmed >= 0) this.confirmedOffset = Math.min(confirmed, resume.offset);
      this.carried = resume.waiting.filter((u) => u.update_id < resume.offset);
    }
    this.onResumePoint = opts?.onResumePoint ?? null;
    this.isDecision = opts?.isDecision ?? null;
    for (const [lane, run] of opts?.waitFor ?? []) {
      this.inherited.set(lane, run);
      void run.catch(() => {}).finally(() => { if (this.inherited.get(lane) === run) this.inherited.delete(lane); });
    }
  }

  private now: () => number;

  /**
   * For the next adapter's `waitFor` (#910): per lane, what must end before
   * that lane starts anything there. A lane's own worker ends after the turn
   * it is in once this adapter is disconnected, and it waited for what this
   * adapter inherited first; a lane with no worker here passes on what it
   * inherited. So a chat's next message never starts while its last is still
   * answered, however many settings saves happened in between.
   */
  runningLaneWork(): Map<string, Promise<void>> {
    const work = new Map(this.inherited);
    for (const [lane, run] of this.laneRuns) work.set(lane, run);
    return work;
  }

  /** See `TelegramResumePoint`. */
  resumePoint(): TelegramResumePoint {
    const waiting = [...this.carried];
    for (const queue of this.lanes.values()) for (const { update } of queue) waiting.push(update);
    waiting.sort((a, b) => a.update_id - b.update_id);
    return { offset: this.offset, waiting, savedAt: this.now(), confirmed: this.confirmedOffset };
  }

  private reportResumePoint(): void {
    if (!this.onResumePoint) return;
    try {
      this.onResumePoint(this.resumePoint());
    } catch (err) {
      console.error('[TelegramAdapter] onResumePoint threw:', err);
    }
  }

  setSTTProvider(provider: STTProvider): void {
    this.sttProvider = provider;
  }

  async connect(): Promise<void> {
    if (this.polling) {
      console.warn('[TelegramAdapter] Already connected');
      return;
    }

    this.authentication = 'unknown';
    // Verify bot token by calling getMe (with timeout so an unreachable
    // api.telegram.org or hung connection doesn't block daemon startup)
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/getMe`, {}, 10_000);
      const data = await response.json() as any;
      this.observeAuthentication(response.status, data);

      if (!data.ok) {
        throw new Error(`Invalid bot token: ${data.description}`);
      }

      console.log('[TelegramAdapter] Connected as:', data.result.username);
    } catch (error) {
      const msg = error instanceof Error
        ? (error.name === 'AbortError' ? 'getMe request timed out after 10s' : error.message)
        : 'Unknown error';
      throw new Error(`Failed to connect to Telegram: ${msg}`);
    }

    this.polling = true;
    // What the previous adapter left waiting (#860, #910), screened against
    // this adapter's list, ahead of anything newer.
    const carried = this.carried;
    this.carried = [];
    for (const update of carried) this.intakeSafely(update);
    this.startPolling();
  }

  async disconnect(): Promise<void> {
    this.polling = false;
    // What waits in a lane never starts here (#860): it was judged against
    // this adapter's list, and the next adapter must judge it against its own,
    // so it goes to that adapter through the resume point. A restart starts
    // with nothing in memory, so there it is lost: the owner sent it while a
    // turn in the same chat was still running, and is never sent an answer.
    this.carried = this.resumePoint().waiting;
    this.lanes.clear();
    this.waitingChat = 0;
    this.waitingDecisions = 0;
    this.reportResumePoint();
    // Abort the long poll rather than leave it running for up to 30s (#882).
    // Whatever it would have returned is unconfirmed, so Telegram hands it to
    // the next adapter; left running, it could land after the new adapter's
    // first poll and be dropped here only by the check in startPolling.
    this.pollAbort?.abort();
    this.pollAbort = null;
    // After the abort: two getUpdates at once and Telegram ends one of them
    // with a 409.
    await this.confirmTaken();
    this.authentication = 'unknown';
    console.log('[TelegramAdapter] Disconnected');
  }

  /**
   * For a shutdown, not a settings save (#911): tell each chat with messages
   * still waiting that they were not read, once and without a retry (Q-07),
   * and forget them, so they are not handed to a next adapter either. Bounded
   * like the confirm, so a Telegram outage cannot hold the shutdown.
   */
  async dropWaiting(reply: string): Promise<void> {
    const chats = new Set<string>();
    // Only what Telegram has been told was read. An update above the
    // confirmed offset (the confirm failed, say) comes back to the next
    // process and is answered then; "send it again" would run it twice.
    const lost = (update: TelegramUpdate) => update.update_id < this.confirmedOffset;
    for (const queue of this.lanes.values()) {
      for (const { update, work } of queue) if (lost(update)) chats.add(String(work.message.chat.id));
    }
    // Handed over but never screened here if this adapter never connected:
    // screened now, so a sender the current list does not name is not
    // written to (#860).
    for (const update of this.carried) {
      const work = lost(update) ? this.screen(update) : null;
      if (work) chats.add(String(work.message.chat.id));
    }
    this.lanes.clear();
    this.carried = [];
    this.waitingChat = 0;
    this.waitingDecisions = 0;
    this.reportResumePoint();
    if (chats.size === 0) return;
    const sends = Promise.allSettled([...chats].map((chat) => this.sendMessage(chat, reply)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([sends, new Promise<void>((r) => { timer = setTimeout(r, TELEGRAM_CONFIRM_TIMEOUT_MS); })]);
    clearTimeout(timer);
  }

  /**
   * Tell Telegram the updates this adapter fetched are done (#911), so a
   * restart, which starts with nothing in memory, is not handed the update
   * this process took and answered (or was answering) again. Only the NEXT
   * `getUpdates` confirms an update, and on a stop there is no next one.
   *
   * This adapter's own offset, which never counts an update fetched after
   * disconnect() (#860): that one stays unconfirmed for whoever polls next.
   *
   * Nothing is persisted. An unclean exit still re-runs an update taken in
   * the last `pollingInterval` before it, since the loop polls again that
   * soon after handing an update off (#910). Persisting the offset would
   * also be unsafe: after a week without updates Telegram may number the
   * next one below it, and a saved offset would then skip every update.
   */
  private async confirmTaken(): Promise<void> {
    const offset = this.offset;
    if (offset <= this.confirmedOffset) return;
    try {
      const ok = await fetchWithTimeout(`${this.baseUrl}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, timeout: 0, limit: 1, allowed_updates: ['message'] }),
      }, TELEGRAM_CONFIRM_TIMEOUT_MS, async (r) => {
        const body = await r.json().catch(() => null) as { ok?: unknown } | null;
        return r.ok && body?.ok === true;
      });
      if (!ok) throw new Error('Telegram did not accept the call');
      this.confirmedOffset = offset;
      this.reportResumePoint();
    } catch (err) {
      console.warn('[TelegramAdapter] Could not confirm the updates taken before disconnecting; a restart may handle the last one again:', err instanceof Error ? err.message : err);
    }
  }

  async sendMessage(chatId: string, text: string, options?: SendOptions): Promise<void> {
    // Telegram has a 4096 char limit per message
    const chunks = splitText(text, 4096);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      try {
        const response = await fetchWithTimeout(`${this.baseUrl}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(telegramSendBody(chatId, chunk, options)),
        }, 15_000);

        // A proxy/outage 5xx can carry a non-JSON body; map it through the
        // status code instead of letting the parse error escape unclassified.
        const data = await response.json().catch(() => null) as any;
        this.observeAuthentication(response.status, data);

        if (!data?.ok) {
          // Retry without Markdown if parsing failed
          if (!options?.literal && data?.description?.includes('parse')) {
            const fallback = await fetchWithTimeout(`${this.baseUrl}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: chunk }),
            }, 15_000);
            const fallbackData = await fallback.json().catch(() => null);
            this.observeAuthentication(fallback.status, fallbackData);
            const fallbackError = telegramErrorFromResponse(fallback.status, fallbackData);
            if (fallbackError) throw fallbackError;
          } else {
            const error = telegramErrorFromResponse(response.status, data);
            if (error) throw error;
          }
        }
      } catch (error) {
        // Tag the error with the not-yet-sent portion (splitText is lossless,
        // so the slices concatenate back exactly) so a retrying caller can
        // resume from the failed chunk instead of duplicating sent ones.
        if (error instanceof Error && i > 0) {
          (error as Error & { remainingText?: string }).remainingText = chunks.slice(i).join('');
        }
        console.error('[TelegramAdapter] Error sending message:', error);
        throw error;
      }
    }
  }

  onMessage(handler: ChannelHandler): void {
    this.handler = handler;
  }

  isConnected(): boolean {
    return this.polling;
  }

  authenticationState(): 'verified' | 'rejected' | 'unknown' { return this.authentication; }

  private observeAuthentication(status: number, body: unknown): void {
    const data = body as { ok?: boolean; error_code?: number } | null;
    // A token rejection is sticky for this adapter, including across older in-flight successes.
    // A new adapter/token or explicit connect performs a new getMe validation.
    if (status === 401 || data?.error_code === 401) this.authentication = 'rejected';
    else if (this.authentication !== 'rejected' && data?.ok === true && status >= 200 && status < 300) this.authentication = 'verified';
  }

  private async startPolling(): Promise<void> {
    console.log('[TelegramAdapter] Starting polling...');

    while (this.polling) {
      let fullBatch = false;
      try {
        const updates = await this.getUpdates();
        fullBatch = updates.length >= TELEGRAM_UPDATES_LIMIT;

        for (const update of updates) {
          // A long poll outlives disconnect() by up to its 30s timeout, and a
          // settings save disconnects this adapter and builds a new one with
          // the new allow-list (#860). A batch that lands afterwards belongs
          // to the new adapter: handled here, it would be judged against the
          // OLD list, so a user just removed from it could still approve.
          // Left unhandled it is never confirmed (the offset only advances on
          // the next call), so Telegram hands it to the new adapter instead.
          if (!this.polling) break;
          // Already fetched and kept: never handle an update twice.
          if (update.update_id < this.offset) continue;
          // Counted before it is handled, so an update that throws is not
          // fetched again on every poll from now on.
          this.offset = update.update_id + 1;
          // Handed to a lane, not awaited (#910): a turn can run for minutes,
          // and awaiting it here held up every later message on the channel,
          // the owner's `approve <id>` included.
          this.intakeSafely(update);
        }
        this.reportResumePoint();
      } catch (error) {
        if (this.authentication !== 'rejected') this.authentication = 'unknown';
        // An aborted poll is disconnect() doing its job, not an error.
        if (this.polling) console.error('[TelegramAdapter] Polling error:', error);
      }

      if (!this.polling) break;
      // A full batch means more are already waiting at Telegram: fetch them
      // now, or a flood of dropped updates from strangers outpaces the
      // loop and the owner's reply waits behind it.
      if (fullBatch) continue;
      await new Promise(resolve => setTimeout(resolve, this.pollingInterval));
    }

    console.log('[TelegramAdapter] Polling stopped');
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    // Bound: server long-poll `timeout: 30` + ~5s slack. If the body's
    // `timeout` value changes, raise this bound to match.
    const abort = new AbortController();
    this.pollAbort = abort;
    const offset = this.offset;
    let data: TelegramGetUpdatesResponse;
    try {
      // The body is read inside the timeout and the abort too: reading it
      // outside left a stalled body able to hold the loop forever.
      data = await fetchWithTimeout(`${this.baseUrl}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset,
          timeout: 30,
          limit: TELEGRAM_UPDATES_LIMIT,
          allowed_updates: ['message'],
        }),
        signal: abort.signal,
      }, 35_000, async (r) => {
        const body = await r.json() as TelegramGetUpdatesResponse;
        // A poll disconnect() aborted must not mark a disconnected adapter verified.
        if (!abort.signal.aborted) this.observeAuthentication(r.status, body);
        return body;
      });
    } finally {
      if (this.pollAbort === abort) this.pollAbort = null;
    }

    if (!data.ok) {
      throw new Error('Failed to get updates');
    }
    // Counted only once answered: a poll that failed may never have arrived.
    this.confirmedOffset = Math.max(this.confirmedOffset, offset);

    return data.result;
  }

  private intakeSafely(update: TelegramUpdate): void {
    try {
      this.intake(update);
    } catch (err) {
      console.error(`[TelegramAdapter] Dropped update ${update.update_id}, which could not be read:`, err);
    }
  }

  /**
   * Take an update off the poll (#910). One that can be refused at once is
   * dropped here, so a stranger's flood never waits in a lane. The rest wait
   * in their lane until it reaches them.
   */
  private intake(update: TelegramUpdate): void {
    const work = this.screen(update);
    if (!work) return;
    const chat = String(work.message.chat.id);
    // Typed text only: a voice note is not known to be a decision until it is
    // transcribed, which happens in its turn.
    const text = work.message.text;
    const decision = !!text && this.isDecision?.(text) === true;
    if ((decision ? this.waitingDecisions : this.waitingChat) >= TELEGRAM_UPDATES_LIMIT) {
      console.warn(`[TelegramAdapter] ${TELEGRAM_UPDATES_LIMIT} messages already wait for an answer; not reading update ${update.update_id}`);
      const now = this.now();
      for (const [c, at] of this.busyRepliedAt) if (now - at >= TELEGRAM_BUSY_REPLY_INTERVAL_MS) this.busyRepliedAt.delete(c);
      if (!this.busyRepliedAt.has(chat)) {
        this.busyRepliedAt.set(chat, now);
        // Sent once, never again (Q-07); a failure only gets logged.
        this.sendMessage(chat, TELEGRAM_BUSY_REPLY).catch((err) => {
          console.error('[TelegramAdapter] Could not say a message was not read:', err);
        });
      }
      return;
    }
    const lane = decision ? `decision:${chat}` : `chat:${chat}`;
    const queue = this.lanes.get(lane);
    if (queue) queue.push({ update, work });
    else this.lanes.set(lane, [{ update, work }]);
    if (decision) this.waitingDecisions++;
    else this.waitingChat++;
    if (!this.runningLanes.has(lane)) {
      const run = this.runLane(lane);
      this.laneRuns.set(lane, run);
      void run.finally(() => { if (this.laneRuns.get(lane) === run) this.laneRuns.delete(lane); });
    }
  }

  /** Start a lane's updates one at a time, in order, until it is empty or the adapter is disconnected. */
  private async runLane(lane: string): Promise<void> {
    this.runningLanes.add(lane);
    try {
      // The same chat's turn the previous adapter is still answering (#910).
      if (lane.startsWith('chat:')) {
        try {
          await this.inherited.get(lane);
        } catch {
          // Its outcome is that adapter's to report; only its end matters here.
        }
      }
      while (this.polling) {
        const queue = this.lanes.get(lane);
        const next = queue?.shift();
        if (!next) break;
        if (queue!.length === 0) this.lanes.delete(lane);
        if (lane.startsWith('decision:')) this.waitingDecisions--;
        else this.waitingChat--;
        // Started: no longer handed to the next adapter (#882), even though
        // it is still being answered.
        this.reportResumePoint();
        try {
          await this.handle(next.work);
        } catch (error) {
          console.error('[TelegramAdapter] Error handling update:', error);
        }
      }
    } finally {
      this.runningLanes.delete(lane);
    }
  }

  /** Screen and handle one update directly, without a lane. Used by tests only. */
  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const work = this.screen(update);
    if (work) await this.handle(work);
  }

  /** The checks that need no I/O: who sent it, and whether it has anything to handle. */
  private screen(update: TelegramUpdate): TelegramWork | null {
    if (!update.message || !this.handler) return null;

    const { message } = update;

    // A message sent on behalf of a chat -- an anonymous group admin, a
    // "send as channel" post, a linked channel's automatic forward -- carries
    // `sender_chat`, and its `from` is a placeholder id that every such sender
    // shares (#885). Listing that id would list every anonymous admin of every
    // group, and this list decides who may approve a gated action, so a
    // message that cannot be traced to one person is not handled at all: it
    // can neither chat, decide, nor become the broadcast recipient.
    if (message.sender_chat || !message.from) {
      console.log(`[TelegramAdapter] Ignoring a message sent on behalf of a chat (${message.sender_chat?.title ?? message.sender_chat?.id ?? 'no sender'}): it cannot be attributed to one person`);
      return null;
    }
    const from = message.from;

    // Security: check allowed users. Empty admits everyone for chat, but not
    // for deciding an approval (senderAllowListed below, #811). A setting that
    // names nobody (a string, a quoted id) restricts to nobody (#883).
    if (this.allowList.restricted && !this.allowList.ids.includes(from.id)) {
      console.log(`[TelegramAdapter] Ignoring message from unauthorized user: ${from.id} (${from.username ?? from.first_name})`);
      return null;
    }

    if (!message.text && !message.voice && !message.audio) return null;
    return { message, from };
  }

  private async handle({ message, from }: TelegramWork): Promise<void> {
    const handler = this.handler;
    if (!handler) return;
    let text = message.text ?? '';

    // Handle voice/audio messages via STT
    const voiceFile = message.voice ?? message.audio;
    if (voiceFile && !text) {
      if (!this.sttProvider) {
        await this.sendMessage(
          message.chat.id.toString(),
          'Voice messages require STT configuration. Set up an STT provider in the Dashboard Settings.'
        );
        return;
      }
      try {
        const audioBuffer = await this.downloadFile(voiceFile.file_id);
        text = await this.sttProvider.transcribe(audioBuffer);
        console.log('[TelegramAdapter] Transcribed voice:', text.slice(0, 80));
      } catch (err) {
        console.error('[TelegramAdapter] STT error:', err);
        await this.sendMessage(
          message.chat.id.toString(),
          'Failed to transcribe voice message. Please try sending text.'
        );
        return;
      }
    }

    if (!text) return;

    const channelMessage: ChannelMessage = {
      id: message.message_id.toString(),
      channel: 'telegram',
      from: from.username || from.first_name,
      text,
      timestamp: message.date * 1000,
      metadata: {
        chatId: message.chat.id,
        userId: from.id,
        chatType: message.chat.type,
        firstName: from.first_name,
        lastName: from.last_name,
        isVoice: !!voiceFile,
      },
      senderAllowListed: this.allowList.ids.includes(from.id),
    };

    console.log('[TelegramAdapter] Message from', channelMessage.from, ':', channelMessage.text.slice(0, 80));

    try {
      const response = await handler(channelMessage);

      if (response) {
        await this.sendMessage(message.chat.id.toString(), response);
      }
    } catch (error) {
      console.error('[TelegramAdapter] Error handling message:', error);

      // A daemon shutting down refuses new turns (DrainingError, matched by
      // name: the daemon is not imported here). This message is not seen
      // again after the restart, so say so plainly.
      const restarting = error instanceof Error && error.name === 'DrainingError';
      await this.sendMessage(
        message.chat.id.toString(),
        restarting ? TELEGRAM_RESTARTING_REPLY : 'Sorry, I encountered an error processing your message.'
      );
    }
  }

  private async downloadFile(fileId: string): Promise<Buffer> {
    // Step 1: Get file path from Telegram
    const fileResp = await fetchWithTimeout(`${this.baseUrl}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    }, 10_000);
    const fileData = await fileResp.json() as any;

    if (!fileData.ok) {
      throw new Error(`Failed to get file info: ${fileData.description}`);
    }

    // Step 2: Download the actual file
    const filePath = fileData.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    const downloadResp = await fetchWithTimeout(downloadUrl, {}, 60_000);

    if (!downloadResp.ok) {
      throw new Error(`Failed to download file: ${downloadResp.status}`);
    }

    return Buffer.from(await downloadResp.arrayBuffer());
  }
}

/**
 * `fetch` bounded by `ms`, and aborted early when `init.signal` aborts. With
 * `read`, the body is read inside the same bound, and its result returned.
 */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response>;
async function fetchWithTimeout<T>(url: string, init: RequestInit, ms: number, read: (r: Response) => Promise<T>): Promise<T>;
async function fetchWithTimeout<T>(url: string, init: RequestInit, ms: number, read?: (r: Response) => Promise<T>): Promise<Response | T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  const outer = init.signal;
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  // Settles when either the request or the abort does: a body read does
  // not always notice its signal, so the abort is raced, not just passed on.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
  });
  aborted.catch(() => {});
  try {
    const run = (async () => {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return read ? await read(response) : response;
    })();
    run.catch(() => {});
    return await Promise.race([run, aborted]);
  } finally {
    clearTimeout(t);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx < maxLength / 2) splitIdx = maxLength;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}
