/**
 * #957: a sent email's provider ids reach the audit trail on its receipt row,
 * and only the ids; the audit view reads account, recipients and subject from
 * the workflow effect, while it exists.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS, getWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { pieceInputDigest } from './piece-effect-guard';
import { emailReceiptIds } from './email-receipt';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

const GMAIL = '@activepieces/piece-gmail';
const SMTP = '@activepieces/piece-smtp';

describe('provider ids of a sent email (#957)', () => {
  test('Gmail gives its message and thread ids, SMTP its Message-ID, anything else nothing', () => {
    expect(emailReceiptIds(GMAIL, 'send_email', { data: { id: '18c0ffee', threadId: '18c0aaaa', labelIds: ['SENT'] }, status: 200 }))
      .toEqual({ messageId: '18c0ffee', threadId: '18c0aaaa' });
    expect(emailReceiptIds(SMTP, 'send-email', { messageId: '<abc@example.test>', accepted: ['a@example.test'] })).toEqual({ messageId: '<abc@example.test>' });
    expect(emailReceiptIds(GMAIL, 'gmail_add_label_to_email', { data: { id: 'x' } })).toEqual({});
    expect(emailReceiptIds('@activepieces/piece-slack', 'send_channel_message', { data: { id: 'x' } })).toEqual({});
    expect(emailReceiptIds(GMAIL, 'send_email', { data: { id: 'bad\nid', threadId: 'x'.repeat(300) } })).toEqual({});
    expect(emailReceiptIds(GMAIL, 'send_email', null)).toEqual({});
  });

  test('the receipt row carries the ids; the entry shows the rest from the effect, and only while it exists', async () => {
    const flow = createFlow({});
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Mailer', trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
      name: 'send', type: 'PIECE', settings: { pieceName: GMAIL, pieceVersion: '0.0.1', actionName: 'send_email', input: { auth: '{{connections.work}}' } } } } });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
    const trail = new AuditTrail();
    const backends = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), llmManager: { chat: async () => ({ content: '' }) } as any,
      authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
        learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
      emergencyController: new EmergencyController(), auditTrail: trail, eventBuffer: new WorkflowEventBuffer(), approvalManager: new ApprovalManager(),
      channelService: { getChannelStatus: () => ({}), tryBroadcastToChannels: async () => ({ delivered: [], failed: [] }) } as any,
      wsService: { broadcastNotificationToDashboard: () => 1 } as any });
    const context = { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'send', executionPath: [] };
    const input = { receiver: ['ana@example.test'], cc: ['bo@example.test'], subject: 'Q3 invoice', body: 'Attached.' };
    const reply = await backends.pieceAuthorize!({ piece: GMAIL, action: 'send_email', input, inputDigest: await pieceInputDigest(input) }, context) as any;
    expect(reply).toMatchObject({ dispatch: 'authorized' });
    backends.pieceReceipt!(context, reply.effectId, { data: { id: '18c0ffee', threadId: '18c0aaaa' }, status: 200 });

    const [entry] = trail.queryEntries().filter(e => e.effect_id === reply.effectId);
    expect(entry).toMatchObject({ outcome: 'succeeded', provider_message_id: '18c0ffee', provider_thread_id: '18c0aaaa',
      email: { to: ['ana@example.test'], cc: ['bo@example.test'], subject: 'Q3 invoice' } });
    // The long-lived rows hold the ids, never the recipients or the subject.
    const rows = JSON.stringify(getWorkflowDb().query('SELECT * FROM audit_trail').all());
    expect(rows).toContain('18c0ffee');
    for (const kept of ['ana@example.test', 'bo@example.test', 'Q3 invoice']) expect(rows).not.toContain(kept);

    // The run removed, the entry keeps its ids and outcome, and has nothing else to show.
    getWorkflowDb().run('DELETE FROM flow_run WHERE id = ?', [run.id]);
    const [after] = trail.queryEntries().filter(e => e.effect_id === reply.effectId);
    expect(after).toMatchObject({ outcome: 'succeeded', provider_message_id: '18c0ffee', email: null });
  });
});
