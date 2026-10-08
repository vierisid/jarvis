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

export class TelegramAdapter implements ChannelAdapter {
  name = 'telegram';
  private token: string;
  private handler: ChannelHandler | null = null;
  private polling: boolean = false;
  private offset: number = 0;
  private baseUrl: string;
  private pollingInterval: number = 1000;
  private sttProvider: STTProvider | null = null;
  /** Parsed, never the raw setting: a string there was a substring match (#883). */
  private allowList: AllowList<number>;

  constructor(token: string, opts?: { sttProvider?: STTProvider; allowedUsers?: unknown }) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.sttProvider = opts?.sttProvider ?? null;
    this.allowList = telegramAllowList(opts?.allowedUsers);
  }

  setSTTProvider(provider: STTProvider): void {
    this.sttProvider = provider;
  }

  async connect(): Promise<void> {
    if (this.polling) {
      console.warn('[TelegramAdapter] Already connected');
      return;
    }

    // Verify bot token by calling getMe (with timeout so an unreachable
    // api.telegram.org or hung connection doesn't block daemon startup)
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/getMe`, {}, 10_000);
      const data = await response.json() as any;

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
    this.startPolling();
  }

  async disconnect(): Promise<void> {
    this.polling = false;
    console.log('[TelegramAdapter] Disconnected');
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

        if (!data?.ok) {
          // Retry without Markdown if parsing failed
          if (!options?.literal && data?.description?.includes('parse')) {
            const fallback = await fetchWithTimeout(`${this.baseUrl}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: chunk }),
            }, 15_000);
            const fallbackError = telegramErrorFromResponse(fallback.status, await fallback.json().catch(() => null));
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

  private async startPolling(): Promise<void> {
    console.log('[TelegramAdapter] Starting polling...');

    while (this.polling) {
      try {
        const updates = await this.getUpdates();

        for (const update of updates) {
          // A long poll outlives disconnect() by up to its 30s timeout, and a
          // settings save disconnects this adapter and builds a new one with
          // the new allow-list (#860). A batch that lands afterwards belongs
          // to the new adapter: handled here, it would be judged against the
          // OLD list, so a user just removed from it could still approve.
          // Left unhandled it is never confirmed (the offset only advances on
          // the next call), so Telegram hands it to the new adapter instead.
          if (!this.polling) break;
          await this.processUpdate(update);
        }
      } catch (error) {
        console.error('[TelegramAdapter] Polling error:', error);
      }

      await new Promise(resolve => setTimeout(resolve, this.pollingInterval));
    }

    console.log('[TelegramAdapter] Polling stopped');
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    // Bound: server long-poll `timeout: 30` + ~5s slack. If the body's
    // `timeout` value changes, raise this bound to match.
    const response = await fetchWithTimeout(`${this.baseUrl}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset: this.offset,
        timeout: 30,
        allowed_updates: ['message'],
      }),
    }, 35_000);

    const data: TelegramGetUpdatesResponse = await response.json() as TelegramGetUpdatesResponse;

    if (!data.ok) {
      throw new Error('Failed to get updates');
    }

    if (data.result.length > 0) {
      this.offset = data.result[data.result.length - 1]!.update_id + 1;
    }

    return data.result;
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    if (!update.message || !this.handler) return;

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
      return;
    }
    const from = message.from;

    // Security: check allowed users. Empty admits everyone for chat, but not
    // for deciding an approval (senderAllowListed below, #811). A setting that
    // names nobody (a string, a quoted id) restricts to nobody (#883).
    if (this.allowList.restricted && !this.allowList.ids.includes(from.id)) {
      console.log(`[TelegramAdapter] Ignoring message from unauthorized user: ${from.id} (${from.username ?? from.first_name})`);
      return;
    }

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
      const response = await this.handler(channelMessage);

      if (response) {
        await this.sendMessage(message.chat.id.toString(), response);
      }
    } catch (error) {
      console.error('[TelegramAdapter] Error handling message:', error);

      await this.sendMessage(
        message.chat.id.toString(),
        'Sorry, I encountered an error processing your message.'
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

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
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
