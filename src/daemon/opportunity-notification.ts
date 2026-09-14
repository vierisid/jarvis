import type { Suggestion } from '../awareness/types.ts';
import type { WebSocketServer } from '../comms/websocket.ts';
import type { ChannelService } from './channel-service.ts';
import { sendDesktopNotificationWithReceipt } from '../comms/desktop-notify.ts';

/** Transport-only delivery. Never invoke the awareness/workflow event pipeline here. */
export async function deliverOpportunityNotification(
  suggestion: Suggestion,
  sockets: Pick<WebSocketServer, 'broadcastWithReceipt'>,
  channels: Pick<ChannelService, 'tryBroadcastToChannels'> & { getManager(): { listChannels(): string[] } },
  desktop = sendDesktopNotificationWithReceipt,
): Promise<string | null> {
  const { id, title, body, type } = suggestion;
  const timestamp = Date.now();
  const event = { type: 'suggestion_ready', data: { id, opportunityId: id, title, body, type }, timestamp };
  const cards = sockets.broadcastWithReceipt({ type: 'notification',
    payload: { source: 'awareness_event', event }, timestamp });
  const chat = sockets.broadcastWithReceipt({ type: 'chat',
    payload: { source: 'proactive', opportunityId: id, text: `**${title}**\n${body}` },
    priority: 'urgent', timestamp });
  if (cards > 0 || chat > 0) return 'websocket';

  // broadcastToAll() swallows failures. Use the explicit per-channel receipts.
  try {
    const result = await channels.tryBroadcastToChannels(channels.getManager().listChannels(),
      `**${title}**\n${body}\nOpportunity: ${id}`);
    if (result.delivered.length) return result.delivered.join(',');
  } catch { /* Try the local desktop when external delivery is unavailable. */ }
  return await desktop(`JARVIS: ${title}`, body, { urgency: 'critical', expireMs: 30000 }) ? 'desktop' : null;
}
