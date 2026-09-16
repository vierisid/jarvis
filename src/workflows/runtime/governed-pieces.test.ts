/**
 * Governed piece adapters: the effect a verified piece is about to dispatch
 * inside the engine has to clear the same Authority boundary as everything
 * else, and a piece with no adapter has to keep running exactly as it does.
 *
 * Each adapter carries a deny path and an approve path here. Both fail if the
 * adapter is removed from `GOVERNED_PIECE_ADAPTERS`: without it the authorize
 * backend reports `governed: false`, so the deny test stops rejecting and the
 * approve test stops producing an approval.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun } from '../db/repos/flow-run';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { resumeResolvedWorkflowEffects } from './effect-approval-scheduler';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends, type BuildServiceBackendsOptions } from './service-backends';
import { AUTHORITY_REQUIREMENTS, type ActionCategory } from '../../roles/authority';
import { GOVERNED_PIECE_ADAPTERS, governedPieceToolName, resolveGovernedPieceAction, sanitizePieceInput } from './piece-effects';
import { authorizePieceDispatch } from './piece-effect-guard';
import { SandboxApi } from '../sandbox-api/server';
import { EngineTokenSigner } from '../sandbox-api/engine-token';
import { SandboxRegistry } from '../sandbox-api/sandbox-registry';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

const GMAIL = '@activepieces/piece-gmail';
/** A real community entry from the catalogue, deliberately never governed. */
const COMMUNITY_PIECE = '@activepieces/piece-activecampaign';

function fixture(piece: string, action: string, level = 10) {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Governed routine', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'action', type: 'PIECE', settings: {
      pieceName: piece, pieceVersion: '0.0.1', actionName: action, input: {},
    } },
  } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const authority = new AuthorityEngine({ default_level: level, governed_categories: [], overrides: [],
    context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const approvals = new ApprovalManager();
  const deliveredApprovals: string[] = [];
  const options: BuildServiceBackendsOptions = { credentialResolver: new CredentialResolver(),
    llmManager: { chat: async () => ({ content: '' }) } as any,
    authorityEngine: authority, emergencyController: new EmergencyController(),
    auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(), approvalManager: approvals,
    onWorkflowApproval: request => { deliveredApprovals.push(request.id); },
    channelService: { getChannelStatus: () => ({}), tryBroadcastToChannels: async () => ({ delivered: [], failed: [] }) } as any,
    wsService: { broadcastNotificationToDashboard: () => {} } as any };
  const backends = buildSandboxServiceBackends(options);
  const context = { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'action', executionPath: [] };
  const authorize = (input: Record<string, unknown> = {}) =>
    backends.pieceAuthorize!({ piece, action, input }, context);
  return { authority, approvals, deliveredApprovals, backends, context, run, version, authorize, options };
}

const SEND_INPUT = {
  receiver: ['finance@example.test'], cc: [], subject: 'Q3 invoice',
  body: 'The invoice is attached.', sender_name: 'Jarvis',
};

describe('governed piece adapters: the catalogue stays open', () => {
  test('a community piece is reported ungoverned and leaves no effect record', async () => {
    const f = fixture(COMMUNITY_PIECE, 'create_contact');
    expect(await f.authorize({ email: 'someone@example.test' })).toEqual({ governed: false });
    expect(listWorkflowEffects(f.run.id)).toHaveLength(0);
    // Nothing is refused: the step goes on to run in the engine as it does today.
    expect(resolveGovernedPieceAction(COMMUNITY_PIECE, 'create_contact')).toBeNull();
  });

  test('the engine asks the daemon about nothing but governed pieces', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ governed: true, dispatch: 'authorized' }), { status: 200 });
    }) as unknown as typeof fetch;
    const base = { apiUrl: 'http://127.0.0.1:1/', engineToken: 't', stepName: 'action',
      executionPath: [] as Array<[string, number]>, fetchImpl };
    expect(await authorizePieceDispatch({ ...base, piece: COMMUNITY_PIECE, action: 'create_contact', input: {} }))
      .toEqual({ governed: false });
    expect(calls).toHaveLength(0);
    expect(await authorizePieceDispatch({ ...base, piece: GMAIL, action: 'send_email', input: SEND_INPUT }))
      .toEqual({ governed: true, dispatch: 'authorized' });
    expect(calls).toEqual(['http://127.0.0.1:1/v1/jarvis/pieces/authorize']);
  });

  test('a governed piece fails closed when the daemon will not authorize', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(authorizePieceDispatch({ apiUrl: 'http://127.0.0.1:1', engineToken: 't', stepName: 'action',
      executionPath: [], fetchImpl, piece: GMAIL, action: 'send_email', input: SEND_INPUT }))
      .rejects.toThrow(/was not authorized/);
    const throwing = (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch;
    await expect(authorizePieceDispatch({ apiUrl: 'http://127.0.0.1:1', engineToken: 't', stepName: 'action',
      executionPath: [], fetchImpl: throwing, piece: GMAIL, action: 'send_email', input: SEND_INPUT }))
      .rejects.toThrow(/was not authorized/);
  });
});

describe('governed piece adapters: gmail', () => {
  test('a denied send is refused, recorded and never authorized', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.addOverride({ action: 'send_email', allowed: false });
    await expect(f.authorize(SEND_INPUT)).rejects.toThrow(/Authority denied/);
    const effect = listWorkflowEffects(f.run.id)[0]!;
    expect(effect).toMatchObject({ status: 'blocked', decision: 'denied', actionCategory: 'send_email',
      toolName: 'piece:gmail/send_email' });
    // The card names who would have received it, not just "gmail".
    expect(effect.target).toMatchObject({ piece: 'gmail', action: 'send_email',
      receiver: ['finance@example.test'], subject: 'Q3 invoice' });
    const audit = new AuditTrail().query({ agentId: `workflow:${f.run.id}` });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool_name: 'piece:gmail/send_email', action_category: 'send_email',
      authority_decision: 'denied', executed: 0 });
  });

  test('a governed send pauses for approval, then authorizes exactly once', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const pending = await f.authorize(SEND_INPUT);
    expect(pending).toMatchObject({ governed: true, dispatch: 'approval_required' });
    const approvalId = (pending as { approval: { approvalId: string } }).approval.approvalId;
    expect(f.deliveredApprovals).toEqual([approvalId]);

    // The human sees the resolved input, not a piece name.
    const request = f.approvals.getRequest(approvalId)!;
    expect(request.action_category).toBe('send_email');
    expect(JSON.parse(request.tool_arguments)).toMatchObject({
      receiver: ['finance@example.test'], subject: 'Q3 invoice', body: 'The invoice is attached.' });
    expect(JSON.parse(request.context)).toMatchObject({ target: { piece: 'gmail', action: 'send_email' } });

    // Re-asking before a decision returns the same waitpoint, never a dispatch.
    expect(await f.authorize(SEND_INPUT)).toEqual(pending);
    expect(f.approvals.getPending()).toHaveLength(1);

    f.approvals.approve(approvalId, 'test-user');
    updateRun(f.run.id, { status: 'PAUSED' });
    expect(resumeResolvedWorkflowEffects()).toBe(1);
    updateRun(f.run.id, { status: 'RUNNING' });

    // The step re-runs on RESUME and re-authorizes rather than trusting the
    // earlier decision; the claim makes the second attempt a replay.
    expect(await f.authorize(SEND_INPUT)).toEqual({ governed: true, dispatch: 'authorized' });
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'succeeded', decision: 'approval_required' });
    expect(await f.authorize(SEND_INPUT)).toEqual({ governed: true, dispatch: 'authorized' });
    expect(listWorkflowEffects(f.run.id)).toHaveLength(1);
  });

  test('an approval does not carry over to different arguments', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const pending = await f.authorize(SEND_INPUT);
    f.approvals.approve((pending as { approval: { approvalId: string } }).approval.approvalId, 'test-user');
    await expect(f.authorize({ ...SEND_INPUT, receiver: ['attacker@example.test'] })).rejects.toThrow(/changed/);
    expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('pending');
  });

  test('reading the mailbox is a read, not a send', async () => {
    // Level 1 clears read_data and nothing else; a send would be refused here.
    const f = fixture(GMAIL, 'gmail_search_mail', 1);
    expect(await f.authorize({ from: 'billing@example.test', max_results: 5 }))
      .toEqual({ governed: true, dispatch: 'authorized' });
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ actionCategory: 'read_data',
      toolName: 'piece:gmail/gmail_search_mail', status: 'succeeded' });
  });

  test('an action the table does not name is gated as the piece worst case', async () => {
    // Level 3 clears read_data and write_data. An unmapped action defaulting
    // to read_data would sail through here; the worst case must not.
    const f = fixture(GMAIL, 'gmail_purge_everything', 3);
    await expect(f.authorize({ label: 'INBOX' })).rejects.toThrow(/Authority level 3 is below required 9/);
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'blocked', actionCategory: 'delete_data',
      target: { unmappedAction: true } });
  });

  test('custom_api_call is gated as the piece worst case, not as its own name', async () => {
    const f = fixture(GMAIL, 'custom_api_call', 3);
    await expect(f.authorize({ url: '/users/me/messages/x', method: 'DELETE' })).rejects.toThrow(/below required 9/);
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ actionCategory: 'delete_data',
      target: { url: '/users/me/messages/x', method: 'DELETE' } });
  });

  test('the resolved connection never reaches the record or the card', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const secret = 'ya29.super-secret-access-token';
    const pending = await f.authorize({ ...SEND_INPUT, auth: { access_token: secret, refresh_token: secret } });
    const approvalId = (pending as { approval: { approvalId: string } }).approval.approvalId;
    const serialized = JSON.stringify({ effect: listWorkflowEffects(f.run.id)[0],
      approval: f.approvals.getRequest(approvalId) });
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('finance@example.test');
    // Stripped on the engine side too, before anything leaves the subprocess.
    expect(sanitizePieceInput({ subject: 'x', auth: { access_token: secret } })).toEqual({ subject: 'x' });
  });
});

describe('governed piece adapters: over the wire', () => {
  test('the engine guard reaches the daemon boundary through the real route', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.addOverride({ action: 'send_email', allowed: false });
    const signer = new EngineTokenSigner();
    const registry = new SandboxRegistry();
    const identity = { sandboxId: SandboxRegistry.newSandboxId(), runId: f.run.id, projectId: f.run.projectId };
    const { token } = await signer.mint(identity);
    registry.register({ ...identity, engineToken: token, expiresAt: Date.now() + 60_000, terminatedAt: null });
    const api = new SandboxApi({ signer, registry, services: f.backends });
    await api.start();
    try {
      // The real engine-side call, over HTTP, with the real token: route
      // registration, auth, step headers and daemon-side sanitizing included.
      await expect(authorizePieceDispatch({
        apiUrl: `${api.baseUrl}/`, engineToken: token, stepName: 'action', executionPath: [],
        piece: GMAIL, action: 'send_email',
        input: { ...SEND_INPUT, auth: { access_token: 'ya29.leaked-over-the-wire' } },
      })).rejects.toThrow(/was not authorized/);
    } finally { await api.stop(); }
    const effect = listWorkflowEffects(f.run.id)[0]!;
    expect(effect).toMatchObject({ status: 'blocked', actionCategory: 'send_email' });
    expect(JSON.stringify(effect)).not.toContain('ya29.leaked-over-the-wire');
  });
});

describe('governed piece adapter table', () => {
  test('every adapter names a real catalogue piece and a valid category', () => {
    for (const adapter of GOVERNED_PIECE_ADAPTERS) {
      expect(adapter.pieceName).toBe(`@activepieces/piece-${adapter.catalogId}`);
      const categories = [adapter.unknownActionCategory, ...Object.keys(adapter.categories) as ActionCategory[]];
      for (const category of categories) expect(AUTHORITY_REQUIREMENTS[category]).toBeGreaterThan(0);
    }
  });

  test('the fallback for an unmapped action is the worst case the piece can reach', () => {
    for (const adapter of GOVERNED_PIECE_ADAPTERS) {
      const fallback = AUTHORITY_REQUIREMENTS[adapter.unknownActionCategory];
      expect(fallback).toBeGreaterThan(AUTHORITY_REQUIREMENTS.read_data);
      for (const category of Object.keys(adapter.categories) as ActionCategory[]) {
        expect(fallback).toBeGreaterThanOrEqual(AUTHORITY_REQUIREMENTS[category]);
      }
    }
  });

  test('custom_api_call is never gated below the piece worst case', () => {
    for (const adapter of GOVERNED_PIECE_ADAPTERS) {
      const resolved = resolveGovernedPieceAction(adapter.pieceName, 'custom_api_call')!;
      expect(AUTHORITY_REQUIREMENTS[resolved.category])
        .toBe(AUTHORITY_REQUIREMENTS[adapter.unknownActionCategory]);
    }
  });

  test('adapter tool names cannot collide with a registry tool name', async () => {
    const { BUILTIN_TOOLS } = await import('../../actions/tools/builtin');
    const builtin = new Set(BUILTIN_TOOLS.map(tool => tool.name));
    for (const adapter of GOVERNED_PIECE_ADAPTERS) {
      for (const names of Object.values(adapter.categories)) {
        for (const action of names ?? []) {
          const name = governedPieceToolName(adapter.catalogId, action);
          expect(builtin.has(name)).toBe(false);
          expect(name).toContain(':');
        }
      }
    }
  });
});
