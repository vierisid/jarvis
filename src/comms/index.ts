// Core WebSocket and Streaming
export { WebSocketServer, type WSMessage, type WSClientHandler } from './websocket.ts';
export { StreamRelay } from './streaming.ts';

// Voice I/O
export {
  OpenAIWhisperSTT,
  GroqWhisperSTT,
  LocalWhisperSTT,
  EdgeTTSProvider,
  ElevenLabsTTSProvider,
  createSTTProvider,
  createTTSProvider,
  listElevenLabsVoices,
  splitIntoSentences,
  type STTProvider,
  type TTSProvider,
} from './voice.ts';

// Channel adapters
export {
  TelegramAdapter,
  type ChannelMessage,
  type ChannelHandler,
  type ChannelAdapter,
} from './channels/telegram.ts';
export { WhatsAppAdapter } from './channels/whatsapp.ts';
// DiscordAdapter is deliberately NOT re-exported here: discord.js costs
// ~38MB RSS at import time. Import it lazily from './channels/discord.ts'
// only when the Discord channel is enabled.
export { SignalAdapter } from './channels/signal.ts';

// Channel Manager
export class ChannelManager {
  private channels: Map<string, import('./channels/telegram.ts').ChannelAdapter> = new Map();
  private handler: import('./channels/telegram.ts').ChannelHandler | null = null;

  /**
   * Register a channel adapter
   */
  register(adapter: import('./channels/telegram.ts').ChannelAdapter): void {
    if (this.channels.has(adapter.name)) {
      console.warn(`[ChannelManager] Channel "${adapter.name}" already registered, overwriting`);
    }

    this.channels.set(adapter.name, adapter);
    console.log(`[ChannelManager] Registered channel: ${adapter.name}`);
  }

  /**
   * Set the message handler for all channels
   */
  setHandler(handler: import('./channels/telegram.ts').ChannelHandler): void {
    this.handler = handler;

    // Apply handler to all registered channels
    for (const adapter of this.channels.values()) {
      adapter.onMessage(handler);
    }

    console.log('[ChannelManager] Handler set for all channels');
  }

  /**
   * Connect all registered channels
   */
  async connectAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.channels.values()).map(async (adapter) => {
        try {
          await adapter.connect();
          console.log(`[ChannelManager] Connected: ${adapter.name}`);
        } catch (error) {
          console.error(`[ChannelManager] Failed to connect ${adapter.name}:`, error);
          throw error;
        }
      })
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      console.warn(`[ChannelManager] ${failures.length} channel(s) failed to connect`);
    }

    const successes = results.filter((r) => r.status === 'fulfilled').length;
    console.log(`[ChannelManager] ${successes}/${this.channels.size} channels connected`);
  }

  /**
   * Disconnect all registered channels
   */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.channels.values()).map(async (adapter) => {
        try {
          await adapter.disconnect();
          console.log(`[ChannelManager] Disconnected: ${adapter.name}`);
        } catch (error) {
          console.error(`[ChannelManager] Error disconnecting ${adapter.name}:`, error);
        }
      })
    );

    console.log('[ChannelManager] All channels disconnected');
  }

  /**
   * Remove every registered adapter. Callers must disconnectAll() first —
   * this only drops the references so a later register/connect cycle starts
   * from a clean slate. Without it, an adapter for a channel the user just
   * DISABLED would survive in the map and connectAll() would happily
   * reconnect it with the old token/allowlist.
   */
  unregisterAll(): void {
    this.channels.clear();
  }

  /**
   * Get a specific channel adapter by name
   */
  getChannel(name: string): import('./channels/telegram.ts').ChannelAdapter | undefined {
    return this.channels.get(name);
  }

  /**
   * List all registered channel names
   */
  listChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Get status of all channels
   */
  getStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const [name, adapter] of this.channels) {
      status[name] = adapter.isConnected();
    }
    return status;
  }
}
