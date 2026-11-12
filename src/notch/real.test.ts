/**
 * The notch's real things end to end inside the brain: a fixture makes a real
 * approval, the notch finds it, a yes runs it once through the product's own
 * decision function, and Today lists it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { approvalToast } from '../authority/approval-delivery.ts';
import { AuditTrail } from '../authority/audit.ts';
import { DeferredExecutor } from '../authority/deferred-executor.ts';
import { AuthorityEngine } from '../authority/engine.ts';
import { NOTCH_DECIDER, applyApprovalDecision, type ApprovalDecisionDeps } from '../daemon/approval-decision.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { notchApprovalWay } from './approvals.ts';
import { NOTCH_FIXTURE_AGENT } from './fixtures.ts';
import type { NotchAnswerAct, NotchLine, NotchToPage } from './protocol.ts';
import { attachNotchReal, type NotchReal } from './real.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';
import { NOTCH_TODAY_MAX, notchToday, notchTodayBlocks, startOfDay } from './today.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
let live: NotchReal | null = null;
afterEach(() => { live?.stop(); live = null; closeDb(); });

const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness() {
  const approvals = new ApprovalManager();
  const audit = new AuditTrail();
  const runs: string[] = [];
  const registry = new ToolRegistry();
  registry.register({ name: 'get_system_info', description: 'Stand-in', category: 'system', parameters: {},
    execute: async () => { runs.push('get_system_info'); return '{"hostname":"test"}'; } });
  const executor = new DeferredExecutor(approvals, audit);
  executor.setToolRegistry(registry);
  executor.setAuthorityEngine(new AuthorityEngine({ default_level: 3, governed_categories: [], overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
  const deps: ApprovalDecisionDeps = { approvalManager: approvals, deferredExecutor: executor, auditTrail: audit };

  const pushed: NotchToPage[] = [];
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  const delivered: string[] = [];
  const opened: (string | null)[] = [];
  const real = attachNotchReal(surface, {
    approvalManager: approvals,
    approve: (id) => applyApprovalDecision('approve', id, NOTCH_DECIDER, deps),
    deliverApproval: (request) => { delivered.push(request.id); },
    openDashboard: (from) => { opened.push(from); },
    // The test looks by hand.
    lookMs: 3_600_000,
    log: () => {},
  });
  live = real;
  const line = (): NotchLine | null => surface.current().line;
  return {
    approvals, deps, runs, real, delivered, opened, line,
    said: (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join(''),
    count: (): number => surface.current().count,
    async look(): Promise<void> { real.approvals.sync(); await settle(); },
    async answer(act: NotchAnswerAct): Promise<void> {
      fromPage({ type: 'answer', id: line()!.id, act });
      await settle();
    },
    async open(): Promise<void> { fromPage({ type: 'open' }); await settle(); },
  };
}

describe('the approval fixture, from the command to Today', () => {
  test('makes a real approval a key may answer, shows it where approvals are shown, and a yes runs it once', async () => {
    const h = harness();
    expect(h.real.fixtures.kinds()).toEqual(['approval', 'payment']);
    const made = await h.real.fixtures.make('approval', {});
    expect(made).toContain('An approval is waiting');
    const [request] = h.approvals.getPending();
    expect(request).toMatchObject({ agent_id: NOTCH_FIXTURE_AGENT, tool_name: 'get_system_info', action_category: 'read_data', execution_mode: 'deferred' });
    expect(h.delivered).toEqual([request!.id]);
    expect(notchApprovalWay(request!)).toBe('key');

    await h.look();
    expect(h.said()).toBe('Get system info?');
    await h.answer('yes');
    await h.answer('done');
    expect(h.said()).toBe('Done.');
    expect(h.runs).toEqual(['get_system_info']);
    await h.answer('done');
    await h.look();
    expect(h.line()).toBeNull();

    // Yes at rest with nothing waiting: Today, with what was just done.
    await h.open();
    const today = h.line();
    expect(today?.kind).toBe('sheet');
    expect(h.said()).toBe('Today: 1 thing done');
    expect(today?.kind === 'sheet' && today.blocks[0]).toMatchObject({ kind: 'row', say: ['Get system info'], small: 'approved' });
    await h.answer('no');
    expect(h.line()).toBeNull();
  });

  test('the payment fixture is a payment to every surface, and approving it in the dashboard runs nothing', async () => {
    const h = harness();
    await h.real.fixtures.make('payment', {});
    const [request] = h.approvals.getPending();
    expect(notchApprovalWay(request!)).toBe('payment');
    expect(approvalToast(request!).approvable).toBe(false);
    await h.look();
    expect(h.said()).toBe('A payment. I never take that on a key: Pay $40.00 to Northwind (a test, no money moves)');
    await h.answer('yes');
    expect(h.opened).toEqual(['pc']);
    expect(await applyApprovalDecision('approve', request!.id, NOTCH_DECIDER, h.deps)).toMatchObject({ status: 'needs_dashboard' });
    expect(await applyApprovalDecision('approve', request!.id, 'dashboard', h.deps)).toMatchObject({ status: 'approved', executed: false });
    expect(h.runs).toEqual([]);
  });

  test('an unknown fixture is refused', async () => {
    const h = harness();
    await expect(h.real.fixtures.make('toString', {})).rejects.toThrow('No fixture is called "toString"');
  });

  test('with nothing waiting and nothing done, yes at rest opens an empty Today', async () => {
    const h = harness();
    await h.open();
    expect(h.said()).toBe('Today');
    const sheet = h.line();
    expect(sheet?.kind === 'sheet' && sheet.blocks).toEqual([{ kind: 'note', say: ['Nothing done yet today.'] }]);
  });
});

describe('Today', () => {
  const noon = new Date(2026, 10, 12, 12, 0, 0).getTime();
  const row = (over: Record<string, unknown>) => ({
    id: 'r', agent_id: 'a', agent_name: 'PA', tool_name: 'request_approval', tool_arguments: '{}', action_category: 'send_email',
    urgency: 'normal', reason: 'Send the weekly update to the team', context: '', status: 'executed', execution_mode: 'deferred',
    decided_at: noon - 5000, decided_by: 'notch', executed_at: noon - 4000, execution_result: 'ok', created_at: noon - 9000,
    execution_outcome: 'committed', ...over,
  }) as never;

  test('lists what has a receipt that says it happened, today only, newest first', () => {
    const rows = notchToday({
      now: () => noon,
      executedApprovals: () => [
        row({ id: '1', reason: 'First', executed_at: noon - 60_000 }),
        row({ id: '2', reason: 'Second', executed_at: noon - 30_000 }),
        row({ id: '3', reason: 'Failed', execution_outcome: 'failed' }),
        row({ id: '4', reason: 'Refused', execution_outcome: 'blocked' }),
        row({ id: '5', reason: 'Yesterday', executed_at: startOfDay(noon) - 1 }),
        row({ id: '6', reason: 'Not run yet', status: 'approved' }),
      ],
      keptPromises: () => [
        { what: 'Send Anna the pricing', completed_at: noon - 45_000 },
        { what: 'An old promise', completed_at: startOfDay(noon) - 10 },
        { what: 'Never finished', completed_at: null },
      ],
    });
    expect(rows.map((r) => r.text)).toEqual(['Second', 'Send Anna the pricing', 'First']);
    expect(rows.map((r) => r.kind)).toEqual(['approved', 'promise', 'approved']);
  });

  test('shows a dozen and says how many more there are', () => {
    const many = Array.from({ length: NOTCH_TODAY_MAX + 3 }, (_, i) => ({ at: noon - i * 1000, text: `Thing ${i}`, kind: 'approved' as const }));
    const blocks = notchTodayBlocks(many);
    expect(blocks).toHaveLength(NOTCH_TODAY_MAX + 1);
    expect(blocks.at(-1)).toEqual({ kind: 'note', say: ['And 3 more, in the dashboard.'] });
    expect(blocks[0]).toMatchObject({ kind: 'row', lead: '12:00', say: ['Thing 0'] });
  });
});
