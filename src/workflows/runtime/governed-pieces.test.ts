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
import { GOVERNED_PIECE_ADAPTERS, governedPieceTarget, governedPieceToolName, isWellFormedPieceActionName, PIECE_ACTION_NAME_MAX_CHARS, reprojectPieceInput,
  resolveGovernedPieceAction, sanitizePieceInput } from './piece-effects';
import { defangPieceProjection } from './piece-effect-receipt';
import { digest } from './effect-context';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN, wrapUntrusted } from '../../roles/untrusted';
import { authorizePieceDispatch } from './piece-effect-guard';
import { WebSocketService } from '../../daemon/ws-service';
import { SandboxApi } from '../sandbox-api/server';
import { EngineTokenSigner } from '../sandbox-api/engine-token';
import { SandboxRegistry } from '../sandbox-api/sandbox-registry';

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
    wsService: { broadcastNotificationToDashboard: () => {} } as any };
  const backends = buildSandboxServiceBackends(options);
  const context = { runId: run.id, projectId: DEFAULT_IDS.project, stepName, executionPath: [] };
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
      expect(await f.authorize(piece.input)).toEqual({ governed: true, dispatch: 'authorized' });
      expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('succeeded');
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
    expect(effect.requestDigest).toBe(digest({ piece: GMAIL, action: 'send_email', input: JSON.parse(EXPECTED) }));
    expect(effect.requestDigest).not.toBe(digest({ piece: GMAIL, action: 'send_email',
      input: { body: { y: 1 }, n: {}, s: {}, subject: 'x' } }));
  });
});
