import type { STTProvider } from '../voice.ts';

export type ChannelMessage = {
  id: string;
  channel: string;
  from: string;
  text: string;
  timestamp: number;
  metadata: Record<string, unknown>;
};

export type ChannelHandler = (message: ChannelMessage) => Promise<string>;

export interface ChannelAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(to: string, text: string): Promise<void>;
  onMessage(handler: ChannelHandler): void;
  isConnected(): boolean;
}

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
    };
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
  private allowedUsers: number[];

  constructor(token: string, opts?: { sttProvider?: STTProvider; allowedUsers?: number[] }) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.sttProvider = opts?.sttProvider ?? null;
    this.allowedUsers = opts?.allowedUsers ?? [];
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

  async sendMessage(chatId: string, text: string): Promise<void> {
    // Telegram has a 4096 char limit per message
    const chunks = splitText(text, 4096);
    for (const chunk of chunks) {
      try {
        const response = await fetchWithTimeout(`${this.baseUrl}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: 'Markdown',
          }),
        }, 15_000);

        const data = await response.json() as any;

        if (!data.ok) {
          // Retry without Markdown if parsing failed
          if (data.description?.includes('parse')) {
            await fetchWithTimeout(`${this.baseUrl}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: chunk }),
            }, 15_000);
          } else {
            throw new Error(`Telegram API error: ${data.description}`);
          }
        }
      } catch (error) {
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

    // Security: check allowed users
    if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(message.from.id)) {
      console.log(`[TelegramAdapter] Ignoring message from unauthorized user: ${message.from.id} (${message.from.username ?? message.from.first_name})`);
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
      from: message.from.username || message.from.first_name,
      text,
      timestamp: message.date * 1000,
      metadata: {
        chatId: message.chat.id,
        userId: message.from.id,
        chatType: message.chat.type,
        firstName: message.from.first_name,
        lastName: message.from.last_name,
        isVoice: !!voiceFile,
      },
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
