/**
 * #957: the same email from another run within 24 hours asks "send again?"
 * and names the earlier run; it is never refused.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS, getWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun } from '../db/repos/flow-run';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { pieceInputDigest } from './piece-effect-guard';
import { resumeResolvedWorkflowEffects } from './effect-approval-scheduler';
import { emailSendKey, EMAIL_DEDUP_WINDOW_MS } from './email-send-dedup';
import type { ActionCategory } from '../../roles/authority';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

const GMAIL = '@activepieces/piece-gmail';
const MAIL = { receiver: ['Ana@Example.test', 'bo@example.test'], subject: 'Q3 invoice', body: 'The invoice is attached.' };

/** One flow; each `run()` is a new run of it, at level 10 with sends not governed, so a send goes without asking. */
function flow(governed: ActionCategory[] = []) {
  const f = createFlow({});
  const version = createDraftVersion({ flowId: f.id, displayName: 'Invoice mailer', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'send', type: 'PIECE', settings: {
      pieceName: GMAIL, pieceVersion: '0.0.1', actionName: 'send_email', input: { auth: '{{connections.work}}' } } } } });
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: governed, overrides: [],
    context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const approvals = new ApprovalManager();
  const backends = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), llmManager: { chat: async () => ({ content: '' }) } as any,
    authorityEngine: authority, emergencyController: new EmergencyController(), auditTrail: new AuditTrail(),
    eventBuffer: new WorkflowEventBuffer(), approvalManager: approvals,
    channelService: { getChannelStatus: () => ({}), tryBroadcastToChannels: async () => ({ delivered: [], failed: [] }) } as any,
    wsService: { broadcastNotificationToDashboard: () => 1 } as any });
  const run = () => {
    const r = createFlowRun({ flowId: f.id, flowVersionId: version.id, status: 'RUNNING' });
    const context = { runId: r.id, projectId: DEFAULT_IDS.project, stepName: 'send', executionPath: [] };
    return { id: r.id, context,
      authorize: async (input: Record<string, unknown> = MAIL) =>
        backends.pieceAuthorize!({ piece: GMAIL, action: 'send_email', input, inputDigest: await pieceInputDigest(input) }, context) as Promise<any>,
      send: async (input: Record<string, unknown> = MAIL) => {
        const reply = await backends.pieceAuthorize!({ piece: GMAIL, action: 'send_email', input, inputDigest: await pieceInputDigest(input) }, context) as any;
        expect(reply).toMatchObject({ dispatch: 'authorized' });
        backends.pieceReceipt!(context, reply.effectId, { data: { id: 'm1', threadId: 't1' } });
      } };
  };
  return { run, approvals, version };
}

describe('the same email across runs (#957)', () => {
  test('a second run sending the same email asks "send again?" naming the first, and sends once approved', async () => {
    const f = flow();
    const first = f.run();
    await first.send();
    const second = f.run();
    const pending = await second.authorize();
    expect(pending).toMatchObject({ governed: true, dispatch: 'approval_required' });
    const card = f.approvals.getRequest(pending.approval.approvalId)!;
    expect(card.reason).toStartWith('Send again? The same email (same account, recipients, subject and body) was sent at ');
    expect(card.reason).toContain(`by run ${first.id} of "Invoice mailer"`);
    expect(listWorkflowEffects(second.id)[0]!.duplicateOf).toMatchObject({ runId: first.id, state: 'sent', workflowName: 'Invoice mailer' });

    // Approved, the run resumes and the send goes out; asked again before that, it still waits.
    expect(await second.authorize()).toEqual(pending);
    f.approvals.approve(card.id, 'owner');
    updateRun(second.id, { status: 'PAUSED' });
    expect(resumeResolvedWorkflowEffects()).toBe(1);
    updateRun(second.id, { status: 'RUNNING' });
    expect(await second.authorize()).toMatchObject({ dispatch: 'authorized' });
  });

  test('recipients in another order or case are the same email; another body, subject or account is not', async () => {
    const f = flow();
    await f.run().send();
    expect(await f.run().authorize({ ...MAIL, receiver: ['BO@example.test', 'ana@example.test'] })).toMatchObject({ dispatch: 'approval_required' });
    expect(await f.run().authorize({ ...MAIL, body: 'Another invoice.' })).toMatchObject({ dispatch: 'authorized' });
    expect(await f.run().authorize({ ...MAIL, subject: 'Q4 invoice' })).toMatchObject({ dispatch: 'authorized' });
    expect(await f.run().authorize({ ...MAIL, cc: ['carl@example.test'] })).toMatchObject({ dispatch: 'authorized' });
    expect(emailSendKey('p', 'work', MAIL)).not.toBe(emailSendKey('p', 'personal', MAIL));
  });

  test('a first send still waiting for approval is named on the second card', async () => {
    const f = flow(['send_email']);
    const first = f.run();
    await first.authorize();
    const second = f.run();
    const pending = await second.authorize();
    expect(f.approvals.getRequest(pending.approval.approvalId)!.reason).toContain(`is already waiting for your approval in run ${first.id}`);
  });

  test('a send denied or older than 24 hours does not count; one whose run was deleted still does', async () => {
    const f = flow(['send_email']);
    const denied = f.run();
    const card = await denied.authorize();
    f.approvals.deny(card.approval.approvalId, 'owner');
    getWorkflowDb().run(`UPDATE workflow_effect SET status = 'blocked' WHERE run_id = ?`, [denied.id]);
    expect(f.approvals.getRequest((await f.run().authorize()).approval.approvalId)!.reason).not.toContain('Send again?');

    const later = { ...MAIL, subject: 'Q4 invoice' };
    const g = flow();
    const old = g.run();
    await old.send(later);
    getWorkflowDb().run('UPDATE workflow_email_send SET created_at = ? WHERE run_id = ?', [Date.now() - EMAIL_DEDUP_WINDOW_MS - 1000, old.id]);
    expect(await g.run().authorize(later)).toMatchObject({ dispatch: 'authorized' });

    // The same account across workflows is the same account: another email here.
    const other = { ...MAIL, subject: 'Q5 invoice' };
    const h = flow();
    const gone = h.run();
    await gone.send(other);
    getWorkflowDb().run('DELETE FROM flow_run WHERE id = ?', [gone.id]);
    const pending = await h.run().authorize(other);
    expect(h.approvals.getRequest(pending.approval.approvalId)!.reason).toContain(`may already have been sent at`);
  });
});
