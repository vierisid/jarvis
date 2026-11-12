import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { ApprovalManager } from './approval.ts';
import { AUDIT_PAGE_MAX, AuditTrail, auditPageLimit } from './audit.ts';
import { AuthorityEngine, decisionAuthor } from './engine.ts';
import { DeferredExecutor } from './deferred-executor.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import { applyApprovalDecision } from '../daemon/approval-decision.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

const audit = () => new AuditTrail();
function asked(mgr: ApprovalManager, trail: AuditTrail) {
  const request = mgr.createRequest({ agentId: 'a1', agentName: 'PA', toolName: 'send_email', toolArguments: { to: 'x@example.test' },
    actionCategory: 'send_email', urgency: 'normal', reason: 'test', context: '' });
  trail.log({ agent_id: 'a1', agent_name: 'PA', tool_name: 'send_email', action_category: 'send_email',
    authority_decision: 'approval_required', approval_id: request.id, executed: false });
  return request;
}
async function decide(action: 'approve' | 'deny', run: () => Promise<string>, device: string | null = 'dev-1') {
  const mgr = new ApprovalManager(), trail = audit();
  const executor = new DeferredExecutor(mgr, trail);
  executor.setToolRegistry({ get: () => undefined, execute: run } as unknown as ToolRegistry);
  const request = asked(mgr, trail);
  await applyApprovalDecision(action, request.id, 'dashboard', { approvalManager: mgr, deferredExecutor: executor, auditTrail: trail, decidedDevice: device });
  return { trail, request };
}

describe('the ledger reads one entry per side effect', () => {
  test('an approved action that ran is one entry with its outcome, however many rows it wrote', async () => {
    const { trail, request } = await decide('approve', async () => 'sent');
    expect(trail.query({ agentId: 'a1' }).length).toBeGreaterThanOrEqual(3);
    const entries = trail.queryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ approval_id: request.id, outcome: 'succeeded', executed: 1, authority_decision: 'approval_required', events: 3 });
    expect(trail.getStats()).toMatchObject({ total: 1, approvalRequired: 1, byOutcome: { succeeded: 1 } });
  });

  test('a denied action is one denied entry that did not run', async () => {
    const { trail } = await decide('deny', async () => 'never');
    expect(trail.queryEntries()).toMatchObject([{ authority_decision: 'denied', outcome: 'not_started', executed: 0 }]);
    expect(trail.getStats()).toMatchObject({ total: 1, denied: 1, byOutcome: { not_started: 1 } });
  });

  test('an approved action whose run threw is not marked executed', async () => {
    const { trail } = await decide('approve', async () => { throw new Error('smtp down'); });
    expect(trail.queryEntries()).toMatchObject([{ outcome: 'failed', executed: 0 }]);
  });

  test('the entry records which device decided, by name when it is still enrolled', async () => {
    getDb().run("INSERT INTO sidecars (id, name, token_id, status, enrolled_at) VALUES ('dev-1', 'Studio laptop', 'tok-1', 'enrolled', datetime('now'))");
    const { trail } = await decide('approve', async () => 'sent', 'dev-1');
    expect(trail.queryEntries()[0]).toMatchObject({ decided_by: 'dashboard:dev-1', decided_device: 'Studio laptop' });
    const other = await decide('approve', async () => 'sent', null);
    expect(other.trail.queryEntries().find(e => e.approval_id === other.request.id)?.decided_by).toBe('dashboard');
  });

  test('a decision row joins the workflow effect its approval belongs to', () => {
    const trail = audit();
    getDb().run('CREATE TABLE IF NOT EXISTS workflow_effect (id TEXT PRIMARY KEY, approval_id TEXT)');
    getDb().run("INSERT INTO workflow_effect (id, approval_id) VALUES ('wfe_1', 'appr_1')");
    trail.log({ agent_id: 'workflow:r1', agent_name: 'Workflow F / s / wfe_1', tool_name: 'workflow_notify', action_category: 'send_message',
      authority_decision: 'approval_required', approval_id: 'appr_1', executed: false, effect_id: 'wfe_1' });
    trail.log({ agent_id: 'workflow:r1', agent_name: 'Workflow F / s', tool_name: 'workflow_notify', action_category: 'send_message',
      authority_decision: 'allowed', approval_id: 'appr_1', executed: false, decided_by: 'dashboard:dev-9' });
    trail.log({ agent_id: 'workflow:r1', agent_name: 'Workflow F / s / wfe_1', tool_name: 'workflow_notify', action_category: 'send_message',
      authority_decision: 'approval_required', approval_id: 'appr_1', executed: true, effect_id: 'wfe_1', outcome: 'succeeded' });
    expect(trail.query({ agentId: 'workflow:r1' }).map(r => r.effect_id)).toEqual(['wfe_1', 'wfe_1', 'wfe_1']);
    expect(trail.queryEntries()).toMatchObject([{ effect_id: 'wfe_1', events: 3, outcome: 'succeeded', decided_by: 'dashboard:dev-9' }]);
    expect(trail.getStats().total).toBe(1);
  });

  test('filters apply to entries, and rows that share no effect or approval stay separate', () => {
    const trail = audit();
    for (const tool of ['a', 'b']) trail.log({ agent_id: 'x', agent_name: 'X', tool_name: tool, action_category: 'read_data', authority_decision: 'allowed', executed: true });
    expect(trail.queryEntries()).toHaveLength(2);
    expect(trail.queryEntries({ tool: 'a' })).toHaveLength(1);
    expect(trail.queryEntries({ decision: 'denied' })).toHaveLength(0);
    expect(trail.getStats()).toMatchObject({ total: 2, allowed: 2 });
  });

  test('an entry with no settling row is counted as unrecorded, never as succeeded', () => {
    const trail = audit();
    // The chat gate writes `executed: true` before the tool runs: that is not a result.
    trail.log({ agent_id: 'x', agent_name: 'X', tool_name: 'send_email', action_category: 'send_email', authority_decision: 'allowed', executed: true });
    expect(trail.queryEntries()).toMatchObject([{ outcome: null }]);
    expect(trail.getStats().byOutcome).toEqual({ unrecorded: 1 });
  });

  test('the page is bounded and ordered by when each entry began, not by its latest row', () => {
    const trail = audit();
    const at = (ms: number) => { const real = Date.now; Date.now = () => ms; return () => { Date.now = real; }; };
    let restore = at(1_000);
    trail.log({ agent_id: 'w', agent_name: 'W', tool_name: 'old', action_category: 'send_message', authority_decision: 'approval_required', approval_id: 'appr_old', executed: false });
    restore(); restore = at(2_000);
    trail.log({ agent_id: 'w', agent_name: 'W', tool_name: 'new', action_category: 'send_message', authority_decision: 'allowed', executed: false });
    restore(); restore = at(3_000);
    // The old entry settles last: it stays one entry, placed where it began.
    trail.log({ agent_id: 'w', agent_name: 'W', tool_name: 'old', action_category: 'send_message', authority_decision: 'approval_required', approval_id: 'appr_old', executed: true, outcome: 'succeeded' });
    restore();
    expect(trail.queryEntries().map(e => [e.tool_name, e.events, e.updated_at])).toEqual([['new', 1, 2_000], ['old', 2, 3_000]]);
    expect(trail.queryEntries({ limit: 1 }).map(e => e.tool_name)).toEqual(['new']);
    expect(trail.queryEntries({ since: 1_500 }).map(e => e.tool_name)).toEqual(['new']);
    expect(trail.queryEntries({ decision: 'approval_required' })).toMatchObject([{ tool_name: 'old', outcome: 'succeeded', executed: 1 }]);
    expect([auditPageLimit(undefined), auditPageLimit(0), auditPageLimit(Number.NaN), auditPageLimit(7), auditPageLimit(1e9)]).toEqual([100, 100, 100, 7, AUDIT_PAGE_MAX]);
  });

  test('who decided names the rule, Authority level, delegated grant or policy when no person did', () => {
    const config = { default_level: 3, governed_categories: ['write_data'], overrides: [{ action: 'delete_data', allowed: false }],
      context_rules: [{ id: 'night', action: 'send_message', condition: 'always', params: {}, effect: 'allow', description: 'notify ok' }],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' } as never;
    const engine = new AuthorityEngine(config);
    const judge = (actionCategory: string, toolName = 't', grants = new Map<string, string[]>()) => decisionAuthor(engine.checkAuthority({
      agentId: 'a', agentAuthorityLevel: 3, agentRoleId: 'r', toolName, toolCategory: 'x', actionCategory: actionCategory as never, temporaryGrants: grants as never }));
    expect(judge('read_data')).toBe('level');
    expect(judge('make_payment')).toBe('level');
    expect(judge('write_data')).toBe('policy');
    expect(judge('delete_data')).toBe('rule:override');
    expect(judge('send_message', 'notify')).toBe('rule:night');
    expect(judge('make_payment', 't', new Map([['a', ['make_payment']]]))).toBe('delegated');
    expect(decisionAuthor(engine.checkAuthority({ agentId: 'a', agentAuthorityLevel: 10, agentRoleId: 'r', toolName: 't', toolCategory: 'x',
      actionCategory: 'read_data', temporaryGrants: new Map(), profile: { label: 'background', denied_categories: ['read_data'] } }))).toBe('policy');
  });
});
