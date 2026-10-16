import type { Suggestion } from '../awareness/types.ts';
import type { WebSocketServer } from '../comms/websocket.ts';
import type { ChannelService } from './channel-service.ts';
import { sendDesktopNotificationReceipt, type DesktopReceipt } from '../comms/desktop-notify.ts';
import { DeliveryUnconfirmedError } from '../comms/delivery.ts';

/**
 * Transport-only delivery. Never invoke the awareness/workflow event pipeline here.
 * Resolves the accepting transport, or null when nothing took it. Throws
 * `DeliveryUnconfirmedError` when a channel may have taken it without
 * confirming (Q-19): then there is no desktop fallback and no retry, so the
 * same opportunity is never shown twice.
 */
export async function deliverOpportunityNotification(
  suggestion: Suggestion,
  sockets: Pick<WebSocketServer, 'broadcastWithReceipt'>,
  channels: Pick<ChannelService, 'tryBroadcastToChannels'> & { getManager(): { listChannels(): string[] } },
  desktop: (title: string, body: string, options?: { urgency?: 'low' | 'normal' | 'critical'; expireMs?: number }) =>
    Promise<DesktopReceipt | boolean> = sendDesktopNotificationReceipt,
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
  const names = channels.getManager().listChannels();
  let result: Awaited<ReturnType<ChannelService['tryBroadcastToChannels']>>;
  try {
    result = await channels.tryBroadcastToChannels(names, `**${title}**\n${body}\nOpportunity: ${id}`);
  } catch (err) {
    // The router reports each channel itself; one that threw part way may have sent.
    throw new DeliveryUnconfirmedError(names, err instanceof Error ? err.message : String(err));
  }
  if (result.delivered.length) return result.delivered.join(',');
  if (result.unknown.length) throw new DeliveryUnconfirmedError(result.unknown.map(u => u.channel));
  // Nothing was sent anywhere, so the local desktop cannot duplicate it. A
  // toast that timed out may be up: unconfirmed, never shown a second time.
  const shown = await desktop(`JARVIS: ${title}`, body, { urgency: 'critical', expireMs: 30000 });
  if (shown === 'unknown') throw new DeliveryUnconfirmedError(['desktop']);
  return shown === true || shown === 'shown' ? 'desktop' : null;
}
