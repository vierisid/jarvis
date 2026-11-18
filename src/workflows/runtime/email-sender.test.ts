/**
 * #957: an email step's card names the account it sends from and the message
 * it answers, read once when its effect is recorded, outside what the
 * approval is bound to.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { upsertConnection } from '../db/repos/app-connection';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { CredentialResolver, type JarvisConnectionSource } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { pieceInputDigest } from './piece-effect-guard';
import { setEncryptionKey } from '../db/encryption';

beforeEach(() => { initWorkflowDb(':memory:'); setEncryptionKey(Buffer.alloc(32, 57)); });
afterEach(() => { closeWorkflowDb(); setEncryptionKey(null); });

const GMAIL = '@activepieces/piece-gmail';
const SMTP = '@activepieces/piece-smtp';

function googleSource(calls: string[]): JarvisConnectionSource & Record<string, unknown> {
  return { id: 'google', pieceNames: [GMAIL], canResolve: id => id === 'jarvis:google', resolve: async () => null,
    accountLabel: async () => { calls.push('account'); return 'owner@example.test'; },
    messageSubject: async (id: string) => { calls.push(`subject:${id}`); return 'Q3 invoice'; } };
}

function fixture(piece: string, action: string, auth: string, sources: JarvisConnectionSource[] = []) {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Mail', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'send', type: 'PIECE', settings: {
      pieceName: piece, pieceVersion: '0.0.1', actionName: action, input: { auth } } } } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: ['send_email'], overrides: [],
    context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const resolver = new CredentialResolver();
  for (const source of sources) resolver.register(source);
  const backends = buildSandboxServiceBackends({ credentialResolver: resolver, llmManager: { chat: async () => ({ content: '' }) } as any,
    authorityEngine: authority, emergencyController: new EmergencyController(), auditTrail: new AuditTrail(),
    eventBuffer: new WorkflowEventBuffer(), approvalManager: new ApprovalManager(),
    channelService: { getChannelStatus: () => ({}), tryBroadcastToChannels: async () => ({ delivered: [], failed: [] }) } as any,
    wsService: { broadcastNotificationToDashboard: () => 1 } as any });
  const context = { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'send', executionPath: [] };
  const authorize = async (input: Record<string, unknown>) =>
    backends.pieceAuthorize!({ piece, action, input, inputDigest: await pieceInputDigest(input) }, context);
  return { run, authorize };
}

describe('the account an email goes out from, on its card (#957)', () => {
  test("Jarvis's Google connection: its address and the replied-to subject, read once", async () => {
    const calls: string[] = [];
    const f = fixture(GMAIL, 'reply_to_email', '{{connections.jarvis:google}}', [googleSource(calls)]);
    const input = { message_id: '18c0ffee', body: 'Thanks' };
    expect(await f.authorize(input)).toMatchObject({ dispatch: 'approval_required' });
    const [effect] = listWorkflowEffects(f.run.id);
    expect(effect!.sender).toEqual({ account: 'owner@example.test', replyTo: '"Q3 invoice" (message 18c0ffee)' });
    // Not part of what the approval is bound to.
    expect(JSON.stringify(effect!.arguments)).not.toContain('owner@example.test');
    // Asked again before a decision: the record is reused, nothing is read again.
    await f.authorize(input);
    expect(calls).toEqual(['account', 'subject:18c0ffee']);
  });

  test('a saved SMTP connection is named with its login and server, never its password', async () => {
    upsertConnection({ externalId: 'work-mail', displayName: 'Work mail', type: 'CUSTOM_AUTH', pieceName: SMTP, pieceVersion: '0.0.1',
      value: { type: 'CUSTOM_AUTH', props: { host: 'smtp.example.test', email: 'me@example.test', password: 'hunter2', port: '587' } } });
    const f = fixture(SMTP, 'send-email', '{{connections.work-mail}}');
    await f.authorize({ from: 'me@example.test', to: ['a@example.test'], subject: 'Hi', body: 'Hello' });
    const [effect] = listWorkflowEffects(f.run.id);
    expect(effect!.sender).toEqual({ account: 'Work mail (me@example.test via smtp.example.test)' });
    expect(JSON.stringify(effect)).not.toContain('hunter2');
  });

  test('a send whose account cannot be read still asks, and anything that is not an email send records none', async () => {
    const f = fixture(GMAIL, 'send_email', '{{connections.jarvis:google}}');
    expect(await f.authorize({ receiver: ['a@example.test'], subject: 'Hi', body: 'x' })).toMatchObject({ dispatch: 'approval_required' });
    expect(listWorkflowEffects(f.run.id)[0]!.sender).toBeUndefined();
    const read = fixture(GMAIL, 'gmail_create_draft', '{{connections.jarvis:google}}', [googleSource([])]);
    await read.authorize({ receiver: ['a@example.test'], subject: 'Hi', body: 'x' });
    expect(listWorkflowEffects(read.run.id)[0]!.sender).toBeUndefined();
  });
});
