/**
 * Approvals on the notch, against the product's own approval code: the real
 * manager, the real executor and the real decision function. Only the tool
 * that runs is a stand-in, and it counts its runs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { ApprovalManager, type ApprovalPrincipal, type ApprovalRequest } from '../authority/approval.ts';
import { approvalToast } from '../authority/approval-delivery.ts';
import { AuditTrail } from '../authority/audit.ts';
import { DeferredExecutor } from '../authority/deferred-executor.ts';
import { EmergencyController, setActiveEmergencyController } from '../authority/emergency.ts';
import { AuthorityEngine, type AuthorityConfig } from '../authority/engine.ts';
import { NOTCH_DECIDER, applyApprovalDecision, type ApprovalDecisionDeps } from '../daemon/approval-decision.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { gateVoiceApprovalResolution } from '../roles/authority.ts';
import { NOTCH_PLAIN_LINE_COLUMNS, attachNotchApprovals, notchApprovalWay, type NotchApprovalWhere } from './approvals.ts';
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

function harness(options: { page?: boolean; denyFails?: boolean; describe?: (request: ApprovalRequest) => Promise<string | null>; where?: (request: ApprovalRequest) => Promise<NotchApprovalWhere | null>; mine?: (id: string) => boolean; now?: () => number } = {}) {
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
      // As a tool's own gate files it: with one sentence that says what will be done.
      actionCategory: 'write_data', urgency: 'normal', reason: 'Write the note', context: extra.context ?? JSON.stringify({ intent: 'Write file' }),
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
    deny: (id) => (options.denyFails ? Promise.reject(new Error('database is locked')) : applyApprovalDecision('deny', id, NOTCH_DECIDER, deps)),
    openDashboard: (from) => { opened.push(from); },
    log: (line) => logs.push(line),
    describe: options.describe,
    where: options.where,
    mine: options.mine,
    ...(options.now ? { now: options.now } : {}),
    clock,
  });
  const line = (): NotchLine | null => surface.current().line;
  const text = (l: NotchLine | null): string => (l?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
  return {
    approvals, deps, runs, ask, surface, inbox, notch, logs, opened, line, fromPage,
    pushed: () => pushed,
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

  test('a line left alone until it folds is not a no: the request still waits, and comes round again', async () => {
    const h = harness();
    const req = h.ask();
    await h.sync();
    await h.answer('fold');
    expect(h.approvals.getRequest(req.id)!.status).toBe('pending');
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    await h.open();
    expect(h.inbox.showing()).toBe(h.notch.itemId(req.id));
  });

  test('Esc is a no: the request is denied as the notch, nothing runs, and it is gone from the count', async () => {
    const h = harness();
    const req = h.ask();
    await h.sync();
    await h.answer('no');
    expect(h.approvals.getRequest(req.id)).toMatchObject({ status: 'denied', decided_by: 'notch' });
    expect(getDb().query('SELECT channel, authority_decision FROM audit_trail WHERE approval_id = ?').get(req.id))
      .toEqual({ channel: 'notch', authority_decision: 'denied' });
    expect(h.runs).toEqual([]);
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
    await h.sync();
    expect(h.inbox.has(h.notch.itemId(req.id))).toBe(false);
    // Nothing waits any more: yes at rest does not bring it back.
    await h.open();
    expect(h.line()).toBeNull();
  });

  test('Esc inside the fuse only takes back the yes; a second Esc, on the offer, is the no', async () => {
    const h = harness();
    const req = h.ask();
    await h.sync();
    await h.answer('yes');
    await h.answer('undo');
    expect(h.approvals.getRequest(req.id)!.status).toBe('pending');
    expect(h.line()).toMatchObject({ kind: 'offer' });
    await h.answer('no');
    expect(h.approvals.getRequest(req.id)!.status).toBe('denied');
    expect(h.runs).toEqual([]);
  });

  test('a no that cannot be recorded is said, and the request still waits', async () => {
    const h = harness({ denyFails: true });
    const req = h.ask();
    await h.sync();
    await h.answer('no');
    expect(h.said()).toBe('That did not go through. It still waits.');
    expect(h.approvals.getRequest(req.id)!.status).toBe('pending');
    await h.answer('done');
    expect(h.count()).toBe(1);
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

// The owner's decision of 13 November 2026: the rule a spoken yes follows
// (nothing destructive by voice) is not applied on the notch.
describe('what the voice rules refuse and a key approves', () => {
  test('a shell command is approved with the key: a careful face, a fuse, and it runs once', async () => {
    const h = harness();
    const command = h.ask({ category: 'execute_command', context: JSON.stringify({ intent: 'On this Jarvis host, in "/srv/shop", run: make deploy' }) });
    expect(gateVoiceApprovalResolution('execute_command', 1, 'approve').kind).toBe('clarify');
    expect(notchApprovalWay(command)).toBe('key');
    await h.sync();
    expect(h.said()).toBe('On this Jarvis host, in "/srv/shop", run: make deploy?');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'approve', mood: 'careful' });
    await h.answer('yes');
    expect(h.line()).toMatchObject({ kind: 'send' });
    expect(h.runs).toEqual([]);
    await h.answer('done');
    expect(h.runs).toHaveLength(1);
    expect(h.approvals.getRequest(command.id)).toMatchObject({ status: 'executed', decided_by: 'notch', execution_outcome: 'committed' });
    expect(h.said()).toBe('Done.');
  });

  test('so is every other request the voice gate calls destructive, except a payment', () => {
    const h = harness();
    for (const category of ['execute_command', 'install_software', 'modify_settings', 'delete_data', 'terminate_agent']) {
      expect(notchApprovalWay(h.ask({ category }))).toBe('key');
    }
    expect(notchApprovalWay(h.ask({ category: 'make_payment' }))).toBe('payment');
  });

  test('a request that is not destructive keeps its ordinary face', async () => {
    const h = harness();
    h.ask();
    await h.sync();
    expect(h.line()?.mood).toBeUndefined();
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

  test('Esc on a line a key cannot approve is still a no: a payment can be refused from anywhere', async () => {
    const h = harness();
    const req = h.ask({ category: 'make_payment' });
    await h.sync();
    expect(h.line()).toMatchObject({ yes: 'open' });
    await h.answer('no');
    expect(h.approvals.getRequest(req.id)).toMatchObject({ status: 'denied', decided_by: 'notch' });
    expect(h.opened).toEqual([]);
    expect(h.count()).toBe(0);
  });

  test('a request that has to be reviewed on screen is reviewed on the notch, which is on that screen: plain words, the exact action under them', async () => {
    const h = harness();
    const review = h.ask({ context: JSON.stringify({ confirm: 'always', intent: 'Review desktop_click. Business effect unknown.' }) });
    expect(notchApprovalWay(review)).toBe('sheet');
    await h.sync();
    // Nobody to put it in plain words here: it is asked by what kind of thing it is.
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'approve', stay: true });
    expect(h.said()).toBe('Write or change a file?');
    const sheet = h.line();
    const paper = sheet?.kind === 'sheet' ? sheet.blocks.find((block) => block.kind === 'paper') : null;
    expect(paper?.kind === 'paper' ? paper.lines.map((parts) => parts.join('')) : []).toEqual([
      'Review desktop_click. Business effect unknown.', 'write_file', 'path: /tmp/a']);
    // Any other surface is still refused it. The notch is not.
    expect(await applyApprovalDecision('approve', review.id, 'telegram', h.deps)).toMatchObject({ status: 'needs_dashboard' });
    await h.answer('yes');
    expect(h.line()).toMatchObject({ kind: 'send' });
    await h.answer('done');
    expect(h.approvals.getRequest(review.id)).toMatchObject({ decided_by: 'notch' });
    expect(['approved', 'executed']).toContain(h.approvals.getRequest(review.id)!.status);
  });

  test('a sentence too long for any sheet is not offered for a yes, and is shown cut with a mark', async () => {
    const h = harness();
    const fits = h.ask({ context: JSON.stringify({ intent: `Write ${'x'.repeat(NOTCH_PLAIN_LINE_COLUMNS - 6)}` }) });
    expect(notchApprovalWay(fits)).toBe('key');
    const endless = h.ask({ context: JSON.stringify({ intent: `Write ${'a very long note '.repeat(200)}to disk` }) });
    expect(notchApprovalWay(endless)).toBe('too_long');
    getDb().run('DELETE FROM approval_requests WHERE id = ?', [fits.id]);
    await h.sync();
    expect(h.said()).toStartWith('Too long to show whole here, so it is approved in the dashboard: Write a very long note');
    expect(h.said()).toEndWith('…');
    expect(h.line()).toMatchObject({ yes: 'open' });
  });

  test('a sentence whose letters could be look-alikes is not offered for a yes', async () => {
    const h = harness();
    const forged = h.ask({ context: JSON.stringify({ intent: 'Send the contract to Саша' }) });
    expect(notchApprovalWay(forged)).toBe('look_alike');
    await h.sync();
    expect(h.said()).toStartWith('Some of its letters could be look-alikes, so it is approved in the dashboard: ');
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

  // The owner's case of 13 November: three things wait, Esc on each of them.
  test('Esc on each of three in a round turns all three down, and yes at rest then finds nothing waiting', async () => {
    const h = harness();
    const first = h.ask();
    const second = h.ask();
    const payment = h.ask({ category: 'make_payment' });
    await h.sync();
    await h.answer('fold');
    expect(h.count()).toBe(3);
    await h.open();
    const before = h.pushed().length;
    await h.answer('no');
    await h.answer('no');
    await h.answer('no');
    // One key each, with no line in between and no list at the end: nothing is left to list.
    expect(h.pushed().slice(before).filter((m) => m.type === 'show').map((m) => (m.type === 'show' ? m.line.kind : ''))).toEqual(['offer', 'offer']);
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
    for (const req of [first, second, payment]) expect(h.approvals.getRequest(req.id)!.status).toBe('denied');
    expect(h.runs).toEqual([]);
    await h.sync();
    await h.open();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
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

describe('an approval asked in plain words', () => {
  const COMMAND = 'On this computer, run: reg query HKCU\\Software\\Valve\\Steam /v SteamExe & if exist "C:\\Program Files (x86)\\Steam\\steam.exe" (echo STEAM_INSTALLED)';

  test('a long command is asked as a question a person understands, with every character of it underneath', async () => {
    const seen: string[] = [];
    const h = harness({ describe: async (request) => { seen.push(request.tool_name); return 'Look up where Steam is installed?'; } });
    const req = h.ask({ context: JSON.stringify({ intent: COMMAND }) });
    expect(notchApprovalWay(req)).toBe('sheet');
    await h.sync();
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'approve', stay: true });
    expect(h.said()).toBe('Look up where Steam is installed?');
    const sheet = h.line();
    const paper = sheet?.kind === 'sheet' ? sheet.blocks.find((block) => block.kind === 'paper') : null;
    expect(paper?.kind === 'paper' ? paper.lines.map((parts) => parts.join('')) : []).toEqual([COMMAND]);
    expect(seen).toEqual(['write_file']);
    // Yes: the fuse says it in the same words, then it is decided as the notch.
    await h.answer('yes');
    expect(h.said()).toBe('Look up where Steam is installed…');
    await h.answer('done');
    expect(h.approvals.getRequest(req.id)).toMatchObject({ status: 'executed', decided_by: 'notch' });
  });

  test('Esc on it is a no', async () => {
    const h = harness({ describe: async () => 'Look up where Steam is installed?' });
    const req = h.ask({ context: JSON.stringify({ intent: COMMAND }) });
    await h.sync();
    await h.answer('no');
    expect(h.approvals.getRequest(req.id)).toMatchObject({ status: 'denied', decided_by: 'notch' });
  });

  test('left alone it goes back to the count, still pending', async () => {
    const h = harness({ describe: async () => 'Look up where Steam is installed?' });
    const req = h.ask({ context: JSON.stringify({ intent: COMMAND }) });
    await h.sync();
    await h.advance(30_000);
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    expect(h.approvals.getRequest(req.id)!.status).toBe('pending');
  });

  test('when nobody can say it in plain words in time, it is asked by what kind of thing it is', async () => {
    for (const describe of [async () => null, async () => { throw new Error('no model'); }, () => new Promise<string | null>(() => {})]) {
      const h = harness({ describe });
      h.ask({ context: JSON.stringify({ intent: COMMAND }) });
      await h.sync();
      await h.advance(4000);
      expect(h.said()).toBe('Write or change a file?');
      expect(h.line()).toMatchObject({ kind: 'sheet' });
    }
  });

  test('a short action, and the model\'s own one-line intent, stay a line as they were', async () => {
    let asked = 0;
    const h = harness({ describe: async () => { asked++; return 'Something else?'; } });
    const short = h.ask({ context: JSON.stringify({ intent: 'Run: echo hello' }) });
    expect(notchApprovalWay(short)).toBe('key');
    await h.sync();
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'approve' });
    expect(h.said()).toBe('Run: echo hello?');
    expect(asked).toBe(0);
  });

  test('a payment is never on the notch, in any words', async () => {
    const h = harness({ describe: async () => 'Pay Northwind forty dollars?' });
    const req = h.ask({ category: 'make_payment', context: JSON.stringify({ intent: COMMAND }) });
    expect(notchApprovalWay(req)).toBe('payment');
    await h.sync();
    expect(h.line()).toMatchObject({ yes: 'open' });
    expect(await applyApprovalDecision('approve', req.id, NOTCH_DECIDER, h.deps)).toMatchObject({ status: 'needs_dashboard' });
  });
});

describe('an approval that was already waiting when the notch came up', () => {
  const COMMAND = 'On this computer, run: reg query HKCU\\Software\\Valve\\Steam /v SteamExe & echo a long command that does not fit one line';

  test('is not worded until it is opened, and then gets its plain words on the sheet', async () => {
    let asked = 0;
    let say: (words: string) => void = () => {};
    const h = harness({ describe: () => { asked++; return new Promise<string | null>((resolve) => { say = resolve; }); } });
    h.ask({ context: JSON.stringify({ intent: COMMAND }), created: Date.now() - 10 * 60_000 });
    await h.sync();
    // It joined the count without a word, and nobody was asked to word it.
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    expect(asked).toBe(0);
    await h.open();
    expect(h.line()).toMatchObject({ kind: 'sheet', stay: true });
    expect(h.said()).toBe('Write or change a file?');
    expect(asked).toBe(1);
    say('Look up where Steam is installed?');
    await settle();
    expect(h.said()).toBe('Look up where Steam is installed?');
    await h.answer('yes');
    expect(h.said()).toBe('Look up where Steam is installed…');
  });
});

describe('typing a poem into Notepad, as it happened on 13 November', () => {
  // The request the product made for it, as it was.
  const POEM = 'The morning spills its gold across the sea,\r\nAnd every waking wave brings hope to me.';

  test('is asked on the notch in plain words, with the poem under them line by line. Never the dashboard', async () => {
    const h = harness({ describe: async () => 'Type this two-line poem into Notepad?' });
    const made = h.approvals.createRequest({
      agentId: 'agent-1', agentName: 'PA', toolName: 'write_file',
      toolArguments: { element_id: 1, action: 'set_value', value: POEM, verify: 'value_equals' },
      actionCategory: 'control_app', urgency: 'normal', reason: 'outside content read this turn: control_app requires user approval',
      context: JSON.stringify({ confirm: 'always', intent: 'Review set_value on desktop element [1] "Text Editor". Business effect unknown beyond UI hints.' }),
      executionMode: 'deferred', principal: PRINCIPAL,
    });
    const request = h.approvals.getRequest(made.id)!;
    expect(notchApprovalWay(request)).toBe('sheet');
    await h.sync();
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'approve', stay: true });
    expect(h.said()).toBe('Type this two-line poem into Notepad?');
    const sheet = h.line();
    const paper = sheet?.kind === 'sheet' ? sheet.blocks.find((block) => block.kind === 'paper') : null;
    expect(paper?.kind === 'paper' ? paper.lines.map((parts) => parts.join('')) : []).toEqual([
      'Review set_value on desktop element [1] "Text Editor". Business effect unknown beyond UI hints.',
      'write_file', 'element_id: 1', 'action: set_value', 'value:',
      'The morning spills its gold across the sea,', 'And every waking wave brings hope to me.', 'verify: value_equals',
    ]);
    expect(h.opened).toEqual([]);
    await h.answer('yes');
    await h.answer('done');
    expect(h.approvals.getRequest(request.id)).toMatchObject({ decided_by: 'notch' });
  });

  test('ordinary writing is never "too long": curly quotes, an apostrophe, an accent, a tab, several paragraphs', () => {
    const h = harness();
    for (const value of ['\u201cI heard her too.\u201d', 'can\u2019t', 'caff\u00e8 perch\u00e9', 'one\ttwo', 'First.\n\nSecond.\r\n\r\nThird.']) {
      const request = h.ask({ context: JSON.stringify({ confirm: 'always', intent: `Review typing. ${value}` }) });
      getDb().run('UPDATE approval_requests SET tool_arguments = ? WHERE id = ?', [JSON.stringify({ text: value }), request.id]);
      expect([value, notchApprovalWay(h.approvals.getRequest(request.id)!)]).toEqual([value, 'sheet']);
    }
  });
});

describe('what the sheet says will be done', () => {
  test('an action on screen: what the product says is acted on comes first, then with what', async () => {
    const h = harness();
    const made = h.approvals.createRequest({
      agentId: 'agent-1', agentName: 'PA', toolName: 'write_file', toolArguments: { element_id: 12, action: 'click' },
      actionCategory: 'control_app', urgency: 'normal', reason: 'needs review',
      context: JSON.stringify({ confirm: 'always', intent: 'Review click on browser element [12] "Send" in Gmail. UI hints: send_email.' }),
      executionMode: 'deferred', principal: PRINCIPAL,
    });
    await h.sync();
    const sheet = h.line();
    const paper = sheet?.kind === 'sheet' ? sheet.blocks.find((block) => block.kind === 'paper') : null;
    expect(paper?.kind === 'paper' ? paper.lines.map((parts) => parts.join('')) : []).toEqual([
      'Review click on browser element [12] "Send" in Gmail. UI hints: send_email.', 'write_file', 'element_id: 12', 'action: click',
    ]);
    expect(h.approvals.getRequest(made.id)!.status).toBe('pending');
  });

  const click = (h: ReturnType<typeof harness>) => h.approvals.createRequest({
    agentId: 'agent-1', agentName: 'PA', toolName: 'desktop_click', toolArguments: { element_id: 12 },
    actionCategory: 'control_app', urgency: 'normal', reason: 'needs review',
    context: JSON.stringify({ confirm: 'always', intent: 'Review desktop_click on element [12].' }),
    executionMode: 'deferred', principal: PRINCIPAL,
  });
  const paperOf = (h: ReturnType<typeof harness>): string[] => {
    const sheet = h.line();
    const paper = sheet?.kind === 'sheet' ? sheet.blocks.find((block) => block.kind === 'paper') : null;
    return paper?.kind === 'paper' ? paper.lines.map((parts) => parts.join('')) : [];
  };

  test('a click says what on the screen it lands on, above the exact action', async () => {
    const asked: string[] = [];
    const h = harness({ where: async (request) => { asked.push(request.tool_name); return { place: 'Button "Send" in "Inbox - Outlook" (olk)' }; } });
    click(h);
    await h.sync();
    expect(asked).toEqual(['desktop_click']);
    expect(paperOf(h)).toEqual([
      'On screen: Button "Send" in "Inbox - Outlook" (olk)', 'Review desktop_click on element [12].', 'desktop_click', 'element_id: 12',
    ]);
  });

  test('what the screen calls it is shown as one short line with nothing hidden in it', async () => {
    const h = harness({ where: async () => ({ place: `Button "Pay\u200b now"\r\n\u202eevil ${'x'.repeat(400)}` }) });
    click(h);
    await h.sync();
    const first = paperOf(h)[0]!;
    expect(first.startsWith('On screen: Button "Pay now" evil x')).toBe(true);
    expect(/[\u200b\u202e\r\n]/.test(first)).toBe(false);
    expect([...first].length).toBeLessThanOrEqual('On screen: '.length + 160);
  });

  test('a click that lands on a payment is not taken on the notch: the line points at the dashboard and a yes only opens it', async () => {
    const h = harness({ where: async () => ({ place: 'Hyperlink "Buy now" in "Store" (steamwebhelper)', pays: true }) });
    const made = click(h);
    await h.sync();
    // Not a sheet with a yes: the payment line.
    expect(h.line()?.kind).toBe('offer');
    expect(h.said()).toBe('That looks like a payment. I never take one on a key: Hyperlink "Buy now" in "Store" (steamwebhelper)');
    await h.answer('yes');
    expect(h.opened).toHaveLength(1);
    expect(h.approvals.getRequest(made.id)!.status).toBe('pending');
    expect(h.runs).toEqual([]);
  });

  test('a read that comes in late and says it pays takes the sheet away, even after a yes', async () => {
    let say: (read: NotchApprovalWhere) => void = () => {};
    const h = harness({ where: () => new Promise<NotchApprovalWhere | null>((resolve) => { say = resolve; }) });
    const made = click(h);
    await h.sync();
    await h.advance(1500);
    // The machine was slow: the sheet is up without its place, and takes a yes.
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'approve' });
    await h.answer('yes');
    expect(h.line()).toMatchObject({ kind: 'send' });
    // The read arrives while the fuse burns, and the fuse burns out.
    say({ place: 'Button "Pay now" in "Checkout" (chrome)', pays: true });
    await settle();
    await h.answer('done');
    expect(h.approvals.getRequest(made.id)!.status).toBe('pending');
    expect(h.runs).toEqual([]);
    expect(h.said()).toContain('That looks like a payment');
  });

  test('a sheet that comes back later is read again: the place it shows is the one in front now', async () => {
    let reads = 0;
    let time = Date.now();
    const h = harness({
      now: () => time,
      where: async () => ({ place: ++reads === 1 ? 'the window in front, "Notepad" (notepad)' : 'the window in front, "Bank" (chrome)' }),
    });
    click(h);
    await h.sync();
    expect(paperOf(h)[0]).toBe('On screen: the window in front, "Notepad" (notepad)');
    // Left alone until it goes back to the count, then opened again a minute later.
    await h.advance(60_000);
    expect(h.line()).toBeNull();
    time += 60_000;
    await h.open();
    await settle();
    expect(reads).toBe(2);
    expect(paperOf(h)[0]).toBe('On screen: the window in front, "Bank" (chrome)');
  });

  test('a machine that cannot say, or says it too late, leaves the sheet as it was', async () => {
    const silent = harness({ where: async () => null });
    click(silent);
    await silent.sync();
    expect(paperOf(silent)).toEqual(['Review desktop_click on element [12].', 'desktop_click', 'element_id: 12']);

    const broken = harness({ where: async () => { throw new Error('the desktop app does not know describe_target'); } });
    click(broken);
    await broken.sync();
    expect(paperOf(broken)).toEqual(['Review desktop_click on element [12].', 'desktop_click', 'element_id: 12']);
    expect(broken.logs.some((line) => line.includes('could not be read'))).toBe(true);

    const slow = harness({ where: () => new Promise<NotchApprovalWhere | null>(() => {}) });
    click(slow);
    await slow.sync();
    // Nothing on the notch yet: it waits for the place, but not for long.
    expect(slow.line()).toBeNull();
    await slow.advance(1500);
    expect(paperOf(slow)).toEqual(['Review desktop_click on element [12].', 'desktop_click', 'element_id: 12']);
  });

  test('a tool that wrote no sentence of its own is never one line with its name: its arguments are on the sheet', async () => {
    const h = harness();
    const bare = h.ask({ context: '' });
    expect(notchApprovalWay(bare)).toBe('sheet');
    await h.sync();
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'approve', stay: true });
    const sheet = h.line();
    const paper = sheet?.kind === 'sheet' ? sheet.blocks.find((block) => block.kind === 'paper') : null;
    expect(paper?.kind === 'paper' ? paper.lines.map((parts) => parts.join('')) : []).toEqual(['write_file', 'path: /tmp/a']);
    // With no arguments at all, its name is the whole of it, and a line is enough.
    const empty = h.ask({ context: '' });
    getDb().run("UPDATE approval_requests SET tool_arguments = '{}' WHERE id = ?", [empty.id]);
    expect(notchApprovalWay(h.approvals.getRequest(empty.id)!)).toBe('key');
  });

  test('a click that pays is a payment: the notch points at the dashboard and its yes is refused', async () => {
    const h = harness();
    const pay = h.ask({ category: 'make_payment', context: JSON.stringify({ confirm: 'always', intent: 'Review click on "Pay now".' }) });
    expect(notchApprovalWay(pay)).toBe('payment');
    await h.sync();
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'open' });
    expect(h.said()).toStartWith('A payment. I never take that on a key');
    expect(await applyApprovalDecision('approve', pay.id, NOTCH_DECIDER, h.deps)).toMatchObject({ status: 'needs_dashboard' });
  });
});

describe('an approval the person\'s own instruction is stopped at', () => {
  test('does not fold: it stays until it is answered', async () => {
    const h = harness({ mine: () => true });
    const req = h.ask();
    await h.sync();
    expect(h.line()).toMatchObject({ kind: 'offer', fold: 0 });
    await h.advance(120_000);
    expect(h.said()).toBe('Write file?');
    expect(h.approvals.getRequest(req.id)!.status).toBe('pending');
  });

  test('its sheet does not time out either', async () => {
    const h = harness({ mine: () => true, describe: async () => 'Look up where Steam is installed?' });
    h.ask({ context: JSON.stringify({ intent: `On this computer, run: ${'reg query HKCU '.repeat(8)}` }) });
    await h.sync();
    await h.advance(120_000);
    expect(h.line()).toMatchObject({ kind: 'sheet', stay: true });
    expect(h.said()).toBe('Look up where Steam is installed?');
  });

  test('any other approval still folds and waits in the count', async () => {
    const h = harness({ mine: () => false });
    h.ask();
    await h.sync();
    const line = h.line();
    expect(line?.kind === 'offer' ? line.fold : 'not an offer').toBeUndefined();
  });
});

test('a sign the width table does not know is no reason to send an approval to the dashboard', () => {
  const h = harness();
  const arrow = h.ask({ context: JSON.stringify({ intent: 'Rename report.txt \u2192 report-final.txt and mark it \u2122' }) });
  expect(notchApprovalWay(arrow)).toBe('sheet');
  const short = h.ask({ context: JSON.stringify({ intent: 'Rename a \u2192 b' }) });
  expect(['key', 'sheet']).toContain(notchApprovalWay(short));
});
