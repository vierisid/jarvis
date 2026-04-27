import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js';
import type { ChannelAdapter, ChannelHandler, ChannelMessage } from './telegram.ts';
import type { STTProvider } from '../voice.ts';

export class DiscordAdapter implements ChannelAdapter {
  name = 'discord';
  private token: string;
  private handler: ChannelHandler | null = null;
  private connected: boolean = false;
  private client: Client | null = null;
  private allowedUsers: string[];
  private guildId: string | null;
  private sttProvider: STTProvider | null;

  constructor(token: string, opts?: {
    allowedUsers?: string[];
    guildId?: string;
    sttProvider?: STTProvider;
  }) {
    this.token = token;
    this.allowedUsers = opts?.allowedUsers ?? [];
    this.guildId = opts?.guildId ?? null;
    this.sttProvider = opts?.sttProvider ?? null;
  }

  setSTTProvider(provider: STTProvider): void {
    this.sttProvider = provider;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      console.warn('[DiscordAdapter] Already connected');
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    // Wait for ready event
    let loginTimeout: ReturnType<typeof setTimeout> | null = null;
    const readyPromise = new Promise<void>((resolve, reject) => {
      loginTimeout = setTimeout(() => reject(new Error('Discord login timed out')), 30000);

      this.client!.once('ready', () => {
        clearTimeout(loginTimeout!);
        this.connected = true;
        console.log(`[DiscordAdapter] Connected as: ${this.client!.user?.tag}`);
        resolve();
      });

      this.client!.once('error', (err) => {
        clearTimeout(loginTimeout!);
        reject(err);
      });
    });
    // Suppress unhandled-rejection if readyPromise rejects after connect() has already thrown.
    readyPromise.catch(() => {});

    // Set up message handler
    this.client.on('messageCreate', async (message: Message) => {
      try {
        await this.processMessage(message);
      } catch (err) {
        console.error('[DiscordAdapter] Unhandled error in processMessage:', err);
      }
    });

    try {
      await this.client.login(this.token);
      await readyPromise;
    } catch (err) {
      if (loginTimeout) clearTimeout(loginTimeout);
      try {
        await this.client?.destroy();
      } catch {
        // ignore destroy errors during cleanup
      }
      this.client = null;
      this.connected = false;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.connected = false;
    console.log('[DiscordAdapter] Disconnected');
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('Discord not connected');

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Invalid or non-text channel: ${channelId}`);
    }

    const chunks = splitMessage(text, 2000);
    for (const chunk of chunks) {
      await (channel as any).send(chunk);
    }
  }

  onMessage(handler: ChannelHandler): void {
    this.handler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async processMessage(message: Message): Promise<void> {
    // Ignore bot messages (including our own)
    if (message.author.bot) return;
    if (!this.handler) return;

    // Security: check allowed users (empty = allow all)
    if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(message.author.id)) {
      return;
    }

    // Security: check guild restriction
    if (this.guildId && message.guildId && message.guildId !== this.guildId) {
      return;
    }

    let text = message.content;

    // Handle audio attachments via STT
    const audioAttachment = message.attachments.find(a =>
      a.contentType?.startsWith('audio/') ||
      a.name?.endsWith('.ogg') ||
      a.name?.endsWith('.mp3') ||
      a.name?.endsWith('.wav') ||
      a.name?.endsWith('.m4a')
    );

    if (audioAttachment && !text && this.sttProvider) {
      try {
        const resp = await fetch(audioAttachment.url);
        if (!resp.ok) throw new Error(`Failed to download: ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        text = await this.sttProvider.transcribe(buffer);
        console.log('[DiscordAdapter] Transcribed audio:', text.slice(0, 80));
      } catch (err) {
        console.error('[DiscordAdapter] STT error:', err);
        await message.reply('Failed to transcribe audio. Please send text.');
        return;
      }
    }

    if (!text) return;

    const channelMessage: ChannelMessage = {
      id: message.id,
      channel: 'discord',
      from: message.author.username,
      text,
      timestamp: message.createdTimestamp,
      metadata: {
        userId: message.author.id,
        channelId: message.channelId,
        guildId: message.guildId,
        isDM: !message.guildId,
        isVoice: !!audioAttachment,
      },
    };

    console.log('[DiscordAdapter] Message from', channelMessage.from, ':', text.slice(0, 80));

    try {
      // Show typing indicator
      if (message.channel.isSendable()) {
        await message.channel.sendTyping();
      }

      const response = await this.handler(channelMessage);

      if (response) {
        const chunks = splitMessage(response, 2000);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      }
    } catch (err) {
      console.error('[DiscordAdapter] Error handling message:', err);
      try {
        await message.reply('Sorry, I encountered an error processing your message.');
      } catch {
        // Ignore send failure
      }
    }
  }
}

export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx < maxLength / 2) {
      // Try space
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx < maxLength / 2) {
      // Hard split
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
