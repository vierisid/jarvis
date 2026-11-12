/**
 * Approvals on the notch, against the product's own approval code: the real
 * manager, the real executor and the real decision function. Only the tool
 * that runs is a stand-in, and it counts its runs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { ApprovalManager, type ApprovalPrincipal } from '../authority/approval.ts';
import { approvalToast } from '../authority/approval-delivery.ts';
import { AuditTrail } from '../authority/audit.ts';
import { DeferredExecutor } from '../authority/deferred-executor.ts';
import { EmergencyController, setActiveEmergencyController } from '../authority/emergency.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { NOTCH_DECIDER, applyApprovalDecision, type ApprovalDecisionDeps } from '../daemon/approval-decision.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { attachNotchApprovals, notchApprovalWay } from './approvals.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchAnswerAct, NotchLine, NotchToPage } from './protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => { setActiveEmergencyController(null); closeDb(); });

const PRINCIPAL: ApprovalPrincipal = { agentRoleId: 'personal-assistant', agentAuthorityLevel: 5 };
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function config(): AuthorityConfig {
  return { default_level: 3, governed_categories: [], overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' };
}

function harness(options: { page?: boolean } = {}) {
  // The product side.
  const approvals = new ApprovalManager();
  const audit = new AuditTrail();
  const runs: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register({ name: 'write_file', description: 'Synthetic write', category: 'file-ops', parameters: {},
    execute: async (params) => { runs.push(params); return 'written'; } });
  const executor = new DeferredExecutor(approvals, audit);
  executor.setToolRegistry(registry);
  executor.setAuthorityEngine(new AuthorityEngine(config()));
  const deps: ApprovalDecisionDeps = { approvalManager: approvals, deferredExecutor: executor, auditTrail: audit };
  const ask = (extra: { context?: string; category?: string; created?: number; mode?: 'deferred' | 'inline' } = {}) => {
    const request = approvals.createRequest({ agentId: 'agent-1', agentName: 'PA', toolName: 'write_file', toolArguments: { path: '/tmp/a' },
      actionCategory: 'write_data', urgency: 'normal', reason: 'Write the note', context: extra.context ?? '',
      executionMode: extra.mode ?? 'deferred', principal: PRINCIPAL });
    if (extra.category) getDb().run('UPDATE approval_requests SET action_category = ? WHERE id = ?', [extra.category, request.id]);
    if (extra.created !== undefined) getDb().run('UPDATE approval_requests SET created_at = ? WHERE id = ?', [extra.created, request.id]);
    return approvals.getRequest(request.id)!;
  };

  // The notch side.
  const pushed: NotchToPage[] = [];
  const logs: string[] = [];
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 0;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, (line) => logs.push(line));
  const inbox = new NotchInbox(surface, { clock, log: (line) => logs.push(line) });
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  if (options.page !== false) fromPage({ type: 'hello', v: 1 });
  const opened: (string | null)[] = [];
  const notch = attachNotchApprovals(inbox, {
    approvalManager: approvals,
    approve: (id) => applyApprovalDecision('approve', id, NOTCH_DECIDER, deps),
    openDashboard: (from) => { opened.push(from); },
    log: (line) => logs.push(line),
  });
  const line = (): NotchLine | null => surface.current().line;
  const text = (l: NotchLine | null): string => (l?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
  return {
    approvals, deps, runs, ask, surface, inbox, notch, logs, opened, line, fromPage,
    said: (): string => text(line()),
    count: (): number => surface.current().count,
    async sync(): Promise<void> { notch.sync(); await settle(); },
    async answer(act: NotchAnswerAct): Promise<void> {
      const id = line()?.id;
      if (!id) throw new Error('nothing is on the notch');
      fromPage({ type: 'answer', id, act });
      await settle();
    },
    async open(): Promise<void> { fromPage({ type: 'open' }); await settle(); },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const timer of [...timers].filter((t) => t.at <= now)) {
        const at = timers.indexOf(timer);
        if (at >= 0) { timers.splice(at, 1); timer.fn(); }
      }
      await settle();
    },
  };
}

describe('one line, one yes', () => {
  test('a new approval arrives as a line that names the action', async () => {
    const h = harness();
    const req = h.ask();
    await h.sync();
    expect(h.said()).toBe(`${approvalToast(req).body}?`);
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'approve', unasked: true });
    expect(h.inbox.showing()).toBe(h.notch.itemId(req.id));
  });

  // Step 1 of the hand test.
  test('yes burns a fuse, then approves through the one decision function: it runs once, as the notch', async () => {
    const h = harness();
    const req = h.ask();
    await h.sync();
    await h.answer('yes');
    expect(h.line()).toMatchObject({ kind: 'send', ms: 3000 });
    // Nothing is decided while the fuse burns.
    expect(h.approvals.getRequest(req.id)!.status).toBe('pending');
    expect(h.runs).toEqual([]);
    await h.answer('done');
    expect(h.runs).toHaveLength(1);
    expect(h.approvals.getRequest(req.id)).toMatchObject({ status: 'executed', decided_by: 'notch', execution_outcome: 'committed' });
    expect(h.said()).toBe('Done.');
    expect(h.line()).toMatchObject({ kind: 'say', mark: 'check' });
    await h.answer('done');
    await h.sync();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('Esc inside the fuse takes the yes back: nothing was decided, and the offer is there again', async () => {
    const h = harness();
    const req = h.ask();
    await h.sync();
    await h.answer('yes');
    await h.answer('undo');
    expect(h.line()).toMatchObject({ kind: 'offer' });
    // The person took it back themselves: the offer is not "unasked" again.
    expect(h.line()?.unasked).toBeUndefined();
    expect(h.approvals.getRequest(req.id)!.status).toBe('pending');
    expect(h.runs).toEqual([]);
    await h.answer('yes');
    await h.answer('done');
    expect(h.runs).toHaveLength(1);
  });

  test('a fuse nobody saw burn out approves nothing', async () => {
    const h = harness();
    const req = h.ask();
    await h.sync();
    await h.answer('yes');
    // The page went away: no word that the window ran out.
    await h.advance(3000 + 1500);
    expect(h.approvals.getRequest(req.id)!.status).toBe('pending');
    expect(h.runs).toEqual([]);
    expect(h.inbox.has(h.notch.itemId(req.id))).toBe(true);
  });

  test('not now, and a line left alone, are never a deny', async () => {
    for (const act of ['no', 'fold'] as const) {
      // A clean store each time round: the first request would still be pending.
      closeDb();
      initDatabase(':memory:', { quiet: true });
      const h = harness();
      const req = h.ask();
      await h.sync();
      await h.answer(act);
      expect(h.approvals.getRequest(req.id)!.status).toBe('pending');
      expect(h.line()).toBeNull();
      expect(h.count()).toBe(1);
    }
  });
});

describe('two surfaces, one decision', () => {
  // Step 7 of the hand test.
  test('approved in the dashboard while the notch shows it: the line leaves by itself', async () => {
    const h = harness();
    const req = h.ask();
    await h.sync();
    expect(h.line()).not.toBeNull();
    await applyApprovalDecision('approve', req.id, 'dashboard', h.deps);
    await h.sync();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
    expect(h.runs).toHaveLength(1);
  });

  // Step 2 of the hand test.
  test('approved in the dashboard while the fuse burns: it runs once, and the notch says it was already decided', async () => {
    const h = harness();
    const req = h.ask();
    await h.sync();
    await h.answer('yes');
    await applyApprovalDecision('approve', req.id, 'dashboard', h.deps);
    // The notch looks, sees it decided, and leaves the line to say so itself.
    await h.sync();
    expect(h.line()).toMatchObject({ kind: 'send' });
    await h.answer('done');
    expect(h.said()).toBe('Already decided in the dashboard.');
    expect(h.runs).toHaveLength(1);
    expect(h.approvals.getRequest(req.id)!.decided_by).toBe('dashboard');
    await h.answer('done');
    await h.sync();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('denied elsewhere during the fuse: the notch says so, and nothing runs', async () => {
    const h = harness();
    const req = h.ask();
    await h.sync();
    await h.answer('yes');
    await applyApprovalDecision('deny', req.id, 'dashboard', h.deps);
    await h.answer('done');
    expect(h.said()).toBe('Already denied. Nothing was run.');
    expect(h.runs).toEqual([]);
  });
});

describe('what a key may not approve', () => {
  // Step 8 of the hand test.
  test('a payment: the line says it never takes that on a key, and yes only opens the dashboard', async () => {
    const h = harness();
    const req = h.ask({ category: 'make_payment' });
    expect(notchApprovalWay(req)).toBe('payment');
    await h.sync();
    expect(h.said()).toBe(`A payment. I never take that on a key: ${approvalToast(req).body}`);
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'open' });
    await h.answer('yes');
    expect(h.opened).toEqual(['pc']);
    expect(h.approvals.getRequest(req.id)!.status).toBe('pending');
    expect(h.runs).toEqual([]);
    await h.answer('done');
    expect(h.count()).toBe(1);
  });

  test('a destructive request, and one that needs on-screen review, are approved in the dashboard', async () => {
    const h = harness();
    const command = h.ask({ category: 'execute_command' });
    expect(notchApprovalWay(command)).toBe('destructive');
    const review = h.ask({ context: JSON.stringify({ confirm: 'always', intent: 'Click Send in Mail (sends an email)' }) });
    expect(notchApprovalWay(review)).toBe('click');
    await h.sync();
    expect(h.said()).toContain('Approved with a click in the dashboard, not with a key: ');
    expect(h.line()).toMatchObject({ yes: 'open' });
  });

  test('a sentence too long to show whole is not offered for a yes', async () => {
    const h = harness();
    const long = h.ask({ context: JSON.stringify({ intent: `Write ${'a very long note '.repeat(20)}to disk` }) });
    expect(notchApprovalWay(long)).toBe('unreadable');
    await h.sync();
    expect(h.said()).toContain('Too long to show whole here');
    expect(h.line()).toMatchObject({ yes: 'open' });
  });

  test('while Jarvis is paused a yes is held, the notch says why, and the request still waits', async () => {
    const controller = new EmergencyController();
    setActiveEmergencyController(controller);
    const h = harness();
    const req = h.ask();
    await h.sync();
    controller.pause();
    await h.answer('yes');
    await h.answer('done');
    expect(h.said()).toContain('Jarvis is paused');
    expect(h.approvals.getRequest(req.id)!.status).toBe('pending');
    expect(h.runs).toEqual([]);
    await h.answer('done');
    expect(h.count()).toBe(1);
  });
});

describe('the count and the round', () => {
  // Step 5 of the hand test.
  test('three approvals: the first speaks, the others join the count, and yes at rest goes through them', async () => {
    const h = harness();
    const first = h.ask();
    const second = h.ask();
    const third = h.ask();
    await h.sync();
    expect(h.inbox.showing()).toBe(h.notch.itemId(first.id));
    expect(h.count()).toBe(2);
    await h.answer('fold');
    expect(h.count()).toBe(3);
    await h.open();
    expect(h.inbox.showing()).toBe(h.notch.itemId(first.id));
    await h.answer('yes');
    await h.answer('done');
    await h.answer('done');
    // Ignore the second: it stays in the count.
    expect(h.inbox.showing()).toBe(h.notch.itemId(second.id));
    await h.answer('fold');
    expect(h.inbox.showing()).toBe(h.notch.itemId(third.id));
    await h.answer('yes');
    await h.answer('done');
    await h.answer('done');
    expect(h.line()).toMatchObject({ kind: 'sheet' });
    expect(h.said()).toBe('1 thing still waits');
    await h.answer('no');
    await h.sync();
    expect(h.count()).toBe(1);
    expect(h.runs).toHaveLength(2);
    expect(h.approvals.getRequest(second.id)!.status).toBe('pending');
  });

  test('an approval that was already waiting when the notch came up joins the count quietly', async () => {
    const h = harness();
    h.ask({ created: Date.now() - 10 * 60_000 });
    await h.sync();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
  });

  test('an agent stopped in the middle of its work goes before the rest in a round', async () => {
    const h = harness();
    const later = h.ask({ created: Date.now() - 10 * 60_000 });
    const blocked = h.ask({ created: Date.now() - 9 * 60_000, mode: 'inline' });
    await h.sync();
    expect(h.inbox.waiting().map((i) => i.id)).toEqual([h.notch.itemId(blocked.id), h.notch.itemId(later.id)]);
  });

  test('one that expired while it waited leaves the count without a word', async () => {
    const h = harness();
    const req = h.ask({ created: Date.now() - 10 * 60_000 });
    await h.sync();
    getDb().run("UPDATE approval_requests SET status = 'expired' WHERE id = ?", [req.id]);
    // Even before the next look, the check on show keeps it off the notch.
    await h.open();
    expect(h.line()?.kind).not.toBe('offer');
    await h.sync();
    expect(h.count()).toBe(0);
  });
});
