/**
 * Channel Service — External Communication Channels
 *
 * Manages Telegram, Discord (and future) channel adapters.
 * Routes all external messages through the same AgentService (same brain),
 * persists conversations to the vault (unified history), and handles
 * proactive broadcasts to all connected channels.
 */

import type { Service, ServiceStatus } from './services.ts';
import type { AgentService } from './agent-service.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { ChannelAdapter, ChannelMessage } from '../comms/channels/telegram.ts';
import type { STTProvider } from '../comms/voice.ts';

import { ChannelManager } from '../comms/index.ts';
import { TelegramAdapter } from '../comms/channels/telegram.ts';
import { DiscordAdapter } from '../comms/channels/discord.ts';
import { createSTTProvider } from '../comms/voice.ts';
import { getOrCreateConversation, addMessage } from '../vault/conversations.ts';

export type ApprovalCommandHandler = (action: 'approve' | 'deny', shortId: string, channel: string) => Promise<string>;

export class ChannelService implements Service {
  name = 'channels';
  private _status: ServiceStatus = 'stopped';
  private config: JarvisConfig;
  private agentService: AgentService;
  private manager: ChannelManager;
  private sttProvider: STTProvider | null = null;
  /** Track last message sender per channel for proactive broadcasts */
  private lastRecipients = new Map<string, string>();
  /** Handler for approval commands (approve/deny) from external channels */
  private approvalHandler: ApprovalCommandHandler | null = null;

  constructor(config: JarvisConfig, agentService: AgentService) {
    this.config = config;
    this.agentService = agentService;
    this.manager = new ChannelManager();
  }

  setApprovalHandler(handler: ApprovalCommandHandler): void {
    this.approvalHandler = handler;
  }

  async start(): Promise<void> {
    this._status = 'starting';

    try {
      // 1. Create STT provider if configured
      if (this.config.stt) {
        this.sttProvider = createSTTProvider(this.config.stt);
        if (this.sttProvider) {
          console.log(`[ChannelService] STT provider: ${this.config.stt.provider}`);
        } else {
          console.log('[ChannelService] STT configured but no valid credentials — voice messages disabled');
        }
      }

      // 2. Create & register adapters from config
      const channels = this.config.channels;

      if (channels?.telegram?.enabled && channels.telegram.bot_token) {
        const telegram = new TelegramAdapter(channels.telegram.bot_token, {
          sttProvider: this.sttProvider ?? undefined,
          allowedUsers: channels.telegram.allowed_users,
        });
        this.manager.register(telegram);
      }

      if (channels?.discord?.enabled && channels.discord.bot_token) {
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
    try {
      await adapter.sendMessage(recipientId, text);
    } catch (err) {
      console.error(`[ChannelService] Failed to send to ${channelName}:`, err);
    }
  }

  /**
   * Broadcast a message to ALL connected external channels.
   * Uses the last known recipient per channel (from most recent inbound message).
   */
  async broadcastToAll(text: string): Promise<void> {
    for (const name of this.manager.listChannels()) {
      const adapter = this.manager.getChannel(name);
      if (!adapter?.isConnected()) continue;

      const lastRecipient = this.lastRecipients.get(name);
      if (!lastRecipient) {
        console.log(`[ChannelService] No known recipient for ${name}, skipping broadcast`);
        continue;
      }

      try {
        await adapter.sendMessage(lastRecipient, text);
      } catch (err) {
        console.error(`[ChannelService] Broadcast to ${name} failed:`, err);
      }
    }
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
      getLastRecipient: (name) => this.lastRecipients.get(name) ?? null,
    });
  }

  /**
   * Core message handler: receives from any channel, routes to AgentService,
   * persists to vault (unified history), returns response.
   */
  private async handleChannelMessage(msg: ChannelMessage): Promise<string> {
    const channelTag = msg.channel; // 'telegram' | 'discord'

    // Track recipient for future broadcasts
    const recipientId = String(msg.metadata.chatId ?? msg.metadata.channelId ?? msg.from);
    this.lastRecipients.set(channelTag, recipientId);

    // Check for approval commands: "approve <id>" or "deny <id>"
    const trimmed = msg.text.trim().toLowerCase();
    const approveMatch = trimmed.match(/^approve\s+([a-f0-9-]+)/i);
    const denyMatch = trimmed.match(/^deny\s+([a-f0-9-]+)/i);

    if (this.approvalHandler && (approveMatch || denyMatch)) {
      const action = approveMatch ? 'approve' : 'deny';
      const shortId = (approveMatch ?? denyMatch)![1];
      try {
        return await this.approvalHandler(action as 'approve' | 'deny', shortId!, channelTag);
      } catch (err) {
        return `Error processing approval: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 1. Persist inbound user message to vault
    const conversation = getOrCreateConversation(channelTag);
    addMessage(conversation.id, { role: 'user', content: msg.text });

    // 2. Route to AgentService (non-streaming — external channels are request/response)
    const response = await this.agentService.handleMessage(msg.text, channelTag);

    // 3. Persist assistant response to vault
    addMessage(conversation.id, { role: 'assistant', content: response });

    return response;
  }
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
        error: `no known recipient for "${name}" -- message Jarvis from that channel once to seed it`,
      });
      continue;
    }
    try {
      await adapter.sendMessage(lastRecipient, text);
      delivered.push(name);
    } catch (err) {
      failed.push({ channel: name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { delivered, failed };
}
