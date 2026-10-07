/**
 * Q-05: a superseded fact cannot silently redirect, or keep, work. A governed
 * step addressing someone memory knows keeps the facts the address matched and
 * stops when they no longer hold: before anyone is asked to approve it, before
 * it dispatches, and before the engine's own retry. It never switches to the
 * address memory holds now.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun } from '../db/repos/flow-run';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager, type ApprovalRequest } from '../../authority/approval';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends, type BuildServiceBackendsOptions } from './service-backends';
import { resumeResolvedWorkflowEffects } from './effect-approval-scheduler';
import { createEntity } from '../../vault/entities';
import { correctFact, createFact, deleteFact } from '../../vault/facts';
import { ActionOutcomeError } from '../../actions/action-outcome';
import { assertRecipientFactsCurrent, recipientAddresses, recipientFactPins } from './fact-bindings';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

const GMAIL = '@activepieces/piece-gmail';
const outcomeOf = (act: () => unknown) => {
  try { act(); return null; } catch (error) { expect(error).toBeInstanceOf(ActionOutcomeError); return (error as ActionOutcomeError).outcome; }
};
const ana = () => createEntity('person', 'Ana').id;

function fixture(action = 'send_email', onWorkflowApproval?: (request: ApprovalRequest) => void) {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Invoice reminder', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'action', type: 'PIECE', settings: { pieceName: GMAIL, pieceVersion: '0.0.1', actionName: action, input: {} } } } as any });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [],
    context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const approvals = new ApprovalManager();
  const options: BuildServiceBackendsOptions = { credentialResolver: new CredentialResolver(),
    llmManager: { chat: async () => ({ content: '' }) } as any, authorityEngine: authority,
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(), approvalManager: approvals, onWorkflowApproval,
    channelService: { getChannelStatus: () => ({}), tryBroadcastToChannels: async () => ({ delivered: [], failed: [] }) } as any,
    wsService: { broadcastNotificationToDashboard: () => {} } as any };
  const backends = buildSandboxServiceBackends(options);
  const authorize = (receiver: string) => backends.pieceAuthorize!({ piece: GMAIL, action,
    input: { receiver: [receiver], subject: 'Invoices', body: 'Hi Ana' } }, { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'action', executionPath: [] });
  return { run, authority, approvals, authorize };
}

describe('which addresses and facts a step depends on', () => {
  test('only email addresses in the props that address people', () => {
    expect(recipientAddresses({ receiver: ['ana@example.com', 'not an address'], cc: '["bob@example.com"]',
      attendees: ['ana@example.com'], subject: 'hello@example.com' })).toEqual(['ana@example.com', 'bob@example.com']);
  });

  test('an address memory knows must still be current; one it does not know is not checked', () => {
    const subject = ana();
    const old = createFact(subject, 'email', 'ana@old.example', { confirmed: true });
    expect(recipientFactPins(['Ana@Old.Example', 'nobody@example.com'])).toEqual([{ value: 'Ana@Old.Example', factIds: [old.id] }]);
    expect(outcomeOf(() => assertRecipientFactsCurrent(recipientFactPins(['ana@old.example'])))).toBeNull();
    correctFact(old.id, 'ana@new.example', 'Ana moved');
    expect(outcomeOf(() => assertRecipientFactsCurrent(recipientFactPins(['ana@old.example'])))).toMatchObject({ status: 'blocked',
      code: 'WORKFLOW_FACT_STALE', effect: 'not_started',
      message: 'Recipient ana@old.example is no longer current in memory (the fact was superseded). Nothing was sent. '
        + 'Update the workflow or the fact, then start a new run; the send never switches to another address on its own.' });
    expect(outcomeOf(() => assertRecipientFactsCurrent(recipientFactPins(['ana@new.example'])))).toBeNull();
  });

  test('an expired, deleted or contested fact stops the step too', () => {
    const subject = ana();
    createFact(subject, 'email', 'ana@expired.example', { validTo: Date.now() - 1000 });
    expect(outcomeOf(() => assertRecipientFactsCurrent(recipientFactPins(['ana@expired.example'])))?.message).toContain('(the fact was expired)');
    const doomed = createFact(subject, 'email', 'ana@gone.example');
    const pins = recipientFactPins(['ana@gone.example']);
    deleteFact(doomed.id);
    expect(outcomeOf(() => assertRecipientFactsCurrent(pins))?.message).toContain('(the fact was deleted)');
    createFact(subject, 'primary_email', 'ana@one.example');
    createFact(subject, 'primary_email', 'ana@two.example');
    expect(outcomeOf(() => assertRecipientFactsCurrent(recipientFactPins(['ana@one.example'])))).toMatchObject({ code: 'WORKFLOW_FACT_AMBIGUOUS' });
  });
});

describe('a governed send checks the facts its recipients matched', () => {
  test('a send to an address memory superseded is blocked before anyone is asked to approve it', async () => {
    const f = fixture();
    f.authority.setGovernedCategories(['send_email']);
    const old = createFact(ana(), 'email', 'ana@old.example', { confirmed: true });
    correctFact(old.id, 'ana@new.example', 'Ana moved');
    await expect(f.authorize('ana@old.example')).rejects.toThrow(/Recipient ana@old\.example is no longer current in memory/);
    expect(f.approvals.getPending()).toEqual([]);
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'blocked', approvalId: null,
      outcome: { code: 'WORKFLOW_FACT_STALE', effect: 'not_started' }, bindings: { facts: [{ value: 'ana@old.example', factIds: [old.id] }] } });
  });

  test('a fact superseded while the send waits for approval blocks it at dispatch, with its arguments still frozen', async () => {
    const f = fixture();
    f.authority.setGovernedCategories(['send_email']);
    const fact = createFact(ana(), 'email', 'ana@old.example', { confirmed: true });
    const pending = await f.authorize('ana@old.example') as { approval: { approvalId: string } };
    correctFact(fact.id, 'ana@new.example', 'Ana moved while the card waited');
    f.approvals.approve(pending.approval.approvalId, 'test-user');
    updateRun(f.run.id, { status: 'PAUSED' });
    expect(resumeResolvedWorkflowEffects()).toBe(1);
    updateRun(f.run.id, { status: 'RUNNING' });
    await expect(f.authorize('ana@old.example')).rejects.toThrow(/no longer current in memory/);
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'blocked', outcome: { code: 'WORKFLOW_FACT_STALE' },
      arguments: { receiver: ['ana@old.example'] } });
  });

  test('a fact superseded while the card is delivered blocks the send even when it is approved at once', async () => {
    let delivered = (_request: ApprovalRequest) => {};
    const f = fixture('send_email', request => delivered(request));
    f.authority.setGovernedCategories(['send_email']);
    const fact = createFact(ana(), 'email', 'ana@old.example', { confirmed: true });
    delivered = request => {
      correctFact(fact.id, 'ana@new.example', 'Ana moved as the card went out');
      f.approvals.approve(request.id, 'test-user');
    };
    await expect(f.authorize('ana@old.example')).rejects.toThrow(/no longer current in memory/);
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'blocked', outcome: { code: 'WORKFLOW_FACT_STALE' } });
  });

  test("the engine's own retry of an authorized send rechecks memory before the service is called again", async () => {
    const f = fixture();
    const fact = createFact(ana(), 'email', 'ana@old.example', { confirmed: true });
    expect(await f.authorize('ana@old.example')).toEqual({ governed: true, dispatch: 'authorized' });
    correctFact(fact.id, 'ana@new.example', 'Ana moved between attempts');
    await expect(f.authorize('ana@old.example')).rejects.toThrow(/no longer current in memory/);
  });

  test('reading mail is never blocked by a recipient fact', async () => {
    const f = fixture('gmail_search_mail');
    const fact = createFact(ana(), 'email', 'ana@old.example', { confirmed: true });
    correctFact(fact.id, 'ana@new.example', 'Ana moved');
    expect(await f.authorize('ana@old.example')).toEqual({ governed: true, dispatch: 'authorized' });
    expect(listWorkflowEffects(f.run.id)[0]!.bindings).toBeUndefined();
  });
});
