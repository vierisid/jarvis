import { test, expect, describe } from 'bun:test';
import {
  ApprovalDelivery,
  type ApprovalBroadcaster,
  type ChannelSender,
} from './approval-delivery.ts';
import type { ApprovalRequest } from './approval.ts';

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'req-1234-5678-abcd',
    agent_id: 'agent-1',
    agent_name: 'Test Agent',
    tool_name: 'execute_command',
    tool_arguments: '{"command":"ls"}',
    action_category: 'execute_command',
    urgency: 'normal',
    reason: 'Agent wants to run a command',
    context: '',
    status: 'pending',
    execution_mode: 'deferred',
    decided_at: null,
    decided_by: null,
    executed_at: null,
    execution_result: null,
    created_at: Date.now(),
    ...overrides,
  };
}

class FakeBroadcaster implements ApprovalBroadcaster {
  public received: ApprovalRequest[] = [];
  broadcastApprovalRequest(request: ApprovalRequest): void {
    this.received.push(request);
  }
}

class FakeChannelSender implements ChannelSender {
  private throwOnSend: Error | null;
  public sent: string[] = [];
  constructor(opts?: { throwOnSend?: Error }) {
    this.throwOnSend = opts?.throwOnSend ?? null;
  }
  async broadcastToAll(text: string): Promise<void> {
    if (this.throwOnSend) throw this.throwOnSend;
    this.sent.push(text);
  }
}

describe('ApprovalDelivery', () => {
  test('delivers normal-urgency requests to external channels', async () => {
    const delivery = new ApprovalDelivery();
    const sender = new FakeChannelSender();
    delivery.setChannelSender(sender);

    await delivery.deliver(makeRequest({ urgency: 'normal' }));

    expect(sender.sent).toHaveLength(1);
  });

  test('delivers urgent requests to external channels', async () => {
    const delivery = new ApprovalDelivery();
    const sender = new FakeChannelSender();
    delivery.setChannelSender(sender);

    await delivery.deliver(makeRequest({ urgency: 'urgent' }));

    expect(sender.sent).toHaveLength(1);
  });

  test('channel message includes the approve/deny reply commands with the short id', async () => {
    const delivery = new ApprovalDelivery();
    const sender = new FakeChannelSender();
    delivery.setChannelSender(sender);

    const request = makeRequest();
    await delivery.deliver(request);

    const shortId = request.id.slice(0, 8);
    const message = sender.sent[0]!;
    expect(message).toContain('[APPROVAL NEEDED]');
    expect(message).toContain(`approve ${shortId}`);
    expect(message).toContain(`deny ${shortId}`);
    expect(message).toContain(request.tool_name);
    expect(message).toContain(request.agent_name);
    expect(message).toContain(request.reason);
  });

  test('always pushes to the websocket broadcaster', async () => {
    const delivery = new ApprovalDelivery();
    const broadcaster = new FakeBroadcaster();
    delivery.setBroadcaster(broadcaster);

    const normal = makeRequest({ urgency: 'normal' });
    const urgent = makeRequest({ id: 'req-urgent-0001', urgency: 'urgent' });
    await delivery.deliver(normal);
    await delivery.deliver(urgent);

    expect(broadcaster.received).toEqual([normal, urgent]);
  });

  test('a channel send failure does not reject and does not skip the broadcaster', async () => {
    const delivery = new ApprovalDelivery();
    const broadcaster = new FakeBroadcaster();
    const sender = new FakeChannelSender({ throwOnSend: new Error('telegram down') });
    delivery.setBroadcaster(broadcaster);
    delivery.setChannelSender(sender);

    await expect(delivery.deliver(makeRequest())).resolves.toBeUndefined();
    expect(broadcaster.received).toHaveLength(1);
    expect(sender.sent).toHaveLength(0);
  });

  test('resolves when no broadcaster or channel sender is wired', async () => {
    const delivery = new ApprovalDelivery();

    await expect(delivery.deliver(makeRequest())).resolves.toBeUndefined();
  });
});
