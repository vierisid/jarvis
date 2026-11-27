/**
 * How the notch is put together, pinned before any of it moves (fix 02, step 1).
 *
 * `real.test.ts` follows single things from end to end. This file pins what
 * `real.ts` decides between the parts, with every part given at once: the
 * order of Home's rows and of the quiet links at its foot, how Today and Undo
 * are merged from several parts, the rows of Settings, which part hears a
 * page come up first, which clocks run and how often, and what stop takes
 * down, in which order.
 *
 * Which part takes which words is pinned by `intents-corpus.test.ts`, through
 * the product's own `notchSide`, and is not pinned again here.
 *
 * A row a part shows only in a state that is long to reach (a call that is
 * on, a job done by hand) is given by standing in for that part's one method
 * on the object `real.ts` hands back: `real.ts` asks that same object when
 * Home is opened, so the order it puts the answers in is the product's own.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { ApprovalManager } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import type { HumanRequest } from '../workflows/runtime/human-input-contract.ts';
import { PeerLink } from '../peers/link.ts';
import { FakeEngine, FakeServer } from '../peers/testing/fake-engines.ts';
import { attachNotchActions } from './actions.ts';
import { NOTCH_AGENT_TICK_MS, NotchAgentStore } from './agents.ts';
import { NOTCH_APPROVAL_LOOK_MS } from './approvals.ts';
import { NotchCallStore } from './call.ts';
import { MAIL_GLANCE_MS } from './mail/attach.ts';
import { NOTCH_FAILURE_LOOK_MS, type NotchNews, type NotchOpenFailure } from './news.ts';
import { NOTCH_PEOPLE_TICK_MS } from './people.ts';
import type { NotchBlock, NotchLine } from './protocol.ts';
import { NOTCH_QUESTION_LOOK_MS } from './questions.ts';
import { NOTCH_ORDER, attachNotchReal, notchIntents, type NotchReal, type NotchRealDeps, type NotchSideRouters } from './real.ts';
import { NOTCH_STANDING_TICK_MS, NotchStandingStore } from './standing.ts';
import { NOTCH_CALL_AFTER_MS } from './around.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import { NotchLearnedStore } from './teach.ts';

const NOON = new Date(2026, 10, 26, 12, 0, 0).getTime();

beforeEach(() => { initDatabase(':memory:', { quiet: true }); setSystemTime(new Date(NOON)); });
let live: NotchReal | null = null;
const realClear = globalThis.clearInterval;
afterEach(() => { live?.stop(); live = null; globalThis.clearInterval = realClear; setSystemTime(); closeDb(); });

const wait = async (): Promise<void> => {
  for (let round = 0; round < 3; round++) { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 2)); }
};

const text = (parts: unknown): string => (Array.isArray(parts) ? parts : []).map((part) => (typeof part === 'string' ? part
  : part && typeof part === 'object' && 'em' in part ? String((part as { em: unknown }).em)
    : part && typeof part === 'object' && 'word' in part ? `[${(part as { word: { value: string } }).word.value}]` : '')).join('');

type Started = { fn: () => void; ms: number; cleared: boolean; unrefed: boolean; handle: unknown };

/** Every interval started while `run` runs: how often, whether it may keep the process alive, whether it was cleared since. None runs by the clock. */
function clocks<T>(run: () => T, cleared?: (one: Started) => void): { out: T; started: Started[] } {
  const realSet = globalThis.setInterval;
  const started: Started[] = [];
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    const one: Started = { fn, ms, cleared: false, unrefed: false, handle: null };
    one.handle = { unref() { one.unrefed = true; } };
    started.push(one);
    return one.handle;
  }) as unknown as typeof setInterval;
  // Stays in place until the test is over (the afterEach above): a handle made here is only known here.
  globalThis.clearInterval = ((handle: unknown) => {
    const one = started.find((each) => each.handle === handle);
    if (one) { if (!one.cleared) cleared?.(one); one.cleared = true; } else realClear(handle as never);
  }) as typeof clearInterval;
  try {
    return { out: run(), started };
  } finally {
    globalThis.setInterval = realSet;
  }
}

interface Given {
  /** Leave these out of what the notch is given. */
  without?: (keyof NotchRealDeps | 'office.connections' | 'office.keys' | 'day.around')[];
  /** With the clocks of the parts that have a switch for them. */
  ticking?: boolean;
  /** Called when an interval is cleared, and when a part is told to stop. */
  log?: (line: string) => void;
  /** What is already so when the notch is made. */
  before?: (state: { questions: HumanRequest[]; failures: NotchOpenFailure[] }) => void;
}

/** A notch with every part given, each on a stand-in for what the product hands it. */
function everything(given: Given = {}) {
  const without = new Set<string>(given.without ?? []);
  const noClock = !given.ticking;
  let onPage: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const surface = new NotchSurface({ dispatchRPC: () => Promise.resolve({}), onEvent(listener) { onPage = listener; }, onSidecarDisconnected() {} }, () => {});
  const fromPage = (message: unknown, sidecarId = 'pc'): void => onPage(sidecarId, { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 2 });
  // The notch's own clock runs only when a test winds it (`pass`): a line stays until it is answered.
  const timers: { fn: () => void; at: number }[] = [];
  let ticks = 0;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: ticks + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
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
  let aroundSays: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const db = getDb();
  const state = {
    paused: false, pauseAsked: 0, opened: [] as (string | null)[], pages: [] as string[], flows: new Map<string, boolean>(), pausedFlows: [] as string[],
    ranFlows: [] as string[], failures: [] as NotchOpenFailure[], questions: [] as HumanRequest[], forgotten: [] as string[],
    tasks: { asked: 0, there: false, hear: null as NotchNews['taskEnded'] | null },
    listenAsked: [] as { on: boolean }[],
  };
  const emergencyListeners = new Set<(state: 'normal' | 'paused') => void>();
  const promiseListeners = new Set<unknown>();
  const executed: unknown[] = [];
  const kept: { what: string; completed_at: number | null }[] = [];
  const manager = new ApprovalManager();

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

  const all: NotchRealDeps = {
    approvalManager: {
      getPending: () => manager.getPending(), getRequest: (id) => manager.getRequest(id), createRequest: (...args) => manager.createRequest(...args),
      getHistory: () => executed as never,
    },
    approve: async () => ({ status: 'already_decided' }), deny: async () => ({ status: 'already_decided' }), withdraw: async () => ({ status: 'already_decided' }),
    // What the notch does is written down in the vault and in the product's audit trail (./actions.ts).
    actions: { db, audit: new AuditTrail() },
    openDashboard: (from) => { state.opened.push(from); },
    emergency: {
      getState: () => (state.paused ? 'paused' : 'normal'),
      pause() { state.pauseAsked++; state.paused = true; for (const hear of [...emergencyListeners]) hear('paused'); },
      resume() { state.paused = false; for (const hear of [...emergencyListeners]) hear('normal'); },
      subscribe(listener: (state: 'normal' | 'paused') => void) {
        emergencyListeners.add(listener);
        return () => { emergencyListeners.delete(listener); given.log?.('stop: the pause no longer heard'); };
      },
    } as never,
    promises: {
      executor: {
        subscribe(listener) { promiseListeners.add(listener); return () => { promiseListeners.delete(listener); given.log?.('stop: promises'); }; },
        cancelExecution: () => false, checkAndAnnounce() {}, setOriginRunner() {},
      },
      create: () => ({ id: 'p', when_due: null }),
      kept: () => kept,
    },
    questions: { pending: () => state.questions, get: (id: string) => state.questions.find((one) => one.id === id) ?? null, answer: () => ({ status: 200 }) } as never,
    openFailures: () => state.failures,
    onTaskEnded: (listener) => { state.tasks.asked++; if (state.tasks.there) state.tasks.hear = listener; return state.tasks.there; },
    asks: { db, turns: () => null, modelReady: () => true, talkPort: { onEvent() {} }, stt: () => null, look: { port: { onEvent() {} } as never } },
    where: { port: { onEvent() {}, dispatchRPC: async () => ({}) } },
    mail: { db, tab: () => null, think: async () => '', noClock } as never,
    standing: { noClock },
    agents: {
      db, noClock,
      workflows: {
        build: async () => ({ ok: false, why: 'not here' }), enable: () => ({ ok: true }), remove: async () => true,
        run: (flowId: string) => { state.ranFlows.push(flowId); return { ok: true }; },
        pause: (flowId: string, paused: boolean) => { if (paused) state.pausedFlows.push(flowId); state.flows.set(flowId, !paused); return true; },
        look: (flowId: string) => (state.flows.has(flowId) ? { job: 'the numbers', enabled: state.flows.get(flowId)! } : null),
        runs: () => [], madeSince: () => [],
      } as never,
    },
    day: { db, noClock, around: { onEvent(listener) { aroundSays = listener; }, onSidecarDisconnected() {} } },
    calls: {
      db, noClock, port: { onEvent() {}, onSidecarDisconnected() {} },
      listen: async (_sidecarId: string, ask: { on: boolean; far: boolean }) => { state.listenAsked.push({ on: ask.on }); return ask.on ? { listening: true, far: ask.far, why: '' } : { listening: false }; },
      stt: () => ({ transcribe: async () => '' }), think: async () => '',
    } as never,
    peers: { db, link, openPage: async () => true, noClock },
    notice: { noClock, see: async () => null, think: async () => '' } as never,
    jobs: {
      db, noClock,
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
    } as never,
    office: {
      memory: { list: () => [{ id: 'f1', about: 'Sam', text: 'prefers calls', source: 'chat' }], forget: (id) => { state.forgotten.push(id); return true; } },
      keys: { read: async () => ({ talk: ['ctrl', 'meta'], yes: ['meta', 'alt'], mac: false }), change: async () => ({ why: 'no' }) },
      voice: () => ({ by: 'Whisper', language: 'English' }),
      connections: () => [{ id: 'gmail', name: 'Gmail', state: 'on', how: 'Through your browser.' }],
      connect: () => {},
      openPage: (_sidecarId, page) => { state.pages.push(page); },
    },
    dayOne: {
      // A brain that is set up: day one does not begin by itself.
      fresh: () => false,
      model: { ready: () => true, name: () => 'a model', hosted: () => false, setUp() {} },
    },
    clock,
    lookMs: 3_600_000,
    log: () => {},
  };
  const deps = { ...all } as Record<string, unknown>;
  for (const name of without) {
    if (name === 'office.connections') deps.office = { ...all.office, connections: undefined };
    else if (name === 'office.keys') deps.office = { ...(deps.office as object), keys: undefined };
    else if (name === 'day.around') deps.day = { ...all.day, around: undefined };
    else delete deps[name];
  }
  given.before?.(state);
  const made = clocks(() => attachNotchReal(surface, deps as unknown as NotchRealDeps), (one) => given.log?.(`clock: ${one.ms}`));
  const real = made.out;
  live = real;
  const line = (): NotchLine | null => surface.current().line;
  const blocks = (): NotchBlock[] => { const shown = line(); return shown && 'blocks' in shown && Array.isArray(shown.blocks) ? shown.blocks as NotchBlock[] : []; };
  return {
    real, surface, state, started: made.started, db, executed, kept, link, fromPage, line, blocks,
    pass,
    around: (payload: Record<string, unknown>): void => aroundSays('pc', { event_type: 'notch.around', payload }),
    resume: (): void => { (all.emergency as unknown as { resume(): void }).resume(); },
    title: (): string => text(line()?.say),
    async open(): Promise<void> { fromPage({ type: 'open' }); await wait(); },
    async answer(more: Record<string, unknown>): Promise<void> { fromPage({ type: 'answer', id: line()!.id, ...more }); await wait(); },
    /** The buttons of the last block of buttons that is up. */
    buttons: (): string[] => blocks().filter((block) => block.kind === 'buttons').flatMap((block) => (block as { buttons: { id: string; label: string }[] }).buttons.map((button) => `${button.id}: ${button.label}`)),
  };
}

const approved = (over: Record<string, unknown>): unknown => ({
  id: 'r', agent_id: 'a', agent_name: 'PA', tool_name: 'request_approval', tool_arguments: '{}', action_category: 'send_email',
  urgency: 'normal', reason: 'Send the weekly update to the team', context: '', status: 'executed', execution_mode: 'deferred',
  decided_at: NOON - 5000, decided_by: 'notch', executed_at: NOON - 4000, execution_result: 'ok', created_at: NOON - 9000,
  execution_outcome: 'committed', ...over,
});

/** Something in every place Home reads a row from. */
function fill(w: ReturnType<typeof everything>): void {
  const minutes = (n: number): number => NOON - n * 60_000;
  // A reply that is drafted, and one that was sent.
  const mailRow = (id: string, state: string, more: Record<string, unknown> = {}): never => ({
    id, thread: `t-${id}`, messageAt: minutes(90), state, who: { name: 'Sam Reed', address: 'sam@example.com' }, subject: 'Pricing', to: [], cc: [],
    draft: 'Yes.', time: null, missing: '', lookFor: '', found: null, tone: '', told: '', about: '', slots: null, asked: '',
    model: 'm', tokensIn: 1000, tokensOut: 200, createdAt: minutes(80), updatedAt: minutes(80), sentAt: null, ...more,
  }) as never;
  w.real.mail!.store.put(mailRow('ready-1', 'ready'));
  w.real.mail!.store.put(mailRow('sent-1', 'sent', { sentAt: minutes(50), updatedAt: minutes(50) }));
  // A job that was shown.
  new NotchLearnedStore(w.db).add('shown-notepad', 'saves the file', 1);
  // An agent on duty, a watch and a chase.
  new NotchAgentStore(w.db).add({ flowId: 'flow-1', name: 'Tony', rung: 'asks first', sentence: 'Every Monday at 9:00, send Sam the numbers.', madeAt: minutes(40), rungAt: minutes(40), askedAt: 0, toldRun: '' });
  w.state.flows.set('flow-1', true);
  const standing = new NotchStandingStore(w.db);
  standing.addEye({ id: 'eye-1', createdAt: minutes(30), name: 'Sam Reed', address: 'sam@example.com' });
  standing.putChase({
    id: 'chase-1', createdAt: minutes(20), name: 'Lea Roth', address: 'lea@example.com', thing: 'answer', about: 'the contract', day: 'Friday', byAt: NOON + 86_400_000,
    thread: null, subject: 'Contract', state: 'on', nudges: 0, nextAt: NOON + 3_600_000, steps: [], updatedAt: minutes(20),
  } as never);
  // A call that was written down.
  const calls = new NotchCallStore(w.db);
  calls.open('call-1', minutes(200), false);
  calls.set('call-1', { endedAt: minutes(190), state: 'done', notes: { summary: 'Pricing was agreed.', with: 'Sam', actions: [{ what: 'Send pricing', owner: 'mine', by: 'Friday' }], followup: '', to: null, sentAt: null } as never });
  // An approved action and a kept promise.
  w.executed.push(approved({ id: '1', reason: 'Sent the weekly update', executed_at: minutes(60) }));
  w.kept.push({ what: 'Send Anna the pricing', completed_at: minutes(70) });
  // A job done where it could be seen, and a call that is on now: each stands in for the one method Home asks.
  w.real.jobs!.done = (since) => (minutes(10) >= since ? [{ id: 'job-1', at: minutes(10), text: 'Pasted 2 from notepad into excel', undoable: true }] : []);
  w.real.around!.callRow = () => ({ kind: 'row', id: 'call', lead: 'Call', say: ['You are on a call. Listen and write it down'], go: true });
}

/** A block as one word: what kind it is, and which. */
const named = (block: NotchBlock): string => {
  const one = block as { kind: string; id?: string; lead?: string; say?: unknown; buttons?: { id: string }[] };
  if (one.kind === 'buttons') return `buttons(${(one.buttons ?? []).map((button) => button.id).join(', ')})`;
  if (one.kind === 'note') return `note: ${text(one.say)}`;
  return `${one.kind}: ${one.id ?? one.lead ?? text(one.say)}`;
};

describe('Home, with every part given', () => {
  test('its rows stand in this order, with today under them and the quiet links at the foot', async () => {
    const w = everything();
    await w.link.refresh();
    fill(w);
    await w.open();
    expect(w.line()?.kind).toBe('ask');
    expect(w.blocks().map(named)).toEqual([
      'row: call',
      'row: mail',
      'row: see',
      'row: learned',
      'row: people',
      'row: agents',
      'row: chases',
      'row: eyes',
      'row: calls',
      // Today, newest first.
      'row: job:job-1',
      'row: chase:chase-1',
      'row: eye:eye-1',
      'row: agent:flow-1',
      'row: 11:10',
      'row: 11:00',
      'row: 10:50',
      'note: Quiet from [22:00] to [07:00].',
      'buttons(asked, quiet, memory, connections, settings, dashboard)',
    ]);
  });

  test('today is one list out of five places, each row with the word or the Undo that is its own', async () => {
    const w = everything();
    fill(w);
    await w.open();
    const today = w.blocks().slice(9, 16).map((block) => {
      const row = block as { lead?: string; say?: unknown; small?: string; buttons?: { id: string }[] };
      return `${row.lead} ${text(row.say)} | ${row.buttons ? row.buttons.map((button) => button.id).join(',') : row.small}`;
    });
    expect(today).toEqual([
      '11:50 Pasted 2 from notepad into excel | undo',
      "11:40 Getting Lea's answer by Friday | undo",
      "11:30 Watching for Sam's reply | undo",
      '11:20 Made Tony: Every Monday at 9:00, send Sam the numbers. | undo',
      '11:10 Replied to Sam: Pricing | sent · 1,200 tokens',
      '11:00 Sent the weekly update | approved',
      '10:50 Send Anna the pricing | promised',
    ]);
  });

  test('Undo on a watch is taken back by the part that watches, and said in a line', async () => {
    const w = everything();
    fill(w);
    await w.open();
    await w.answer({ act: 'button', button: 'undo', row: 'eye:eye-1' });
    expect(w.title()).toBe("No longer watching for Sam's reply.");
    expect(new NotchStandingStore(w.db).eyes()).toEqual([]);
  });

  test('Undo on an agent switches it off, by the part that keeps the agents', async () => {
    const w = everything();
    fill(w);
    await w.open();
    await w.answer({ act: 'button', button: 'undo', row: 'agent:flow-1' });
    expect(w.title()).toBe('Tony is switched off. It is still in Agents.');
    expect(w.state.pausedFlows).toEqual(['flow-1']);
  });

  test('Undo on a job is handed to the jobs with its id, and Home leaves', async () => {
    const w = everything();
    fill(w);
    const undone: string[] = [];
    w.real.jobs!.undo = (jobId) => { undone.push(jobId); };
    await w.open();
    await w.answer({ act: 'button', button: 'undo', row: 'job:job-1' });
    expect(undone).toEqual(['job-1']);
    expect(w.line()).toBeNull();
  });

  test('a row opens the sheet of the part it belongs to', async () => {
    const w = everything();
    await w.link.refresh();
    fill(w);
    const opens: [row: string, title: string][] = [
      ['see', 'What I see'], ['learned', 'Jobs you showed me: 1'], ['people', 'Your organisation'], ['agents', 'Your agents'],
      ['chases', 'What I am chasing'], ['eyes', 'What I keep an eye on'], ['calls', 'After the call with Sam'],
    ];
    const seen: [string, string][] = [];
    for (const [row] of opens) {
      await w.open();
      expect(w.line()?.kind).toBe('ask');
      await w.answer({ act: 'go', row });
      seen.push([row, `${w.line()?.kind}: ${w.title()}`]);
      // Closed: Home is back under it, and is closed too.
      await w.answer({ act: 'no' });
      expect(w.line()?.kind).toBe('ask');
      await w.answer({ act: 'no' });
      expect(w.line()).toBeNull();
    }
    expect(seen).toEqual(opens.map(([row, title]) => [row, `sheet: ${title}`]));
  });

  test('each quiet link opens what it names over Home, and the dashboard takes the person away', async () => {
    const w = everything();
    await w.open();
    expect(w.buttons()).toEqual(['asked: What you asked', 'quiet: Quiet for an hour', 'memory: Memory', 'connections: Connections', 'settings: Settings', 'dashboard: Dashboard']);
    for (const [button, title] of [['memory', 'What I remember'], ['connections', 'Connections'], ['settings', 'Settings']] as const) {
      await w.answer({ act: 'button', button });
      expect([button, w.line()?.kind, w.title()]).toEqual([button, 'sheet', title]);
      await w.answer({ act: 'no' });
      // Home is back when it is closed.
      expect([button, w.line()?.kind]).toEqual([button, 'ask']);
    }
    await w.answer({ act: 'button', button: 'dashboard' });
    expect(w.state.opened).toEqual(['pc']);
    expect(w.line()).toBeNull();
  });

  test('"Day one again" in Settings takes the notch: Home does not come back over it', async () => {
    const w = everything();
    await w.open();
    await w.answer({ act: 'button', button: 'settings' });
    await w.answer({ act: 'button', button: 'dayone' });
    await wait();
    expect(w.line()?.kind).not.toBe('ask');
    expect(w.real.dayOne!.step()).toBe(1);
  });

  test('a link is there only when its part is', async () => {
    const none = everything({ without: ['office', 'day', 'openDashboard'] });
    await none.open();
    expect(none.buttons()).toEqual(['asked: What you asked']);
    none.real.stop();
    // The settings need only the day's own store; the connections need to be told what is connected.
    const some = everything({ without: ['office.connections'] });
    await some.open();
    expect(some.buttons()).toEqual(['asked: What you asked', 'quiet: Quiet for an hour', 'memory: Memory', 'settings: Settings', 'dashboard: Dashboard']);
  });

  test('with nothing but the asks given, Home is the field, an empty today and one link', async () => {
    const w = everything({ without: ['office', 'day', 'openDashboard', 'where', 'mail', 'standing', 'agents', 'calls', 'peers', 'notice', 'jobs', 'dayOne', 'promises', 'emergency', 'questions'] });
    await w.open();
    expect(w.blocks().map(named)).toEqual(['note: Nothing done yet today.', 'buttons(asked)']);
  });
});

describe('Settings, with every part given', () => {
  const rows = (w: ReturnType<typeof everything>): string[] => w.blocks().map((block) => {
    const row = block as { kind: string; lead?: string; say?: unknown; buttons?: { id: string }[] };
    return row.kind === 'row' ? `${row.lead}: ${text(row.say)}${row.buttons ? ` (${row.buttons.map((button) => button.id).join(', ')})` : ''}` : named(block);
  });

  test('its rows stand in this order: the keys, sounds, voice, watching, noticing, calls, then the links', async () => {
    const w = everything();
    await w.open();
    await w.answer({ act: 'ask', text: 'settings' });
    expect(w.title()).toBe('Settings');
    expect(rows(w)).toEqual([
      'Talk: Hold [Ctrl + Win] and speak.',
      'Yes: Tap [Win + Alt].',
      'Sounds: My small sounds are [off].',
      'Voice: I make out what you say with Whisper, in English. (voice)',
      'Watching: What I see, and what I never watch.',
      'Noticing: In the window you are in I [offer one thing].',
      'Calls: On a call I [offer to listen], and hear [your side only].',
      'buttons(cando, moves, dayone)',
      'note: The keys are for this computer. Nothing spoken is kept as sound.',
    ]);
  });

  test('a word of a row that another part owns is changed by that part, and its own word by itself', async () => {
    const w = everything();
    await w.open();
    await w.answer({ act: 'ask', text: 'settings' });
    await w.answer({ act: 'word', word: 'callside', value: 'both sides' });
    await w.answer({ act: 'word', word: 'notice', value: 'offer nothing' });
    await w.answer({ act: 'word', word: 'sound', value: 'on' });
    expect(rows(w).slice(2, 7)).toEqual([
      'Sounds: My small sounds are [on].',
      'Voice: I make out what you say with Whisper, in English. (voice)',
      'Watching: What I see, and what I never watch.',
      'Noticing: In the window you are in I [offer nothing].',
      'Calls: On a call I [offer to listen], and hear [both sides].',
    ]);
    expect(w.real.prefs!.sound()).toBe(true);
  });

  test('each of its links opens what it names, and the voice goes to the page where speech is set', async () => {
    const w = everything();
    for (const [press, title] of [[{ act: 'go', row: 'see' }, 'What I see'], [{ act: 'button', button: 'cando' }, 'What I can do'], [{ act: 'button', button: 'moves' }, 'How I move']] as const) {
      await w.open();
      await w.answer({ act: 'ask', text: 'settings' });
      await w.answer(press);
      expect(w.title()).toBe(title);
      await w.answer({ act: 'no' });
      // Settings is back when it is closed.
      expect(w.title()).toBe('Settings');
      await w.answer({ act: 'no' });
    }
    await w.open();
    await w.answer({ act: 'ask', text: 'settings' });
    await w.answer({ act: 'button', button: 'voice', row: '' });
    expect(w.state.pages).toEqual(['speech']);
  });

  test('a row is there only when its part is', async () => {
    const w = everything({ without: ['where', 'notice', 'calls', 'dayOne', 'office.keys'] });
    await w.open();
    await w.answer({ act: 'ask', text: 'settings' });
    expect(rows(w)).toEqual([
      'Keys: This computer cannot tell me its keys. They are in its tray menu, under Settings.',
      'Sounds: My small sounds are [off].',
      'Voice: I make out what you say with Whisper, in English. (voice)',
      'buttons(cando, moves)',
      'note: The keys are for this computer. Nothing spoken is kept as sound.',
    ]);
  });
});

describe('a page comes up', () => {
  test('what waits is told of it first, and day one after', () => {
    const w = everything();
    const heard: string[] = [];
    const inbox = w.real.inbox as unknown as { cameUp(): void };
    const inboxCameUp = inbox.cameUp.bind(inbox);
    inbox.cameUp = () => { heard.push('inbox'); inboxCameUp(); };
    const dayOne = w.real.dayOne!;
    const dayOneCameUp = dayOne.cameUp.bind(dayOne);
    dayOne.cameUp = () => { heard.push('day one'); dayOneCameUp(); };
    w.fromPage({ type: 'hello', v: 2 }, 'laptop');
    expect(heard).toEqual(['inbox', 'day one']);
  });

  test('on a notch that was stopped, day one is not told', () => {
    const w = everything();
    const heard: string[] = [];
    const dayOne = w.real.dayOne!;
    dayOne.cameUp = () => { heard.push('day one'); };
    w.fromPage({ type: 'hello', v: 2 }, 'laptop');
    expect(heard).toEqual(['day one']);
    w.real.stop();
    w.fromPage({ type: 'hello', v: 2 }, 'laptop');
    expect(heard).toEqual(['day one']);
  });
});

describe('the words the notch acts on itself, put together', () => {
  test('the table it routes by is the one the corpus asks: every part\'s words, by band, and inside a band in the order of `notchIntents`', () => {
    const w = everything();
    const table = w.real.intents();
    // Every part that has words of its own hands them over.
    expect([...new Set(table.map((one) => one.feature))].sort()).toEqual([...NOTCH_ORDER.says].sort());
    // Each part's list as the notch has it, put together by the function the corpus asks (./intents-corpus.test.ts).
    const routers = Object.fromEntries(NOTCH_ORDER.says.map((id) => [id, { intents: () => table.filter((one) => one.feature === id) }])) as unknown as NotchSideRouters;
    expect(table.map((one) => one.id)).toEqual(notchIntents(routers).map((one) => one.id));
    // Inside a band: a word to somebody before an eye and a chase, and those before an agent.
    const commands = table.filter((one) => one.band === 'command').map((one) => one.feature);
    expect(commands.indexOf('standing')).toBeGreaterThan(commands.lastIndexOf('people'));
    expect(commands.lastIndexOf('standing')).toBeLessThan(commands.indexOf('agents'));
  });

  test('a part that is not there hands over nothing', () => {
    const w = everything({ without: ['mail', 'peers', 'calls', 'dayOne', 'emergency'] });
    expect([...new Set(w.real.intents().map((one) => one.feature))].sort()).toEqual(['agents', 'canDo', 'memory', 'moves', 'prefs', 'put', 'said', 'teach']);
  });
});

describe('the clocks of the notch', () => {
  const periods = (started: Started[]): number[] => started.map((one) => one.ms).sort((a, b) => a - b);

  test('with every part given: one for each part that looks by itself, each at its own pace, none keeping the brain alive', () => {
    const w = everything({ ticking: true });
    expect(periods(w.started)).toEqual([
      // Asking to hear the tasks end, until the task manager is there.
      500,
      // Noticing.
      2000,
      // Questions, failures.
      NOTCH_QUESTION_LOOK_MS, NOTCH_FAILURE_LOOK_MS,
      // The shown jobs, the agents, the people, the eyes and chases, the day.
      30_000, NOTCH_AGENT_TICK_MS, NOTCH_PEOPLE_TICK_MS, NOTCH_STANDING_TICK_MS, 30_000,
      // The mailbox, and the instructions that are looked over.
      MAIL_GLANCE_MS, 60_000,
      // Old calls are cleared, and what waits for a yes is looked for (as often as this test asked).
      3_600_000, 3_600_000,
    ]);
    expect(w.started.filter((one) => !one.unrefed)).toEqual([]);
  });

  test('the clocks a test may leave out are left out, and the others run all the same', () => {
    const w = everything();
    expect(periods(w.started)).toEqual([500, NOTCH_QUESTION_LOOK_MS, NOTCH_FAILURE_LOOK_MS, 60_000, 3_600_000]);
  });

  test('with nothing given, the notch looks for failures and for what waits for a yes, and no more', () => {
    const w = everything({ ticking: true, without: ['office', 'day', 'openDashboard', 'where', 'mail', 'standing', 'agents', 'calls', 'peers', 'notice', 'jobs', 'dayOne', 'promises', 'emergency', 'questions', 'asks', 'onTaskEnded', 'lookMs'] });
    expect(periods(w.started)).toEqual([NOTCH_APPROVAL_LOOK_MS, NOTCH_FAILURE_LOOK_MS].sort((a, b) => a - b));
  });

  test('a part that leans on another has no clock without it: no mail, no chases; no day, no calls and no noticing', () => {
    const noMail = everything({ ticking: true, without: ['mail'] });
    // The eyes and chases stand on the mailbox: neither has a clock.
    expect(periods(noMail.started)).toEqual([500, 2000, NOTCH_QUESTION_LOOK_MS, NOTCH_FAILURE_LOOK_MS, 30_000, 30_000, 30_000, 30_000, 60_000, 3_600_000, 3_600_000]);
    noMail.real.stop();
    const noDay = everything({ ticking: true, without: ['day'] });
    // Without the day's store there are no settings: no day, no calls, no noticing.
    expect(periods(noDay.started)).toEqual([500, NOTCH_QUESTION_LOOK_MS, NOTCH_FAILURE_LOOK_MS, 30_000, 30_000, 30_000, 30_000, 60_000, 60_000, 3_600_000]);
  });
});

describe('stop, with every part given', () => {
  /** Says so when a part the notch hands back is told to stop. */
  function watched(w: ReturnType<typeof everything>, order: string[]): void {
    const parts: Record<string, { stop(): void } | null> = {
      asks: w.real.asks, people: w.real.people, 'day one': w.real.dayOne, look: w.real.look, drop: w.real.drop, where: w.real.where, mail: w.real.mail,
      presence: w.real.presence, around: w.real.around, jobs: w.real.jobs, catcher: w.real.catcher, teach: w.real.teach, put: w.real.put, notice: w.real.notice, agents: w.real.agents,
      inbox: w.real.inbox,
    };
    for (const [name, part] of Object.entries(parts)) {
      expect([name, part === null]).toEqual([name, false]);
      const stop = part!.stop.bind(part);
      part!.stop = () => { order.push(`stop: ${name}`); stop(); };
    }
  }

  test('the clocks first, then what is on the notch, then each part, in this order', () => {
    const order: string[] = [];
    const w = everything({ ticking: true, log: (line) => order.push(line) });
    watched(w, order);
    w.real.stop();
    const clocksCleared = order.filter((line) => line.startsWith('clock: '));
    // Every clock real.ts started itself is cleared before anything else is stopped. The three that parts keep
    // for themselves (the instructions, the people, the mailbox) go with their part.
    expect(order.slice(0, 10).every((line) => line.startsWith('clock: '))).toBe(true);
    expect(clocksCleared).toHaveLength(13);
    expect(w.started.filter((one) => !one.cleared)).toEqual([]);
    const parts = order.filter((line) => !line.startsWith('clock: '));
    // What is on the notch ends before any part is stopped.
    expect(parts[0]).toBe('stop: inbox');
    // The promises and the pause only stop hearing: which of the two goes first is not pinned.
    expect(parts.slice(1, 3).sort()).toEqual(['stop: promises', 'stop: the pause no longer heard']);
    // The features from the last made to the first (fix 02, step 4: asking, the look, the drop, the jobs and
    // the agents are features now), then the parts that are not features yet, in the order they always had.
    expect(parts.slice(3)).toEqual([
      'stop: drop',
      'stop: look',
      'stop: asks',
      'stop: agents',
      'stop: put',
      'stop: teach',
      'stop: catcher',
      'stop: jobs',
      'stop: people',
      'stop: day one',
      'stop: where',
      'stop: mail',
      'stop: presence',
      'stop: around',
      'stop: notice',
    ]);
  });

  /** A chase whose next step is due now. */
  const dueChase = (w: ReturnType<typeof everything>): { looked: number; sent: number } => {
    new NotchStandingStore(w.db).putChase({
      id: 'chase-due', createdAt: NOON - 86_400_000, name: 'Lea Roth', address: 'lea@example.com', thing: 'answer', about: 'the contract', day: 'Friday', byAt: NOON + 86_400_000,
      thread: null, subject: 'Contract', state: 'on', nudges: 1, nextAt: NOON - 1000, steps: [], updatedAt: NOON - 86_400_000,
    } as never);
    // The mailbox the chases write through: the object the mail layer hands them.
    const seen = { looked: 0, sent: 0 };
    const mailbox = w.real.mail!.standing;
    mailbox.look = async () => { seen.looked++; };
    mailbox.send = async () => { seen.sent++; return { ok: true }; };
    mailbox.went = async () => false;
    return seen;
  };
  /** The clocks of half a minute, the chases' among them, run once, whether or not they were cleared. */
  const halfMinute = async (w: ReturnType<typeof everything>): Promise<void> => { for (const one of w.started.filter((each) => each.ms === NOTCH_STANDING_TICK_MS)) one.fn(); await wait(); };

  test('a chase that is due is taken up at its clock: the mailbox is looked at and its follow-up goes', async () => {
    const w = everything({ ticking: true });
    const seen = dueChase(w);
    await halfMinute(w);
    expect(seen).toEqual({ looked: 1, sent: 1 });
    expect(new NotchStandingStore(w.db).chase('chase-due')).toMatchObject({ state: 'on', nudges: 2 });
  });

  test('on a notch that was stopped a chase that is due is not taken up, even if its clock were to run: nothing is looked at, nothing is sent', async () => {
    const w = everything({ ticking: true });
    const seen = dueChase(w);
    w.real.stop();
    await halfMinute(w);
    expect(seen).toEqual({ looked: 0, sent: 0 });
    expect(new NotchStandingStore(w.db).chase('chase-due')).toMatchObject({ state: 'on', nudges: 1 });
    expect(w.line()).toBeNull();
  });

  test('a call that is listened to is let go: the desktop app is told to stop hearing', async () => {
    const w = everything();
    w.around({ call: true });
    await w.pass(NOTCH_CALL_AFTER_MS);
    expect(w.title()).toBe('On a call. Listen and write it down?');
    await w.answer({ act: 'yes' });
    expect(w.state.listenAsked).toEqual([{ on: true }]);
    w.real.stop();
    await wait();
    expect(w.state.listenAsked).toEqual([{ on: true }, { on: false }]);
  });

  test('after it Esc twice pauses nothing, a promise is not heard, and nothing is taken', async () => {
    const w = everything();
    w.fromPage({ type: 'stop' });
    expect(w.state.pauseAsked).toBe(1);
    w.state.paused = false;
    w.real.stop();
    w.fromPage({ type: 'stop' });
    expect(w.state.pauseAsked).toBe(1);
    expect(w.real.showing()).toBe(false);
    await w.open();
    expect(w.line()).toBeNull();
    expect(w.real.inbox.present('late', async (stage) => { await stage.say(['Late.'], 1000); })).toBe(false);
  });
});

const question = (id: string, title: string): HumanRequest => ({
  id, kind: 'approval', title, prompt: '', fields: [], requestKey: 'k', workflowName: 'Monthly invoices',
  flowId: 'f', runId: 'r', created: NOON, deadline: NOON + 3_600_000, status: 'pending', answers: null, generation: 0,
});

describe('what looks by itself, put together', () => {
  /** Every clock of that pace runs once. */
  const tick = async (w: ReturnType<typeof everything>, ms: number): Promise<void> => { for (const one of w.started.filter((each) => each.ms === ms && !each.cleared)) one.fn(); await wait(); };

  test('a question that waits when the notch is made is on it at once, and a later one at the next look', async () => {
    const w = everything({ before: (state) => { state.questions.push(question('q1', 'Send the 30 invoices')); } });
    await wait();
    expect(w.title()).toBe('Send the 30 invoices?');
    await w.answer({ act: 'no' });
    await wait();
    w.state.questions.splice(0, 1, question('q2', 'Pay the 4 suppliers'));
    expect(w.title()).not.toBe('Pay the 4 suppliers?');
    await tick(w, NOTCH_QUESTION_LOOK_MS);
    expect(w.title()).toBe('Pay the 4 suppliers?');
  });

  test('a failure that was open when the notch was made is not news; one of an agent, later, is said as the agent\'s own with its two ways on', async () => {
    const w = everything({ before: (state) => { state.failures.push({ key: 'old', headline: 'An old failure.' } as NotchOpenFailure); } });
    fill(w);
    await wait();
    expect(w.line()).toBeNull();
    w.state.failures.push({ key: 'k1', headline: 'Gmail needs you to sign in again.', flowId: 'flow-1', steps: ['connect', 'run_again'] } as NotchOpenFailure);
    await tick(w, NOTCH_FAILURE_LOOK_MS);
    // The agent is named by the part that keeps the agents.
    expect([w.line()?.kind, w.title()]).toEqual(['offer', 'Tony stopped. Gmail needs you to sign in again.']);
    await w.answer({ act: 'yes' });
    // The way to a sign-in is the notch's own Connections.
    expect([w.line()?.kind, w.title()]).toEqual(['sheet', 'Connections']);
    await w.answer({ act: 'no' });
    expect(w.title()).toBe('Run Tony again now?');
    await w.answer({ act: 'yes' });
    expect(w.state.ranFlows).toEqual(['flow-1']);
    expect(w.title()).toBe('Tony is running again.');
  });

  test('with everything stopped, an agent that had stopped is not run again', async () => {
    const w = everything({ without: ['office', 'day'] });
    fill0(w);
    w.state.failures.push({ key: 'k1', headline: 'It broke.', flowId: 'flow-1', steps: ['run_again'] } as NotchOpenFailure);
    await tick(w, NOTCH_FAILURE_LOOK_MS);
    expect(w.title()).toBe('Tony stopped. It broke.');
    w.state.paused = true;
    await w.answer({ act: 'yes' });
    expect(w.state.ranFlows).toEqual([]);
    expect(w.title()).toBe('Everything is stopped. Wake me first.');
  });

  test('without a pause to ask, an agent that had stopped is run again', async () => {
    const w = everything({ without: ['office', 'day', 'emergency'] });
    fill0(w);
    w.state.failures.push({ key: 'k1', headline: 'It broke.', flowId: 'flow-1', steps: ['run_again'] } as NotchOpenFailure);
    await tick(w, NOTCH_FAILURE_LOOK_MS);
    await w.answer({ act: 'yes' });
    expect(w.state.ranFlows).toEqual(['flow-1']);
  });

  test('the end of a task is asked for until the task manager is there, and no more after', async () => {
    const w = everything();
    const asking = w.started.find((one) => one.ms === 500)!;
    asking.fn();
    asking.fn();
    expect([w.state.tasks.asked, asking.cleared]).toEqual([2, false]);
    w.state.tasks.there = true;
    asking.fn();
    expect([w.state.tasks.asked, asking.cleared]).toEqual([3, true]);
    // What it was given is the news: a task that ends is said.
    w.state.tasks.hear!('complete', { id: 't1', agentName: 'Mara', task: 'the report' });
    await wait();
    expect(w.title()).toBe('Mara finished: the report');
  });

  test('a task manager that never comes is given up after two minutes of asking', () => {
    const w = everything();
    const asking = w.started.find((one) => one.ms === 500)!;
    for (let n = 0; n < 120; n++) asking.fn();
    expect([w.state.tasks.asked, asking.cleared]).toEqual([120, false]);
    asking.fn();
    expect([w.state.tasks.asked, asking.cleared]).toEqual([121, true]);
  });
});

/** An agent on duty, and nothing else. */
function fill0(w: ReturnType<typeof everything>): void {
  new NotchAgentStore(w.db).add({ flowId: 'flow-1', name: 'Tony', rung: 'asks first', sentence: 'Every Monday at 9:00, send Sam the numbers.', madeAt: NOON - 60_000, rungAt: NOON - 60_000, askedAt: 0, toldRun: '' });
  w.state.flows.set('flow-1', true);
}

describe('the back office, put together', () => {
  test('Memory lists how a person is always written to beside what else is known, and each is forgotten where it is kept', async () => {
    const w = everything();
    w.real.mail!.store.setTone({ name: 'Marco Bianchi', address: 'marco@example.com' }, 'shorter', NOON);
    await w.open();
    await w.answer({ act: 'button', button: 'memory' });
    const rows = (): string[] => w.blocks().filter((block) => block.kind === 'row').map((block) => { const row = block as { id?: string; lead?: string; say?: unknown; small?: string }; return `${row.id} | ${row.lead}: ${text(row.say)} | ${row.small ?? ''}`; });
    expect(rows()).toEqual(['tone:marco@example.com | Marco Bianchi: gets short replies | you said so on the notch', 'f1 | Sam: prefers calls | chat']);
    for (const row of ['tone:marco@example.com', 'f1']) {
      await w.answer({ act: 'button', button: 'forget', row });
      await w.answer({ act: 'button', button: 'sure', row });
    }
    expect(w.real.mail!.store.tones()).toEqual([]);
    expect(w.state.forgotten).toEqual(['f1']);
    expect(w.real.memory!.count()).toBe(1);
  });

  test('without the mail layer Memory is the product\'s memory alone, and a manner of writing cannot be forgotten there', async () => {
    const w = everything({ without: ['mail'] });
    expect(w.real.memory!.count()).toBe(1);
    await w.open();
    await w.answer({ act: 'ask', text: 'what do you remember' });
    expect(w.title()).toBe('What I remember');
  });

  test('a press that names a link Home did not show: the connections open all the same, and a part that is not there opens nothing', async () => {
    const w = everything({ without: ['office.connections'] });
    await w.open();
    expect(w.buttons()).not.toContain('connections: Connections');
    await w.answer({ act: 'button', button: 'connections' });
    expect([w.line()?.kind, w.title()]).toEqual(['sheet', 'Connections']);
    await w.answer({ act: 'no' });
    expect(w.line()?.kind).toBe('ask');
    w.real.stop();
    const none = everything({ without: ['office', 'day', 'openDashboard'] });
    await none.open();
    for (const button of ['memory', 'connections', 'settings', 'dashboard', 'nothing']) {
      await none.answer({ act: 'button', button });
      expect([button, none.line()?.kind]).toEqual([button, 'ask']);
    }
  });

  test('a suggestion goes to the count, and says nothing by itself', async () => {
    const w = everything();
    expect(w.real.suggestions.toast('JARVIS: Stand up', 'You have been sitting for two hours.')).toBe(true);
    expect(await w.real.suggestions.toastWithReceipt('JARVIS: Drink', 'Water.')).toBe('shown');
    await wait();
    expect(w.line()).toBeNull();
    expect(w.surface.current().count).toBe(2);
  });
});

describe('Esc twice, put together', () => {
  test('the face at rest is the one the part that knows where the person is gives, and that part is told of sleep and of waking', async () => {
    const w = everything();
    let refreshed = 0;
    let faces = 0;
    const where = w.real.where!;
    const refresh = where.refresh.bind(where);
    const face = where.face.bind(where);
    where.refresh = () => { refreshed++; refresh(); };
    where.face = () => { faces++; return face(); };
    w.fromPage({ type: 'stop' });
    await wait();
    expect(w.state.pauseAsked).toBe(1);
    expect(refreshed).toBe(1);
    expect(w.title()).toBe('Everything is stopped. Nothing runs until you wake me.');
    const asked = faces;
    // Woken from anywhere: the notch has the face that part gives it, and the part is told again.
    w.resume();
    await wait();
    expect(faces).toBeGreaterThan(asked);
    expect(refreshed).toBe(2);
  });
});

// Fix 05, the owner's decision of 26 November 2026: one list of what the notch did, which also writes the
// audit. `real.ts` makes it and hands it to the parts, and Today reads what only the list has.
describe('the list of what the notch did, with every part given', () => {
  const tables = (w: ReturnType<typeof everything>): string[] => (w.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
  const todayRows = (w: ReturnType<typeof everything>): string[] => w.blocks().filter((block) => block.kind === 'row' && typeof (block as { lead?: string }).lead === 'string' && /^\d\d:\d\d$/.test((block as { lead: string }).lead))
    .map((block) => { const row = block as { lead?: string; say?: unknown; small?: string; buttons?: { id: string }[] }; return `${row.lead} ${text(row.say)} | ${row.buttons ? row.buttons.map((button) => button.id).join(',') : row.small}`; });
  const SEVEN: [string, string, string, string, string, string, string] = [
    '11:50 Pasted 2 from notepad into excel | undo',
    "11:40 Getting Lea's answer by Friday | undo",
    "11:30 Watching for Sam's reply | undo",
    '11:20 Made Tony: Every Monday at 9:00, send Sam the numbers. | undo',
    '11:10 Replied to Sam: Pricing | sent · 1,200 tokens',
    '11:00 Sent the weekly update | approved',
    '10:50 Send Anna the pricing | promised',
  ];

  test('its table is made with the notch, and not when the brain was not given where to keep it', () => {
    expect(tables(everything())).toContain('notch_actions');
    live?.stop();
    closeDb();
    initDatabase(':memory:', { quiet: true });
    const without = everything({ without: ['actions'] });
    expect(tables(without)).not.toContain('notch_actions');
  });

  test('without it, today is the seven rows it was', async () => {
    const w = everything({ without: ['actions'] });
    fill(w);
    await w.open();
    expect(todayRows(w)).toEqual(SEVEN);
  });

  test('what the parts list themselves is not listed twice, and what only the list has stands among the rest in its place', async () => {
    const w = everything();
    fill(w);
    // As the parts write them: the same things the seven rows are about, each with its entry in the list.
    let at = NOON;
    const list = attachNotchActions(w.db, { now: () => at, log: () => {} });
    const asked = { seen: 'line' as const, how: 'key' as const };
    const minutes = (n: number): number => NOON - n * 60_000;
    const write = (ago: number, entry: Parameters<typeof list.record>[0]): void => { at = minutes(ago); list.record(entry); };
    write(10, { kind: 'job_rounds', what: 'Pasted 2 from notepad into excel', asked, outcome: 'done', ref: 'job:job-1' });
    write(20, { kind: 'chase_mail', what: "First mail to Lea for Lea's answer", asked, outcome: 'done', ref: 'chase:chase-1:0' });
    write(40, { kind: 'agent_made', what: 'Made Tony: Every Monday at 9:00, send Sam the numbers.', asked, outcome: 'done', ref: 'agent:flow-1' });
    write(50, { kind: 'mail_reply', what: 'Reply to Sam: Pricing', asked, outcome: 'done', ref: 'mail:sent-1' });
    write(60, { kind: 'approval', what: 'Sent the weekly update', asked, outcome: 'done', ref: 'approval:1', approvalId: '1' });
    write(70, { kind: 'promise', what: 'Promised: Send Anna the pricing', asked: { seen: 'nothing', how: 'system' }, outcome: 'done', ref: 'promise:p' });
    await w.open();
    expect(todayRows(w)).toEqual(SEVEN);
    await w.answer({ act: 'no' });
    // And what none of them lists: a follow-up that went by itself, a word to somebody, a reply that may have gone.
    write(15, { kind: 'chase_followup', what: "Follow-up to Lea for Lea's answer", asked: { seen: 'sheet', how: 'system' }, outcome: 'done', ref: 'chase:chase-1:1' });
    write(35, { kind: 'people_tell', what: 'Message to Leo', asked: { seen: 'line', how: 'said', fuseMs: 3000 }, outcome: 'done' });
    write(55, { kind: 'mail_reply', what: 'Reply to Anna: Invoice', asked, outcome: 'unsure', ref: 'mail:other' });
    write(65, { kind: 'people_tell', what: 'Message to Anna', asked: { seen: 'line', how: 'said', fuseMs: 3000 }, outcome: 'not_done' });
    await w.open();
    expect(todayRows(w)).toEqual([
      SEVEN[0],
      "11:45 Follow-up to Lea for Lea's answer | sent",
      SEVEN[1], SEVEN[2],
      '11:25 Message to Leo | sent',
      SEVEN[3], SEVEN[4],
      '11:05 Reply to Anna: Invoice | may have gone',
      SEVEN[5], SEVEN[6],
    ]);
  });

  test('Undo on an agent in today changes the entry of its making, and the audit gets it as the same entry', async () => {
    const w = everything();
    fill(w);
    const list = attachNotchActions(w.db, { now: () => NOON - 40 * 60_000, audit: new AuditTrail(), log: () => {} });
    list.record({ kind: 'agent_made', what: 'Made Tony: Every Monday at 9:00, send Sam the numbers.', asked: { seen: 'line', how: 'key' }, outcome: 'done', ref: 'agent:flow-1' });
    await w.open();
    await w.answer({ act: 'button', button: 'undo', row: 'agent:flow-1' });
    expect(w.title()).toBe('Tony is switched off. It is still in Agents.');
    expect(list.since(0)).toMatchObject([{ kind: 'agent_made', outcome: 'undone', ref: 'agent:flow-1' }]);
    const trail = new AuditTrail();
    expect(trail.queryEntries({ tool: 'notch_agent_made' })).toMatchObject([{ events: 2, outcome: 'undone', channel: 'notch', decided_by: 'notch' }]);
    expect(trail.query({ tool: 'notch_agent_made_undo' })).toHaveLength(1);
  });

  test('a word to somebody, said on this notch, is in the list and in the audit trail when it has gone', async () => {
    const w = everything();
    await w.link.refresh();
    await wait();
    const route = w.real.people!.route('tell Leo the review moved to Friday');
    expect(route).not.toBeNull();
    route!.run();
    await wait();
    expect(w.line()).toMatchObject({ kind: 'send' });
    const list = attachNotchActions(w.db, { log: () => {} });
    expect(list.since(0)).toEqual([]);
    await w.answer({ act: 'done' });
    await wait();
    expect(list.since(0)).toMatchObject([{ kind: 'people_tell', outcome: 'done', what: 'Message to Leo', seen: 'line', how: 'said' }]);
    expect(new AuditTrail().queryEntries({ agentId: 'notch' })).toMatchObject([
      { tool_name: 'notch_people_tell', action_category: 'send_message', authority_decision: 'allowed', channel: 'notch', decided_by: 'notch', outcome: 'succeeded', executed: 1 },
    ]);
    // And it is a row of today.
    await w.answer({ act: 'done' });
    await w.open();
    expect(todayRows(w)).toEqual(['12:00 Message to Leo | sent']);
  });
});
