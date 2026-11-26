/**
 * The notch's real things end to end inside the brain: a fixture makes a real
 * approval, the notch finds it, a yes runs it once through the product's own
 * decision function, and Today lists it.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { runCommandTool } from '../actions/tools/builtin.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { ApprovalManager } from '../authority/approval.ts';
import { approvalToast } from '../authority/approval-delivery.ts';
import { AuditTrail } from '../authority/audit.ts';
import { DeferredExecutor } from '../authority/deferred-executor.ts';
import { AuthorityEngine } from '../authority/engine.ts';
import { NOTCH_DECIDER, SYSTEM_DECIDER, applyApprovalDecision, type ApprovalDecisionDeps } from '../daemon/approval-decision.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import type { RawInteraction } from '../skills/recorder.ts';
import { NOTCH_WATCH_EVENT } from './catch.ts';
import { NOTCH_PLAIN_LINE_COLUMNS, notchApprovalSentence, notchApprovalWay } from './approvals.ts';
import { NOTCH_FIXTURE_AGENT } from './fixtures.ts';
import { NotchLedger } from './ledger.ts';
import type { NotchAnswerAct, NotchLine, NotchToPage } from './protocol.ts';
import { NOTCH_TICK_FAILURE_SAID_MS, attachNotchReal, type NotchReal } from './real.ts';
import { PeerLink } from '../peers/link.ts';
import { FakeEngine, FakeServer } from '../peers/testing/fake-engines.ts';
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
    withdraw: (id) => applyApprovalDecision('deny', id, SYSTEM_DECIDER, deps),
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
      approvalManager: approvals, approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
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
    // The sentence is the tool's own gate's: the machine, the directory, the
    // command. How long it is depends on where the brain runs (the directory
    // is in it), and that decides how it is shown: short, as one line; longer,
    // in plain words with the sentence under them. Both are checked, whichever
    // this machine makes.
    const sentence = notchApprovalSentence(request!);
    expect(sentence).toMatch(/run: echo notch test$/);
    const way = notchApprovalWay(request!);
    expect(way).toBe([...sentence].length > NOTCH_PLAIN_LINE_COLUMNS ? 'sheet' : 'key');
    await h.look();
    if (way === 'sheet') {
      // With nobody to word it here, it is asked by what kind of thing it is.
      expect(h.said()).toBe('Run a command on this computer?');
      expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'approve', stay: true, mood: 'careful' });
      const sheet = h.line();
      const paper = sheet?.kind === 'sheet' ? sheet.blocks.find((block) => block.kind === 'paper') : null;
      expect(paper?.kind === 'paper' ? paper.lines.map((parts) => parts.join('')).join(' ') : '').toBe(sentence);
    } else {
      expect(h.said()).toMatch(/run: echo notch test\?$/);
      expect(h.line()).toMatchObject({ kind: 'offer', yes: 'approve', mood: 'careful' });
    }
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
    const none = attachNotchReal(surface, { approvalManager: approvals, approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }), lookMs: 3_600_000, log: () => {} });
    expect(none.fixtures.kinds()).toEqual(['approval', 'payment']);
    none.stop();
    const early = attachNotchReal(surface, { approvalManager: approvals, approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }), toolRegistry: () => null, lookMs: 3_600_000, log: () => {} });
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

describe('doing it in view, put together (pass 10)', () => {
  function world() {
    let onPage: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    let onWatch: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const surface = new NotchSurface({ dispatchRPC: () => Promise.resolve({}), onEvent(listener) { onPage = listener; }, onSidecarDisconnected() {} }, () => {});
    const fromPage = (message: unknown): void => onPage('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
    fromPage({ type: 'hello', v: 1 });
    const sent: Record<string, unknown>[] = [];
    const calls: string[] = [];
    const shown: RawInteraction[] = [];
    const hearers = new Set<(interaction: RawInteraction, count: number) => void>();
    let watchAsked = 0;
    const real = attachNotchReal(surface, {
      approvalManager: new ApprovalManager(), approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      asks: { db: getDb(), turns: () => null, modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null },
      jobs: {
        db: getDb(), noClock: true,
        hands: {
          act: async (request) => {
            sent.push(request);
            if (request.do === 'pitch') return { done: true, known: true, dy: request.dy as number };
            return request.do === 'copy' ? { done: true, empty: false, rows: 1, cols: 2, hash: 'h' } : { done: true };
          },
        },
        watchPort: { onEvent(listener) { onWatch = listener; } },
        count: async () => 2,
        hold: () => {},
        watch: () => { watchAsked++; },
        teach: {
          recorder: {
            async start() { calls.push('start'); return { ok: true }; },
            async stop() { calls.push('stop'); return shown.splice(0); },
            onStep(listener) { hearers.add(listener); return () => { hearers.delete(listener); }; },
          },
          save: (interactions) => ({ ok: true, skill: 'shown-notepad', steps: interactions.length, notes: [], apps: ['Notepad'] }),
          describe: async () => 'saves the file',
          forget() {},
          effect: () => ({ pays: false, deletes: false, missing: false }),
          runSkill: async (_skill, _from, run) => { run.onProgress(1); return { end: { how: 'done' }, next: 1 }; },
        },
      },
      lookMs: 3_600_000, log: () => {},
    });
    live = real;
    const line = (): NotchLine | null => surface.current().line;
    const said = (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? part.word.value : '')).join('');
    const type = async (words: string): Promise<void> => {
      fromPage({ type: 'open' });
      await settle();
      fromPage({ type: 'answer', id: line()!.id, act: 'ask', text: words });
      await settle();
      await settle();
    };
    const answer = async (act: NotchAnswerAct, more: Record<string, unknown> = {}): Promise<void> => { fromPage({ type: 'answer', id: line()!.id, act, ...more }); await settle(); await settle(); };
    let ts = Date.now();
    const hand = (payload: Record<string, unknown>): void => onWatch('pc', { event_type: NOTCH_WATCH_EVENT, payload: { ...payload, ts: (ts += 200) } });
    const does = async (interaction: RawInteraction): Promise<void> => { shown.push(interaction); for (const hear of [...hearers]) hear(interaction, shown.length); await settle(); };
    return { real, sent, calls, line, said, type, answer, hand, does, watchAsked: () => watchAsked };
  }
  const FILE = { id: '0x1a', pid: 100, w: 900, h: 700 };
  const SHEET = { id: '0x2b', pid: 200, w: 1200, h: 800 };
  const row = (w: ReturnType<typeof world>, n: number): void => {
    w.hand({ kind: 'click', app: 'notepad', win: FILE, pt: { x: 120, y: 200 + 22 * n } });
    w.hand({ kind: 'keys', app: 'notepad', win: FILE, keys: 'ctrl,c' });
    w.hand({ kind: 'click', app: 'excel', win: SHEET, pt: { x: 300, y: 400 + 20 * n } });
    w.hand({ kind: 'keys', app: 'excel', win: SHEET, keys: 'ctrl,v' });
  };

  test('the desktop apps are asked to tell what the hands do, and the parts are all there', () => {
    const w = world();
    expect(w.watchAsked()).toBe(1);
    expect(w.real.jobs && w.real.catcher && w.real.teach && w.real.put).toBeTruthy();
  });

  // The plan's test, step 1, typed in Home: it reaches the recorder with no model and no turn in between.
  test('"Watch me" typed in Home starts a showing; yes ends it; and the job is in Home after', async () => {
    const w = world();
    await w.type('Watch me');
    expect(w.calls).toEqual(['start']);
    expect(w.said()).toBe('Watching. Do it once by hand, then press done.');
    await w.does({ action: 'click', ref: { role: 'Button', name: 'Save', path: [], ordinal: 0, sig: 's' }, ts: 1, app: 'notepad' });
    expect(w.said()).toBe('Watching. Step 1: clicked Save.');
    await w.answer('yes');
    expect(w.calls).toEqual(['start', 'stop']);
    expect(w.said()).toBe('Learned it in 1 step: saves the file. Do it every Monday at 9:00?');
    expect(w.real.teach!.row()).toMatchObject({ id: 'learned' });
  });

  // The plan's test, step 7.
  test('two rows pasted by hand, with nothing said: it offers to take over, and a yes does the rest and lists it in Today', async () => {
    const w = world();
    row(w, 0);
    row(w, 1);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settle();
    expect(w.said()).toBe('I can take it from here. 2 left.');
    await w.answer('yes');
    // Two rows at the pace a program is given to take each step in: under two seconds.
    await new Promise((resolve) => setTimeout(resolve, 1900));
    await settle();
    expect(w.sent.filter((request) => request.do === 'keys' && request.keys === 'ctrl,v').length).toBe(2);
    expect(w.real.jobs!.done(0)).toMatchObject([{ text: 'Pasted 2 from notepad into excel', undoable: true }]);
  });

  test('while Jarvis is being shown a job, what the hands do is not a job to take over', async () => {
    const w = world();
    await w.type('Watch me');
    row(w, 0);
    row(w, 1);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(w.said()).toBe('Watching. Do it once by hand, then press done.');
  });
});

// The hardening audit, 17 November 2026: every test of these words had called the route on a free notch. In
// the product the words are typed into Home, or spoken, and the line that carries them still has the notch
// when they are acted on. What they opened was refused the notch: nothing came up, and the ledger said done.
describe('words the notch acts on itself, typed into Home as a person types them', () => {
  test('"what can you do", "settings" and "show me how you move" each open what they name', async () => {
    const pushed: NotchToPage[] = [];
    let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const port: NotchSurfacePort = {
      dispatchRPC(_sidecarId, _method, params) { const message = (params as { message?: NotchToPage }).message; if (message) pushed.push(message); return Promise.resolve({}); },
      onEvent(listener) { onEvent = listener; },
      onSidecarDisconnected() {},
    };
    const surface = new NotchSurface(port, () => {});
    const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
    fromPage({ type: 'hello', v: 1 });
    const real = attachNotchReal(surface, {
      approvalManager: new ApprovalManager(),
      approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      asks: { db: getDb(), turns: () => null, modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null },
      day: { db: getDb(), noClock: true },
      lookMs: 3_600_000,
      log: () => {},
    });
    const wait = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 2)); for (let i = 0; i < 60; i++) await Promise.resolve(); };
    const line = (): NotchLine | null => surface.current().line;
    const title = (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
    for (const [words, opens] of [['what can you do', 'What I can do'], ['settings', 'Settings'], ['show me how you move', 'How I move']] as const) {
      fromPage({ type: 'open' });
      await wait();
      expect(line()?.kind).toBe('ask');
      fromPage({ type: 'answer', id: line()!.id, act: 'ask', text: words });
      await wait();
      expect([words, line()?.kind, title()]).toEqual([words, 'sheet', opens]);
      fromPage({ type: 'answer', id: line()!.id, act: 'no' });
      await wait();
      expect(line()).toBeNull();
    }
    real.stop();
  });
});

// Listening to a call, put together as the product puts it together: the
// notch hears that a call is on, asks, the desktop app's pieces are made into
// words, and when the call is over the notch says what came out of it.
describe('a call that is listened to, put together', () => {
  test('from "a call is on" to "2 actions came out of it", with the row in Settings and in Home', async () => {
    const pushed: NotchToPage[] = [];
    let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const port: NotchSurfacePort = {
      dispatchRPC(_sidecarId, _method, params) { const message = (params as { message?: NotchToPage }).message; if (message) pushed.push(message); return Promise.resolve({}); },
      onEvent(listener) { onEvent = listener; },
      onSidecarDisconnected() {},
    };
    const surface = new NotchSurface(port, () => {});
    const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
    fromPage({ type: 'hello', v: 1 });
    const timers: { fn: () => void; at: number }[] = [];
    let now = 0;
    const clock = {
      setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
      clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
    };
    let around: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    let call: (sidecarId: string, event: { event_type: string; payload: unknown; binary?: unknown }) => void = () => {};
    const asked: { on: boolean; id: string; far: boolean }[] = [];
    const heard = [
      'Thanks for making the time today Sam, I wanted to go through the pricing for the five seats and the date we start.',
      'Sure. Five seats on the Pro plan works for us, and I would like to begin on the first of December if legal agrees.',
      'Good, then I send you the pricing for five seats by Friday and you check the start date with your legal team.',
    ];
    const real = attachNotchReal(surface, {
      approvalManager: new ApprovalManager(),
      approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      asks: { db: getDb(), turns: () => null, modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null },
      day: { db: getDb(), noClock: true, around: { onEvent(listener) { around = listener; }, onSidecarDisconnected() {} } },
      calls: {
        db: getDb(), noClock: true,
        port: { onEvent(listener) { call = listener; }, onSidecarDisconnected() {} },
        async listen(_sidecarId, ask) {
          asked.push(ask);
          if (!ask.on) { call('pc', { event_type: 'notch.call', payload: { id: ask.id, phase: 'end', reason: 'asked' } }); return { listening: false }; }
          return { listening: true, far: ask.far, why: '' };
        },
        stt: () => ({ transcribe: async () => heard.shift() ?? '' }),
        think: async () => JSON.stringify({ summary: 'Pricing and a start date were agreed.', with: 'Sam', actions: [{ what: 'Send pricing for 5 seats', owner: 'mine', by: 'Friday' }, { what: 'Check the start date with legal', owner: 'theirs', by: '' }], followup: 'As agreed.' }),
      },
      clock,
      lookMs: 3_600_000,
      log: () => {},
    });
    live = real;
    const wait = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 2)); for (let i = 0; i < 60; i++) await Promise.resolve(); };
    const pass = async (ms: number): Promise<void> => {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at; timers.splice(timers.indexOf(next), 1); next.fn();
        await wait();
      }
      now = until;
      await wait();
    };
    const line = (): NotchLine | null => surface.current().line;
    const said = (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
    const answer = async (act: NotchAnswerAct): Promise<void> => { fromPage({ type: 'answer', id: line()!.id, act }); await wait(); };

    // A calling program has the microphone for a minute: a call.
    around('pc', { event_type: 'notch.around', payload: { call: true } });
    await pass(60_000);
    expect(said()).toBe('On a call. Listen and write it down?');
    expect(asked).toEqual([]);
    await answer('yes');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ on: true, far: false });
    expect(said()).toBe('Listening. I hold everything else until you are done.');
    await answer('done');
    // The eye is lit while it listens.
    expect(pushed.some((message) => message.type === 'act' && message.eye === true)).toBe(true);
    for (const source of ['mic', 'far', 'mic']) {
      call('pc', { event_type: 'notch.call', payload: { id: asked[0]!.id, phase: 'piece', source, seq: 1, at: Date.now(), ms: 8000, voiced_ms: 7000, rate: 16_000 }, binary: { type: 'inline', data: Buffer.alloc(16_000 * 2 * 8, 1).toString('base64') } });
      await wait();
    }
    // The calling program lets the microphone go: after a quarter of a minute the call is over.
    around('pc', { event_type: 'notch.around', payload: { call: false } });
    await pass(15_000);
    expect(asked.at(-1)).toMatchObject({ on: false });
    // There is no way to the mailbox here: the follow-up is drafted all the same, to be read on the sheet.
    expect(said()).toBe('Call ended. 2 actions came out of it. Follow-up drafted.');
    expect(pushed.filter((message) => message.type === 'act' && message.eye !== undefined).at(-1)).toMatchObject({ eye: false });
    await answer('yes');
    expect(said()).toBe('After the call with Sam');
    await answer('no');
    // Home has its row, and Settings the two words.
    fromPage({ type: 'open' });
    await wait();
    const text = (parts: unknown): string => (Array.isArray(parts) ? parts : []).map((part) => (typeof part === 'string' ? part : part && typeof part === 'object' && 'em' in part ? String((part as { em: unknown }).em) : part && typeof part === 'object' && 'word' in part ? `[${(part as { word: { value: string } }).word.value}]` : '')).join('');
    const rows = (): string[] => { const shown = line(); return (shown && 'blocks' in shown && Array.isArray(shown.blocks) ? shown.blocks : []).filter((block) => block.kind === 'row').map((block) => text((block as { say: unknown }).say)); };
    expect(rows()).toContain('Your last call: 2 actions.');
    fromPage({ type: 'answer', id: line()!.id, act: 'ask', text: 'settings' });
    await wait();
    expect(said()).toBe('Settings');
    expect(rows()).toContain('On a call I [offer to listen], and hear [your side only].');
    fromPage({ type: 'answer', id: line()!.id, act: 'word', word: 'callside', value: 'both sides' });
    await wait();
    expect(rows()).toContain('On a call I [offer to listen], and hear [both sides].');
  });
});

describe("other people's Jarvises, put together", () => {
  function assembled(given: boolean, think?: (sentence: string) => string) {
    const pushed: NotchToPage[] = [];
    let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const port: NotchSurfacePort = {
      dispatchRPC(_sidecarId, _method, params) { const message = (params as { message?: NotchToPage }).message; if (message) pushed.push(message); return Promise.resolve({}); },
      onEvent(listener) { onEvent = listener; },
      onSidecarDisconnected() {},
    };
    const surface = new NotchSurface(port, () => {});
    const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
    fromPage({ type: 'hello', v: 1 });
    const server = new FakeServer();
    const engine = new FakeEngine(server, 'Sam0000000000000000001', 'sam');
    const leo = new FakeEngine(server, 'Leo0000000000000000002', 'leo');
    engine.signedIn = true;
    leo.signedIn = true;
    engine.contacts.set(leo.id, { deviceId: leo.id, localName: 'Leo', ownDevice: null, serverDisplayName: 'x', createdAt: 1 });
    leo.contacts.set(engine.id, { deviceId: engine.id, localName: 'Sam', ownDevice: null, serverDisplayName: 'x', createdAt: 1 });
    const link = new PeerLink({ readMs: 0 });
    link.attach(engine);
    engine.dialog = link.dialog;
    engine.notice = link.notice;
    const real = attachNotchReal(surface, {
      approvalManager: new ApprovalManager(),
      approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      asks: { db: getDb(), turns: () => null, modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null },
      day: { db: getDb(), noClock: true },
      ...(given ? { peers: { db: getDb(), link, openPage: async () => true, noClock: true, ...(think ? { think: async (messages: { role: string; content: string }[]) => think(messages[1]!.content.split('\n').pop()!) } : {}) } } : {}),
      lookMs: 3_600_000,
      log: () => {},
    });
    const wait = async (): Promise<void> => { for (let round = 0; round < 4; round++) { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 2)); } };
    const line = (): NotchLine | null => surface.current().line;
    const said = (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
    return { real, link, engine, leo, fromPage, wait, line, said };
  }

  test('Home has the row for the organisation, and it opens the sheet', async () => {
    const h = assembled(true);
    await h.link.refresh();
    h.fromPage({ type: 'open' });
    await h.wait();
    const rows = (h.line() as { blocks: { kind: string; id?: string }[] }).blocks.filter((block) => block.kind === 'row');
    expect(rows.find((row) => row.id === 'people')).toMatchObject({ go: true, say: [{ em: 'Your organisation' }, ': you and ', { em: 'Leo' }, '.'] });
    h.fromPage({ type: 'answer', id: h.line()!.id, act: 'go', row: 'people' });
    await h.wait();
    expect([h.line()?.kind, h.said()]).toEqual(['sheet', 'Your organisation']);
    h.real.stop();
  });

  test('"tell Leo ..." typed into Home goes to Leo', async () => {
    const h = assembled(true);
    await h.link.refresh();
    h.fromPage({ type: 'open' });
    await h.wait();
    h.fromPage({ type: 'answer', id: h.line()!.id, act: 'ask', text: 'tell Leo the review moved to Friday' });
    await h.wait();
    expect([h.line()?.kind, h.said()]).toEqual(['send', 'Telling Leo: The review moved to Friday…']);
    h.fromPage({ type: 'answer', id: h.line()!.id, act: 'done' });
    await h.wait();
    expect(h.said()).toBe('Sent to Leo. I will tell you when it is seen.');
    expect(h.leo.inbox.map((item) => item.payload.text)).toEqual(['The review moved to Friday']);
    h.real.stop();
  });

  test('said any way: what the fixed words do not fit is read by the model, and goes to Leo turned to him', async () => {
    const asked: string[] = [];
    const h = assembled(true, (sentence) => { asked.push(sentence); return sentence.includes('love') ? '{"kind":"tell","to":[1],"words":"I love you"}' : sentence.includes('late') ? '{"kind":"tell","to":[1],"words":"I am running late"}' : '{"kind":"none"}'; });
    await h.link.refresh();
    const type = async (text: string): Promise<void> => {
      h.fromPage({ type: 'open' });
      await h.wait();
      h.fromPage({ type: 'answer', id: h.line()!.id, act: 'ask', text });
      await h.wait();
    };
    const out = async (): Promise<void> => { h.fromPage({ type: 'answer', id: h.line()!.id, act: 'done' }); await h.wait(); h.fromPage({ type: 'answer', id: h.line()!.id, act: 'done' }); await h.wait(); };
    // None of the fixed words: read, and done as "tell Leo ..." is.
    await type('hey, I need Leo to know I am running late');
    expect([h.line()?.kind, h.said()]).toEqual(['send', 'Telling Leo: I am running late…']);
    await out();
    // The fixed words, with words about him: turned to him.
    await type('tell Leo I love him');
    expect([h.line()?.kind, h.said()]).toEqual(['send', 'Telling Leo: I love you…']);
    await out();
    expect(h.leo.inbox.map((item) => item.payload.text)).toEqual(['I am running late', 'I love you']);
    // The fixed words, with nothing to turn: no model.
    await type('can you tell Leo hi');
    expect(h.said()).toBe('Telling Leo: Hi…');
    expect(asked).toEqual(['hey, I need Leo to know I am running late', 'tell Leo I love him']);
    h.real.stop();
  });

  test('with the switch off there is no row, and the same words go nowhere near Leo', async () => {
    const h = assembled(false);
    expect(h.real.people).toBeNull();
    h.fromPage({ type: 'open' });
    await h.wait();
    const rows = (h.line() as { blocks: { kind: string; id?: string }[] }).blocks.filter((block) => block.kind === 'row');
    expect(rows.find((row) => row.id === 'people')).toBeUndefined();
    h.fromPage({ type: 'answer', id: h.line()!.id, act: 'ask', text: 'tell Leo the review moved to Friday' });
    await h.wait();
    expect(h.leo.inbox).toEqual([]);
    h.real.stop();
  });
});

/** The notch assembled with its noticing, an instruction door that keeps what was submitted, and a clock of its own. */
function assembledNotch(think: () => string) {
    const pushed: NotchToPage[] = [];
    let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const port: NotchSurfacePort = {
      dispatchRPC(_sidecarId, _method, params) { const message = (params as { message?: NotchToPage }).message; if (message) pushed.push(message); return Promise.resolve({}); },
      onEvent(listener) { onEvent = listener; },
      onSidecarDisconnected() {},
    };
    const surface = new NotchSurface(port, () => {});
    const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
    fromPage({ type: 'hello', v: 1 });
    let whereSays: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const state = { now: new Date(2026, 10, 18, 10, 0).getTime(), looks: 0, paused: false };
    const timers: { fn: () => void; at: number }[] = [];
    let ticks = 0;
    const clock = {
      setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: ticks + ms }; timers.push(timer); return timer; },
      clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
    };
    const submitted: { text: string; requestId: string }[] = [];
    const real = attachNotchReal(surface, {
      approvalManager: new ApprovalManager(),
      approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      emergency: { getState: () => (state.paused ? 'paused' : 'normal'), pause() { state.paused = true; }, resume() { state.paused = false; }, subscribe() { return () => {}; } } as never,
      asks: {
        db: getDb(), modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null,
        turns: () => ({
          ready: () => true, conversation: () => 'conv-notch',
          submit(turn: { text: string; requestId: string }) { submitted.push({ text: turn.text, requestId: turn.requestId }); },
          cancel() {}, onEvent: () => () => {}, look: () => null, mark() {},
        }) as never,
      },
      where: { port: { onEvent(listener) { whereSays = listener; }, dispatchRPC: async () => ({}) } },
      day: { db: getDb(), noClock: true, now: () => state.now },
      notice: {
        noClock: true,
        see: async () => { state.looks++; return { picture: new Uint8Array([1]), x: 0, y: 0, w: 800, h: 600, app: 'slack' }; },
        think: async () => think(),
      },
      clock,
      lookMs: 3_600_000,
      log: () => {},
    });
    live = real;
    const wait = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 2)); for (let i = 0; i < 60; i++) await Promise.resolve(); };
    /** The notch's own clock goes on: a line's moment passes. */
    const pass = async (ms: number): Promise<void> => {
      const until = ticks + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        ticks = next.at; timers.splice(timers.indexOf(next), 1); next.fn();
        await wait();
      }
      ticks = until;
      await wait();
    };
    /** Holds the talk keys, says `words`, lets go, and waits out the moment the words are shown. */
    const say = async (talkId: string, words: string): Promise<void> => {
      real.asks!.listen(talkId); await wait();
      real.asks!.released(talkId); await wait();
      real.asks!.words(talkId, words); await wait();
      await pass(2000);
    };
    const line = (): NotchLine | null => surface.current().line;
    const text = (parts: unknown): string => (Array.isArray(parts) ? parts : []).map((part) => (typeof part === 'string' ? part : part && typeof part === 'object' && 'em' in part ? String((part as { em: unknown }).em) : part && typeof part === 'object' && 'word' in part ? `[${(part as { word: { value: string } }).word.value}]` : '')).join('');
    return {
      real, state, submitted, line, wait, fromPage, pass, say,
      said: (): string => text(line()?.say),
      rows: (): string[] => { const shown = line(); return (shown && 'blocks' in shown && Array.isArray(shown.blocks) ? shown.blocks : []).filter((block) => block.kind === 'row').map((block) => text((block as { say: unknown }).say)); },
      inFront(payload: Record<string, unknown>): void { whereSays('pc', { event_type: 'notch.where', payload: { look: '', still: true, never: [], ...payload } }); },
      async rests(): Promise<string> {
        await real.notice!.tick();
        state.now += 8000;
        const did = await real.notice!.tick();
        await wait();
        return did;
      },
      async answer(act: NotchAnswerAct, more: Record<string, unknown> = {}): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act, ...more }); await wait(); },
    };
}

// The owner, 18 November 2026: "if I start a meeting and I do not accept the meeting feature ... I cannot use
// Jarvis in anything else. If I try to open the Jarvis menu ... it just tells me you're in a meeting. Do you
// want me to start transcribing?"
describe('a call that was not listened to leaves the notch to its owner, put together', () => {
  function onACall() {
    const pushed: NotchToPage[] = [];
    let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const port: NotchSurfacePort = {
      dispatchRPC(_sidecarId, _method, params) { const message = (params as { message?: NotchToPage }).message; if (message) pushed.push(message); return Promise.resolve({}); },
      onEvent(listener) { onEvent = listener; },
      onSidecarDisconnected() {},
    };
    const surface = new NotchSurface(port, () => {});
    const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
    fromPage({ type: 'hello', v: 1 });
    const timers: { fn: () => void; at: number }[] = [];
    let now = 0;
    const clock = {
      setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
      clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
    };
    let around: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const asked: { on: boolean; id: string; far: boolean }[] = [];
    const submitted: string[] = [];
    const real = attachNotchReal(surface, {
      approvalManager: new ApprovalManager(),
      approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      asks: {
        db: getDb(), modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null,
        turns: () => ({ ready: () => true, conversation: () => 'conv-notch', submit(turn: { text: string }) { submitted.push(turn.text); }, cancel() {}, onEvent: () => () => {}, look: () => null, mark() {} }) as never,
      },
      day: { db: getDb(), noClock: true, around: { onEvent(listener) { around = listener; }, onSidecarDisconnected() {} } },
      calls: {
        db: getDb(), noClock: true,
        port: { onEvent() {}, onSidecarDisconnected() {} },
        async listen(_sidecarId, ask) { asked.push(ask); return ask.on ? { listening: true, far: ask.far, why: '' } : { listening: false }; },
        stt: () => ({ transcribe: async () => '' }),
        think: async () => '{}',
      },
      clock,
      lookMs: 3_600_000,
      log: () => {},
    });
    live = real;
    const wait = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 2)); for (let i = 0; i < 60; i++) await Promise.resolve(); };
    const pass = async (ms: number): Promise<void> => {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at; timers.splice(timers.indexOf(next), 1); next.fn();
        await wait();
      }
      now = until;
      await wait();
    };
    const line = (): NotchLine | null => surface.current().line;
    const text = (parts: unknown): string => (Array.isArray(parts) ? parts : []).map((part) => (typeof part === 'string' ? part : part && typeof part === 'object' && 'em' in part ? String((part as { em: unknown }).em) : '')).join('');
    return {
      real, asked, submitted, line, wait, pass, fromPage,
      said: (): string => text(line()?.say),
      rows: (): string[] => { const shown = line(); return (shown && 'blocks' in shown && Array.isArray(shown.blocks) ? shown.blocks : []).filter((block) => block.kind === 'row').map((block) => text((block as { say: unknown }).say)); },
      callBegins: async (): Promise<void> => { around('pc', { event_type: 'notch.around', payload: { call: true } }); await pass(60_000); },
      tap: async (): Promise<void> => { fromPage({ type: 'open' }); await wait(); },
      answer: async (act: NotchAnswerAct, more: Record<string, unknown> = {}): Promise<void> => { fromPage({ type: 'answer', id: line()!.id, act, ...more }); await wait(); },
    };
  }

  test('after a no to the question, a tap opens Home every time, and what is typed there runs', async () => {
    const h = onACall();
    await h.callBegins();
    expect(h.said()).toBe('On a call. Listen and write it down?');
    await h.answer('no');
    expect(h.said()).toBe('On a call. I hold everything until you are done.');
    await h.answer('done');
    expect(h.asked).toEqual([]);
    // Three taps: Home each time, with the call's row first, and never the question again.
    for (let i = 0; i < 3; i++) {
      await h.tap();
      expect(h.line()).toMatchObject({ kind: 'ask', placeholder: 'Ask, or tell me what to do' });
      expect(h.rows()[0]).toBe('You are on a call. Listen and write it down');
      await h.answer('no');
      expect(h.line()).toBeNull();
    }
    expect(h.asked).toEqual([]);
    // An instruction typed in Home during the call runs like any other.
    await h.tap();
    await h.answer('ask', { text: 'what is on my calendar tomorrow' });
    expect(h.submitted).toEqual(['what is on my calendar tomorrow']);
  });

  test('"settings" typed in Home during the call opens the settings', async () => {
    const h = onACall();
    await h.callBegins();
    await h.answer('no');
    await h.answer('done');
    await h.tap();
    await h.answer('ask', { text: 'settings' });
    await h.wait();
    expect(h.said()).toBe('Settings');
  });

  test('Home\'s row has the call listened to after all, by that one press', async () => {
    const h = onACall();
    await h.callBegins();
    await h.answer('no');
    await h.answer('done');
    await h.tap();
    await h.answer('go', { row: 'call' });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ on: true, far: false });
    expect(h.said()).toBe('Listening. I hold everything else until you are done.');
    await h.answer('done');
    // Listened to now. Home still opens, and says so.
    await h.tap();
    expect(h.line()).toMatchObject({ kind: 'ask' });
    expect(h.rows()[0]).toBe('I am listening to this call, and writing it down.');
  });
});

describe('noticing, put together', () => {
  const assembled = assembledNotch;
  const SLACK = (): string => JSON.stringify({ offer: true, seen: 'Leo asked for the October revenue.', act: 'Reply to him here with the number', yes: 'reply', about: 'leo october revenue' });

  test('from resting in a window to the instruction running, and the switch in Settings', async () => {
    const h = assembled(SLACK);
    expect(h.real.notice).not.toBeNull();
    h.inFront({ app: 'slack.exe', name: 'Slack', title: 'general' });
    expect(await h.rests()).toBe('looked');
    expect(h.said()).toBe('Leo asked for the October revenue. Reply to him here with the number?');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'reply' });
    expect(h.submitted).toEqual([]);
    await h.answer('yes');
    // What runs is what was read, as an instruction of its own kind.
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.text).toBe('Leo asked for the October revenue. Reply to him here with the number.');
    expect(h.submitted[0]!.requestId).toStartWith('notch-offered-');
    expect(h.said()).toBe('On it: Leo asked for the October revenue. Reply to him here with the number.');
  });

  test('Settings has its row, and "offer nothing" stops the looking', async () => {
    const h = assembled(SLACK);
    h.fromPage({ type: 'open' });
    await h.wait();
    h.fromPage({ type: 'answer', id: h.line()!.id, act: 'ask', text: 'settings' });
    await h.wait();
    expect(h.said()).toBe('Settings');
    expect(h.rows()).toContain('In the window you are in I [offer one thing].');
    await h.answer('word', { word: 'notice', value: 'offer nothing' });
    expect(h.rows()).toContain('In the window you are in I [offer nothing].');
    await h.answer('no');
    await h.wait();
    while (h.line()) { await h.answer('no'); }
    h.inFront({ app: 'slack.exe', name: 'Slack', title: 'general' });
    expect(await h.rests()).toBe('waits');
    expect(h.state.looks).toBe(0);
  });

  test('nothing is looked at where Jarvis looks away, on the bare desktop, while a line is up, or while everything is stopped', async () => {
    const h = assembled(SLACK);
    // A bank: the desktop app looks away, and there is no window in front to look at.
    h.inFront({ app: 'chrome.exe', name: 'Chrome', site: 'bank.example', look: 'bank' });
    expect(await h.rests()).toBe('waits');
    // The bare desktop.
    h.inFront({ app: 'explorer.exe', name: 'Explorer', title: '' });
    expect(await h.rests()).toBe('waits');
    // Hands on the keys.
    h.inFront({ app: 'slack.exe', name: 'Slack', title: 'general', still: false });
    expect(await h.rests()).toBe('waits');
    // Something is on the notch.
    h.inFront({ app: 'slack.exe', name: 'Slack', title: 'general' });
    h.fromPage({ type: 'open' });
    await h.wait();
    expect(h.line()).not.toBeNull();
    expect(await h.real.notice!.tick()).toBe('waits');
    while (h.line()) { await h.answer('no'); }
    // Everything is stopped.
    h.state.paused = true;
    expect(await h.real.notice!.tick()).toBe('waits');
    expect(h.state.looks).toBe(0);
    h.state.paused = false;
    h.real.where!.refresh();
    // Awake again, the wait in a window starts anew, and then it looks.
    expect(await h.real.notice!.tick()).toBe('waits');
    expect(await h.rests()).toBe('looked');
    expect(h.state.looks).toBe(1);
  });
});

describe('talking about the line that is up, put together', () => {
  const SLACK = (): string => JSON.stringify({ offer: true, seen: 'Leo asked for the October revenue.', act: 'Reply to him here with the number', yes: 'reply', about: 'leo october revenue' });

  test('"yes, go ahead" said over an offer is its yes: the offer comes back, is taken, and what it runs is what was read', async () => {
    const h = assembledNotch(SLACK);
    h.inFront({ app: 'slack.exe', name: 'Slack', title: 'general' });
    await h.rests();
    expect(h.said()).toBe('Leo asked for the October revenue. Reply to him here with the number?');
    await h.say('t1', 'Yes, go ahead.');
    expect(h.submitted.map((one) => one.text)).toEqual(['Leo asked for the October revenue. Reply to him here with the number.']);
    expect(h.submitted[0]!.requestId).toStartWith('notch-offered-');
    // What was said is in the list of what was asked, as what the notch did with it.
    const spoken = new NotchLedger(getDb()).recent(5).find((row) => row.source === 'spoken');
    expect(spoken).toMatchObject({ state: 'done', kind: 'notch', heard: 'Yes, go ahead.', answer: 'Said yes to the line that was up.' });
  });

  test('a noise the speech-to-text made a word of is no yes: nothing the offer stands for is run', async () => {
    const h = assembledNotch(SLACK);
    h.inFront({ app: 'slack.exe', name: 'Slack', title: 'general' });
    await h.rests();
    await h.say('t1', 'Okay.');
    expect(h.submitted.map((one) => one.text)).toEqual(['Okay.']);
    expect(h.submitted.some((one) => one.text.includes('Reply to him'))).toBe(false);
  });

  test('what is said over an offer and is not about it is an instruction like any other, and the offer waits', async () => {
    const h = assembledNotch(SLACK);
    h.inFront({ app: 'slack.exe', name: 'Slack', title: 'general' });
    await h.rests();
    await h.say('t1', 'Open the Q3 deck.');
    expect(h.submitted.map((one) => one.text)).toEqual(['Open the Q3 deck.']);
    expect(h.real.inbox.has('notice:1')).toBe(true);
  });
});

describe('a notch that fails does not take the brain with it, and stop stops it (fix 02, step 0)', () => {
  type Started = { fn: () => void; cleared: boolean; handle: unknown };
  const realClear = globalThis.clearInterval;
  // The notch of a test is stopped while its made-up clocks can still be cleared, and then the real one is put back.
  afterEach(() => { live?.stop(); live = null; globalThis.clearInterval = realClear; setSystemTime(); });

  /** Every interval that is started while `run` runs: what it calls, and whether it was cleared since. None runs by the clock. */
  function clocks<T>(run: () => T): { out: T | null; failed: Error | null; started: Started[] } {
    const realSet = globalThis.setInterval;
    const started: Started[] = [];
    globalThis.setInterval = ((fn: () => void) => {
      const one: Started = { fn, cleared: false, handle: null };
      one.handle = { unref() {} };
      started.push(one);
      return one.handle;
    }) as unknown as typeof setInterval;
    // Stays in place until the test is over (the afterEach above): a handle made here is only known here.
    globalThis.clearInterval = ((handle: unknown) => {
      const one = started.find((each) => each.handle === handle);
      if (one) one.cleared = true; else realClear(handle as never);
    }) as typeof clearInterval;
    try {
      return { out: run(), failed: null, started };
    } catch (error) {
      return { out: null, failed: error as Error, started };
    } finally {
      globalThis.setInterval = realSet;
    }
  }

  const page = () => {
    let onPage: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const surface = new NotchSurface({ dispatchRPC: () => Promise.resolve({}), onEvent(listener) { onPage = listener; }, onSidecarDisconnected() {} }, () => {});
    const fromPage = (message: unknown): void => onPage('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
    fromPage({ type: 'hello', v: 1 });
    return { surface, fromPage };
  };

  const jobsDeps = () => ({
    db: getDb(),
    hands: { act: async () => ({ done: true }) },
    watchPort: { onEvent() {} },
    hold: () => {},
    teach: {
      recorder: { async start() { return { ok: true }; }, async stop() { return []; }, onStep() { return () => {}; } },
      save: () => ({ ok: true, skill: 's', steps: 0, notes: [], apps: [] }),
      describe: async () => '',
      forget() {},
      effect: () => ({ pays: false, deletes: false, missing: false }),
      runSkill: async () => ({ end: { how: 'done' }, next: 0 }),
    },
  }) as never;

  test('a clock of the notch that throws says so in the log and throws nothing: the brain is not ended by it', () => {
    const { surface } = page();
    const state = { broken: false };
    const logs: string[] = [];
    const boom = (what: string): never => { throw new Error(`${what} is broken`); };
    // The database of the calls, which stops answering.
    const db = getDb();
    const callsDb = new Proxy(db, { get(target, key) {
      if (state.broken) boom('the database');
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    const made = clocks(() => attachNotchReal(surface, {
      approvalManager: new ApprovalManager(), approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      emergency: { getState: () => (state.broken ? boom('the pause') : 'normal'), pause() {}, resume() {}, subscribe() { return () => {}; } } as never,
      asks: { db, turns: () => null, modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null },
      jobs: jobsDeps(),
      questions: { pending: () => (state.broken ? boom('the questions') : []), get: () => null, answer: () => ({ status: 200 }) },
      openFailures: () => (state.broken ? boom('the failures') : []),
      onTaskEnded: () => (state.broken ? boom('the task manager') : false),
      day: { db, around: { onEvent() {}, onSidecarDisconnected() {} } },
      calls: { db: callsDb, port: { onEvent() {}, onSidecarDisconnected() {} }, listen: async () => ({ listening: false }), stt: () => null, think: async () => '' } as never,
      lookMs: 3_600_000, log: (line) => logs.push(line),
    }));
    expect(made.failed).toBeNull();
    live = made.out;
    state.broken = true;
    const thrown: string[] = [];
    for (const one of made.started) {
      try { one.fn(); } catch (error) { thrown.push((error as Error).message); }
    }
    state.broken = false;
    expect(thrown).toEqual([]);
    // Each one that had nothing around it says what failed.
    for (const what of ['the clock of the shown jobs', 'the clock of the day', 'clearing old calls', 'asking to hear the tasks end']) {
      expect(logs.filter((line) => line.startsWith(`[notch] ${what} failed: `))).toHaveLength(1);
    }
    // The first time, with where it failed.
    expect(logs.find((line) => line.startsWith('[notch] asking to hear the tasks end failed: the task manager is broken\n'))).toContain('real.test.ts');
  });

  test('a clock that fails at every look says so the first time, and then once a minute with how often', () => {
    const { surface } = page();
    const logs: string[] = [];
    const made = clocks(() => attachNotchReal(surface, {
      approvalManager: new ApprovalManager(), approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      onTaskEnded: () => { throw new Error('the task manager is broken'); },
      lookMs: 3_600_000, log: (line) => logs.push(line),
    }));
    live = made.out;
    const said = (): string[] => logs.filter((line) => line.includes('asking to hear the tasks end failed')).map((line) => line.split('\n')[0]!);
    const start = Date.now();
    setSystemTime(new Date(start));
    for (let look = 0; look < 5; look++) for (const one of made.started) one.fn();
    expect(said()).toEqual(['[notch] asking to hear the tasks end failed: the task manager is broken']);
    setSystemTime(new Date(start + NOTCH_TICK_FAILURE_SAID_MS));
    for (const one of made.started) one.fn();
    expect(said()).toEqual([
      '[notch] asking to hear the tasks end failed: the task manager is broken',
      '[notch] asking to hear the tasks end failed (and 4 more times since that was last said): the task manager is broken',
    ]);
    // Where it failed is said the first time only.
    expect(logs.filter((line) => line.includes('real.test.ts'))).toHaveLength(1);
  });

  test('a notch that was stopped no longer says it tells the person: what waits is toasted again', () => {
    const { surface } = page();
    const made = clocks(() => attachNotchReal(surface, {
      approvalManager: new ApprovalManager(), approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      lookMs: 3_600_000, log: () => {},
    }));
    const real = made.out!;
    live = real;
    expect(real.showing()).toBe(true);
    real.stop();
    expect(surface.listening()).toBe(1);
    expect(real.showing()).toBe(false);
  });

  test('on a notch that was made whole, a part that fails to stop is said, whatever the error is', () => {
    const { surface } = page();
    const logs: string[] = [];
    const made = clocks(() => attachNotchReal(surface, {
      approvalManager: new ApprovalManager(), approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      promises: {
        executor: { subscribe: () => () => { throw new ReferenceError('gone is not defined'); }, cancelExecution: () => false, checkAndAnnounce() {}, setOriginRunner() {} },
        create: () => ({ id: 'p', when_due: null }), kept: () => [],
      },
      lookMs: 3_600_000, log: (line) => logs.push(line),
    }));
    expect(made.failed).toBeNull();
    made.out!.stop();
    expect(logs).toEqual(['[notch] a part of the notch did not stop: gone is not defined']);
  });

  test('stop clears every clock, takes the line off the notch, and nothing comes up after it', async () => {
    const { surface, fromPage } = page();
    const made = clocks(() => attachNotchReal(surface, {
      approvalManager: new ApprovalManager(), approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      asks: { db: getDb(), turns: () => null, modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null },
      jobs: jobsDeps(),
      questions: { pending: () => [], get: () => null, answer: () => ({ status: 200 }) },
      onTaskEnded: () => false,
      day: { db: getDb(), around: { onEvent() {}, onSidecarDisconnected() {} } },
      lookMs: 3_600_000, log: () => {},
    }));
    expect(made.failed).toBeNull();
    const real = made.out!;
    live = real;
    expect(made.started.length).toBeGreaterThanOrEqual(6);
    // Home is up: a line is on the notch.
    fromPage({ type: 'open' });
    await settle();
    expect(surface.current().line?.kind).toBe('ask');
    real.stop();
    await settle();
    expect(made.started.filter((one) => !one.cleared)).toEqual([]);
    expect(surface.current().line).toBeNull();
    // A tap on a notch that was stopped opens nothing, and nothing new is taken.
    fromPage({ type: 'open' });
    await settle();
    expect(surface.current().line).toBeNull();
    expect(real.inbox.present('late', async (stage) => { await stage.say(['Late.'], 1000); })).toBe(false);
  });

  test('when a part cannot be made, the throw goes on and what was made before it is stopped', async () => {
    const { surface, fromPage } = page();
    const logs: string[] = [];
    const made = clocks(() => attachNotchReal(surface, {
      approvalManager: new ApprovalManager(), approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
      asks: { db: getDb(), turns: () => null, modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null },
      jobs: jobsDeps(),
      questions: { pending: () => [], get: () => null, answer: () => ({ status: 200 }) },
      // The mail layer is made after the jobs, the asks and the questions, whose clocks are running by then.
      mail: { get db(): never { throw new Error('no such table: notch_mail'); } } as never,
      lookMs: 3_600_000, log: (line) => logs.push(line),
    }));
    expect(made.out).toBeNull();
    expect(made.failed?.message).toBe('no such table: notch_mail');
    expect(made.started.length).toBeGreaterThan(0);
    expect(made.started.filter((one) => !one.cleared)).toEqual([]);
    // A part that was never made is not a part that failed to stop.
    expect(logs.filter((line) => line.includes('did not stop'))).toEqual([]);
    // And the half of a notch that is left answers nothing.
    fromPage({ type: 'open' });
    await settle();
    expect(surface.current().line).toBeNull();
  });
});

// The review of 26 November 2026: every instruction that ended with an approval still unanswered
// closed it through `deny`, as the notch. The audit said the owner had said no on the notch, to
// something they were never asked.
describe('an instruction that ends with an approval unanswered', () => {
  test('closes it as the system: the audit does not say the owner said no on the notch', async () => {
    const approvals = new ApprovalManager();
    const audit = new AuditTrail();
    const deps: ApprovalDecisionDeps = { approvalManager: approvals, deferredExecutor: new DeferredExecutor(approvals, audit), auditTrail: audit };
    let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const port: NotchSurfacePort = { dispatchRPC: () => Promise.resolve({}), onEvent(listener) { onEvent = listener; }, onSidecarDisconnected() {} };
    const surface = new NotchSurface(port, () => {});
    const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
    fromPage({ type: 'hello', v: 1 });
    const listeners = new Set<(event: unknown) => void>();
    const turns: { conversationId: string; turnId: string; requestId: string }[] = [];
    const closedAs: string[] = [];
    const real = attachNotchReal(surface, {
      approvalManager: approvals,
      approve: (id) => applyApprovalDecision('approve', id, NOTCH_DECIDER, deps),
      deny: (id) => { closedAs.push('the notch'); return applyApprovalDecision('deny', id, NOTCH_DECIDER, deps); },
      withdraw: (id) => { closedAs.push('the system'); return applyApprovalDecision('deny', id, SYSTEM_DECIDER, deps); },
      asks: {
        db: getDb(), modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null,
        turns: () => ({
          ready: () => true, conversation: () => 'conv-notch',
          submit(turn: { conversationId: string; turnId: string; requestId: string }) { turns.push({ conversationId: turn.conversationId, turnId: turn.turnId, requestId: turn.requestId }); },
          cancel() {}, look: () => null, mark() {},
          onEvent(listener: (event: unknown) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        }) as never,
      },
      day: { db: getDb(), noClock: true },
      lookMs: 3_600_000,
      log: () => {},
    });
    live = real;
    const wait = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 2)); for (let i = 0; i < 60; i++) await Promise.resolve(); };
    let sequence = 0;
    const emit = (payload: unknown): void => { for (const listener of [...listeners]) listener({ ...turns[0]!, eventId: `e${++sequence}`, sequence, payload }); };

    fromPage({ type: 'open' });
    await wait();
    fromPage({ type: 'answer', id: surface.current().line!.id, act: 'ask', text: 'Send the numbers to Sam' });
    await wait();
    expect(turns).toHaveLength(1);
    // The turn asks for an approval, and then ends without it having been answered.
    const request = approvals.createRequest({ agentId: 'a1', agentName: 'PA', toolName: 'send_email', toolArguments: { to: 'sam@northwind.example' }, actionCategory: 'send_email', urgency: 'normal', reason: 'test', context: '' });
    emit({ kind: 'approval', approvalId: request.id, status: 'pending' });
    await wait();
    emit({ kind: 'terminal', state: 'completed' });
    await wait();

    expect(closedAs).toEqual(['the system']);
    expect(approvals.getRequest(request.id)).toMatchObject({ status: 'denied', decided_by: SYSTEM_DECIDER });
    expect(getDb().query('SELECT channel, decided_by, authority_decision FROM audit_trail WHERE approval_id = ?').all(request.id))
      .toEqual([{ channel: 'system', decided_by: 'system', authority_decision: 'denied' }]);
  });
});

