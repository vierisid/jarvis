/**
 * Q-08: Authority holds at every execution entry outside workflows -- the
 * approval executor, every decision surface, realtime voice, chat turns and
 * tool dispatch -- below any UI control. Workflow entries are certified in
 * `workflows/runtime/emergency-hold.test.ts` and the delivery suite.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { ApprovalManager, UNANSWERED_APPROVAL_TTL_MS, type ApprovalPrincipal } from './approval.ts';
import { AuditTrail } from './audit.ts';
import { AuthorityEngine, type AuthorityConfig } from './engine.ts';
import { authorityConfigPatchError } from './config-validation.ts';
import { DeferredExecutor } from './deferred-executor.ts';
import { EmergencyController, setActiveEmergencyController } from './emergency.ts';
import { ToolRegistry, type ToolDefinition } from '../actions/tools/registry.ts';
import { ActionOutcomeError, type ActionFailure } from '../actions/action-outcome.ts';
import { checkpointExecution } from '../actions/execution-scope.ts';
import { applyApprovalDecision, applyExecutionResolution, channelDecisionReply, type ApprovalDecisionDeps } from '../daemon/approval-decision.ts';
import { ChannelService, CHANNEL_APPROVE_NOT_ALLOWED, channelSenderMayApprove } from '../daemon/channel-service.ts';
import { createApiRoutes, type ApiContext } from '../daemon/api-routes.ts';
import { WebSocketService } from '../daemon/ws-service.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import type { RoleDefinition } from '../roles/types.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => { setActiveEmergencyController(null); closeDb(); });

const PRINCIPAL: ApprovalPrincipal = { agentRoleId: 'personal-assistant', agentAuthorityLevel: 5 };
const CLICK_ONLY = JSON.stringify({ confirm: 'always', intent: 'Click Send in Mail (sends an email)' });

function config(overrides: Partial<AuthorityConfig> = {}): AuthorityConfig {
  return { default_level: 3, governed_categories: [], overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal', ...overrides };
}

/** One approval pipeline: manager, audit, engine, executor and a write tool that counts its runs. */
function pipeline(opts: { tool?: ToolDefinition['execute'] } = {}) {
  const approvals = new ApprovalManager();
  const audit = new AuditTrail();
  const authority = new AuthorityEngine(config());
  const runs: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register({ name: 'write_file', description: 'Synthetic write', category: 'file-ops', parameters: {},
    execute: opts.tool ?? (async (params) => { runs.push(params); return 'written'; }) });
  const executor = new DeferredExecutor(approvals, audit);
  executor.setToolRegistry(registry);
  executor.setAuthorityEngine(authority);
  const deps: ApprovalDecisionDeps = { approvalManager: approvals, deferredExecutor: executor, auditTrail: audit };
  const ask = (extra: { context?: string; principal?: ApprovalPrincipal | null; mode?: 'deferred' | 'workflow' } = {}) =>
    approvals.createRequest({ agentId: 'agent-1', agentName: 'PA', toolName: 'write_file', toolArguments: { path: '/tmp/a' },
      actionCategory: 'write_data', urgency: 'normal', reason: 'Write the note', context: extra.context ?? '',
      executionMode: extra.mode ?? 'deferred', ...(extra.principal === null ? {} : { principal: extra.principal ?? PRINCIPAL }) });
  return { approvals, audit, authority, registry, executor, deps, runs, ask };
}

describe('an approved call is judged again when it runs', () => {
  test('a permission revoked after approval stops it, as the agent it was asked for', async () => {
    const p = pipeline();
    const req = p.ask();
    p.approvals.approve(req.id, 'dashboard');
    p.authority.addOverride({ action: 'write_data', allowed: false });
    const receipt = await p.executor.executeApprovedWithReceipt(req.id);
    expect(receipt.result).toContain('its permissions changed after it was approved');
    expect(p.runs).toEqual([]);
    expect(p.approvals.getRequest(req.id)).toMatchObject({ status: 'executed', execution_outcome: 'blocked' });
  });

  test('unchanged permissions let it run once; a level lowered below a gate it cannot substitute stops it', async () => {
    const p = pipeline();
    const ok = p.ask();
    p.approvals.approve(ok.id, 'dashboard');
    await p.executor.executeApprovedWithReceipt(ok.id);
    await p.executor.executeApprovedWithReceipt(ok.id);
    expect(p.runs).toHaveLength(1);
    const low = p.ask({ principal: { agentRoleId: 'reader', agentAuthorityLevel: 1 } });
    p.approvals.approve(low.id, 'dashboard');
    p.authority.updateConfig({ ...p.authority.getConfig(), default_level: 1 });
    expect((await p.executor.executeApprovedWithReceipt(low.id)).result).toContain('permissions changed');
    expect(p.runs).toHaveLength(1);
  });

  test('a request that recorded no one is asked for again', async () => {
    const p = pipeline();
    const req = p.ask({ principal: null });
    p.approvals.approve(req.id, 'dashboard');
    expect((await p.executor.executeApprovedWithReceipt(req.id)).result).toContain('Ask for it again');
    expect(p.runs).toEqual([]);
  });
});

describe('a card that must be reviewed on screen', () => {
  test('is approved on the dashboard only; a chat reply or a toast is refused and the card stays pending', async () => {
    const p = pipeline();
    const req = p.ask({ context: CLICK_ONLY });
    for (const surface of ['telegram', 'discord', 'notification']) {
      expect(await applyApprovalDecision('approve', req.id, surface, p.deps)).toMatchObject({ status: 'needs_dashboard' });
    }
    expect(p.approvals.getRequest(req.id)!.status).toBe('pending');
    expect(await applyApprovalDecision('approve', req.id, 'dashboard', p.deps)).toMatchObject({ status: 'approved', executed: true });
    expect(p.runs).toHaveLength(1);
  });

  test('approved anywhere else, the executor refuses it', async () => {
    const p = pipeline();
    const req = p.ask({ context: CLICK_ONLY });
    p.approvals.approve(req.id, 'telegram');
    expect((await p.executor.executeApprovedWithReceipt(req.id)).result).toContain('approved on the dashboard');
    expect(p.runs).toEqual([]);
  });
});

describe('two surfaces deciding one request', () => {
  test('dispatch it once', async () => {
    const p = pipeline();
    const req = p.ask();
    const outcomes = await Promise.all([
      applyApprovalDecision('approve', req.id, 'dashboard', p.deps),
      applyApprovalDecision('approve', req.id, 'telegram', p.deps),
      applyApprovalDecision('approve', req.id, 'notification', p.deps),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['already_decided', 'already_decided', 'approved']);
    expect(p.runs).toHaveLength(1);
  });

  test('every decision and every receipt is audited with the surface it came from', async () => {
    const p = pipeline();
    const approved = p.ask();
    await applyApprovalDecision('approve', approved.id, 'telegram', p.deps);
    const denied = p.ask();
    await applyApprovalDecision('deny', denied.id, 'notification', p.deps);
    const rows = p.audit.query({ limit: 10 }).map((r) => [r.approval_id === approved.id ? 'approved' : 'denied', r.authority_decision, r.channel, r.executed]);
    expect(rows).toEqual(expect.arrayContaining([
      ['approved', 'allowed', 'chat', 0], ['approved', 'approval_required', null, 1], ['denied', 'denied', 'notification', 0],
    ]));
  });
});

describe('Pause and Kill below every decision surface', () => {
  test('approving waits while Jarvis is paused; denying still works', async () => {
    const controller = new EmergencyController();
    setActiveEmergencyController(controller);
    const p = pipeline();
    const req = p.ask();
    controller.pause();
    const held = await applyApprovalDecision('approve', req.id, 'dashboard', p.deps);
    expect(held).toMatchObject({ status: 'held', state: 'paused' });
    expect(channelDecisionReply(held, req)).toContain('Resume Jarvis, then approve it');
    expect(p.approvals.getRequest(req.id)!.status).toBe('pending');
    const other = p.ask();
    expect(await applyApprovalDecision('deny', other.id, 'dashboard', p.deps)).toMatchObject({ status: 'denied' });
    controller.resume();
    expect(await applyApprovalDecision('approve', req.id, 'dashboard', p.deps)).toMatchObject({ status: 'approved', executed: true });
    expect(p.runs).toHaveLength(1);
  });

  test('Kill denies every pending request, workflow ones included', () => {
    const p = pipeline();
    const chat = p.ask(), workflow = p.ask({ mode: 'workflow' });
    expect(p.approvals.denyAllPending('emergency-kill').map((r) => r.id).sort()).toEqual([chat.id, workflow.id].sort());
    expect(p.approvals.getPending()).toEqual([]);
  });

  test('Kill stops a tool in flight at its next checkpoint; Pause lets it finish', async () => {
    const controller = new EmergencyController();
    setActiveEmergencyController(controller);
    let release!: () => void;
    const steps: string[] = [];
    const registry = new ToolRegistry();
    registry.register({ name: 'run_skill', description: 'Two steps', category: 'automation', parameters: {},
      execute: async () => {
        steps.push('first');
        await new Promise<void>((resolve) => { release = resolve; });
        checkpointExecution();
        steps.push('second');
        return 'done';
      } });
    const paused = registry.execute('run_skill', {});
    controller.pause();
    release();
    expect(await paused).toBe('done');
    controller.resume();
    const killed = registry.execute('run_skill', {});
    controller.kill();
    release();
    await expect(killed).rejects.toThrow(/stopped with Kill/);
    expect(steps).toEqual(['first', 'second', 'first']);
  });
});

describe('what a receipt says', () => {
  const failing = (outcome: ActionFailure) => async () => { throw new ActionOutcomeError(outcome); };

  test('a tool that cannot say whether it ran leaves the request unresolved, never run again', async () => {
    const p = pipeline({ tool: failing({ status: 'unknown', code: 'LOST_REPLY', message: 'the reply was lost', effect: 'may_have_occurred' }) });
    const req = p.ask();
    const outcome = await applyApprovalDecision('approve', req.id, 'dashboard', p.deps);
    expect(p.approvals.getRequest(req.id)).toMatchObject({ status: 'approved', execution_outcome: 'unknown' });
    expect(channelDecisionReply(outcome, req)).toContain('not known whether it happened');
    expect(await applyExecutionResolution('execute', req.id, 'dashboard', p.deps)).toMatchObject({ status: 'not_executable' });
    expect(await applyExecutionResolution('close', req.id, 'dashboard', p.deps)).toMatchObject({ status: 'closed' });
  });

  test('nothing started is blocked, not failed; a plain error is failed', async () => {
    const blocked = pipeline({ tool: failing({ status: 'blocked', code: 'OFFLINE', message: 'machine offline', effect: 'not_started' }) });
    const a = blocked.ask();
    const reply = channelDecisionReply(await applyApprovalDecision('approve', a.id, 'dashboard', blocked.deps), a);
    expect(blocked.approvals.getRequest(a.id)!.execution_outcome).toBe('blocked');
    expect(reply).toStartWith('Approved, but not run');
    const failed = pipeline({ tool: async () => { throw new Error('disk full'); } });
    const b = failed.ask();
    expect(channelDecisionReply(await applyApprovalDecision('approve', b.id, 'dashboard', failed.deps), b)).toStartWith('Approved, but it failed');
    const done = pipeline();
    const c = done.ask();
    expect(channelDecisionReply(await applyApprovalDecision('approve', c.id, 'dashboard', done.deps), c)).toStartWith('Approved and executed');
  });
});

describe('approving from chat', () => {
  test('needs a sender on the channel\'s allowed users list', () => {
    const cfg = (telegram: number[], discord: string[]) => ({ channels: { telegram: { enabled: true, bot_token: 't', allowed_users: telegram },
      discord: { enabled: true, bot_token: 't', allowed_users: discord } } }) as never;
    expect(channelSenderMayApprove(cfg([], []), 'telegram', 42)).toBe(false);
    expect(channelSenderMayApprove(cfg([42], []), 'telegram', 42)).toBe(true);
    expect(channelSenderMayApprove(cfg([42], []), 'telegram', 7)).toBe(false);
    expect(channelSenderMayApprove(cfg([], ['u-1']), 'discord', 'u-1')).toBe(true);
    expect(channelSenderMayApprove(cfg([42], []), 'discord', 42)).toBe(false);
  });

  test('a sender not on the list can deny but not approve', async () => {
    const svc = new ChannelService({ channels: { telegram: { enabled: false, bot_token: '', allowed_users: [] } } } as never, {} as never);
    const handled: string[] = [];
    svc.setApprovalHandler(async (action, shortId) => { handled.push(`${action} ${shortId}`); return 'ok'; });
    const message = (text: string) => ({ id: '1', channel: 'telegram', from: 'someone', text, timestamp: 0, metadata: { chatId: 1, userId: 99 } });
    const handle = (svc as unknown as { handleChannelMessage(m: unknown): Promise<string> }).handleChannelMessage.bind(svc);
    expect(await handle(message('approve abcdef12'))).toBe(CHANNEL_APPROVE_NOT_ALLOWED);
    expect(await handle(message('deny abcdef12'))).toBe('ok');
    expect(handled).toEqual(['deny abcdef12']);
  });

  test('names exactly one card, by at least the 8 characters the card shows', () => {
    const p = pipeline();
    const insert = (id: string) => getDb().run(`INSERT INTO approval_requests (id, agent_id, agent_name, tool_name, tool_arguments, action_category, urgency, reason, context, status, execution_mode, created_at)
      VALUES (?, 'a', 'PA', 'write_file', '{}', 'write_data', 'normal', 'r', '', 'pending', 'deferred', ?)`, [id, Date.now()]);
    insert('aaaa1111-0000-0000-0000-000000000001');
    insert('aaaa1111-0000-0000-0000-000000000002');
    insert('bbbb2222-0000-0000-0000-000000000003');
    expect(p.approvals.findByShortId('a')).toBeNull();
    expect(p.approvals.findByShortId('bbbb')).toBeNull(); // unique, but shorter than the card shows
    expect(p.approvals.findByShortId('aaaa1111')).toBeNull(); // two cards share it
    expect(p.approvals.findByShortId('bbbb2222')!.id).toBe('bbbb2222-0000-0000-0000-000000000003');
    expect(p.approvals.findByShortId('aaaa1111-0000-0000-0000-000000000002')!.id).toBe('aaaa1111-0000-0000-0000-000000000002');
  });
});

describe('a card nobody answers', () => {
  test('stops being approvable after 24 hours; a workflow approval keeps its own lifecycle', () => {
    const p = pipeline();
    const chat = p.ask(), workflow = p.ask({ mode: 'workflow' }), fresh = p.ask();
    getDb().run('UPDATE approval_requests SET created_at = ? WHERE id IN (?, ?)', [Date.now() - UNANSWERED_APPROVAL_TTL_MS - 1, chat.id, workflow.id]);
    expect(p.approvals.expireUnanswered(UNANSWERED_APPROVAL_TTL_MS)).toBe(1);
    expect([chat, workflow, fresh].map((r) => p.approvals.getRequest(r.id)!.status)).toEqual(['expired', 'pending', 'pending']);
  });
});

describe('permission settings', () => {
  test('a level that is not a number counts for nothing', () => {
    const authority = new AuthorityEngine(config({ default_level: Number.NaN }));
    const decision = authority.checkAuthority({ agentId: 'a', agentAuthorityLevel: Number.NaN, agentRoleId: 'r', toolName: 'run_command',
      toolCategory: 'terminal', actionCategory: 'execute_command', temporaryGrants: new Map() });
    expect(decision).toMatchObject({ allowed: false, deniedByLevel: true });
  });

  test('a config change is checked before it is applied', () => {
    expect(authorityConfigPatchError({ default_level: 'high' })).toContain('default_level');
    expect(authorityConfigPatchError({ default_level: 11 })).toContain('default_level');
    expect(authorityConfigPatchError({ governed_categories: ['send_email', 'teleport'] })).toContain('governed_categories');
    expect(authorityConfigPatchError({ overrides: [{ action: 'send_email', allowed: 'yes' }] })).toContain('override');
    expect(authorityConfigPatchError({ default_level: 5, governed_categories: ['send_email'],
      overrides: [{ action: 'send_email', allowed: true, requires_approval: true }] })).toBeNull();
  });

  test('the routes refuse a bad config, and a learning accept keeps a Kill', async () => {
    const authority = new AuthorityEngine(config());
    const appConfig = { authority: { default_level: 3, emergency_state: 'killed' } } as Record<string, any>;
    const suggestions: Array<{ actionCategory: string }> = [];
    const routes = createApiRoutes({ config: appConfig, agentService: {}, authorityEngine: authority,
      learner: { getSuggestions: () => suggestions, markSuggestionSent: () => {} },
    } as unknown as ApiContext) as Record<string, Record<string, (req: Request) => Promise<Response>>>;
    const post = (path: string, body: unknown) => routes[path]!.POST!(new Request(`http://localhost${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
    expect((await post('/api/authority/config', { default_level: 'high' })).status).toBe(400);
    expect(authority.getConfig().default_level).toBe(3);
    expect((await post('/api/authority/learning/accept', { action: 'send_email', tool_name: 'x' })).status).toBe(400);
    suggestions.push({ actionCategory: 'send_email' });
    expect((await post('/api/authority/learning/accept', { action: 'send_email', tool_name: 'x' })).status).toBe(200);
    expect(appConfig.authority.emergency_state).toBe('killed');
    expect(appConfig.authority.overrides).toEqual([{ action: 'send_email', allowed: true, requires_approval: false }]);
  });
});

describe('chat turns', () => {
  type Exec = { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }, signal?: AbortSignal, taint?: Set<string>) => Promise<unknown> };
  const role = { id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: [], authority_level: 5 } as unknown as RoleDefinition;
  function turnHarness(governed: AuthorityConfig['governed_categories'] = []) {
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.register({ name: 'run_command', description: 't', category: 'terminal', parameters: {}, execute: async () => { calls.push('run_command'); return 'ok'; } });
    registry.register({ name: 'request_approval', description: 't', category: 'authority', parameters: {},
      execute: async (args) => `[DENIED] User denied approval for: ${String(args.intent)}` });
    const approvals = new ApprovalManager();
    const orch = new AgentOrchestrator();
    orch.setToolRegistry(registry);
    orch.setAuthorityEngine(new AuthorityEngine(config({ governed_categories: governed })));
    orch.setApprovalManager(approvals);
    orch.createPrimary(role);
    const exec = (name: string, args: Record<string, unknown>, turn: Set<string>, signal?: AbortSignal) =>
      (orch as unknown as Exec).executeTool({ id: 't', name, arguments: args }, signal, turn);
    return { orch, approvals, calls, exec, registry };
  }

  test('an intent the person denied cannot be carried out through a tool the level allows, in that turn', async () => {
    const h = turnHarness();
    const turn = new Set<string>();
    expect(await h.exec('request_approval', { action_category: 'execute_command', intent: 'git push --force' }, turn)).toContain('[DENIED]');
    expect(await h.exec('run_command', {}, turn)).toContain('[AWAITING_APPROVAL]');
    expect(h.calls).toEqual([]);
    expect(await h.exec('run_command', {}, new Set())).toBe('ok');
    expect(h.calls).toEqual(['run_command']);
  });

  test('a card raised in chat records whom it was asked for, and runs once approved', async () => {
    const h = turnHarness(['execute_command']);
    expect(await h.exec('run_command', {}, new Set())).toContain('[AWAITING_APPROVAL]');
    const [card] = h.approvals.getPending();
    expect(JSON.parse(card!.principal!)).toMatchObject({ agentRoleId: 'personal-assistant', agentAuthorityLevel: 5 });
    const executor = new DeferredExecutor(h.approvals, new AuditTrail());
    executor.setToolRegistry(h.registry);
    executor.setAuthorityEngine(new AuthorityEngine(config({ governed_categories: ['execute_command'] })));
    expect(await applyApprovalDecision('approve', card!.id, 'dashboard', { approvalManager: h.approvals, deferredExecutor: executor }))
      .toMatchObject({ status: 'approved', executed: true });
    expect(h.calls).toEqual(['run_command']);
  });

  test('a task cancelled while its card waits withdraws the card instead of handing it on', async () => {
    const h = turnHarness(['execute_command']);
    const executor = new DeferredExecutor(h.approvals, new AuditTrail());
    executor.setToolRegistry(h.registry);
    h.orch.setDeferredExecutor(executor);
    const abort = new AbortController();
    const pending = h.exec('run_command', {}, new Set(), abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    expect(await pending).toContain('[APPROVAL WITHDRAWN]');
    const [card] = h.approvals.getHistory({ limit: 1 });
    expect(card).toMatchObject({ status: 'denied', decided_by: 'task-cancelled' });
    expect(h.calls).toEqual([]);
  });
});

describe('a spoken yes or no', () => {
  function voice() {
    const p = pipeline();
    const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as never);
    ws.setApprovalManager(p.approvals);
    ws.setDeferredExecutor(p.executor);
    ws.setAuditTrail(p.audit);
    (ws as unknown as { broadcastApprovalUpdate: () => void }).broadcastApprovalUpdate = () => {};
    return { ...p, ws };
  }

  test('decides nothing while more than one card waits', async () => {
    const v = voice();
    v.ask(); v.ask();
    expect(await v.ws.resolveLatestPendingByVoice('approve', 0.99)).toMatchObject({ kind: 'gated', message: expect.stringContaining('2 approvals are waiting') });
    expect(v.approvals.getPending()).toHaveLength(2);
    expect(v.runs).toEqual([]);
  });

  test('approves the one card waiting, and waits while Jarvis is paused', async () => {
    const controller = new EmergencyController();
    setActiveEmergencyController(controller);
    const v = voice();
    v.ask();
    controller.pause();
    expect(await v.ws.resolveLatestPendingByVoice('approve', 0.99)).toMatchObject({ kind: 'gated' });
    expect(v.runs).toEqual([]);
    controller.resume();
    expect(await v.ws.resolveLatestPendingByVoice('approve', 0.99)).toMatchObject({ kind: 'approval' });
    expect(v.runs).toHaveLength(1);
  });
});
