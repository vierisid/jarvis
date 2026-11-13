/**
 * The notch's real things end to end inside the brain: a fixture makes a real
 * approval, the notch finds it, a yes runs it once through the product's own
 * decision function, and Today lists it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runCommandTool } from '../actions/tools/builtin.ts';
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
  // The product's real shell tool: the fixture is filed against it, and its
  // one command is a harmless echo.
  registry.register(runCommandTool);
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
    deny: (id) => applyApprovalDecision('deny', id, NOTCH_DECIDER, deps),
    deliverApproval: (request) => { delivered.push(request.id); },
    openDashboard: (from) => { opened.push(from); },
    approveAsDashboard: (id) => applyApprovalDecision('approve', id, 'dashboard', deps),
    toolRegistry: () => registry,
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
    expect(h.real.fixtures.kinds()).toEqual(['approval', 'payment', 'command', 'elsewhere']);
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

  test('the failure fixture records one failure and the notch says its sentence at once', async () => {
    const approvals = new ApprovalManager();
    const open: { key: string; headline: string }[] = [];
    let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const surface = new NotchSurface({ dispatchRPC: () => Promise.resolve({}), onEvent(listener) { onEvent = listener; }, onSidecarDisconnected() {} }, () => {});
    onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message: { type: 'hello', v: 1 } } });
    const real = attachNotchReal(surface, {
      approvalManager: approvals, approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }),
      openFailures: () => open,
      recordFixtureFailure: () => { open.push({ key: 'k', headline: 'The notch test failed, and Jarvis cannot tell whether it took effect.' }); return open[0]!.headline; },
      lookMs: 3_600_000, log: () => {},
    });
    live = real;
    expect(real.fixtures.kinds()).toEqual(['approval', 'payment', 'failure']);
    expect(await real.fixtures.make('failure', {})).toContain('A test failure is in the list of open failures');
    await settle();
    expect(surface.current().line).toMatchObject({ kind: 'say', mark: 'fail', say: ['The notch test failed, and Jarvis cannot tell whether it took effect.'] });
  });

  test('the command fixture files a real shell command the way the product does, and a key approves it: it runs once', async () => {
    const h = harness();
    const made = await h.real.fixtures.make('command', {});
    expect(made).toContain('echo notch test');
    const [request] = h.approvals.getPending();
    expect(request).toMatchObject({ agent_id: NOTCH_FIXTURE_AGENT, tool_name: 'run_command', action_category: 'execute_command' });
    expect(JSON.parse(request!.tool_arguments)).toEqual({ command: 'echo notch test' });
    // The sentence is the tool's own gate's: the machine, the directory, the command.
    expect(notchApprovalWay(request!)).toBe('key');
    await h.look();
    expect(h.said()).toMatch(/run: echo notch test\?$/);
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'approve', mood: 'careful' });
    await h.answer('yes');
    await h.answer('done');
    for (let i = 0; i < 60 && h.said() !== 'Done.'; i++) await new Promise((r) => setTimeout(r, 25));
    expect(h.said()).toBe('Done.');
    const after = h.approvals.getRequest(request!.id)!;
    expect(after).toMatchObject({ status: 'executed', decided_by: 'notch', execution_outcome: 'committed' });
    expect(after.execution_result).toContain('notch test');
  });

  test('without the brain\'s tools there is no command fixture, and before they are loaded it says so', async () => {
    const approvals = new ApprovalManager();
    const surface = new NotchSurface({ dispatchRPC: () => Promise.resolve({}), onEvent() {}, onSidecarDisconnected() {} }, () => {});
    const none = attachNotchReal(surface, { approvalManager: approvals, approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), lookMs: 3_600_000, log: () => {} });
    expect(none.fixtures.kinds()).toEqual(['approval', 'payment']);
    none.stop();
    const early = attachNotchReal(surface, { approvalManager: approvals, approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), toolRegistry: () => null, lookMs: 3_600_000, log: () => {} });
    live = early;
    await expect(early.fixtures.make('command', {})).rejects.toThrow('has not loaded its tools yet');
    expect(approvals.getPending()).toEqual([]);
  });

  // Steps 2 and 7 of the hand test, on a brain whose dashboard cannot be reached.
  test('"elsewhere" decides the oldest fixture approval as a dashboard click does, and the notch\'s line leaves by itself', async () => {
    const h = harness();
    await expect(h.real.fixtures.make('elsewhere', {})).rejects.toThrow('No fixture approval is waiting');
    await h.real.fixtures.make('approval', {});
    await h.look();
    expect(h.line()?.kind).toBe('offer');
    expect(await h.real.fixtures.make('elsewhere', {})).toContain('the way a click on its dashboard card does');
    expect(h.runs).toEqual(['get_system_info']);
    expect(h.approvals.getHistory({ status: 'executed' })[0]).toMatchObject({ decided_by: 'dashboard' });
    await h.look();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('"elsewhere" decides the approval the notch is showing, not an older one that waits in the count', async () => {
    const h = harness();
    await h.real.fixtures.make('approval', {});
    await h.look();
    // Left alone: it goes back to the count.
    await h.answer('fold');
    await new Promise((r) => setTimeout(r, 5));
    // A second one arrives and speaks, as in the hand test.
    await h.real.fixtures.make('approval', {});
    await h.look();
    const [older, newer] = [...h.approvals.getPending()].sort((a, b) => a.created_at - b.created_at);
    expect(h.real.inbox.showing()).toBe(h.real.approvals.itemId(newer!.id));
    await h.real.fixtures.make('elsewhere', {});
    expect(h.approvals.getRequest(newer!.id)!.status).toBe('executed');
    expect(h.approvals.getRequest(older!.id)!.status).toBe('pending');
    await h.look();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    // With nothing on the notch it takes the newest that waits.
    await h.real.fixtures.make('elsewhere', {});
    expect(h.approvals.getRequest(older!.id)!.status).toBe('executed');
  });

  test('"elsewhere" never touches the payment, or an approval that is not the fixture\'s own', async () => {
    const h = harness();
    await h.real.fixtures.make('payment', {});
    h.approvals.createRequest({ agentId: 'someone-else', agentName: 'PA', toolName: 'get_system_info', toolArguments: {},
      actionCategory: 'read_data', urgency: 'normal', reason: 'r', context: '' });
    await expect(h.real.fixtures.make('elsewhere', {})).rejects.toThrow('No fixture approval is waiting');
    expect(h.approvals.getPending()).toHaveLength(2);
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

  test('a row carries the whole sentence of what was done, a shell command included, and marks a cut', () => {
    const command = 'On this Jarvis host, in "/home/sam/projects/northwind/storefront", run: pnpm --filter storefront run build && rsync -a dist/ deploy@shop:/srv/www/';
    const [whole, cut] = notchToday({
      now: () => noon,
      executedApprovals: () => [
        row({ id: '1', tool_name: 'run_command', context: JSON.stringify({ intent: command }), executed_at: noon - 1000 }),
        row({ id: '2', tool_name: 'run_command', context: JSON.stringify({ intent: `Run: ${'x'.repeat(400)}` }), executed_at: noon - 2000 }),
      ],
    });
    expect(whole!.text).toBe(command);
    expect([...cut!.text].length).toBe(220);
    expect(cut!.text).toEndWith('…');
  });

  test('shows a dozen and says how many more there are', () => {
    const many = Array.from({ length: NOTCH_TODAY_MAX + 3 }, (_, i) => ({ at: noon - i * 1000, text: `Thing ${i}`, kind: 'approved' as const }));
    const blocks = notchTodayBlocks(many);
    expect(blocks).toHaveLength(NOTCH_TODAY_MAX + 1);
    expect(blocks.at(-1)).toEqual({ kind: 'note', say: ['And 3 more, in the dashboard.'] });
    expect(blocks[0]).toMatchObject({ kind: 'row', lead: '12:00', say: ['Thing 0'] });
  });
});
