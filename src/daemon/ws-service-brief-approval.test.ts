/**
 * #1075: a Brief-owned approval reaches its turn as a `brief_chat_event`, and
 * ALSO as the ordinary dashboard notification, so the existing approval card
 * shows it with its details. External channels still get exactly one card.
 */
import { expect, test } from 'bun:test';
import type { ApprovalRequest } from '../authority/approval.ts';
import { ApprovalDelivery, type ChannelSender } from '../authority/approval-delivery.ts';
import type { WSMessage } from '../comms/websocket.ts';
import type { BriefChatTransport } from '../brief/chat-transport.ts';
import type { BriefCapabilities } from '../brief/capabilities.ts';
import { WebSocketService } from './ws-service.ts';

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: '0d4c1f52-7a8b-4c9d-8e1f-2a3b4c5d6e7f', agent_id: 'a1', agent_name: 'PA', tool_name: 'run_command',
    tool_arguments: '{"command":"make deploy"}', action_category: 'execute_command', urgency: 'normal',
    reason: 'execute_command requires user approval', context: '', status: 'pending', execution_mode: 'deferred',
    decided_at: null, decided_by: null, executed_at: null, execution_result: null, created_at: 0, ...overrides,
  };
}

function fixture(owned: boolean) {
  const service = new WebSocketService(0, { setDelegationCallback: () => {} } as never);
  const broadcasts: WSMessage[] = [];
  service.getServer().broadcast = (message: WSMessage) => { broadcasts.push(message); };
  const briefCalls: string[] = [];
  const transport = { approval: (r: ApprovalRequest) => { briefCalls.push(`${r.id}:${r.status}`); return owned; },
    hasClient: () => false } as unknown as BriefChatTransport;
  service.setBriefChatTransport(transport, {} as BriefCapabilities);
  const sent: string[] = [];
  const sender: ChannelSender = { broadcastToAll: async (text: string) => { sent.push(text); } };
  const delivery = new ApprovalDelivery();
  delivery.setBroadcaster(service);
  delivery.setChannelSender(sender);
  return { service, broadcasts, briefCalls, sent, delivery };
}

const approvalFrames = (frames: WSMessage[], source: string) =>
  frames.filter(frame => frame.type === 'notification' && (frame.payload as { source?: string }).source === source);

for (const owned of [true, false]) {
  test(`an approval request is on the dashboard and in each channel exactly once (Brief-owned=${owned})`, async () => {
    const { broadcasts, briefCalls, sent, delivery } = fixture(owned);
    const pending = request();
    await delivery.deliver(pending);
    expect(briefCalls).toEqual([`${pending.id}:pending`]);
    const cards = approvalFrames(broadcasts, 'approval_request');
    expect(cards).toHaveLength(1);
    // The card carries the whole request, not just the id the Brief event has.
    expect((cards[0]!.payload as { request: ApprovalRequest }).request).toEqual(pending);
    expect((cards[0]!.payload as { shortId: string }).shortId).toBe(pending.id.slice(0, 8));
    expect(broadcasts).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(pending.id.slice(0, 8));
  });

  test(`an approval update reaches the dashboard exactly once (Brief-owned=${owned})`, () => {
    const { service, broadcasts, briefCalls, sent } = fixture(owned);
    const approved = request({ status: 'approved', decided_at: 1, decided_by: 'dashboard' });
    service.broadcastApprovalUpdate(approved);
    expect(briefCalls).toEqual([`${approved.id}:approved`]);
    const updates = approvalFrames(broadcasts, 'approval_update');
    expect(updates).toHaveLength(1);
    expect((updates[0]!.payload as { request: ApprovalRequest }).request).toEqual(approved);
    expect(broadcasts).toHaveLength(1);
    // Control only: broadcastApprovalUpdate has no channel path; the
    // exactly-once channel evidence is the request test above.
    expect(sent).toHaveLength(0);
  });
}
