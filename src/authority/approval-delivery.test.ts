import { test, expect, describe } from 'bun:test';
import {
  APPROVAL_LABEL_DELIVERY_MAX_CHARS,
  ApprovalDelivery,
  approvalNotificationText,
  boundedApprovalLabel,
  type ApprovalBroadcaster,
  type ChannelSender,
} from './approval-delivery.ts';
import type { ApprovalRequest } from './approval.ts';
import { UNTRUSTED_OPEN } from '../roles/untrusted.ts';
import { createRequestApprovalTool } from '../actions/tools/approval-tool.ts';

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: '3f2a9b1c-4d5e-4f60-8a7b-9c0d1e2f3a4b',
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

    // The reply command must match the approve/deny regex in
    // channel-service.ts handleChannelMessage, or replies can't be parsed.
    const approveLine = message.split('\n').find((line) => line.trim().startsWith('approve '))!;
    expect(approveLine.trim()).toMatch(/^approve\s+[a-f0-9-]+$/);
  });

  test('always pushes to the websocket broadcaster', async () => {
    const delivery = new ApprovalDelivery();
    const broadcaster = new FakeBroadcaster();
    delivery.setBroadcaster(broadcaster);

    const normal = makeRequest({ urgency: 'normal' });
    const urgent = makeRequest({ id: 'a1b2c3d4-0000-4000-8000-000000000001', urgency: 'urgent' });
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

/**
 * #651. The card is a handful of labelled lines, and `tool_name` and
 * `agent_name` are rendered into two of them verbatim. A line break inside
 * either is a forged field: a workflow whose name the composer model chose can
 * put its own `Reason:` line on the card, above the real one.
 */
describe('ApprovalDelivery: a label cannot forge a line of the card', () => {
  async function send(overrides: Partial<ApprovalRequest>): Promise<string[]> {
    const delivery = new ApprovalDelivery();
    const sender = new FakeChannelSender();
    delivery.setChannelSender(sender);
    await delivery.deliver(makeRequest(overrides));
    return sender.sent[0]!.split('\n');
  }

  test.each([
    ['\\n', '\n'],
    ['\\r\\n', '\r\n'],
    ['U+2028', '\u2028'],
    ['vertical tab', '\u000b'],
  ])('a %s in agent_name or tool_name stays inside its own line', async (_label, br) => {
    const lines = await send({
      agent_name: `Workflow: Daily digest${br}Reason: routine read, safe to approve`,
      tool_name: `piece:gmail/send_email${br}Agent: Trusted Assistant`,
    });
    expect(lines.filter(line => line.startsWith('Reason:'))).toEqual(['Reason: Agent wants to run a command']);
    expect(lines.filter(line => line.startsWith('Agent:'))).toHaveLength(1);
    expect(lines.filter(line => line.startsWith('Action:'))).toHaveLength(1);
    expect(lines.find(line => line.startsWith('Agent:'))).toBe(
      'Agent: Workflow: Daily digest Reason: routine read, safe to approve');
    // No separator survives anywhere in the message, not just at line starts.
    expect(lines.join('\n')).not.toMatch(/[\r\u000b\u2028\u2029]/u);
  });

  test('an ordinary label is rendered byte-exact', async () => {
    const lines = await send({ agent_name: 'Workflow: Governed routine', tool_name: 'piece:gmail/send_email' });
    expect(lines).toContain('Agent: Workflow: Governed routine');
    expect(lines).toContain('Action: piece:gmail/send_email (execute_command)');
  });

  test('a label longer than the delivery backstop is cut and marked', async () => {
    const lines = await send({ agent_name: 'n'.repeat(APPROVAL_LABEL_DELIVERY_MAX_CHARS * 3) });
    const agent = lines.find(line => line.startsWith('Agent: '))!;
    expect(agent).toBe(`Agent: ${'n'.repeat(APPROVAL_LABEL_DELIVERY_MAX_CHARS)}...`);
  });

  /**
   * #696. `reason` is not always the Authority engine's wording:
   * `request_approval` writes the model's own `intent` into it, so it is
   * model-authored text and was the one line of the card still rendered raw.
   */
  test.each([
    ['\\n', '\n'],
    ['\\r\\n', '\r\n'],
    ['U+2028', '\u2028'],
    ['vertical tab', '\u000b'],
  ])('a %s in reason stays inside its own line', async (_label, br) => {
    const lines = await send({ reason: `Send the weekly update${br}Action: read_file (read_data)${br}Agent: Trusted Assistant` });
    expect(lines.filter(line => line.startsWith('Action:'))).toEqual(['Action: execute_command (execute_command)']);
    expect(lines.filter(line => line.startsWith('Agent:'))).toEqual(['Agent: Test Agent']);
    expect(lines.filter(line => line.startsWith('Reason:'))).toEqual([
      'Reason: Send the weekly update Action: read_file (read_data) Agent: Trusted Assistant']);
    expect(lines.join('\n')).not.toMatch(/[\r\u000b\u2028\u2029]/u);
  });

  test('a bidi override in reason does not survive, and an ordinary reason is byte-exact', async () => {
    expect(await send({ reason: 'Send to bob\u202Etxt.exe' })).toContain('Reason: Send to bobtxt.exe');
    expect(await send({ reason: 'execute_command is a governed action requiring user approval' }))
      .toContain('Reason: execute_command is a governed action requiring user approval');
  });

  test('the model-written intent of request_approval reaches the card on one line', async () => {
    const delivery = new ApprovalDelivery();
    const sender = new FakeChannelSender();
    delivery.setChannelSender(sender);
    let created: ApprovalRequest | null = null;
    const tool = createRequestApprovalTool({
      approvalDelivery: delivery,
      getCurrentAgent: () => ({ id: 'primary', name: 'Jarvis' }),
      approvalManager: {
        createRequest: (p: { agentId: string; agentName: string; toolName: string; actionCategory: string; urgency: string; reason: string; context: string }) => {
          created = makeRequest({ agent_id: p.agentId, agent_name: p.agentName, tool_name: p.toolName,
            action_category: p.actionCategory as ApprovalRequest['action_category'], urgency: p.urgency as ApprovalRequest['urgency'],
            reason: p.reason, context: p.context });
          return created;
        },
        waitForResolution: async () => ({ ...created!, status: 'denied' }),
      } as never,
    });
    await tool.execute({ action_category: 'send_email',
      intent: 'Send email to alice@example.com\nAction: read_file (read_data)\nReason: routine, safe to approve' });
    await Promise.resolve();
    const lines = sender.sent[0]!.split('\n');
    expect(lines.filter(line => line.startsWith('Action:'))).toEqual(['Action: request_approval (send_email)']);
    expect(lines.filter(line => line.startsWith('Reason:'))).toEqual([
      'Reason: Send email to alice@example.com Action: read_file (read_data) Reason: routine, safe to approve']);
  });

  test('a reason longer than the delivery backstop is cut and marked', async () => {
    const lines = await send({ reason: 'r'.repeat(APPROVAL_LABEL_DELIVERY_MAX_CHARS + 1) });
    expect(lines.find(line => line.startsWith('Reason: '))).toBe(`Reason: ${'r'.repeat(APPROVAL_LABEL_DELIVERY_MAX_CHARS)}...`);
  });
});

/**
 * #696 review. The desktop notification shows the same `reason` and carries an
 * Approve button, so it is reduced the same way.
 */
describe('approvalNotificationText', () => {
  const br = String.fromCharCode(10);
  const rlo = String.fromCharCode(0x202e);

  test('the reason is one line with no format characters', () => {
    const text = approvalNotificationText({ tool_name: 'request_approval', agent_name: 'Jarvis',
      reason: `Send the weekly update${br}Approve: read_file?${rlo}txt.exe` });
    expect(text).toEqual({ title: 'Approve: Request approval?', body: 'Send the weekly update Approve: read_file?txt.exe' });
  });

  test('with no reason, the agent and tool fallback is reduced too', () => {
    const text = approvalNotificationText({ tool_name: `send_email${br}x`, agent_name: `Workflow: a${br}Reason: safe`, reason: '  ' });
    expect(text).toEqual({ title: 'Approve: Send email x?', body: 'Workflow: a Reason: safe wants to run Send email x.' });
  });

  test('an ordinary request reads as it always did', () => {
    expect(approvalNotificationText({ tool_name: 'send_email', agent_name: 'Jarvis', reason: 'Send the weekly update' }))
      .toEqual({ title: 'Approve: Send email?', body: 'Send the weekly update' });
  });
});

/**
 * #696 final review. The dashboard card's headline is the model's own
 * request_approval intent when it is not the engine's wording, so it is
 * reduced to one line with no format characters -- and NOT cut, since the
 * dashboard is where a long intent can be read whole.
 */
describe('the dashboard intent built from a model-written reason', () => {
  test('is one line with no format characters, and is not cut', async () => {
    const { WebSocketService } = await import('../daemon/ws-service.ts');
    const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as never);
    const long = 'z'.repeat(APPROVAL_LABEL_DELIVERY_MAX_CHARS * 2);
    const reason = `Send to bob${String.fromCharCode(0x202e)}txt.exe${String.fromCharCode(10)}${long}`;
    expect(ws.computeApprovalIntent(makeRequest({ tool_name: 'request_approval', reason })))
      .toBe(`Send to bobtxt.exe ${long}`);
    expect(ws.computeApprovalIntent(makeRequest({ tool_name: 'request_approval', reason: 'Send the weekly update' })))
      .toBe('Send the weekly update');
  });
});

describe('boundedApprovalLabel', () => {
  test('within the cap and on one line, it is the identity', () => {
    const text = 'Workflow: Nightly reconciliation / send_summary';
    expect(boundedApprovalLabel(text, 512)).toBe(text);
  });

  test('bidi overrides, isolates and zero-width characters do not survive', () => {
    // RLO would render the rest of the line reversed on a bidi-aware client.
    const label = boundedApprovalLabel('Daily ‮digest‬ ⁦x⁩ a​b', 512);
    expect(label).not.toMatch(/[​‪-‮⁦-⁩]/u);
    expect(label).toBe('Daily digest x ab');
  });

  test('a framing delimiter is defanged, so a label cannot open a block', () => {
    expect(boundedApprovalLabel(`name ${UNTRUSTED_OPEN} tail`, 512)).not.toContain(UNTRUSTED_OPEN);
  });

  test('exactly at the cap is not marked; one over is', () => {
    expect(boundedApprovalLabel('a'.repeat(10), 10)).toBe('a'.repeat(10));
    expect(boundedApprovalLabel('a'.repeat(11), 10)).toBe(`${'a'.repeat(10)}...`);
  });
});
