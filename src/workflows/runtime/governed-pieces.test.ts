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
import { listWorkflowEffects, saveWorkflowEffect } from '../db/repos/workflow-effect';
import { workflowEffectId } from './effect-boundary';
import { resumeResolvedWorkflowEffects } from './effect-approval-scheduler';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { maxWaitingWorkflowCards } from './deferred-cards';
import { buildSandboxServiceBackends, type BuildServiceBackendsOptions } from './service-backends';
import { AUTHORITY_REQUIREMENTS, type ActionCategory } from '../../roles/authority';
import { DEFAULT_CONFIG } from '../../config/types';
import { ABOVE_LEVEL_SUBSTITUTION } from '../../authority/tool-action-map';
import { ALL_PIECE_ADAPTERS, GOVERNED_PIECE_ADAPTERS, governedPieceTarget, redactHttpInput, REDACTED, governedPieceToolDefinition, governedPieceToolName, RESERVED_TARGET_KEYS, isWellFormedPieceActionName, PIECE_ACTION_NAME_MAX_CHARS, reprojectPieceInput,
  resolveGovernedPieceAction, sanitizePieceInput, tracksPieceCompletion } from './piece-effects';
import { defangPieceProjection } from './piece-effect-receipt';
import { digest } from './effect-context';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN, wrapUntrusted } from '../../roles/untrusted';
import { authorizePieceDispatch, CODE_STEP_PIECE, PIECE_RECEIPT_MAX_BYTES, pieceInputDigest, receiptBody } from './piece-effect-guard';
import { getWaitpoint } from '../db/repos/waitpoint';
import { isCommunityPiece } from './step-admission';
import { WebSocketService } from '../../daemon/ws-service';
import { SandboxApi } from '../sandbox-api/server';
import { EngineTokenSigner } from '../sandbox-api/engine-token';
import { SandboxRegistry } from '../sandbox-api/sandbox-registry';
import { createJarvisPieceAuthorizeRoute, type JarvisPiecesRouteDeps } from '../sandbox-api/routes/jarvis-pieces';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

const GMAIL = '@activepieces/piece-gmail';
/** A real community entry from the catalogue, deliberately never governed. */
const COMMUNITY_PIECE = '@activepieces/piece-activecampaign';

function fixture(piece: string, action: string, level = 10, names: { displayName?: string; stepName?: string } = {}) {
  const stepName = names.stepName ?? 'action';
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: names.displayName ?? 'Governed routine', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: stepName, type: 'PIECE', settings: {
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
    wsService: { broadcastNotificationToDashboard: () => 1 } as any };
  const backends = buildSandboxServiceBackends(options);
  const context = { runId: run.id, projectId: DEFAULT_IDS.project, stepName, executionPath: [] };
  const authorize = async (input: Record<string, unknown> = {}) =>
    backends.pieceAuthorize!({ piece, action, input, inputDigest: await pieceInputDigest(input) }, context);
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

  test('the engine asks the daemon about every piece, but only a governed one\'s input leaves it (Q-08)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:1/v1/jarvis/pieces/authorize');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return new Response(JSON.stringify(body.piece === GMAIL ? { governed: true, dispatch: 'authorized', effectId: 'wfe_fixture' } : { governed: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const base = { apiUrl: 'http://127.0.0.1:1/', engineToken: 't', stepName: 'action',
      executionPath: [] as Array<[string, number]>, fetchImpl };
    expect(await authorizePieceDispatch({ ...base, piece: COMMUNITY_PIECE, action: 'create_contact', input: { secret: 'x' } }))
      .toEqual({ governed: false });
    expect(bodies[0]).toEqual({ piece: COMMUNITY_PIECE, action: 'create_contact', input: {} });
    expect(await authorizePieceDispatch({ ...base, piece: GMAIL, action: 'send_email', input: SEND_INPUT }))
      .toEqual({ governed: true, dispatch: 'authorized', effectId: 'wfe_fixture' });
    expect(bodies[1]!.inputDigest).toMatch(/^[0-9a-f]{64}$/);
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
    // Any other step is admitted, not authorized, and its refusal says which it is (Q-08).
    await expect(authorizePieceDispatch({ apiUrl: 'http://127.0.0.1:1', engineToken: 't', stepName: 'action',
      executionPath: [], fetchImpl, piece: CODE_STEP_PIECE, action: 'run', input: {} }))
      .rejects.toThrow(/^CODE step was not admitted: daemon responded 503/);
    await expect(authorizePieceDispatch({ apiUrl: 'http://127.0.0.1:1', engineToken: 't', stepName: 'action',
      executionPath: [], fetchImpl, piece: COMMUNITY_PIECE, action: 'create_contact', input: {} }))
      .rejects.toThrow(`Piece step ${COMMUNITY_PIECE}/create_contact was not admitted`);
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
    const dispatched = await f.authorize(SEND_INPUT) as { effectId: string };
    expect(dispatched).toMatchObject({ governed: true, dispatch: 'authorized' });
    expect(typeof dispatched.effectId).toBe('string');
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'dispatching', decision: 'approval_required' });
    await expect(f.authorize(SEND_INPUT)).rejects.toThrow(/replay is blocked/);
    f.backends.pieceReceipt!(f.context, dispatched.effectId, { id: 'a123' });
    expect(await f.authorize(SEND_INPUT)).toEqual({ governed: true, dispatch: 'completed', result: { id: 'a123' } });
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

  test('an attachment is summarised, not spelled out byte by byte', () => {
    const bounded = sanitizePieceInput({ subject: 'x', attachments: new Uint8Array(4096),
      sentAt: new Date('2026-09-16T10:00:00.000Z'), body: 'y'.repeat(900) });
    expect(bounded.attachments).toBe('[binary, 4096 bytes]');
    expect(bounded.sentAt).toBe('2026-09-16T10:00:00.000Z');
    expect(String(bounded.body)).toContain('[388 more characters]');
    // Deterministic, so the digest an approval was granted against still
    // matches when the step re-authorizes on resume.
    expect(sanitizePieceInput({ subject: 'x', attachments: new Uint8Array(4096),
      sentAt: new Date('2026-09-16T10:00:00.000Z'), body: 'y'.repeat(900) })).toEqual(bounded);
  });
});

/**
 * The actions added between the previously vetted versions and the ones the
 * catalogue now installs (#664): gmail 0.15.0 -> 0.17.0, slack 0.17.10 ->
 * 0.21.0, claude 0.4.12 -> 0.7.0. The other five verified pieces kept the same
 * action set. Unmapped, these took the delete_data fallback, which over-gated
 * the writes and the reads.
 */
describe('governed piece adapters: actions added by the catalogue refresh', () => {
  const expected: Array<[string, string, ActionCategory]> = [
    [GMAIL, 'gmail_archive_message', 'write_data'],
    [GMAIL, 'gmail_get_or_create_label', 'write_data'],
    [GMAIL, 'gmail_update_label', 'write_data'],
    [GMAIL, 'gmail_untrash_message', 'write_data'],
    [GMAIL, 'gmail_trash_message', 'delete_data'],
    [GMAIL, 'gmail_modify_labels', 'delete_data'],
    [GMAIL, 'gmail_modify_thread_labels', 'delete_data'],
    ['@activepieces/piece-slack', 'send_message_to_multiple_users', 'send_message'],
    ['@activepieces/piece-claude', 'list_models', 'read_data'],
    ['@activepieces/piece-claude', 'get_model', 'read_data'],
    ['@activepieces/piece-claude', 'get_message_batch', 'read_data'],
    ['@activepieces/piece-claude', 'list_message_batches', 'read_data'],
    ['@activepieces/piece-claude', 'get_message_batch_results', 'read_data'],
    ['@activepieces/piece-claude', 'count_tokens', 'write_data'],
    ['@activepieces/piece-claude', 'create_message_batch', 'write_data'],
    ['@activepieces/piece-claude', 'cancel_message_batch', 'delete_data'],
    ['@activepieces/piece-claude', 'delete_message_batch', 'delete_data'],
  ];
  for (const [piece, action, category] of expected) {
    test(`${action} is mapped, as ${category}`, () => {
      expect(resolveGovernedPieceAction(piece, action)).toMatchObject({ known: true, category });
    });
  }

  test('a bulk label change names the messages and the labels on the card', async () => {
    const f = fixture(GMAIL, 'gmail_modify_labels');
    f.authority.addOverride({ action: 'delete_data', allowed: false });
    await expect(f.authorize({ message_ids: ['m1', 'm2'], add_label_ids: ['TRASH'] })).rejects.toThrow(/Authority denied/);
    expect(listWorkflowEffects(f.run.id)[0]!.target).toMatchObject({
      piece: 'gmail', action: 'gmail_modify_labels', message_ids: ['m1', 'm2'], add_label_ids: ['TRASH'],
    });
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

describe('the approval card describes the piece action', () => {
  test('the card names the piece, the action and the reviewed target', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const pending = await f.authorize(SEND_INPUT);
    const approvalId = (pending as { approval: { approvalId: string } }).approval.approvalId;
    const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as any);
    const intent = ws.computeApprovalIntent(f.approvals.getRequest(approvalId)!);
    // Not "gmail", and not "send_email is a governed action": who it goes to.
    expect(intent).toContain('Gmail - send email');
    expect(intent).toContain('finance@example.test');
    expect(intent).toContain('Q3 invoice');
  });

  test('a piece action with no resolvable target still names what will run', async () => {
    const f = fixture('@activepieces/piece-openai', 'list_models', 1);
    f.authority.setGovernedCategories(['read_data']);
    const pending = await f.authorize({});
    const approvalId = (pending as { approval: { approvalId: string } }).approval.approvalId;
    const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as any);
    expect(ws.computeApprovalIntent(f.approvals.getRequest(approvalId)!)).toContain('Openai - list models');
  });

  /**
   * #697. The target values are the step's real input -- a subject or a
   * recipient a flow wired from an email it read -- and the dashboard sentence
   * cut them at 80 characters but kept line breaks, controls and bidi
   * overrides, the same hole #651 closed on the Telegram card.
   */
  test('a target value cannot reorder or break the dashboard sentence', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const rlo = String.fromCharCode(0x202e);
    const pending = await f.authorize({ ...SEND_INPUT,
      subject: `Q3 invoice${rlo}gpj.exe\r\nNEL${String.fromCharCode(0x85)}LS${String.fromCharCode(0x2028)}VT${String.fromCharCode(0x0b)}end`,
      receiver: [`finance@example.test\n(approved by finance)`] });
    const approvalId = (pending as { approval: { approvalId: string } }).approval.approvalId;
    const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as any);
    const intent = ws.computeApprovalIntent(f.approvals.getRequest(approvalId)!);
    expect(intent).not.toMatch(/[\p{Cf}\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    expect(intent).toContain('receiver: finance@example.test (approved by finance)');
    expect(intent).toContain('subject: Q3 invoicegpj.exe NEL LS VT end');
  });

  test('a target value made only of invisible characters is named as such, not shown blank', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const pending = await f.authorize({ ...SEND_INPUT, subject: `${String.fromCharCode(0x202e)}${String.fromCharCode(0x200b)}` });
    const approvalId = (pending as { approval: { approvalId: string } }).approval.approvalId;
    const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as any);
    expect(ws.computeApprovalIntent(f.approvals.getRequest(approvalId)!)).toContain('subject: (invisible characters only)');
  });

  test('a long target value is still cut at 80 and marked', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const pending = await f.authorize({ ...SEND_INPUT, subject: 's'.repeat(300) });
    const approvalId = (pending as { approval: { approvalId: string } }).approval.approvalId;
    const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as any);
    const intent = ws.computeApprovalIntent(f.approvals.getRequest(approvalId)!);
    expect(intent).toContain(`subject: ${'s'.repeat(80)}...`);
    expect(intent).not.toContain('s'.repeat(81));
  });
});

describe('governed piece adapter table', () => {
  test('verified means governed, in both directions', async () => {
    const { VERIFIED } = await import('../pieces-library/catalog-overrides');
    const { CATALOG } = await import('../pieces-library/catalog');
    const governed = new Set(GOVERNED_PIECE_ADAPTERS.map(adapter => adapter.catalogId));
    // A piece promoted to VERIFIED without an adapter would be presented as
    // vetted while its effects stayed outside the boundary.
    expect([...VERIFIED].sort()).toEqual([...governed].sort());
    for (const adapter of GOVERNED_PIECE_ADAPTERS) {
      const entry = CATALOG.find(piece => piece.id === adapter.catalogId)!;
      expect(entry).toBeDefined();
      expect(entry.npmPackage).toBe(adapter.pieceName);
    }
  });

  /**
   * What the table has to cover is the version the catalogue installs, read
   * from the published package by the catalog sync. The sync only moves a
   * verified piece to a version this still holds for, so a failure here means
   * a hand edit moved a version or dropped a mapping.
   */
  test('every action of the installed version is mapped', async () => {
    const { CATALOG } = await import('../pieces-library/catalog');
    const { VERIFIED_MANIFESTS } = await import('../pieces-library/verified-manifests-generated');
    for (const adapter of GOVERNED_PIECE_ADAPTERS) {
      const piece = adapter.catalogId;
      const manifest = VERIFIED_MANIFESTS[piece];
      expect({ piece, manifest: manifest !== undefined }).toEqual({ piece, manifest: true });
      const installed = CATALOG.find(entry => entry.id === piece)!.vettedVersion;
      expect({ piece, version: manifest!.version }).toEqual({ piece, version: installed });
      expect(manifest!.actions.length).toBeGreaterThan(0);
      const unmapped = manifest!.actions
        .map(action => action.name)
        .filter(name => !resolveGovernedPieceAction(adapter.pieceName, name)!.known);
      expect({ piece, unmapped }).toEqual({ piece, unmapped: [] });
    }
  });

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

/**
 * One deny path and one approve path per verified piece, over its primary
 * effect. Each case fails if that piece's adapter is removed from the table:
 * without an adapter the backend answers `governed: false`, so nothing is
 * denied and no approval is raised.
 */
const PIECES: Array<{
  id: string; action: string; category: ActionCategory; input: Record<string, unknown>;
  target: Record<string, unknown>;
  /** A more severe action of the same piece, to prove per-action severity. */
  severe: [string, ActionCategory];
  /** A read of the same piece, which must clear authority level 1. */
  read?: string;
}> = [
  { id: 'gmail', action: 'send_email', category: 'send_email',
    input: { receiver: ['finance@example.test'], subject: 'Q3 invoice' },
    target: { receiver: ['finance@example.test'] }, severe: ['gmail_delete_draft', 'delete_data'],
    read: 'gmail_get_profile' },
  { id: 'slack', action: 'slack_post_message', category: 'send_message',
    input: { channel: 'C0ENGINEERING', text: 'deploy finished' }, target: { channel: 'C0ENGINEERING' },
    severe: ['slack_delete_message', 'delete_data'], read: 'slack_list_channels' },
  { id: 'notion', action: 'notion_create_page', category: 'write_data',
    input: { parent_page_id: 'p_1', title: 'Quarterly review' }, target: { parent_page_id: 'p_1' },
    severe: ['notion_archive_page', 'delete_data'], read: 'notion_search' },
  { id: 'openai', action: 'ask_chatgpt', category: 'write_data',
    input: { model: 'gpt-4o', prompt: 'summarise the vault' }, target: { prompt: 'summarise the vault' },
    severe: ['delete_file', 'delete_data'], read: 'list_models' },
  { id: 'claude', action: 'ask_claude', category: 'write_data',
    input: { model: 'claude-opus-4', prompt: 'summarise the vault' },
    target: { prompt: 'summarise the vault' }, severe: ['custom_api_call', 'delete_data'] },
  { id: 'github', action: 'github_create_issue', category: 'write_data',
    input: { repository: { owner: 'vierisid', repo: 'jarvis' }, title: 'Flaky test' },
    target: { title: 'Flaky test' }, severe: ['delete_branch', 'delete_data'], read: 'find_issue' },
  { id: 'google-calendar', action: 'google_calendar_create_event', category: 'write_data',
    input: { calendar_id: 'primary', title: 'Design review' }, target: { calendar_id: 'primary' },
    severe: ['google_calendar_delete_event', 'delete_data'], read: 'google_calendar_list_events' },
  { id: 'google-drive', action: 'drive_share_file', category: 'modify_settings',
    input: { file_id: 'f_1', user_email: 'outsider@example.test', role: 'writer' },
    target: { user_email: 'outsider@example.test' }, severe: ['drive_empty_trash', 'delete_data'],
    read: 'drive_list_files' },
  { id: 'discord', action: 'discord_send_message', category: 'send_message',
    input: { guild_id: 'g_1', channel_id: 'c_1', content: 'deploy finished' },
    target: { channel_id: 'c_1' }, severe: ['discord_bulk_delete_messages', 'delete_data'],
    read: 'discord_list_channels' },
  { id: 'telegram-bot', action: 'send_text_message', category: 'send_message',
    input: { chat_id: '4711', message: 'deploy finished' }, target: { chat_id: '4711' },
    severe: ['create_invite_link', 'modify_settings'], read: 'get_chat_member' },
];

describe('every verified piece is gated', () => {
  test('the table covers exactly the verified set', () => {
    const verified = new Set(GOVERNED_PIECE_ADAPTERS.map(adapter => adapter.catalogId));
    expect([...verified].sort()).toEqual(PIECES.map(piece => piece.id).sort());
    expect(verified.size).toBe(10);
  });

  for (const piece of PIECES) {
    const pieceName = `@activepieces/piece-${piece.id}`;

    test(`${piece.id}: a denied ${piece.action} is refused and recorded`, async () => {
      const f = fixture(pieceName, piece.action);
      f.authority.addOverride({ action: piece.category, allowed: false });
      await expect(f.authorize(piece.input)).rejects.toThrow(/Authority denied/);
      const effect = listWorkflowEffects(f.run.id)[0]!;
      expect(effect).toMatchObject({ status: 'blocked', decision: 'denied',
        actionCategory: piece.category, toolName: `piece:${piece.id}/${piece.action}` });
      expect(effect.target).toMatchObject({ piece: piece.id, action: piece.action, ...piece.target });
    });

    test(`${piece.id}: a governed ${piece.action} waits for a human, then dispatches`, async () => {
      const f = fixture(pieceName, piece.action);
      f.authority.setGovernedCategories([piece.category]);
      const pending = await f.authorize(piece.input);
      expect(pending).toMatchObject({ governed: true, dispatch: 'approval_required' });
      const approvalId = (pending as { approval: { approvalId: string } }).approval.approvalId;
      const request = f.approvals.getRequest(approvalId)!;
      expect(request.action_category).toBe(piece.category);
      // The card carries the resolved input, so the reviewer sees the real
      // recipient / file / prompt rather than the piece name.
      expect(JSON.parse(request.tool_arguments)).toMatchObject(piece.input);
      expect(JSON.parse(request.context)).toMatchObject({ target: { piece: piece.id, ...piece.target } });
      f.approvals.approve(approvalId, 'test-user');
      updateRun(f.run.id, { status: 'PAUSED' });
      expect(resumeResolvedWorkflowEffects()).toBe(1);
      updateRun(f.run.id, { status: 'RUNNING' });
      expect(await f.authorize(piece.input)).toMatchObject({ governed: true, dispatch: 'authorized' });
      expect(listWorkflowEffects(f.run.id)[0]!.status).toBe(tracksPieceCompletion(pieceName, piece.action) ? 'dispatching' : 'succeeded');
    });

    test(`${piece.id}: ${piece.severe[0]} is gated above the piece's ordinary writes`, async () => {
      const [action, category] = piece.severe;
      expect(resolveGovernedPieceAction(pieceName, action)!.category).toBe(category);
      // Level 3 clears reads and writes. The severe action must not pass it.
      const f = fixture(pieceName, action, 3);
      await expect(f.authorize(piece.input)).rejects.toThrow(/below required/);
      expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'blocked', actionCategory: category });
    });

    if (piece.read) {
      test(`${piece.id}: ${piece.read} stays a read`, async () => {
        expect(resolveGovernedPieceAction(pieceName, piece.read!)!.category).toBe('read_data');
        const f = fixture(pieceName, piece.read!, 1);
        expect(await f.authorize({})).toEqual({ governed: true, dispatch: 'authorized' });
        expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ actionCategory: 'read_data', status: 'succeeded' });
      });
    }
  }
});


/**
 * #634. `bound()` cuts every string in a governed piece's input to 512
 * characters, and `manage_workflow` is the one tool that FRAMES its own return
 * -- so a `{{ }}` expression wiring that return into a piece's input put a cut
 * through an `UNTRUSTED_CONTENT` block, keeping the open delimiter and dropping
 * the close. That projection becomes `workflow_effect.arguments`, is copied to
 * `approval_requests.tool_arguments` and is rendered on the approval card,
 * where a dangling open line disclaims whatever follows it.
 *
 * The fix is on the DAEMON side only (`piece-effect-receipt.ts`), because
 * nothing is durable before the daemon's pass and `piece-effects.ts` is
 * compiled into the engine bundle under a type-only-imports rule.
 */
describe('#634: a stored piece projection can never hold half a framed block', () => {
  /** What a prior `manage_workflow` step hands a `{{ }}` expression. */
  const framed = () => wrapUntrusted(`${'payload line\n'.repeat(200)}`, 'manage_workflow');

  test('a cut through a framed block leaves no live delimiter at any cut point', () => {
    const block = framed();
    // Non-vacuous: the projection alone DOES keep the open delimiter and lose
    // the close -- that is the defect. Checked for BOTH shapes: the one-pass
    // shape is what an honest engine sends and, since #651, what the daemon
    // keeps; the two-pass shape is what the daemon stored before #651, and is
    // still a value a stale or forged engine could send.
    const onePass = sanitizePieceInput({ message: block }) as { message: string };
    const twoPass = sanitizePieceInput(onePass) as { message: string };
    for (const undefanged of [onePass, twoPass]) {
      expect(undefanged.message).toContain(UNTRUSTED_OPEN);
      expect(undefanged.message).not.toContain(UNTRUSTED_CLOSE);
    }

    // The daemon's pass is what makes the stored value safe.
    const stored = defangPieceProjection(twoPass) as { message: string };
    expect(stored.message).not.toContain(UNTRUSTED_OPEN);
    expect(stored.message).not.toContain(UNTRUSTED_CLOSE);
    // The preamble survives as prose, so the row still says this is data.
    expect(stored.message).toContain('UNTRUSTED-CONTENT');
    // And the "how much was hidden" note is still there -- re-cutting with
    // `boundedReceiptText` would have eaten it.
    expect(stored.message).toContain('more characters]');

    // Every cut point, not just 512: wherever the block is sliced, nothing live
    // survives. This is the property the issue is actually about.
    //
    // Offsets are taken FROM the delimiter, not from 0. `wrapUntrusted` puts a
    // preamble in front of the payload, so the open delimiter does not start at
    // index 0 -- a loop over small absolute indices would slice a prefix with no
    // token in it at all and assert nothing. Pinned so this stays true.
    const opensAt = block.indexOf(UNTRUSTED_OPEN);
    expect(opensAt).toBeGreaterThan(100);
    for (const k of [-1, 0, 1, 5, UNTRUSTED_OPEN.length - 1, UNTRUSTED_OPEN.length, UNTRUSTED_OPEN.length + 1, 400]) {
      const cut = defangPieceProjection({ m: block.slice(0, opensAt + k) }) as { m: string };
      expect(cut.m).not.toContain(UNTRUSTED_OPEN);
      expect(cut.m).not.toContain(UNTRUSTED_CLOSE);
    }
  });

  test('it reaches the durable record and the approval card, not just the helper', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const pending = await f.authorize({ ...SEND_INPUT, body: framed() });
    const approvalId = (pending as { approval: { approvalId: string } }).approval.approvalId;
    const effect = listWorkflowEffects(f.run.id)[0]!;
    const card = f.approvals.getRequest(approvalId)!;
    for (const stored of [JSON.stringify(effect.arguments), card.tool_arguments]) {
      expect(stored).not.toContain(UNTRUSTED_OPEN);
      expect(stored).not.toContain(UNTRUSTED_CLOSE);
    }
    // The target the card renders its sentence from inherits the fix, because
    // it is built from the same defanged value.
    expect(JSON.stringify(effect.target)).not.toContain(UNTRUSTED_OPEN);
  });

  /**
   * THE DIGEST CONTRACT. `bound()`'s docblock requires determinism because
   * `effect-boundary.ts`'s `requestDigest` is recomputed from this projection
   * on every resume; a changed projection makes a pending approval fail with
   * "Workflow effect changed since it was recorded".
   *
   * So an UNCHANGED input must keep its digest. The literal below was computed
   * against the pre-#634 code path and is pinned here, so this fails if the
   * projection of ordinary content ever moves again -- whether the cause is
   * `bound()`, `defangPieceProjection` or `canonicalJson`.
   */
  test('an unchanged input keeps the exact digest it had before #634', () => {
    // Deliberately ORDINARY: no marker spelling, no ill-formed UTF-16, and no
    // surrogate pair straddling index 512. Those are the only two classes the
    // fix is allowed to move.
    const fixtureInput = {
      to: 'ops@example.com',
      subject: 'Nightly reconciliation report',
      at_cap: 'a'.repeat(512),
      body: 'The reconciliation run completed with 4 mismatches. '.repeat(80),
      attachments: ['ledger.csv', 'diff.txt'],
      meta: { retries: 2, dryRun: false, tags: ['nightly', 'finance'] },
      auth: { access_token: 'must-never-appear' },
    };
    const projected = defangPieceProjection(sanitizePieceInput(fixtureInput));
    expect(digest(projected)).toBe('6663ca45610250b4ff5efece2a3c06d21f87c7e6313239b3780c8098d5d7fe45');
    // The parts that digest covers, spelled out so a failure above is readable
    // rather than just a hex mismatch.
    const shown = projected as Record<string, string>;
    expect(shown.at_cap!.length).toBe(512);
    expect(shown.body!.endsWith('... [3648 more characters]')).toBe(true);
    expect('auth' in projected).toBe(false);
    // Still deterministic across calls, which is the original contract.
    expect(digest(defangPieceProjection(sanitizePieceInput(fixtureInput)))).toBe(digest(projected));
  });

  /**
   * The two classes that DO move, named so the invalidation cost is written
   * down rather than discovered on resume.
   */
  test('only a marker spelling and ill-formed UTF-16 change the projection', () => {
    const plain = { a: 'ordinary text', b: 'x'.repeat(2000) };
    expect(defangPieceProjection(sanitizePieceInput(plain))).toEqual(sanitizePieceInput(plain));

    // 1. the BARE TOKEN, which is wider than the delimiter and is the class a
    // reader is most likely to under-count. `markerPattern()` matches
    // `UNTRUSTED_CONTENT` alone, so ordinary content that merely MENTIONS it --
    // a SQL column, a JSON key, a filename -- is rewritten too, and its durable
    // row is no longer byte-exact.
    const marked = { a: `hello ${UNTRUSTED_OPEN} there` };
    expect(defangPieceProjection(sanitizePieceInput(marked))).not.toEqual(sanitizePieceInput(marked));
    const mentions = { q: 'SELECT untrusted_content FROM pages' };
    expect((defangPieceProjection(sanitizePieceInput(mentions)) as { q: string }).q)
      .toBe('SELECT untrusted-content FROM pages');

    // 2. ill-formed UTF-16 in the kept prefix.
    const lone = { a: `bad \ud800 surrogate` };
    expect(defangPieceProjection(sanitizePieceInput(lone))).not.toEqual(sanitizePieceInput(lone));
    expect((defangPieceProjection(sanitizePieceInput(lone)) as { a: string }).a).toContain('\ufffd');

    // A marker AFTER the kept prefix cannot move anything, because what is kept
    // is byte-exact before the first matched span.
    const late = { a: `${'y'.repeat(600)}${UNTRUSTED_OPEN}` };
    expect(defangPieceProjection(sanitizePieceInput(late))).toEqual(sanitizePieceInput(late));
  });
});

/**
 * #651 (b). `sanitizePieceInput` runs twice in production: in the engine on the
 * resolved input (`piece-effect-guard.ts`), then in the daemon on what the
 * engine sent (`service-backends.ts`). `bound()` was not idempotent, so the
 * daemon's pass re-cut the engine's output and re-counted. Every count note on
 * the card described the first note, not the input:
 *
 *   - a 10,000-character string showed `[26 more characters]` -- 26 being the
 *     length of the engine's own `... [9488 more characters]`;
 *   - a 100-item array showed `[1 more items]`, the engine's `[75 more items]`
 *     marker being the one item over the cap;
 *   - a 50-key object showed `omittedFields: 1` instead of 10, and lost a real
 *     field, because the engine's `omittedFields` key was the 41st.
 *
 * These drive the daemon's backend with what the engine actually sends, which
 * is `sanitizePieceInput(raw)`, never the raw input.
 */
describe('#651: the card counts what the step will send, not what the engine wrote', () => {
  const longInput = () => {
    const meta: Record<string, number> = {};
    for (let i = 0; i < 50; i++) meta[`z${String(i).padStart(2, '0')}`] = i;
    return {
      ...SEND_INPUT,
      body: 'x'.repeat(10_000),
      receiver: Array.from({ length: 100 }, (_, i) => `r${i}@example.test`),
      meta,
    };
  };

  test('a long string, a long array and a wide object keep the engine\'s counts', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const pending = await f.authorize(sanitizePieceInput(longInput()));
    const approvalId = (pending as { approval: { approvalId: string } }).approval.approvalId;
    const shown = JSON.parse(f.approvals.getRequest(approvalId)!.tool_arguments) as {
      body: string; receiver: string[]; meta: Record<string, number>;
    };
    expect(shown.body.slice(512)).toBe('... [9488 more characters]');
    expect(shown.receiver).toHaveLength(26);
    expect(shown.receiver.at(-1)).toBe('[75 more items]');
    expect(shown.meta.omittedFields).toBe(10);
    expect(Object.keys(shown.meta).filter(k => k !== 'omittedFields')).toHaveLength(40);

    // The target the card leads with is a third application of the bound, on
    // the daemon's own projection, so it had the same defect one level down.
    const target = JSON.parse(f.approvals.getRequest(approvalId)!.context).target as { receiver: string[] };
    expect(target.receiver).toHaveLength(26);
    expect(target.receiver.at(-1)).toBe('[75 more items]');
  });

  test('the stored projection is exactly the engine\'s projection', async () => {
    const f = fixture(GMAIL, 'send_email');
    const raw = longInput();
    await f.authorize(sanitizePieceInput(raw));
    const effect = listWorkflowEffects(f.run.id)[0]!;
    expect(effect.arguments).toEqual(defangPieceProjection(sanitizePieceInput(raw)));
  });

  /**
   * The digest pin above is of ONE pass, which is not what production stores.
   * This pins the production composition -- engine pass, daemon pass, defang --
   * and it reproduces the one-pass literal, which is the idempotence stated as
   * a number. Before #651 the stored projection of this fixture digested to
   * `238cfd917b3d2b78e6f536e0a187dcbbb015c64960d734122cb02aa161c830a3` (its
   * `body` ended `[26 more characters]`), and that is the kind of value a
   * pending approval for a long input was granted against; see `piece-effects.ts`
   * for exactly which ones the fix invalidates.
   */
  test('the production composition reproduces the pinned one-pass digest', async () => {
    const fixtureInput = {
      to: 'ops@example.com',
      subject: 'Nightly reconciliation report',
      at_cap: 'a'.repeat(512),
      body: 'The reconciliation run completed with 4 mismatches. '.repeat(80),
      attachments: ['ledger.csv', 'diff.txt'],
      meta: { retries: 2, dryRun: false, tags: ['nightly', 'finance'] },
      auth: { access_token: 'must-never-appear' },
    };
    const f = fixture(GMAIL, 'send_email');
    await f.authorize(sanitizePieceInput(fixtureInput));
    const effect = listWorkflowEffects(f.run.id)[0]!;
    expect(digest(effect.arguments)).toBe('6663ca45610250b4ff5efece2a3c06d21f87c7e6313239b3780c8098d5d7fe45');
  });

  /**
   * The daemon still bounds. It no longer re-cuts a value inside the
   * envelope the engine's projection can occupy, but a value the engine did
   * NOT cut -- a stale or forged engine -- is cut here exactly as before, and
   * the credential is stripped at every level either way.
   */
  /**
   * The envelope's exact edges, as a forged or stale engine would probe them:
   * one past each is cut with an accurate count, and the credential goes at
   * every size.
   */
  test('the daemon envelope keeps 544 / 26 / 41 and cuts 545 / 27 / 42', () => {
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    const kept = reprojectPieceInput({ s: 'a'.repeat(544), a: Array(26).fill('x'), o: keys(41) }) as {
      s: string; a: string[]; o: Record<string, number>;
    };
    expect(kept.s).toHaveLength(544);
    expect(kept.a).toHaveLength(26);
    expect(Object.keys(kept.o)).toHaveLength(41);
    expect('omittedFields' in kept.o).toBe(false);

    const cut = reprojectPieceInput({ s: 'a'.repeat(545), a: Array(27).fill('x'), o: keys(42) }) as {
      s: string; a: string[]; o: Record<string, number>;
    };
    expect(cut.s.slice(512)).toBe('... [33 more characters]');
    expect(cut.a).toHaveLength(26);
    expect(cut.a.at(-1)).toBe('[2 more items]');
    expect(cut.o.omittedFields).toBe(2);

    // A 41-key object whose 41 keys include the credential: the envelope keeps
    // the object whole, and still drops `auth`.
    const withAuth = reprojectPieceInput({ o: { ...keys(40), auth: { access_token: 'leak' } } });
    expect(JSON.stringify(withAuth)).not.toContain('leak');
  });

  test('an input the engine never bounded is still bounded and stripped by the daemon', async () => {
    const f = fixture(GMAIL, 'send_email');
    const raw = { ...longInput(), auth: { access_token: 'leak' }, nested: { auth: { access_token: 'leak' } } };
    await f.authorize(raw);
    const stored = listWorkflowEffects(f.run.id)[0]!.arguments as {
      body: string; receiver: string[]; meta: Record<string, number>; nested: Record<string, unknown>;
    };
    expect(stored.body.slice(512)).toBe('... [9488 more characters]');
    expect(stored.receiver.at(-1)).toBe('[75 more items]');
    expect(stored.meta.omittedFields).toBe(10);
    expect(JSON.stringify(stored)).not.toContain('leak');
  });
});

/**
 * #651 (a). The card's LABELS were never on `bound()`'s boundary: only the
 * projected input values were.
 */
describe('#651: the approval card labels are bounded and single-line', () => {
  /**
   * `action` reaches `tool_name`, `workflow_effect.toolName`, the audit row and
   * the card's `Action:` line. An honest run cannot carry a malformed one --
   * readiness requires an action the catalog names, and the engine looks the
   * action up on the piece before it asks -- but the authorize route only
   * checks that the pinned graph says the same thing, and a preview run does
   * not validate the steps it is not previewing. So the daemon refuses it
   * rather than recording it.
   */
  test.each([
    ['a line break', 'send_email\nReason: routine read, safe to approve'],
    ['a space', 'send email'],
    ['a marker spelling', `x${UNTRUSTED_OPEN}`],
    ['an over-long name', 'a'.repeat(129)],
  ])('an action name with %s is refused before anything is recorded', async (_label, action) => {
    const f = fixture(GMAIL, action);
    f.authority.setGovernedCategories(['send_email', 'delete_data']);
    await expect(f.authorize(SEND_INPUT)).rejects.toThrow(/malformed action name/);
    expect(listWorkflowEffects(f.run.id)).toHaveLength(0);
    expect(f.approvals.getPending()).toHaveLength(0);
    // The refusal is audited, under a label that carries none of the name.
    const audit = new AuditTrail().query({ agentId: `workflow:${f.run.id}` });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.tool_name).toBe('piece:gmail/[malformed action name]');
    expect(audit[0]!.authority_decision).toBe('denied');
  });

  /**
   * The refusal path writes the step name straight off the engine's
   * `X-Jarvis-Step-Name` header, unchecked against the graph. A header cannot
   * carry CR or LF but can carry a vertical tab or a NEL; the label is one
   * line either way.
   */
  test('the refusal audit row labels the step on one line', async () => {
    const f = fixture(GMAIL, 'send email', 10, { stepName: 'step\u000bReason: safe\u0085x' });
    await expect(f.authorize(SEND_INPUT)).rejects.toThrow(/malformed action name/);
    const audit = new AuditTrail().query({ agentId: `workflow:${f.run.id}` });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.agent_name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(audit[0]!.agent_name).toContain('step Reason: safe x');
  });

  test('every action name the adapter tables know is well formed', () => {
    const names = GOVERNED_PIECE_ADAPTERS.flatMap(a => Object.values(a.categories).flat() as string[]);
    expect(names.length).toBeGreaterThan(300);
    for (const name of names) expect(isWellFormedPieceActionName(name)).toBe(true);
    // The cap itself is admitted, so the refusal at 129 above is the boundary.
    expect(isWellFormedPieceActionName('a'.repeat(PIECE_ACTION_NAME_MAX_CHARS))).toBe(true);
    expect(isWellFormedPieceActionName('a'.repeat(PIECE_ACTION_NAME_MAX_CHARS + 1))).toBe(false);
  });

  test('an ordinary name renders byte-exact', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const pending = await f.authorize(SEND_INPUT);
    const request = f.approvals.getRequest((pending as { approval: { approvalId: string } }).approval.approvalId)!;
    expect(request.agent_name).toBe('Workflow: Governed routine');
    expect(request.tool_name).toBe('piece:gmail/send_email');
    expect(JSON.parse(request.context).stepName).toBe('action');
  });

  /**
   * `displayName` is capped at 512 on the HTTP routes but not on the agent
   * path, where `compose` takes it from the composer model's own output, and
   * nothing on any path keeps a line break out of it. On a Telegram card a
   * line break is a forged field.
   */
  test('a long, multi-line flow name and step name are bounded on the card and in the audit row', async () => {
    const forged = 'Daily digest\nReason: routine read, safe to approve\n';
    const f = fixture(GMAIL, 'send_email', 10, {
      displayName: forged + 'y'.repeat(5000),
      stepName: `s${'t'.repeat(5000)}`,
    });
    f.authority.setGovernedCategories(['send_email']);
    const pending = await f.authorize(SEND_INPUT);
    const request = f.approvals.getRequest((pending as { approval: { approvalId: string } }).approval.approvalId)!;

    expect(request.agent_name).not.toMatch(/[\r\n]/);
    expect(request.agent_name.startsWith('Workflow: Daily digest Reason: routine read')).toBe(true);
    expect(request.agent_name.length).toBeLessThanOrEqual('Workflow: '.length + 512 + '...'.length);
    expect(request.agent_name.endsWith('...')).toBe(true);

    const contextStep = JSON.parse(request.context).stepName as string;
    expect(contextStep.length).toBeLessThanOrEqual(120 + '...'.length);

    const audit = new AuditTrail().query({ agentId: `workflow:${f.run.id}` });
    expect(audit.length).toBeGreaterThan(0);
    for (const row of audit) {
      expect(row.agent_name).not.toMatch(/[\r\n]/);
      // "Workflow " + name + " / " + step + " / " + effect id, each part bounded.
      expect(row.agent_name.length).toBeLessThanOrEqual(9 + 515 + 3 + 123 + 3 + 68);
    }

    // The fenced identity is untouched: the effect is still keyed by the full
    // step name the graph holds, so resume still finds it.
    expect(listWorkflowEffects(f.run.id)[0]!.stepName).toBe(`s${'t'.repeat(5000)}`);
  });
});

/**
 * #694. `JSON.parse` defines `__proto__` as an ordinary own key, and a JSON
 * prop on a governed piece (a `custom_api_call` body, say) reaches the engine
 * as `JSON.parse` output, so the piece receives the field. `bound()` used to
 * write it with `out[key] = ...`, which calls the `__proto__` SETTER: the
 * projection lost the key with no `omittedFields` marker, so the card and the
 * digest described an input without a field the step still sends.
 */
describe('#694: an own __proto__ key is projected, not dropped', () => {
  const RAW = '{"subject":"x","body":{"__proto__":{"admin":true},"y":1},"s":{"__proto__":"str"},"n":{"__proto__":null}}';
  const EXPECTED = '{"body":{"__proto__":{"admin":true},"y":1},"n":{"__proto__":null},"s":{"__proto__":"str"},"subject":"x"}';

  test.each([
    ['the engine pass', sanitizePieceInput],
    ['the daemon pass', reprojectPieceInput],
  ])('%s keeps the key as an own property', (_label, project) => {
    const projected = project(JSON.parse(RAW)) as Record<string, Record<string, unknown>>;
    for (const field of ['body', 's', 'n']) {
      expect(Object.keys(projected[field]!)).toContain('__proto__');
      // Written as data, not as the prototype: nothing became inherited.
      expect(Object.getPrototypeOf(projected[field]!)).toBe(Object.prototype);
    }
    expect(JSON.stringify(projected)).toBe(EXPECTED);
  });

  test('at the top level, inside an array item and under a target prop', () => {
    const projected = sanitizePieceInput(JSON.parse('{"__proto__":1,"a":[{"__proto__":2}],"subject":{"__proto__":3}}'));
    expect(JSON.stringify(projected)).toBe('{"__proto__":1,"a":[{"__proto__":2}],"subject":{"__proto__":3}}');
    const resolved = resolveGovernedPieceAction(GMAIL, 'send_email')!;
    expect(JSON.stringify(governedPieceTarget(resolved, projected).subject)).toBe('{"__proto__":3}');
  });

  test('the daemon pass is still the identity on the engine pass', () => {
    const once = sanitizePieceInput(JSON.parse(RAW));
    expect(JSON.stringify(reprojectPieceInput(JSON.parse(JSON.stringify(once))))).toBe(JSON.stringify(once));
  });

  test('over the wire, the stored effect, the approval row and the digest carry the key', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const signer = new EngineTokenSigner();
    const registry = new SandboxRegistry();
    const identity = { sandboxId: SandboxRegistry.newSandboxId(), runId: f.run.id, projectId: f.run.projectId };
    const { token } = await signer.mint(identity);
    registry.register({ ...identity, engineToken: token, expiresAt: Date.now() + 60_000, terminatedAt: null });
    const api = new SandboxApi({ signer, registry, services: f.backends });
    await api.start();
    let reply: Awaited<ReturnType<typeof authorizePieceDispatch>>;
    try {
      // The real engine-side client: its own pass, JSON over HTTP, the
      // daemon's pass and the defang, as production composes them.
      reply = await authorizePieceDispatch({
        apiUrl: `${api.baseUrl}/`, engineToken: token, stepName: 'action', executionPath: [],
        piece: GMAIL, action: 'send_email', input: JSON.parse(RAW),
      });
    } finally { await api.stop(); }
    expect(reply).toMatchObject({ governed: true, dispatch: 'approval_required' });
    const effect = listWorkflowEffects(f.run.id)[0]!;
    expect(JSON.stringify(effect.arguments)).toBe(EXPECTED);
    const request = f.approvals.getRequest((reply as { approval: { approvalId: string } }).approval.approvalId)!;
    expect(request.tool_arguments).toBe(EXPECTED);
    // The fence is taken over the projection that names the field, so an
    // approval of it cannot be replayed against one that does not.
    expect(effect.requestDigest).toBe(digest({ piece: GMAIL, action: 'send_email', input: JSON.parse(EXPECTED), inputDigest: await pieceInputDigest(JSON.parse(RAW)) }));
    expect(effect.requestDigest).not.toBe(digest({ piece: GMAIL, action: 'send_email',
      input: { body: { y: 1 }, n: {}, s: {}, subject: 'x' }, inputDigest: await pieceInputDigest(JSON.parse(RAW)) }));
  });
});

/**
 * #722. `omittedFields` was both `bound()`'s count marker and an ordinary key,
 * so a step input holding its own `omittedFields` read on the card as a count
 * of dropped fields -- in an object of ANY size, not only a cut one -- and when
 * the object was also cut with that field among the 40 kept, the count
 * overwrote the field's value. A field of that spelling is now escaped with a
 * leading `~`, so the bare key only ever means the count.
 */
describe('#722: a field named like the omitted-fields marker', () => {
  /** An object of `n` ordinary keys that sort AFTER `omittedFields` (`z00`...), plus `extra`. */
  const wide = (n: number, extra: Record<string, unknown>): Record<string, unknown> => {
    const o: Record<string, unknown> = { ...extra };
    for (let i = 0; i < n; i++) o[`z${String(i).padStart(2, '0')}`] = i;
    return o;
  };

  test('in a small object it is a field, not a count', () => {
    const projected = sanitizePieceInput({ subject: 'x', body: { a: 1, omittedFields: 7 } });
    expect(projected.body).toEqual({ a: 1, '~omittedFields': 7 });
    expect('omittedFields' in (projected.body as object)).toBe(false);
  });

  test('in a cut object its value survives, and the count is the real count', () => {
    // 42 keys: the real field sorts first, so it is among the 40 kept, and
    // before #722 the count of 2 overwrote its value.
    const projected = sanitizePieceInput({ body: wide(41, { omittedFields: 'REAL' }) }).body as Record<string, unknown>;
    expect(projected['~omittedFields']).toBe('REAL');
    expect(projected.omittedFields).toBe(2);
    expect(Object.keys(projected)).toHaveLength(41);
  });

  test('a field that sorts past the cut is counted, as any dropped field is', () => {
    const projected = sanitizePieceInput({ body: wide(40, { '~omittedFields': 'x' }) }).body as Record<string, unknown>;
    // `~` sorts after `z`, so it is the 41st key and is dropped and counted.
    expect(projected.omittedFields).toBe(1);
    expect('~omittedFields' in projected).toBe(false);
    expect('~~omittedFields' in projected).toBe(false);
  });

  test('the escape is injective: each spelling keeps a distinct name', () => {
    expect(sanitizePieceInput({ omittedFields: 1, '~omittedFields': 2, '~~omittedFields': 3, omittedFieldsX: 4 }))
      .toEqual({ '~omittedFields': 1, '~~omittedFields': 2, '~~~omittedFields': 3, omittedFieldsX: 4 });
  });

  test('the daemon pass is still the identity on the engine pass, so nothing is escaped twice', () => {
    for (const raw of [{ body: { a: 1, omittedFields: 7 } }, { body: wide(41, { omittedFields: 'REAL' }) }, { omittedFields: { omittedFields: 1 } }]) {
      const once = sanitizePieceInput(raw);
      expect(reprojectPieceInput(JSON.parse(JSON.stringify(once)))).toEqual(once);
    }
  });

  test('an object the engine did not cut has its own keys escaped and cut by the daemon as the first pass would', () => {
    const raw = { body: wide(45, { omittedFields: 'REAL' }) };
    expect(reprojectPieceInput(raw)).toEqual(sanitizePieceInput(raw));
  });

  test('a value inside the envelope is kept as an engine sent it: the daemon cannot tell a marker from a field there', () => {
    // Pinned so the docblock's limit stays true. Only an engine that skipped
    // sanitizePieceInput sends this, and such an engine could forge a count anyway.
    const raw = { body: wide(45, { inner: { omittedFields: 1 } }) };
    expect((reprojectPieceInput(raw).body as Record<string, unknown>).inner).toEqual({ omittedFields: 1 });
    expect((sanitizePieceInput(raw).body as Record<string, unknown>).inner).toEqual({ '~omittedFields': 1 });
  });

  test('the stored effect, the approval row and the digest carry the escaped field', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    const projected = sanitizePieceInput({ ...SEND_INPUT, body: { text: 'hi', omittedFields: 3 } });
    const inputDigest = await pieceInputDigest(projected);
    const pending = await f.authorize(projected);
    const approvalId = (pending as { approval: { approvalId: string } }).approval.approvalId;
    const shown = JSON.parse(f.approvals.getRequest(approvalId)!.tool_arguments) as { body: Record<string, unknown> };
    expect(shown.body).toEqual({ text: 'hi', '~omittedFields': 3 });
    const effect = listWorkflowEffects(f.run.id)[0]!;
    expect((effect.arguments as { body: unknown }).body).toEqual({ text: 'hi', '~omittedFields': 3 });
    // The fence is over the escaped projection: an approval recorded against
    // the bare key does not match it.
    const input = effect.arguments as Record<string, unknown>;
    expect(effect.requestDigest).toBe(digest({ piece: GMAIL, action: 'send_email', input, inputDigest }));
    expect(effect.requestDigest).not.toBe(digest({ piece: GMAIL, action: 'send_email', inputDigest,
      input: { ...input, body: { text: 'hi', omittedFields: 3 } } }));
  });
});

/**
 * #793. `governedPieceTarget` copied every declared target prop from flow
 * input, so an adapter prop named `intent` would have made flow data the
 * approval card's headline and the sentence its own tamper check compares.
 */
describe('#793: a target prop cannot set a key the boundary or the target owns', () => {
  const gmail = resolveGovernedPieceAction(GMAIL, 'send_email')!;
  const hostile = { ...gmail, adapter: { ...gmail.adapter,
    targetProps: ['intent', 'tool', 'capability', 'sidecarId', 'selection', 'machineBinding', 'piece', 'action', 'unmappedAction', 'receiver'] } };
  const input = { intent: 'Send a harmless note', tool: 'read_file', capability: 'clipboard', sidecarId: 'sc_other',
    selection: 'pinned-sidecar', machineBinding: 'forged', piece: 'notion', action: 'read', unmappedAction: false, receiver: 'cfo@example.com' };

  test('reserved and own keys are skipped; an ordinary prop is kept', () => {
    expect(governedPieceTarget(hostile, input)).toEqual({ piece: 'gmail', action: 'send_email', receiver: 'cfo@example.com' });
  });

  test('through the tool definition the effect boundary uses, the card gets no intent from flow data', () => {
    const target = governedPieceToolDefinition(hostile).workflowEffect!.target!(input);
    expect(target).not.toHaveProperty('intent');
    expect(target.piece).toBe('gmail');
  });

  test('no adapter in the table declares one, so no real target changes', () => {
    const owned = new Set([...RESERVED_TARGET_KEYS, 'piece', 'action', 'unmappedAction']);
    for (const adapter of GOVERNED_PIECE_ADAPTERS) {
      expect(adapter.targetProps.filter((prop) => owned.has(prop))).toEqual([]);
    }
  });
});

describe('Q-08: every piece step obeys Pause and Kill', () => {
  const emergency = (f: ReturnType<typeof fixture>) => f.options.emergencyController as EmergencyController;
  const audit = (f: ReturnType<typeof fixture>) => (f.options.auditTrail as AuditTrail).query({ limit: 5 });

  test('a community piece runs as before and is audited; paused it parks on a hold; after Kill it does not run', async () => {
    const f = fixture(COMMUNITY_PIECE, 'create_contact');
    expect(await f.authorize()).toEqual({ governed: false });
    expect(audit(f)[0]).toMatchObject({ tool_name: `community piece ${COMMUNITY_PIECE}/create_contact`, authority_decision: 'allowed', executed: 1 });
    emergency(f).pause();
    const held = await f.authorize() as { dispatch?: string; approval: { waitpointId: string; hold?: string } };
    expect(held).toMatchObject({ governed: false, dispatch: 'held', approval: { hold: expect.stringMatching(/paused/) } });
    expect(getWaitpoint(held.approval.waitpointId)?.type).toBe('HOLD');
    emergency(f).resume();
    emergency(f).kill();
    await expect(f.authorize()).rejects.toThrow(/stopped with Kill/);
  });

  test('a CODE step is admitted the same way and audited as a code step', async () => {
    const f = fixture(COMMUNITY_PIECE, 'create_contact');
    expect(await f.backends.pieceAuthorize!({ piece: CODE_STEP_PIECE, action: 'run', input: {} }, f.context)).toEqual({ governed: false });
    expect(audit(f)[0]).toMatchObject({ tool_name: 'code step', executed: 1 });
    emergency(f).pause();
    expect(await f.backends.pieceAuthorize!({ piece: CODE_STEP_PIECE, action: 'run', input: {} }, f.context)).toMatchObject({ dispatch: 'held' });
  });

  test("Jarvis's own pieces and the in-run core steps leave no admission row", async () => {
    const f = fixture(COMMUNITY_PIECE, 'create_contact');
    // The HTTP piece is governed since #961 and has its own tests (core-pieces.test.ts).
    for (const piece of ['@jarvispieces/piece-jarvis-tool', '@activepieces/piece-delay', '@activepieces/piece-store']) {
      expect(await f.backends.pieceAuthorize!({ piece, action: 'run', input: {} }, f.context)).toEqual({ governed: false });
    }
    expect(audit(f)).toEqual([]);
    // A community piece still leaves one.
    expect(await f.backends.pieceAuthorize!({ piece: COMMUNITY_PIECE, action: 'create_contact', input: {} }, f.context)).toEqual({ governed: false });
    expect(audit(f)).toEqual([expect.objectContaining({ tool_name: `community piece ${COMMUNITY_PIECE}/create_contact` })]);
  });

  test('a recorded piece authorization is not handed out again while paused', async () => {
    const f = fixture(GMAIL, 'gmail_create_draft');
    expect(await f.authorize(SEND_INPUT)).toMatchObject({ governed: true, dispatch: 'authorized' });
    emergency(f).pause();
    expect(await f.authorize(SEND_INPUT)).toMatchObject({ governed: true, dispatch: 'approval_required', approval: { hold: expect.any(String) } });
    emergency(f).resume();
    expect(await f.authorize(SEND_INPUT)).toMatchObject({ governed: true, dispatch: 'authorized' });
  });

  // Same length and count, different only past the card's cut: the last
  // character of a 600-character body and the 26th recipient. The projection
  // the card is built from cannot tell these apart, cut once or twice.
  const people = (last: string) => [...Array.from({ length: 25 }, (_, i) => `person${i}@example.test`), last];
  const REVIEWED = { ...SEND_INPUT, body: `${'x'.repeat(599)}y`, receiver: people('person25@example.test') };
  const CHANGED = { ...SEND_INPUT, body: `${'x'.repeat(599)}z`, receiver: people('someone-else@example.test') };
  // What the engine sends: its projection of the input, and a digest of all of it.
  const sendWhole = (f: ReturnType<typeof fixture>) => async (input: Record<string, unknown>) => f.backends.pieceAuthorize!({
    piece: GMAIL, action: 'send_email', input: sanitizePieceInput(input), inputDigest: await pieceInputDigest(input) }, f.context);

  test('a piece approval covers the whole input, not the shortened copy its card shows', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    expect(sanitizePieceInput(CHANGED)).toEqual(sanitizePieceInput(REVIEWED));
    expect(sanitizePieceInput(sanitizePieceInput(CHANGED))).toEqual(sanitizePieceInput(sanitizePieceInput(REVIEWED)));
    const send = sendWhole(f);
    const parked = await send(REVIEWED) as { approval: { approvalId: string } };
    f.approvals.approve(parked.approval.approvalId, 'dashboard');
    await expect(send(CHANGED)).rejects.toThrow(/changed since it was recorded/);
    expect(await send(REVIEWED)).toMatchObject({ dispatch: 'authorized' });
  });

  test('an untracked draft approval parked before the whole-input digest existed runs once, then is bound to it', async () => {
    const action = 'gmail_create_draft';
    const f = fixture(GMAIL, action);
    f.authority.setGovernedCategories(['write_data']);
    // Q-08's compatibility path still applies to actions without a send fence.
    const parked = await f.backends.pieceAuthorize!({ piece: GMAIL, action, input: sanitizePieceInput(REVIEWED) }, f.context) as { approval: { approvalId: string } };
    f.approvals.approve(parked.approval.approvalId, 'dashboard');
    const send = async (input: Record<string, unknown>) => f.backends.pieceAuthorize!({
      piece: GMAIL, action, input: sanitizePieceInput(input), inputDigest: await pieceInputDigest(input) }, f.context);
    expect(await send(REVIEWED)).toMatchObject({ dispatch: 'authorized' });
    await expect(send(CHANGED)).rejects.toThrow(/changed since it was recorded/);
  });

  test('a tracked send without a whole-input digest needs a fresh, fully bound request', async () => {
    const f = fixture(GMAIL, 'send_email');
    f.authority.setGovernedCategories(['send_email']);
    await expect(f.backends.pieceAuthorize!({ piece: GMAIL, action: 'send_email', input: sanitizePieceInput(REVIEWED) }, f.context))
      .rejects.toThrow('A tracked send requires the complete input digest');
    expect(listWorkflowEffects(f.run.id)).toEqual([]);
    expect(f.approvals.getPending()).toEqual([]);
    const send = sendWhole(f);
    const parked = await send(REVIEWED) as { approval: { approvalId: string } };
    expect(parked).toMatchObject({ dispatch: 'approval_required' });
    f.approvals.approve(parked.approval.approvalId, 'dashboard');
    await expect(send(CHANGED)).rejects.toThrow(/changed since it was recorded/);
    expect(await send(REVIEWED)).toMatchObject({ dispatch: 'authorized' });
  });

  test('the whole-input digest leaves the connection out and sees past the cut', async () => {
    const base = { ...SEND_INPUT, body: 'x'.repeat(600) };
    expect(await pieceInputDigest({ ...base, auth: { access_token: 'one' } })).toBe(await pieceInputDigest({ ...base, auth: { access_token: 'two' } }));
    expect(await pieceInputDigest(base)).not.toBe(await pieceInputDigest({ ...base, body: `${base.body}y` }));
  });

  test('the engine parks a step the daemon holds, and refuses a malformed hold', async () => {
    const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const base = { apiUrl: 'http://127.0.0.1:1', engineToken: 't', stepName: 'action', executionPath: [] as Array<[string, number]> };
    const held = { governed: false, dispatch: 'held', approval: { effectId: '', approvalId: '', waitpointId: 'wp-1', hold: 'paused' } };
    expect(await authorizePieceDispatch({ ...base, fetchImpl: reply(held), piece: COMMUNITY_PIECE, action: 'create_contact', input: {} })).toEqual(held as never);
    await expect(authorizePieceDispatch({ ...base, fetchImpl: reply({ governed: false, dispatch: 'held' }), piece: COMMUNITY_PIECE, action: 'create_contact', input: {} }))
      .rejects.toThrow(/malformed hold/);
  });
});

describe('the admission route (Q-08)', () => {
  const call = (runId: string, deps: JarvisPiecesRouteDeps, body: Record<string, unknown>) => createJarvisPieceAuthorizeRoute(deps)({
    req: new Request('http://127.0.0.1/v1/jarvis/pieces/authorize', { method: 'POST',
      headers: { 'X-Jarvis-Step-Name': 'action', 'X-Jarvis-Execution-Path': '[]' }, body: JSON.stringify(body) }),
    claims: { runId, projectId: DEFAULT_IDS.project, sandboxId: 'test' } as never, params: {},
  });

  test('unwired, as in an engine-only harness: a governed piece fails closed, any other step runs', async () => {
    const { run } = fixture(GMAIL, 'send_email');
    expect((await call(run.id, {}, { piece: GMAIL, action: 'send_email', input: {} })).status).toBe(503);
    const other = await call(run.id, {}, { piece: COMMUNITY_PIECE, action: 'create_contact' });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ governed: false });
  });

  test('a whole-input digest must be a SHA-256 hex digest, and reaches the service intact', async () => {
    const { run } = fixture(GMAIL, 'send_email');
    const seen: unknown[] = [];
    const deps: JarvisPiecesRouteDeps = { pieceAuthorize: async (req) => { seen.push(req); return { governed: false }; } };
    expect((await call(run.id, deps, { piece: GMAIL, action: 'send_email', input: {}, inputDigest: 'not-a-digest' })).status).toBe(400);
    expect(seen).toEqual([]);
    const whole = 'a'.repeat(64);
    expect((await call(run.id, deps, { piece: GMAIL, action: 'send_email', input: {}, inputDigest: whole })).status).toBe(200);
    expect(seen).toEqual([{ piece: GMAIL, action: 'send_email', input: {}, inputDigest: whole }]);
  });
});

describe('#953: a verified piece action above the level asks only when its category is governed', () => {
  // The shipped Authority defaults: level 3, send_email/send_message/make_payment governed.
  const shipped = (action: string) => {
    const f = fixture(GMAIL, action, DEFAULT_CONFIG.authority.default_level);
    f.authority.setGovernedCategories([...DEFAULT_CONFIG.authority.governed_categories] as ActionCategory[]);
    return f;
  };
  const approvalOf = (reply: unknown) => (reply as { approval: { approvalId: string } }).approval.approvalId;

  test('at the shipped defaults a Gmail send raises a card, then authorizes exactly once after approval', async () => {
    expect(DEFAULT_CONFIG.authority.default_level).toBe(3);
    expect(DEFAULT_CONFIG.authority.governed_categories).toContain('send_email');
    const f = shipped('send_email');
    const pending = await f.authorize(SEND_INPUT);
    expect(pending).toMatchObject({ governed: true, dispatch: 'approval_required' });
    const approvalId = approvalOf(pending);
    expect(f.deliveredApprovals).toEqual([approvalId]);
    const request = f.approvals.getRequest(approvalId)!;
    expect(request.action_category).toBe('send_email');
    // The substituted reason, so the approval learner never learns from it.
    expect(request.reason).toContain(ABOVE_LEVEL_SUBSTITUTION);
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ decision: 'approval_required', status: 'pending' });

    f.approvals.approve(approvalId, 'dashboard');
    const dispatched = await f.authorize(SEND_INPUT) as { effectId: string };
    expect(dispatched).toMatchObject({ governed: true, dispatch: 'authorized' });
    await expect(f.authorize(SEND_INPUT)).rejects.toThrow(/replay is blocked/);
    expect(listWorkflowEffects(f.run.id)).toHaveLength(1);
  });

  test('above-level send cards count against the flow\'s card budget, and one past it waits for a place (#1039)', async () => {
    const f = shipped('send_email');
    const cap = maxWaitingWorkflowCards();
    const authorizeIn = async (runId: string) => f.backends.pieceAuthorize!({ piece: GMAIL, action: 'send_email', input: SEND_INPUT,
      inputDigest: await pieceInputDigest(SEND_INPUT) }, { ...f.context, runId });
    const runs = [f.run.id, ...Array.from({ length: cap }, () => createFlowRun({ flowId: f.version.flowId, flowVersionId: f.version.id, status: 'RUNNING' }).id)];
    for (const runId of runs.slice(0, cap)) expect(await authorizeIn(runId)).toMatchObject({ governed: true, dispatch: 'approval_required' });
    const cards = f.approvals.getPending().filter((r) => r.execution_mode === 'workflow');
    // Recorded under the category the budget counts: the send's, not the substitution floor.
    expect(cards.map((r) => r.action_category)).toEqual(Array(cap).fill('send_email'));
    const over = await authorizeIn(runs[cap]!) as { dispatch: string; approval: { approvalId: string; code?: string } };
    expect(over.dispatch).toBe('approval_required');
    expect(over.approval).toMatchObject({ approvalId: '', code: 'APPROVALS_WAITING' });
    expect(f.approvals.getPending()).toHaveLength(cap);
    expect(listWorkflowEffects(runs[cap]!)[0]).toMatchObject({ status: 'pending', approvalId: null, deferral: { budget: 'other' } });
  });

  test('a send whose category is not governed stays denied by level', async () => {
    const f = shipped('send_email');
    f.authority.setGovernedCategories(['send_message', 'make_payment']);
    await expect(f.authorize(SEND_INPUT)).rejects.toThrow(/Authority level 3 is below required 7 for send_email/);
    expect(f.approvals.getPending()).toHaveLength(0);
  });

  test('deletes and settings changes stay denied by level, even when governed', async () => {
    for (const [action, category] of [['gmail_trash_message', 'delete_data'], ['gmail_stop_watch', 'modify_settings'],
      ['custom_api_call', 'delete_data']] as const) {
      const f = shipped(action);
      f.authority.setGovernedCategories([...DEFAULT_CONFIG.authority.governed_categories as ActionCategory[], 'delete_data', 'modify_settings']);
      await expect(f.authorize({ message_id: 'm1' })).rejects.toThrow(new RegExp(`Authority level 3 is below required 9 for ${category}`));
      expect(f.approvals.getPending()).toHaveLength(0);
      closeWorkflowDb(); initWorkflowDb(':memory:');
    }
  });

  test('an override or a context rule that denies still denies', async () => {
    const overridden = shipped('send_email');
    overridden.authority.addOverride({ action: 'send_email', allowed: false });
    await expect(overridden.authorize(SEND_INPUT)).rejects.toThrow(/Explicitly denied by override/);
    expect(overridden.approvals.getPending()).toHaveLength(0);
    closeWorkflowDb(); initWorkflowDb(':memory:');
    const ruled = shipped('send_email');
    ruled.authority.addContextRule({ id: 'no-mail', action: 'send_email', condition: 'always', params: {}, effect: 'deny', description: 'No mail from workflows' });
    await expect(ruled.authorize(SEND_INPUT)).rejects.toThrow(/No mail from workflows/);
    expect(ruled.approvals.getPending()).toHaveLength(0);
  });

  test('below the write_data floor a governed send is denied, not asked', async () => {
    const f = fixture(GMAIL, 'send_email', 2);
    f.authority.setGovernedCategories(['send_email']);
    await expect(f.authorize(SEND_INPUT)).rejects.toThrow(/Authority level 2 is below required 7 for send_email/);
    expect(f.approvals.getPending()).toHaveLength(0);
  });

  test('an approved card is refused at dispatch once the category stops being governed, or after Kill', async () => {
    const ungoverned = shipped('send_email');
    ungoverned.approvals.approve(approvalOf(await ungoverned.authorize(SEND_INPUT)), 'dashboard');
    ungoverned.authority.setGovernedCategories([]);
    await expect(ungoverned.authorize(SEND_INPUT)).rejects.toThrow(/below required 7/);
    closeWorkflowDb(); initWorkflowDb(':memory:');
    const killed = shipped('send_email');
    killed.approvals.approve(approvalOf(await killed.authorize(SEND_INPUT)), 'dashboard');
    (killed.options.emergencyController as EmergencyController).kill();
    await expect(killed.authorize(SEND_INPUT)).rejects.toThrow(/system killed/);
    expect(listWorkflowEffects(killed.run.id)[0]).toMatchObject({ status: 'blocked' });
  });
});

describe('Q-07 after #953: no Gmail send is replayed by an engine retry', () => {
  const REPLY_INPUT = { message_id: 'm1', reply_type: 'reply', body: 'Thanks, received.' };
  const approvalOf = (reply: unknown) => (reply as { approval: { approvalId: string } }).approval.approvalId;
  const shippedLevel = (action: string) => {
    const f = fixture(GMAIL, action, DEFAULT_CONFIG.authority.default_level);
    f.authority.setGovernedCategories([...DEFAULT_CONFIG.authority.governed_categories] as ActionCategory[]);
    return f;
  };

  test('every Gmail send action except the one that parks itself is tracked', () => {
    const sends = GOVERNED_PIECE_ADAPTERS.find((a) => a.catalogId === 'gmail')!.categories.send_email!;
    expect(sends.filter((action) => !tracksPieceCompletion(GMAIL, action))).toEqual(['request_approval_in_mail']);
  });

  for (const action of ['reply_to_email', 'gmail_reply_to_thread', 'gmail_send_draft', 'gmail_forward_message']) {
    test(`${action} at level 3: card, approve, one dispatch, and an engine retry is not resent`, async () => {
      const f = shippedLevel(action);
      const pending = await f.authorize(REPLY_INPUT);
      expect(pending).toMatchObject({ governed: true, dispatch: 'approval_required' });
      f.approvals.approve(approvalOf(pending), 'dashboard');
      expect(await f.authorize(REPLY_INPUT)).toMatchObject({ governed: true, dispatch: 'authorized', effectId: expect.any(String) });
      // The engine's "Retry on failure" asks again with no completion receipt: refused, not resent.
      await expect(f.authorize(REPLY_INPUT)).rejects.toThrow(/replay is blocked/);
    });
  }

  test('a recorded authorization is not handed out again once Authority denies it', async () => {
    const f = fixture(GMAIL, 'gmail_create_draft');
    expect(await f.authorize(SEND_INPUT)).toEqual({ governed: true, dispatch: 'authorized' });
    expect(await f.authorize(SEND_INPUT)).toEqual({ governed: true, dispatch: 'authorized' });
    f.authority.addOverride({ action: 'write_data', allowed: false });
    await expect(f.authorize(SEND_INPUT)).rejects.toThrow(/Explicitly denied by override/);
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'succeeded', replayRefusal: { outcome: { code: 'AUTHORITY_DENIED' } } });
    // The refused retry is in the trail, not only on the record.
    expect((f.options.auditTrail as AuditTrail).query({ agentId: `workflow:${f.run.id}` })
      .filter((row) => row.authority_decision === 'denied' && row.tool_name === 'piece:gmail/gmail_create_draft')).toHaveLength(1);
  });

  test('a recorded authorization is not handed out again once Authority wants an approval it never got', async () => {
    const f = fixture(GMAIL, 'gmail_create_draft');
    expect(await f.authorize(SEND_INPUT)).toEqual({ governed: true, dispatch: 'authorized' });
    f.authority.setGovernedCategories(['write_data']);
    await expect(f.authorize(SEND_INPUT)).rejects.toThrow(/now requires approval/);
  });

  test('a tracked send whose receipt is recorded hands back its result even after Authority changes', async () => {
    const f = shippedLevel('reply_to_email');
    f.approvals.approve(approvalOf(await f.authorize(REPLY_INPUT)), 'dashboard');
    const dispatched = await f.authorize(REPLY_INPUT) as { effectId: string };
    f.backends.pieceReceipt!(f.context, dispatched.effectId, { id: 'a1b2' });
    f.authority.addOverride({ action: 'send_email', allowed: false });
    // Nothing is sent again, so nothing is asked again: the stored result comes back.
    expect(await f.authorize(REPLY_INPUT)).toEqual({ governed: true, dispatch: 'completed', result: { id: 'a1b2' } });
  });

  for (const decided of [false, true]) {
    test(`a send recorded untracked before the upgrade and never sent ends typed, its card ${decided ? 'closed' : 'denied'}`, async () => {
      const f = shippedLevel('reply_to_email');
      const pending = await f.authorize(REPLY_INPUT);
      const approvalId = approvalOf(pending);
      // What an older daemon recorded: the same step under the untracked route.
      const tracked = listWorkflowEffects(f.run.id)[0]!;
      const legacyId = workflowEffectId(f.run.id, 'action', [], 'piece');
      saveWorkflowEffect({ ...tracked, id: legacyId, route: 'piece' });
      if (decided) f.approvals.approve(approvalId, 'dashboard');
      await expect(f.authorize(REPLY_INPUT)).rejects.toThrow(/before an upgrade changed how sends are tracked/);
      expect(listWorkflowEffects(f.run.id).find((e) => e.id === legacyId)).toMatchObject({ status: 'blocked',
        outcome: { code: 'WORKFLOW_UPGRADED', effect: 'not_started' } });
      expect(f.approvals.getRequest(approvalId)).toMatchObject(decided
        ? { status: 'executed', execution_outcome: 'blocked' } : { status: 'denied' });
      // An engine retry of the same step repeats the typed outcome; it does not claim a send may have happened.
      await expect(f.authorize(REPLY_INPUT)).rejects.toThrow(/before an upgrade changed how sends are tracked/);
    });
  }

  test('the approval request mail resumes through its recorded authorization', async () => {
    const f = shippedLevel('request_approval_in_mail');
    const input = { receiver: 'boss@example.test', subject: 'OK?', body: 'Approve the spend?' };
    f.approvals.approve(approvalOf(await f.authorize(input)), 'dashboard');
    expect(await f.authorize(input)).toEqual({ governed: true, dispatch: 'authorized' });
    // The piece parks itself after sending; on resume the engine re-runs the step.
    expect(await f.authorize(input)).toEqual({ governed: true, dispatch: 'authorized' });
  });
});

describe('#955: the editor badge and the admission agree on which steps skip approval', () => {
  test('a step is audited as a community piece exactly when isCommunityPiece says so', async () => {
    const pieces = [COMMUNITY_PIECE, '@activepieces/piece-mcp', GMAIL, '@jarvispieces/piece-jarvis-notify',
      '@activepieces/piece-http', '@activepieces/piece-webhook', '@activepieces/piece-delay'];
    for (const piece of pieces) {
      // The admission reads the request's piece, not the step's settings; a
      // governed piece is checked against the pinned graph, so it gets its own.
      const governed = piece === GMAIL || piece === '@activepieces/piece-http';
      const f = fixture(governed ? piece : COMMUNITY_PIECE, 'send_email');
      const reply = await f.backends.pieceAuthorize!({ piece, action: 'send_email', input: {}, inputDigest: await pieceInputDigest({}) }, f.context);
      // Every ungoverned piece was let through by the admission; the verified
      // one and the governed core HTTP piece (#961) went to Authority.
      expect(reply).toMatchObject({ governed });
      const audited = (f.options.auditTrail as AuditTrail).query({ limit: 5 })
        .some((row) => row.tool_name === `community piece ${piece}/send_email`);
      expect(`${piece}: ${audited}`).toBe(`${piece}: ${isCommunityPiece(piece)}`);
      closeWorkflowDb(); initWorkflowDb(':memory:');
    }
    // The core webhook piece is not loaded (#961: the editor's Webhook trigger
    // is Jarvis's own ingress), so it has no in-run exemption: were it ever to
    // run, it would be treated, audited and badged as any community piece.
    expect(pieces.filter(isCommunityPiece)).toEqual([COMMUNITY_PIECE, '@activepieces/piece-mcp', '@activepieces/piece-webhook']);
  });
});

describe('#961: the core HTTP piece is governed by method', () => {
  const HTTP = '@activepieces/piece-http';
  const shipped = () => {
    const f = fixture(HTTP, 'send_request', DEFAULT_CONFIG.authority.default_level);
    f.authority.setGovernedCategories([...DEFAULT_CONFIG.authority.governed_categories] as ActionCategory[]);
    return f;
  };
  // A read carries no body; anything else sends one, as a flow would.
  const request = (method: string, extra: Record<string, unknown> = {}) => ({ method, url: 'https://ops.example.test/api/logs',
    headers: { 'Content-Type': 'application/json' }, queryParams: {}, authType: 'NONE',
    ...(/^(get|head)$/i.test(method) ? { body_type: 'none' } : { body_type: 'json', body: { data: { line: 'ok' } } }), ...extra });
  const approvalOf = (reply: unknown) => (reply as { approval: { approvalId: string } }).approval.approvalId;

  test('at the shipped defaults a POST raises a card naming the method and the URL, and a GET runs without one', async () => {
    const post = shipped();
    const pending = await post.authorize(request('POST'));
    expect(pending).toMatchObject({ governed: true, dispatch: 'approval_required' });
    const card = post.approvals.getRequest(approvalOf(pending))!;
    expect(card).toMatchObject({ action_category: 'send_message', tool_name: 'piece:http/send_request' });
    expect(JSON.parse(card.context).target).toMatchObject({ piece: 'http', action: 'send_request', method: 'POST', url: 'https://ops.example.test/api/logs' });
    closeWorkflowDb(); initWorkflowDb(':memory:');
    const get = shipped();
    expect(await get.authorize(request('GET'))).toEqual({ governed: true, dispatch: 'authorized' });
    expect(get.approvals.getPending()).toHaveLength(0);
    expect(listWorkflowEffects(get.run.id)[0]).toMatchObject({ actionCategory: 'read_data', status: 'succeeded' });
  });

  test('PUT and PATCH ask as a POST does; DELETE and any other method are denied at the default level', async () => {
    for (const [method, outcome] of [['PUT', 'card'], ['PATCH', 'card'], ['post', 'card'], ['HEAD', 'run'], ['get', 'run'],
      ['DELETE', 'denied'], ['PURGE', 'denied'], [' GET', 'denied'], ['', 'denied']] as const) {
      const f = shipped();
      const reply = f.authorize(request(method));
      if (outcome === 'card') expect(await reply).toMatchObject({ dispatch: 'approval_required' });
      else if (outcome === 'run') expect(await reply).toEqual({ governed: true, dispatch: 'authorized' });
      else await expect(reply).rejects.toThrow(/Authority level 3 is below required 9 for delete_data/);
      closeWorkflowDb(); initWorkflowDb(':memory:');
    }
  });

  test('a request that is not a read is never sent twice: an engine retry after a lost or failed send is refused (Q-07)', async () => {
    const f = shipped();
    f.approvals.approve(approvalOf(await f.authorize(request('POST'))), 'dashboard');
    expect(await f.authorize(request('POST'))).toMatchObject({ governed: true, dispatch: 'authorized', effectId: expect.any(String) });
    await expect(f.authorize(request('POST'))).rejects.toThrow(/replay is blocked/);
    expect(listWorkflowEffects(f.run.id)).toHaveLength(1);
    expect(tracksPieceCompletion(HTTP, 'send_request', request('GET'))).toBe(false);
    expect(tracksPieceCompletion(HTTP, 'send_request', request('HEAD'))).toBe(false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'get ', 'PURGE']) expect(tracksPieceCompletion(HTTP, 'send_request', request(method))).toBe(true);
    // A caller that cannot see the input assumes a send.
    expect(tracksPieceCompletion(HTTP, 'send_request')).toBe(true);
    expect(tracksPieceCompletion(HTTP, 'parse_url', request('POST'))).toBe(false);
  });

  test('a GET or HEAD that carries a body is a send: it asks, and it is never sent twice', async () => {
    for (const [method, body] of [['GET', { data: { leak: 'x' } }], ['HEAD', { data: 'raw text' }], ['GET', { data: [{ fieldName: 'f', fieldType: 'file', fileFieldValue: 'x' }] }],
      ['GET', '[nested value omitted]']] as const) {
      const input = request(method, { body_type: 'json', body });
      expect(resolveGovernedPieceAction(HTTP, 'send_request', input)!.category).toBe('send_message');
      expect(tracksPieceCompletion(HTTP, 'send_request', input)).toBe(true);
      const f = shipped();
      expect(await f.authorize(input)).toMatchObject({ dispatch: 'approval_required' });
      closeWorkflowDb(); initWorkflowDb(':memory:');
    }
    // An empty body is no body.
    for (const body of [undefined, null, '', {}, { data: '' }, { data: null }]) {
      expect(resolveGovernedPieceAction(HTTP, 'send_request', request('GET', { body }))!.category).toBe('read_data');
    }
  });

  test('a GET is a read: the engine retry of a recorded authorization reads it again', async () => {
    const f = shipped();
    expect(await f.authorize(request('GET'))).toEqual({ governed: true, dispatch: 'authorized' });
    expect(await f.authorize(request('GET'))).toEqual({ governed: true, dispatch: 'authorized' });
  });

  test('a POST whose receipt is recorded hands back the stored response and sends nothing', async () => {
    const f = shipped();
    f.approvals.approve(approvalOf(await f.authorize(request('POST'))), 'dashboard');
    const dispatched = await f.authorize(request('POST')) as { effectId: string };
    f.backends.pieceReceipt!(f.context, dispatched.effectId, { status: 201, headers: {}, body: { id: 7 } });
    expect(await f.authorize(request('POST'))).toEqual({ governed: true, dispatch: 'completed', result: { status: 201, headers: {}, body: { id: 7 } } });
  });

  test('inline credentials never reach the effect record or the card', async () => {
    const secrets = ['sekret-token', 'sekret-header', 'key-1', 'q-secret', 'pw-1', 't-1', 'proxy-pw', 'basic-pw'];
    const input = request('POST', {
      url: 'https://user:pw-1@ops.example.test/api/logs?token=t-1&page=2',
      headers: { Authorization: 'Bearer sekret-header', 'X-Api-Key': 'key-1', Accept: 'application/json' },
      queryParams: { api_key: 'q-secret', page: '2' },
      authType: 'BEARER_TOKEN', authFields: { token: 'sekret-token', password: 'basic-pw', username: 'ops' },
      use_proxy: true, proxy_settings: { proxy_host: 'proxy.example.test', proxy_password: 'proxy-pw' },
    });
    const f = shipped();
    const card = f.approvals.getRequest(approvalOf(await f.authorize(sanitizePieceInput(input, HTTP))))!;
    const stored = JSON.stringify([listWorkflowEffects(f.run.id), card]);
    for (const secret of secrets) expect(`${secret}: ${stored.includes(secret)}`).toBe(`${secret}: false`);
    // Redacted, not dropped: the reviewer still sees that the request is authenticated, and the rest is kept.
    expect(JSON.parse(card.context).target.url).toBe('https://[redacted]@ops.example.test/api/logs?token=[redacted]&page=2');
    expect(JSON.parse(card.tool_arguments)).toMatchObject({ headers: { Authorization: '[redacted]', 'X-Api-Key': '[redacted]', Accept: 'application/json' },
      queryParams: { api_key: '[redacted]', page: '2' }, authFields: { token: '[redacted]', password: '[redacted]', username: 'ops' } });
    // The daemon redacts what an engine sent unredacted too.
    closeWorkflowDb(); initWorkflowDb(':memory:');
    const raw = shipped();
    const rawCard = raw.approvals.getRequest(approvalOf(await raw.authorize(input)))!;
    const rawStored = JSON.stringify([listWorkflowEffects(raw.run.id), rawCard]);
    for (const secret of secrets) expect(`${secret}: ${rawStored.includes(secret)}`).toBe(`${secret}: false`);
  });

  test('the engine sends the redacted projection and the digest of the whole input', async () => {
    const input = request('POST', { headers: { Authorization: 'Bearer sekret-header' } });
    let sent: Record<string, any> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ governed: true, dispatch: 'authorized', effectId: 'wfe_x' }), { status: 200 });
    }) as unknown as typeof fetch;
    await authorizePieceDispatch({ apiUrl: 'http://127.0.0.1:1', engineToken: 't', piece: HTTP, action: 'send_request',
      stepName: 'action', executionPath: [], input, fetchImpl });
    expect(sent.input.headers.Authorization).toBe('[redacted]');
    expect(sent.inputDigest).toBe(await pieceInputDigest(input));
    expect(JSON.stringify(sent)).not.toContain('sekret-header');
  });

  test('redaction is idempotent, so the daemon pass is still the identity on the engine pass', () => {
    const long = `https://u:p@ops.example.test/${'a'.repeat(600)}?api_key=k&x=1`;
    const input = request('POST', { url: long, headers: { Cookie: 'c=1', Accept: 'x' }, authFields: { token: 'tk' } });
    const engine = sanitizePieceInput(input, HTTP);
    expect(reprojectPieceInput(engine, HTTP)).toEqual(engine);
    expect(redactHttpInput(redactHttpInput(input))).toEqual(redactHttpInput(input));
    // Another piece's input is untouched.
    expect(sanitizePieceInput({ headers: { Authorization: 'x' } }, GMAIL)).toEqual({ headers: { Authorization: 'x' } });
  });

  test('a cut that lands inside a redacted value keeps its note through the daemon pass', () => {
    // Place the cut (512 characters) inside "[redacted]" for every offset into it.
    for (let inside = 0; inside < REDACTED.length; inside++) {
      const prefix = 'https://ops.example.test/?token=';
      const url = `${prefix.replace('?', `${'p'.repeat(512 - prefix.length - inside)}?`)}secret-value&next=1`;
      const engine = sanitizePieceInput(request('GET', { url }), HTTP);
      expect(String(engine.url)).toMatch(/\.\.\. \[\d+ more characters\]$/);
      expect(reprojectPieceInput(engine, HTTP)).toEqual(engine);
      expect(String(engine.url)).not.toContain('secret-value');
    }
  });

  test('credential names are matched as words: an author is content, an access token is not', () => {
    const out = redactHttpInput(request('POST', {
      url: 'https://x.test/?author=bob&oauth_callback_url=https%3A%2F%2Fa&accessToken=t1&sig=s1',
      headers: { 'X-Author': 'ann', 'X-Api-Key': 'k1', accessToken: 'a1', clientSecret: 'c1', 'X-Session-Id': 'sid', Accept: 'json' },
      body: { data: { password: 'p1', note: 'hello', authToken: 'q1' } },
    }));
    expect(out.url).toBe('https://x.test/?author=bob&oauth_callback_url=https%3A%2F%2Fa&accessToken=[redacted]&sig=[redacted]');
    expect(out.headers).toEqual({ 'X-Author': 'ann', 'X-Api-Key': '[redacted]', accessToken: '[redacted]', clientSecret: '[redacted]',
      'X-Session-Id': '[redacted]', Accept: 'json' });
    expect(out.body).toEqual({ data: { password: '[redacted]', note: 'hello', authToken: '[redacted]' } });
    const form = redactHttpInput(request('POST', { body_type: 'form_data', body: { data: [
      { fieldName: 'api_key', fieldType: 'text', textFieldValue: 'f1' }, { fieldName: 'name', fieldType: 'text', textFieldValue: 'Ann' }] } }));
    expect(form.body).toEqual({ data: [{ fieldName: 'api_key', fieldType: 'text', textFieldValue: '[redacted]' },
      { fieldName: 'name', fieldType: 'text', textFieldValue: 'Ann' }] });
  });

  test('keys, nested body fields and a password holding an @ are redacted too', () => {
    const out = redactHttpInput(request('POST', {
      url: 'https://user:p@ss@ops.example.test/x?key=g1&monkey=ok',
      headers: { key: 'k0', 'Ocp-Apim-Subscription-Key': 'k1', 'x-functions-key': 'k2' },
      body: { data: { user: { password: 'p1', name: 'Ann' }, items: [{ token: 't1' }, { note: 'n' }] } },
    }));
    expect(out.url).toBe('https://[redacted]@ops.example.test/x?key=[redacted]&monkey=ok');
    expect(out.headers).toEqual({ key: '[redacted]', 'Ocp-Apim-Subscription-Key': '[redacted]', 'x-functions-key': '[redacted]' });
    expect(out.body).toEqual({ data: { user: { password: '[redacted]', name: 'Ann' }, items: [{ token: '[redacted]' }, { note: 'n' }] } });
    expect(redactHttpInput(out)).toEqual(out);
    for (const name of ['authtoken', 'AUTHTOKEN', 'apitoken', 'clientsecret', 'privatekey', 'PHPSESSID']) {
      expect(`${name}: ${(redactHttpInput(request('GET', { headers: { [name]: 'v' } })).headers as Record<string, unknown>)[name]}`).toBe(`${name}: [redacted]`);
    }
  });

  test('a wide input whose projection loses the method is a tracked worst case on both sides', async () => {
    const wide = request('GET', Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`a${String(i).padStart(2, '0')}`, i])));
    let sent: Record<string, any> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ governed: true, dispatch: 'completed', result: { status: 200 } }), { status: 200 });
    }) as unknown as typeof fetch;
    // The engine reads the projection it sends: the method is cut, so it takes the send's worst case and accepts a stored receipt.
    expect(await authorizePieceDispatch({ apiUrl: 'http://127.0.0.1:1', engineToken: 't', piece: HTTP, action: 'send_request',
      stepName: 'action', executionPath: [], input: wide, fetchImpl })).toMatchObject({ dispatch: 'completed' });
    expect('method' in sent.input).toBe(false);
    expect(tracksPieceCompletion(HTTP, 'send_request', sent.input)).toBe(true);
    expect(resolveGovernedPieceAction(HTTP, 'send_request', sent.input)!.category).toBe('delete_data');
  });

  test('without its input the category is the worst case, and the method may only narrow it', () => {
    const blind = resolveGovernedPieceAction(HTTP, 'send_request')!;
    expect(blind).toMatchObject({ category: 'delete_data', known: true, byInput: true, categoryProps: ['method', 'body'] });
    expect(resolveGovernedPieceAction(HTTP, 'parse_url', request('POST'))).toMatchObject({ category: 'read_data', byInput: false });
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', '', 'x', 'get']) {
      const narrowed = resolveGovernedPieceAction(HTTP, 'send_request', { method })!.category;
      expect(AUTHORITY_REQUIREMENTS[narrowed]).toBeLessThanOrEqual(AUTHORITY_REQUIREMENTS[blind.category]);
    }
    for (const adapter of ALL_PIECE_ADAPTERS) {
      for (const action of Object.keys(adapter.categoryFromInput ?? {})) {
        expect(`${adapter.catalogId}/${action}: ${AUTHORITY_REQUIREMENTS[resolveGovernedPieceAction(adapter.pieceName, action)!.category]}`)
          .toBe(`${adapter.catalogId}/${action}: ${AUTHORITY_REQUIREMENTS[adapter.unknownActionCategory]}`);
      }
    }
  });

  test('padding that pushes a rule\'s props out of the projection takes the blind category for every rule', () => {
    // 40 keys that sort before any rule prop: the engine cuts the projection
    // at 40 sorted keys, so the props the rule reads are gone from what it
    // sees while the piece still receives them.
    const padding = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`a${String(i).padStart(2, '0')}`, i]));
    const samples: unknown[] = [undefined, false, true, null, '', 'GET', 'HEAD', 'get', 'subscribed', 'pending', 'transactional', 'private'];
    let rules = 0;
    const covered: string[] = [];
    for (const adapter of ALL_PIECE_ADAPTERS) {
      for (const [action, rule] of Object.entries(adapter.categoryFromInput ?? {})) {
        rules++;
        covered.push(`${adapter.catalogId}/${action}`);
        const blind = resolveGovernedPieceAction(adapter.pieceName, action)!.category;
        let narrowed = false;
        const combos = rule.props.reduce<Record<string, unknown>[]>((acc, prop) =>
          acc.flatMap(base => samples.map(value => value === undefined ? base : { ...base, [prop]: value })), [{}]);
        for (const props of combos) {
          if (resolveGovernedPieceAction(adapter.pieceName, action, props)!.category !== blind) narrowed = true;
          // `zz` keeps the object over 40 keys even when the rule's props are left out.
          const raw = { ...padding, ...props, zz: 'target' };
          const engine = sanitizePieceInput(raw, adapter.pieceName);
          const daemon = reprojectPieceInput(engine, adapter.pieceName);
          const label = `${adapter.catalogId}/${action} ${JSON.stringify(props)}`;
          for (const input of [raw, engine, daemon]) {
            expect(`${label}: ${resolveGovernedPieceAction(adapter.pieceName, action, input)!.category}`).toBe(`${label}: ${blind}`);
          }
        }
        // The samples reach a narrow case, so the padded assertions above are not vacuous.
        expect(`${adapter.catalogId}/${action} narrows: ${narrowed}`).toBe(`${adapter.catalogId}/${action} narrows: true`);
      }
    }
    expect(rules).toBeGreaterThan(0);
    // Every input-narrowed Asana rule is among those checked.
    expect(covered).toEqual(expect.arrayContaining(['asana/create_project', 'asana/instantiate_project_template',
      'asana/create_team', 'asana/duplicate_project', 'asana/update_project', 'asana/update_team']));
  });

  test('padding inside the body cannot hide its data from the read rule', () => {
    const inner = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`a${String(i).padStart(2, '0')}`, 0]));
    for (const method of ['GET', 'HEAD']) {
      const raw = { url: 'https://x.test/', method, body: { ...inner, data: 'exfil' } };
      const engine = sanitizePieceInput(raw, HTTP);
      const daemon = reprojectPieceInput(engine, HTTP);
      expect('data' in (engine.body as object)).toBe(false);
      for (const [label, input] of [['raw', raw], ['engine', engine], ['daemon', daemon]] as const) {
        expect(`${method} ${label}: ${resolveGovernedPieceAction(HTTP, 'send_request', input)!.category}`).toBe(`${method} ${label}: send_message`);
        expect(`${method} ${label}: ${tracksPieceCompletion(HTTP, 'send_request', input)}`).toBe(`${method} ${label}: true`);
      }
      // A wide body with no data at all is not judged a read either: the cut could have hidden one.
      const wideNoData = sanitizePieceInput({ url: 'https://x.test/', method, body: { ...inner, zz: 0 } }, HTTP);
      expect(resolveGovernedPieceAction(HTTP, 'send_request', wideNoData)!.category).toBe('send_message');
      // A small body with no data is still a read.
      expect(resolveGovernedPieceAction(HTTP, 'send_request', sanitizePieceInput({ url: 'https://x.test/', method, body: { a: 1 } }, HTTP))!.category).toBe('read_data');
    }
  });

  test('a field spelled like the cut marker neither hides a cut nor narrows a rule', () => {
    const http = (extra: Record<string, unknown>) => sanitizePieceInput({ method: 'GET', url: 'https://x.test/', ...extra }, HTTP);
    // Not cut: the field is escaped, so the rule still reads the GET.
    expect(resolveGovernedPieceAction(HTTP, 'send_request', http({ omittedFields: 0 }))!.category).toBe('read_data');
    // Cut: whatever the input spells, the bare marker is the count and the worst case holds.
    const pad = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`z${String(i).padStart(2, '0')}`, i]));
    for (const spoof of [{}, { omittedFields: 0 }, { '~omittedFields': 0 }]) {
      const cut = http({ ...pad, ...spoof });
      expect(cut.method).toBe('GET');
      expect(typeof cut.omittedFields).toBe('number');
      expect(resolveGovernedPieceAction(HTTP, 'send_request', cut)!.category).toBe('delete_data');
      expect(tracksPieceCompletion(HTTP, 'send_request', cut)).toBe(true);
    }
  });

  test('an HTTP receipt too large for the route keeps the status and says how much body it left out', () => {
    const effectId = `wfe_${'a'.repeat(64)}`;
    const small = { status: 200, headers: { a: 'b' }, body: { ok: true } };
    expect(JSON.parse(receiptBody(HTTP, effectId, small))).toEqual({ effectId, result: small });
    const big = { status: 201, headers: { a: 'b' }, body: 'x'.repeat(PIECE_RECEIPT_MAX_BYTES) };
    const reduced = receiptBody(HTTP, effectId, big);
    expect(new TextEncoder().encode(reduced).byteLength).toBeLessThanOrEqual(PIECE_RECEIPT_MAX_BYTES);
    expect(JSON.parse(reduced)).toEqual({ effectId, result: { status: 201, headers: { a: 'b' }, body: null, receiptOmittedBodyBytes: PIECE_RECEIPT_MAX_BYTES + 2 } });
    // Any other piece's receipt is sent as it is; the route decides.
    expect(receiptBody(GMAIL, effectId, big)).toBe(JSON.stringify({ effectId, result: big }));
    // A cookie the server set never reaches the durable receipt, whole or reduced.
    const cookie = { status: 200, headers: { 'Set-Cookie': 'sid=1', 'content-type': 'x' }, body: 'ok' };
    expect(JSON.parse(receiptBody(HTTP, effectId, cookie)).result.headers).toEqual({ 'content-type': 'x' });
    expect(JSON.parse(receiptBody(HTTP, effectId, { ...cookie, body: 'x'.repeat(PIECE_RECEIPT_MAX_BYTES) })).result.headers).toEqual({ 'content-type': 'x' });
  });
});


describe('managed ClickUp task permissions', () => {
  test('read-only authority cannot create tasks; a configured approval pauses writes', async () => {
    const readOnly = fixture('@activepieces/piece-clickup','create_task',1);
    await expect(readOnly.authorize({list_id:'sandbox',name:'Example'})).rejects.toThrow(/Authority denied/);
    const allowed = fixture('@activepieces/piece-clickup','get_list_task',1);
    expect(await allowed.authorize({task_id:'task1'})).toMatchObject({governed:true,dispatch:'authorized'});
    const approved = fixture('@activepieces/piece-clickup','update_task');
    approved.authority.setGovernedCategories(['write_data']);
    expect(await approved.authorize({task_id:'task1',name:'Changed'})).toMatchObject({governed:true,dispatch:'approval_required'});
  });

  // A self-hosted ClickUp workflow on the user's own connection ran at the
  // default level before the piece was governed; its reads, writes and
  // comments must keep doing so, with no card.
  test('reads, writes and comments run at the default level 3 without a card', async () => {
    for (const [action, input] of [['clickup_get_spaces', {workspace_id:'8'}], ['get_task_comments', {task_id:'task1'}],
      ['list_workspace_tasks', {workspace_id:'8'}], ['create_task_comments', {task_id:'task1', comment:'Done'}],
      ['clickup_set_task_status', {task_id:'task1', status:'done'}]] as const) {
      const f = fixture('@activepieces/piece-clickup', action, 3);
      expect({action, reply: await f.authorize(input)}).toMatchObject({action, reply: {governed:true, dispatch:'authorized'}});
      expect(f.approvals.getPending()).toHaveLength(0);
      expect(f.deliveredApprovals).toEqual([]);
    }
  });

  test('a delete requires delete_data and an unmapped action stays modify_settings', async () => {
    for (const action of ['delete_task', 'clickup_delete_task', 'delete_message', 'clickup_delete_space']) {
      expect(resolveGovernedPieceAction('@activepieces/piece-clickup', action)).toMatchObject({category:'delete_data', known:true});
    }
    await expect(fixture('@activepieces/piece-clickup', 'delete_task', 3).authorize({task_id:'task1'})).rejects.toThrow(/Authority denied/);
    expect(await fixture('@activepieces/piece-clickup', 'delete_task', 9).authorize({task_id:'task1'})).toMatchObject({governed:true, dispatch:'authorized'});
    for (const action of ['custom_api_call', 'clickup_added_upstream_later']) {
      expect(resolveGovernedPieceAction('@activepieces/piece-clickup', action)).toMatchObject({category:'modify_settings', known:false});
    }
    await expect(fixture('@activepieces/piece-clickup', 'custom_api_call', 3).authorize({url:'/user', method:'GET'})).rejects.toThrow(/Authority denied/);
  });

  test('every ClickUp write, send and delete carries a completion receipt; no read does', () => {
    const adapter = ALL_PIECE_ADAPTERS.find(a => a.catalogId === 'clickup')!;
    for (const [category, names] of Object.entries(adapter.categories)) {
      for (const action of names ?? []) {
        expect(`${action}: ${tracksPieceCompletion(adapter.pieceName, action)}`).toBe(`${action}: ${category !== 'read_data'}`);
      }
    }
    expect(tracksPieceCompletion(adapter.pieceName, 'custom_api_call')).toBe(false);
  });
});
