/**
 * What a sentence means today, pinned.
 *
 * Every row of ./intents-corpus.txt is one sentence under one stated state
 * of the notch, and what is done with it now: which part's intent takes it
 * (./intents.ts), or what comes after the table when none does (the
 * reading of words that name somebody, the memory, the pointing, the
 * assistant's turn). A row marked `## wrong:` is pinned as it behaves today
 * and says beside it what is meant to happen: the fix that changes it flips
 * that row, and no other.
 *
 * Nothing here is a stand-in for the deciding itself. The routers are the
 * product's own, made with `attachNotch...`, and which of them takes a
 * sentence is decided by the product's own resolver: `notchSide` of
 * ./real.ts, the one function the notch itself calls. It asks the table of
 * intents (./intents.ts) that the parts hand their words to, and says which
 * intent took the sentence; this corpus names the part that intent is of,
 * and never has a copy of the order. The sentence is typed into Home or said with the talk
 * keys and goes through the real ./asks.ts, and "where is" goes through the
 * real ./point.ts. Only the ends are stand-ins: no model, no network, no
 * desktop app. What a router would do (`run`) is not done, with one
 * exception: a taught job that is done again is let run against stand-in
 * hands, so that the row can say whether it acted at once or showed a line
 * first.
 *
 * To see what every row gives now, in the form of the file (it is printed,
 * and every row is still checked):
 *   NOTCH_CORPUS_PRINT=1 bun test src/notch/intents-corpus.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BriefChatEvent, BriefChatPayload, BriefTurnRef, BriefTurnState } from '../brief/contracts.ts';
import type { RawInteraction } from '../skills/recorder.ts';
import { PeerLink } from '../peers/link.ts';
import { PeerStore } from '../peers/store.ts';
import { FakeEngine, FakeServer } from '../peers/testing/fake-engines.ts';
import { READ as PAGE_READ, readLive } from '../../ui/src/notch/surface/readers.ts';
import { agentSentence, attachNotchAgents } from './agents.ts';
import { attachNotchAsks, type NotchAskHow, type NotchSided, type NotchTurnDoor } from './asks.ts';
import { attachNotchCalls } from './call.ts';
import { attachNotchCanDo } from './cando.ts';
import { notchMoveAt } from './day.ts';
import { NOTCH_DAY_ONE_AFTER_MS, NOTCH_DAY_ONE_ORDER, attachNotchDayOne } from './dayone.ts';
import { NotchInbox } from './inbox.ts';
import { attachNotchJobs, type NotchJobHands, type PlacedStep } from './jobs.ts';
import { NotchLedger } from './ledger.ts';
import type { NotchLooked } from './look.ts';
import { attachNotchMail } from './mail/notch.ts';
import { MailStore, mailProposalId } from './mail/store.ts';
import { mailPerson } from './mail/thread.ts';
import { attachNotchMemory } from './memory.ts';
import { attachNotchMoves } from './moves.ts';
import { attachNotchPeople } from './people.ts';
import { createNotchPoint, whereKind, whereQuestion } from './point.ts';
import { notchPauseWords } from './pause.ts';
import { attachNotchPrefs } from './prefs.ts';
import type { NotchLine, NotchWord } from './protocol.ts';
import { attachNotchPut } from './put.ts';
import { NOTCH_INTENT_ACTS_GUARDED, NOTCH_INTENT_BANDS, matchingIntents, type NotchIntent } from './intents.ts';
import { notchIntents, notchRead, notchSide, type NotchSideRouters } from './real.ts';
import { attachNotchSaid, saidWhen, saidWords } from './said.ts';
import { NotchSettings } from './settings.ts';
import { attachNotchStanding } from './standing.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';
import { NotchLearnedStore, attachNotchTeach, parseSchedule } from './teach.ts';

const HERE = import.meta.dir;
const CORPUS = join(HERE, 'intents-corpus.txt');
const PRINT = process.env.NOTCH_CORPUS_PRINT === '1';

/** The routers `notchSide` of ./real.ts chooses among. Their order is that function's own, and is not written here. */
type Router = keyof NotchSideRouters;
/** What the ledger says when a taught job is done again (./teach.ts): the one thing here that is let run. */
const JOB_AGAIN = 'Did the job again.';

/**
 * The states a row can be under. With none of them: nothing was ever taught,
 * nothing is held, no draft and no line is up, the organisation is Leo, Anna
 * and Sam, a window that lists what is in it (a spreadsheet) is in front,
 * and the sentence is typed into Home.
 */
const CONTEXTS = {
  job: 'a job was taught once, some time ago (nothing of it is fresh, and its window is not in front)',
  front: 'with job: the window the job was shown in is the one in front now',
  fresh: 'a job was shown a moment ago, the same thing done twice: where to go on from is fresh',
  shown: 'a job was shown a moment ago, once (no "job" with it: this is the only one)',
  choice: 'a line of choices is up: "Stopped at row 4. What now?" with Undo it, Watch me, Tell Anna, Continue, Pause',
  held: 'a thing that was circled is held',
  draft: 'a draft of a mail reply is open on the notch',
  line: 'an offer is up on the notch ("Every day at 9:00, send me the news." with the key "make agent")',
  dayone: 'day one is on its talking step, waiting to hear the person',
  reply: 'the assistant has just asked "Shall I send it?" and the sentence is the reply typed into that line (with spoken: said while it is up)',
  spoken: 'said with the talk keys held, not typed',
  browser: 'a browser is in front: a window that says too little about itself, so it can only be looked at',
  alone: 'no organisation: there is nobody whose Jarvis this one talks to',
} as const;
type Context = keyof typeof CONTEXTS;

const quiet = (): void => {};

/** The window a job was shown in (a text editor), and the one that is in front when it is not that one. */
const JOB_WINDOW = { id: '0x1a', pid: 100, w: 900, h: 700 };
const OTHER_WINDOW = { id: '0x7c', pid: 4242, w: 1600, h: 900 };
/** One row copied from the editor into a sheet, as the recorder tells it: shown twice, it is a round. */
const rowShown = (n: number, at: number): RawInteraction[] => {
  const ref = (name: string) => ({ role: 'Button', name, path: [], ordinal: 0, sig: name });
  return [
    { action: 'click', ref: ref(`line ${n}`), ts: at, app: 'notepad', win: JOB_WINDOW, pt: { x: 120, y: 200 + 22 * n } },
    { action: 'press_keys', value: 'ctrl,c', ts: at + 1, app: 'notepad', win: JOB_WINDOW },
    { action: 'click', ref: ref(`cell ${n}`), ts: at + 2, app: 'excel', win: OTHER_WINDOW, pt: { x: 300, y: 400 + 20 * n } },
    { action: 'press_keys', value: 'ctrl,v', ts: at + 3, app: 'excel', win: OTHER_WINDOW },
  ] as RawInteraction[];
};
const settle = async (): Promise<void> => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

/** A window that lists what is in it, as the desktop app reads it. */
const SHEET_WINDOW = {
  window_title: 'Payouts - Excel', app: 'excel', pid: 4242,
  elements: [
    { id: 1, name: 'Payouts - Excel', control_type: 'Window', rect: { x: 100, y: 50, w: 1600, h: 900 } },
    { id: 2, name: 'File', control_type: 'MenuItem', rect: { x: 110, y: 90, w: 40, h: 24 } },
    { id: 3, name: 'Close', control_type: 'Button', rect: { x: 1652, y: 52, w: 46, h: 30 } },
    { id: 4, name: 'Save as', control_type: 'Button', rect: { x: 800, y: 900, w: 90, h: 30 } },
    // Its cells: enough of the window is named for it to be answered from its own list.
    ...Array.from({ length: 96 }, (_, at) => ({
      id: 10 + at, name: `${'ABCDEFGHIJKL'[at % 12]}${Math.floor(at / 12) + 1}`, control_type: 'DataItem',
      rect: { x: 110 + (at % 12) * 130, y: 140 + Math.floor(at / 12) * 95, w: 128, h: 93 },
    })),
  ],
};
/** A browser: the window and nothing of the page in it. */
const BROWSER_WINDOW = {
  window_title: 'Inbox - Mail - Browser', app: 'chrome', pid: 5151,
  elements: [{ id: 1, name: 'Inbox - Mail - Browser', control_type: 'Window', rect: { x: 0, y: 0, w: 1600, h: 900 } }],
};

/** A turn store that keeps what was submitted and ends a turn when told. */
function fakeDoor() {
  const listeners = new Set<(event: BriefChatEvent) => void>();
  const turns = new Map<string, { ref: BriefTurnRef; text: string; state: BriefTurnState; reply: string }>();
  let sequence = 0;
  const emit = (turnId: string, payload: BriefChatPayload): void => {
    const turn = turns.get(turnId)!;
    if (payload.kind === 'delta') turn.reply += payload.text;
    if (payload.kind === 'terminal') turn.state = payload.state;
    for (const listener of [...listeners]) listener({ ...turn.ref, eventId: `e${++sequence}`, sequence, payload });
  };
  const door: NotchTurnDoor = {
    ready: () => true,
    conversation: () => 'conv-notch',
    submit(turn) { turns.set(turn.turnId, { ref: { conversationId: turn.conversationId, turnId: turn.turnId, requestId: turn.requestId }, text: turn.text, state: 'running', reply: '' }); },
    cancel(ref) { if (turns.get(ref.turnId)?.state === 'running') emit(ref.turnId, { kind: 'terminal', state: 'cancelled' }); },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    look(ref) { const turn = turns.get(ref.turnId); return turn ? { state: turn.state, text: turn.reply } : null; },
    mark() {},
  };
  return {
    door,
    texts: (): string[] => [...turns.values()].map((turn) => turn.text),
    /** The running turn answers with these words and ends. */
    answer(words: string): void {
      const running = [...turns.values()].find((turn) => turn.state === 'running')!;
      emit(running.ref.turnId, { kind: 'delta', messageId: 'm', text: words });
      emit(running.ref.turnId, { kind: 'terminal', state: 'completed' });
    },
  };
}

/** The notch's own routers and its asking, put together as ./real.ts puts them, in the state the contexts name. */
async function world(contexts: ReadonlySet<Context>) {
  const db = new Database(':memory:');
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC: () => Promise.resolve({ pushed: true }),
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  // The lines on the notch run on a clock that is wound by hand: nothing here waits for real time.
  const timers: { fn: () => void; at: number }[] = [];
  let wound = 0;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: wound + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const advance = async (ms: number): Promise<void> => {
    wound += ms;
    for (const timer of [...timers].filter((one) => one.at <= wound)) {
      const at = timers.indexOf(timer);
      if (at >= 0) { timers.splice(at, 1); timer.fn(); }
    }
    await settle();
  };
  const surface = new NotchSurface(port, quiet);
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  const line = (): NotchLine | null => surface.current().line;
  let asks!: ReturnType<typeof attachNotchAsks>;
  const inbox = new NotchInbox(surface, { clock, log: quiet, home: (stage) => asks.home(stage) });
  const settings = new NotchSettings(db);

  // --- the parts that have words of their own, each the product's own ---
  if (contexts.has('dayone')) settings.set('dayone', { step: NOTCH_DAY_ONE_ORDER.indexOf('talk') + 1, done: false });
  const dayOne = attachNotchDayOne({
    inbox, settings, clock, log: quiet,
    fresh: () => false,
    model: { ready: () => true, name: () => 'a model', hosted: () => false, setUp: quiet },
    isWhere: whereQuestion,
    around: () => [],
  });

  const leo = mailPerson('Leo Bianchi', 'leo@lumen.example');
  const mailStore = new MailStore(db);
  const mail = attachNotchMail(inbox, {
    store: mailStore,
    watch: {
      hold: quiet, release: quiet, redraft: async () => null, stillWaits: async () => true,
      look: async () => ({ through: 'browser', listed: 1, read: 0, asked: 0, prepared: 0, overtaken: 0 }),
      lastLook: () => null, busy: () => false,
    },
    mailbox: () => null,
    zone: 'UTC',
    log: quiet,
  });

  /** What was seen of the deciding: who the resolver said took the words, each time it was asked, and what was reached after it. */
  const seen = {
    sides: [] as { text: string; router: Router | null; did: string }[],
    /** Every intent that matched, each time the resolver was asked: the first is the one that took the words. */
    matched: [] as { text: string; ids: string[] }[],
    /** How often the model that reads words about people was really asked. */
    asked: 0,
    remembered: [] as string[],
    point: [] as string[],
    /** A taught job was let run, and how often the hands were then asked to do a step of it. */
    ran: 0, hands: 0, copies: 0,
  };
  // The hands. Asking where a window is, or how far apart the rows are, touches nothing and is not counted:
  // only what moves the pointer, clicks, types or pastes is "the hands were set to work".
  const hands: NotchJobHands = {
    act: async (request) => {
      if (request.do === 'front') return contexts.has('front') ? { done: true, win: JOB_WINDOW, app: 'Notepad' } : { done: true, win: OTHER_WINDOW, app: 'excel' };
      if (request.do === 'find') return { done: true, win: request.win as typeof JOB_WINDOW };
      if (request.do === 'pitch') return { done: true, known: true, dy: request.dy as number } as never;
      seen.hands++;
      // Two more rows to copy, and then there is nothing left: a job that goes on "until nothing is left" ends.
      if (request.do === 'copy') return ++seen.copies > 2 ? { done: true, empty: true } : { done: true, empty: false, rows: 1, cols: 2, hash: `h${seen.copies}` };
      return { done: true };
    },
  };
  /** What the recorder hands over when a showing ends: nothing, but for the state "fresh". */
  let recorded: RawInteraction[] = [];
  // The product's pause, as the tray and Esc twice drive it.
  const emergency = { state: 'normal' as 'normal' | 'paused', getState: () => emergency.state, pause: () => { emergency.state = 'paused'; } };
  const jobs = attachNotchJobs(inbox, { db, hands, sleep: async () => {}, log: quiet });
  const put = attachNotchPut({ inbox, jobs, hands, hold: quiet, log: quiet });
  const teach = attachNotchTeach({
    inbox, jobs, hands, db, log: quiet,
    recorder: { start: async () => ({ ok: true }), stop: async () => recorded.splice(0), onStep: () => quiet },
    save: (interactions) => ({ ok: true, skill: 'shown-notepad', steps: interactions.length, notes: [], apps: ['Notepad', 'Excel'] }),
    forget: quiet,
    effect: () => ({ pays: false, deletes: false, missing: false }),
    runSkill: async () => { seen.hands++; return { end: { how: 'done' }, next: 1 } as never; },
    catcher: () => null,
  });

  const standing = attachNotchStanding({ inbox, db, mail: { onRead: quiet } as never, eye: quiet, log: quiet });
  const agents = attachNotchAgents({ inbox, db, workflows: {} as never, log: quiet });
  const memory = attachNotchMemory({ inbox, list: () => [], forget: () => false, log: quiet });
  const calls = attachNotchCalls({ onEvent() {}, onSidecarDisconnected() {} } as never, {
    inbox, db, settings, listen: async () => null, stt: () => null, think: async () => '', log: quiet,
  });
  const prefs = attachNotchPrefs({ inbox, settings, setSound: quiet, log: quiet });
  const moves = attachNotchMoves({ inbox, resting: () => surface.resting(), log: quiet });
  const canDo = attachNotchCanDo({ inbox });
  const saidLine = attachNotchSaid({ inbox, line, skip: (item) => item.startsWith('ask:'), log: quiet });

  // The organisation: this one is Vera's, and it talks to Leo's, Anna's and Sam's.
  let people: ReturnType<typeof attachNotchPeople> | null = null;
  const stops: (() => void)[] = [];
  if (!contexts.has('alone')) {
    const server = new FakeServer();
    const engine = new FakeEngine(server, 'Vera000000000000000001', 'vera');
    engine.signedIn = true;
    for (const [id, name] of [['Leo0000000000000000002', 'Leo'], ['Anna000000000000000003', 'Anna'], ['Sam0000000000000000004', 'Sam']] as const) {
      const theirs = new FakeEngine(server, id, name.toLowerCase());
      theirs.signedIn = true;
      engine.contacts.set(id, { deviceId: id, localName: name, ownDevice: null, serverDisplayName: 'x', createdAt: 1 });
    }
    const link = new PeerLink({ readMs: 0, log: quiet });
    link.attach(engine);
    people = attachNotchPeople({
      inbox, link, store: new PeerStore(db), openPage: async () => true, log: quiet, noClock: true,
      // The model that reads what the fixed words do not fit. Here it always says the words are for nobody.
      think: async () => { seen.asked++; return '{"kind":"none"}'; },
      time: { calendar: async () => null },
      onCall: () => false,
      chases: () => standing as never,
      agents: { list: () => [{ name: 'Tony', sentence: 'Every Monday at 9:00, send Sam the numbers.' }], take: () => false },
      look: () => { const held = put.held(); return held ? { what: held.what, rows: held.rows, app: held.app } : null; },
      files: { dir: join(HERE, 'no-such-folder'), save: async () => null, find: async () => [] },
    });
    await link.refresh();
    stops.push(() => people?.stop());
  }

  // --- what was decided, as it is decided ---
  // The parts are handed to the product's resolver as they are, and the resolver says which intent took the
  // words: the row names the part that intent is of. What it would do is not done. A taught job done again is
  // the exception (see above).
  const routers: NotchSideRouters = { pause: notchPauseWords(emergency, quiet), dayOne, mail, put, teach, people, standing, agents, memory, calls, prefs, moves, canDo, said: saidLine };
  const side = (text: string, how?: NotchAskHow): NotchSided | null => {
    // Every intent that matches, asked before the resolver: nothing is run in between, so it sees the same state.
    seen.matched.push({ text, ids: matchingIntents(notchIntents(routers), text, how).map((one) => one.id) });
    const hit = notchSide(routers, text, how);
    seen.sides.push({ text, router: hit ? hit.intent.feature as Router : null, did: hit?.did ?? '' });
    if (!hit) return null;
    return { ...hit, run: hit.intent.id === 'teach.run' && hit.did === JOB_AGAIN ? () => { seen.ran++; hit.run(); } : quiet };
  };
  const front = contexts.has('browser') ? BROWSER_WINDOW : SHEET_WINDOW;
  const point = createNotchPoint({
    read: async () => { seen.point.push('window'); return front; },
    // The window's own list of what is in it goes to the model, which finds nothing of the question in it.
    choose: async () => { seen.point.push('list'); return '{"none": true}'; },
    see: async () => ({ picture: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), x: 0, y: 0, w: 1600, h: 900, app: front.app }),
    // And so does a picture of the window.
    look: async () => { seen.point.push('picture'); return '{"none": true}'; },
    ring: async () => true,
    clear: async () => {},
    sleep: async () => {},
    log: quiet,
  });
  const door = fakeDoor();
  const ledger = new NotchLedger(db);
  asks = attachNotchAsks(inbox, {
    ledger, turns: () => door.door, modelReady: () => true, heardMs: 0, log: quiet,
    paused: () => emergency.state !== 'normal',
    side,
    read: (text) => {
      const reading = notchRead({ teach, people }, text);
      if (!reading) return null;
      return reading.then((hit) => (hit ? { did: hit.did, run: quiet } : null));
    },
    keys: () => saidLine.keys(),
    remember: async (what) => { seen.remembered.push(what); return { ok: true, said: 'Kept.', understood: what }; },
    point,
    people: () => [],
    here: () => people?.names() ?? [],
    today: () => [],
  });
  stops.push(() => asks.stop(), () => dayOne.stop(), () => teach.stop(), () => put.stop(), () => jobs.stop(), () => standing.stop(), () => agents.stop(), () => calls.stop());

  // --- the state the contexts name, reached the way the product reaches it ---
  if (contexts.has('front') && !contexts.has('job')) throw new Error('the state "front" is about a job: name "job" with it');
  if (contexts.has('job')) {
    // Kept as places only where its window is to be found again: the job of "front" was shown in the editor.
    const placed: PlacedStep[] | null = contexts.has('front')
      ? [{ kind: 'click', app: 'notepad', win: JOB_WINDOW, x: 40, y: 12 }, { kind: 'keys', app: 'notepad', win: JOB_WINDOW, keys: 'ctrl,s' }]
      : null;
    // Some time ago: an hour.
    new NotchLearnedStore(db, () => Date.now() - 3_600_000).add('shown-notepad', 'saves the file', 3, placed);
  }
  if (contexts.has('fresh')) {
    // Shown the way a person shows it: "watch me", the same row copied twice, "done". What it then offers
    // ("I can take it from here") is left unanswered and closed: the rounds stay where to go on from.
    const at = Date.now() - 2000;
    recorded = [...rowShown(0, at), ...rowShown(1, at + 10)];
    teach.route('watch me')!.run();
    await settle();
    if (line()?.kind !== 'offer') throw new Error(`the corpus could not begin a showing: ${line()?.kind}`);
    fromPage({ type: 'answer', id: line()!.id, act: 'yes' });
    for (let round = 0; round < 6; round++) { await settle(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    if (!JSON.stringify(line()?.say ?? '').includes('take it from here')) throw new Error(`the corpus could not make a fresh job: ${JSON.stringify(line()?.say)}`);
    fromPage({ type: 'answer', id: line()!.id, act: 'no' });
    await settle();
    seen.hands = 0;
  }
  if (contexts.has('held')) {
    const row = (parts: string[]) => ({ kind: 'row', name: '', value: '', parts });
    const looked: NotchLooked = { id: 'l1', how: 'loop', refused: '', app: 'Grafana', title: 'Installs', around: [], things: [row(['Acme', '1,200.00', 'paid']), row(['Lumen', '430.33', 'late'])], picture: null, window: null };
    put.shown('pc', looked);
    if (!put.held()) throw new Error('the corpus could not make a thing be held');
  }
  if (contexts.has('draft')) {
    const at = Date.now() - 60_000;
    mailStore.put({
      id: mailProposalId('19a1b2c3d4e5f601', at), thread: '19a1b2c3d4e5f601', messageAt: at, state: 'ready', who: leo, subject: 'Deck for Thursday?', to: [leo], cc: [],
      draft: 'Hi Leo,\nHappy to go ahead with the proposal.\nVera', time: null, missing: '', lookFor: '', found: null, tone: '', told: '', about: '',
      model: 'm', tokensIn: 1, tokensOut: 1, createdAt: at + 1, updatedAt: at + 1, sentAt: null,
    });
    await mail.arrived();
    await settle();
    fromPage({ type: 'answer', id: line()!.id, act: 'yes' });
    await settle();
    if (line()?.kind !== 'sheet') throw new Error(`the corpus could not open a draft: ${line()?.kind}`);
  }
  if (contexts.has('shown')) {
    // Shown once, a moment ago: "watch me", two steps, "done", and the schedule it then offers is declined.
    const at = Date.now() - 2000;
    recorded = [
      { action: 'click', ref: { role: 'Button', name: 'File', path: [], ordinal: 0, sig: 'File' }, ts: at, app: 'notepad' },
      { action: 'press_keys', value: 'ctrl,s', ts: at + 1, app: 'notepad' },
    ] as RawInteraction[];
    teach.route('watch me')!.run();
    await settle();
    if (line()?.kind !== 'offer') throw new Error(`the corpus could not begin a showing: ${line()?.kind}`);
    fromPage({ type: 'answer', id: line()!.id, act: 'yes' });
    for (let round = 0; round < 6; round++) { await settle(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    if (!JSON.stringify(line()?.say ?? '').includes('Do it every')) throw new Error(`the corpus could not show a job once: ${JSON.stringify(line()?.say)}`);
    fromPage({ type: 'answer', id: line()!.id, act: 'no' });
    await settle();
    // "Kept. Say run it when you want it done." is read and leaves.
    for (let round = 0; round < 6 && line(); round++) { if (line()!.kind === 'say') fromPage({ type: 'answer', id: line()!.id, act: 'done' }); await advance(4000); }
    if (line()) throw new Error(`the corpus could not clear the notch after a showing: ${line()?.kind}`);
    seen.hands = 0;
  }
  if (contexts.has('choice')) {
    inbox.add({
      id: 'choice', subject: 'choice', class: 'person', speaks: true, urgent: true, asked: true,
      title: () => ['Stopped at row 4. What now?'],
      play: async (stage) => {
        const id = stage.id();
        stage.put({ id, kind: 'offer', say: ['Stopped at row 4. What now?'], options: ['Undo it', 'Watch me', 'Tell Anna', 'Continue', 'Pause'], mood: 'careful', fold: 0 });
        await stage.answer(id, ['pick', 'no']);
        return 'settled';
      },
    });
    await settle();
    if (!JSON.stringify(line() ?? '').includes('Undo it')) throw new Error(`the corpus could not put a line of choices up: ${JSON.stringify(line())}`);
  }
  if (contexts.has('line')) {
    agents.route('every day at 9 send me the news')!.run();
    await settle();
    if (line()?.kind !== 'offer') throw new Error(`the corpus could not put an offer up: ${line()?.kind}`);
  }
  if (contexts.has('dayone')) {
    dayOne.cameUp();
    await advance(NOTCH_DAY_ONE_AFTER_MS + 10);
    if ((line() as { keys?: string } | null)?.keys !== 'talk') throw new Error(`the corpus could not bring day one to its talking step: ${JSON.stringify(line()?.say)}`);
  }

  /** Types the words into Home, as a person does. */
  const type = async (words: string): Promise<void> => {
    fromPage({ type: 'open' });
    await settle();
    if (line()?.kind !== 'ask') throw new Error(`Home is not open: ${line()?.kind}`);
    fromPage({ type: 'answer', id: line()!.id, act: 'ask', text: words });
    await settle();
  };
  /** Says the words: keys down, keys up, the words arrive. */
  const speak = async (words: string): Promise<void> => {
    asks.listen('talk-1');
    await settle();
    asks.released('talk-1');
    await settle();
    asks.words('talk-1', words);
    await settle();
    await advance(0);
  };
  if (contexts.has('reply')) {
    // An instruction went to the assistant, and its answer is a question: that question waits on the notch.
    await type('Draft a mail to Sam about the offsite');
    door.answer('Shall I send it?');
    await settle();
    await advance(0);
    if (line()?.kind !== 'ask' || !JSON.stringify(line()).includes('Shall I send it?')) throw new Error(`the corpus could not have the assistant ask back: ${JSON.stringify(line())}`);
  }

  /** What is done with a sentence, in one line. */
  const decide = async (sentence: string): Promise<string> => {
    const before = { sides: seen.sides.length, turns: door.texts().length, asked: seen.asked };
    if (contexts.has('reply') && !contexts.has('spoken')) {
      fromPage({ type: 'answer', id: line()!.id, act: 'ask', text: sentence });
      await settle();
    } else if (contexts.has('spoken')) await speak(sentence);
    else await type(sentence);
    for (let round = 0; round < 6; round++) { await settle(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    const row = ledger.recent(1)[0];
    if (!row || row.heard !== sentence) throw new Error(`the sentence did not arrive: ${sentence}`);
    const first = seen.sides.slice(before.sides).find((one) => one.text === sentence);
    // Only when the model was really asked for this sentence: a reading that was promised and never put to it is none.
    const read = seen.asked > before.asked ? 'read+' : '';
    if (emergency.state !== 'normal' && first?.router !== 'pause') throw new Error(`everything was stopped by something that was not the word for it: ${sentence}`);
    if (row.kind === 'notch') {
      if (first?.router && seen.ran > 0) {
        // A taught job done again: whether the hands were set to work with nothing asked, or a line came up first.
        for (let round = 0; round < 4; round++) { await advance(50); await new Promise((resolve) => setTimeout(resolve, 0)); }
        const up = line();
        const how = seen.hands > 0 ? 'acts at once' : up && (up.kind === 'offer' || up.kind === 'ask') ? 'a line first' : 'nothing seen to happen';
        // A job that was set going is let end before this world is taken down under it.
        for (let round = 0; round < 200 && jobs.busy(); round++) { await advance(50); await new Promise((resolve) => setTimeout(resolve, 0)); }
        if (jobs.busy()) throw new Error(`the job that was done again did not end: ${sentence}`);
        return `${first.router}: ${first.did} (${how})`;
      }
      if (first?.router) return `${first.router}: ${first.did}`;
      return `${read}people.read: ${row.did.join(' ')}`;
    }
    if (row.kind === 'remember') return `${read}remember: ${seen.remembered.join(' | ')}`;
    if (row.kind === 'turn') {
      const went = door.texts().length > before.turns;
      const kind = whereKind(sentence);
      const sent = [...new Set(seen.point.filter((one) => one !== 'window'))];
      const pointed = seen.point.length > 0 ? `point(${kind ?? 'go on'}; ${sent.length ? `${sent.join(' and ')} of the window to the model` : 'window read'})+` : '';
      return `${read}${pointed}${went ? 'turn' : 'turn not started'}`;
    }
    return `${row.state}: ${row.note ?? ''}`.trim();
  };

  return { decide, seen, table: (): NotchIntent[] => notchIntents(routers), stop: () => { for (const stop of stops) { try { stop(); } catch { /* it is over either way */ } } db.close(); } };
}

// --- the file ---

interface Row { n: number; sentence: string; today: string; wrong: string | null }
interface Section { n: number; kind: 'route' | 'when'; names: string[]; rows: Row[] }

function corpus(): { sections: Section[]; lines: string[] } {
  const lines = readFileSync(CORPUS, 'utf8').split('\n');
  const sections: Section[] = [];
  lines.forEach((raw, at) => {
    const text = raw.trim();
    if (!text || text.startsWith('#')) return;
    if (text.startsWith('@')) {
      const [kind, ...names] = text.slice(1).trim().split(/\s+/);
      if (kind !== 'route' && kind !== 'when') throw new Error(`line ${at + 1}: a section is "@ route [states]" or "@ when <reader>"`);
      sections.push({ n: at + 1, kind, names, rows: [] });
      return;
    }
    const section = sections.at(-1);
    if (!section) throw new Error(`line ${at + 1}: a row before any section`);
    const [body, wrong, more] = text.split(/\s+## wrong:\s*/);
    if (more !== undefined) throw new Error(`line ${at + 1}: a row is marked wrong once`);
    const cut = body!.indexOf(' => ');
    if (cut < 0) throw new Error(`line ${at + 1}: a row is "sentence => what happens"`);
    section.rows.push({ n: at + 1, sentence: body!.slice(0, cut).trim(), today: body!.slice(cut + 4).trim(), wrong: wrong === undefined ? null : wrong.trim() });
  });
  return { sections, lines };
}

// --- the readers of a time ---

/** Wednesday 18 November 2026, 10:00, on this machine's clock: the moment "tomorrow" and "Friday" are counted from. */
const WHEN_NOW = new Date(2026, 10, 18, 10, 0, 0).getTime();
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n: number): string => String(n).padStart(2, '0');
const pageWord = (value: string): NotchWord => ({ name: 'when', value, options: [value] });

/** Each reader of a time there is today, by the name a section of the file calls it. */
const WHEN: Record<string, (text: string) => string> = {
  // The schedule in a sentence that asks for an agent (./agents.ts, scheduleIn, reached through agentSentence).
  agent: (text) => {
    const read = agentSentence(text);
    return !read ? 'no agent' : read.when === null ? `no schedule | ${read.job}` : `${read.when} | ${read.job}`;
  },
  // The lit word of a taught job's schedule, as the brain reads it back (./teach.ts).
  teach: (text) => {
    const read = parseSchedule(text);
    return !read ? 'not read' : `${read.day === null ? 'every day' : DAY_NAMES[read.day]} ${read.hour}:${two(read.minute)}`;
  },
  // The evening's "move it to" word, counted from Wednesday 18 November 2026, 10:00 (./day.ts).
  move: (text) => {
    const at = notchMoveAt(text, WHEN_NOW);
    if (at === null) return 'not read';
    const d = new Date(at);
    return `${DAY_NAMES[d.getDay()]} ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${d.getHours()}:${two(d.getMinutes())}`;
  },
  // A day and a time said over a line (./said.ts).
  said: (text) => {
    const read = saidWhen(saidWords(text));
    return [read.day ?? '-', read.time ?? '-', read.part ?? '-'].join(' ');
  },
  // What the page makes of a value typed into a lit word, before the brain sees it (ui/src/notch/surface/readers.ts).
  'page-sched': (text) => PAGE_READ.sched(text, pageWord('Monday at 9:00')) ?? 'refused',
  'page-daytime': (text) => PAGE_READ.dayTime(text, pageWord('Thursday at 10:00')) ?? 'refused',
  'page-day': (text) => PAGE_READ.day(text, pageWord('Friday')) ?? 'refused',
  // A sentence typed into a word that takes one ("tell me" on a mail draft), as the page hands it on.
  'page-free': (text) => readLive({ name: 'told', value: 'tell me', options: ['say no', 'say yes', 'ask for more time'], free: true, long: true }, text) ?? 'refused',
};

// --- the tests ---

/** [rows, rows marked wrong] of each section of the file. */
const ROWS: Record<string, [number, number]> = {
  '@ route': [128, 19],
  '@ route job': [37, 4],
  '@ route job front': [6, 0],
  '@ route shown': [3, 0],
  '@ route shown spoken': [2, 0],
  '@ route fresh': [4, 0],
  '@ route job reply': [20, 0],
  '@ route job front reply': [2, 0],
  '@ route job reply spoken': [4, 0],
  '@ route reply': [14, 0],
  '@ route held': [8, 0],
  '@ route draft spoken': [12, 0],
  '@ route line spoken': [13, 0],
  '@ route line job spoken': [6, 0],
  '@ route choice spoken': [8, 0],
  '@ route choice job spoken': [2, 0],
  '@ route dayone spoken': [5, 0],
  '@ route spoken': [6, 0],
  '@ route job spoken': [1, 0],
  '@ route browser': [7, 4],
  '@ route alone': [9, 0],
  '@ when agent': [26, 7],
  '@ when teach': [9, 2],
  '@ when move': [10, 0],
  '@ when said': [13, 4],
  '@ when page-sched': [12, 4],
  '@ when page-daytime': [4, 2],
  '@ when page-day': [4, 2],
  '@ when page-free': [2, 1],
};
const TOTALS = { routing: 297, routingWrong: 27, times: 80, timesWrong: 22 };

const read = corpus();
/** For every routing row, the intents that matched its sentence when it was decided, the one that took it first. */
const matchedRows: { n: number; sentence: string; ids: string[] }[] = [];
/** Every intent of the table as it was handed over, by its id: kept from the worlds the rows were decided in. */
const tableSeen = new Map<string, NotchIntent>();
const printed = new Map<number, string>();
const show = (row: Row, now: string): void => { printed.set(row.n, `${row.sentence} => ${now}${row.wrong === null ? '' : `  ## wrong: ${row.wrong}`}`); };

// Printed after everything was checked, and whether or not it held: what differs has failed above.
afterAll(() => { if (PRINT) console.log(read.lines.map((line, at) => printed.get(at + 1) ?? line).join('\n')); });

describe('what a sentence means today', () => {
  for (const section of read.sections.filter((one) => one.kind === 'route')) {
    const names = section.names as Context[];
    test(`line ${section.n}: ${names.length ? names.join(', ') : 'nothing taught, nothing held, nothing up, typed'} (${section.rows.length} sentences)`, async () => {
      for (const name of names) if (!(name in CONTEXTS)) throw new Error(`line ${section.n}: no such state: ${name}`);
      const differs: string[] = [];
      for (const row of section.rows) {
        // A world of its own for every sentence: none of them finds what another left.
        const made = await world(new Set(names));
        let now: string;
        try {
          now = await made.decide(row.sentence);
          for (const one of made.table()) tableSeen.set(one.id, one);
          const matched = made.seen.matched.filter((one) => one.text === row.sentence).at(-1);
          if (matched) matchedRows.push({ n: row.n, sentence: row.sentence, ids: matched.ids });
        } finally { made.stop(); }
        show(row, now);
        if (now !== row.today) differs.push(`line ${row.n}: ${JSON.stringify(row.sentence)}\n    the file says: ${row.today}\n    it gives now:  ${now}`);
      }
      expect(differs).toEqual([]);
    });
  }
});

describe('what a time is read as today', () => {
  for (const section of read.sections.filter((one) => one.kind === 'when')) {
    test(`line ${section.n}: ${section.names.join(' ')} (${section.rows.length} values)`, () => {
      const reader = WHEN[section.names[0] ?? ''];
      if (!reader) throw new Error(`line ${section.n}: no such reader of a time: ${section.names[0]}`);
      const differs: string[] = [];
      for (const row of section.rows) {
        const now = reader(row.sentence);
        show(row, now);
        if (now !== row.today) differs.push(`line ${row.n}: ${JSON.stringify(row.sentence)}\n    the file says: ${row.today}\n    it gives now:  ${now}`);
      }
      expect(differs).toEqual([]);
    });
  }
});

describe('the file itself', () => {
  test('a row that is marked wrong says what is meant, and that is not what happens today', () => {
    const marked = read.sections.flatMap((section) => section.rows.filter((row) => row.wrong !== null));
    expect(marked.length).toBeGreaterThan(0);
    for (const row of marked) {
      expect([row.n, row.wrong === '']).toEqual([row.n, false]);
      expect([row.n, row.wrong === row.today]).toEqual([row.n, false]);
    }
  });

  test('no sentence stands twice under the same state', () => {
    for (const section of read.sections) {
      const twice = section.rows.map((row) => row.sentence).filter((sentence, at, all) => all.indexOf(sentence) !== at);
      expect([section.n, twice]).toEqual([section.n, []]);
    }
  });

  // A file that was cut short, or a row that was commented out, must not pass for the whole. These numbers are
  // changed by hand, in the same commit as the rows: [rows, rows marked wrong] for each section.
  test('has every row it had: the counts are pinned', () => {
    const counted = Object.fromEntries(read.sections.map((section) =>
      [`@ ${[section.kind, ...section.names].join(' ')}`, [section.rows.length, section.rows.filter((row) => row.wrong !== null).length]]));
    expect(counted).toEqual(ROWS);
    const total = (kind: Section['kind'], at: 0 | 1): number => read.sections.filter((one) => one.kind === kind).reduce((sum, one) => sum + ROWS[`@ ${[one.kind, ...one.names].join(' ')}`]![at], 0);
    expect({ routing: total('route', 0), routingWrong: total('route', 1), times: total('when', 0), timesWrong: total('when', 1) }).toEqual(TOTALS);
  });
});

describe('the table of intents, as the parts hand it over', () => {
  /** Every intent there is, with where it stands, what kind of act it is, and whether it acts at once. Changed by hand. */
  const TABLE: Record<string, string> = {
    'pause.all': 'control none acts',
    'dayone.answer': 'up none acts',
    'dayone.start': 'open none acts',
    'dayone.around': 'open none acts',
    'mail.slot': 'up send fuse',
    'mail.steer': 'up none acts',
    'put.answer': 'up screen acts',
    'put.here': 'command screen acts',
    'teach.done': 'up create acts',
    'teach.watch': 'command create yes',
    'teach.undo': 'command screen acts',
    'teach.run': 'command screen acts',
    'said.yes': 'up answer acts',
    'people.org': 'open none acts',
    'people.job': 'command send fuse',
    'people.agent': 'command send fuse',
    'people.show': 'command send fuse',
    'people.rule': 'command settings yes',
    'people.time': 'command send fuse',
    'people.give': 'command send yes',
    'people.request': 'command send fuse',
    'people.file': 'command send fuse',
    'people.say': 'command send fuse',
    'standing.eye': 'command create acts',
    'standing.chase': 'command create yes',
    'agents.list': 'open none acts',
    'agents.make': 'command create yes',
    'memory.open': 'open none acts',
    'calls.open': 'open none acts',
    'prefs.settings': 'open none acts',
    'prefs.connections': 'open none acts',
    'moves.open': 'open none acts',
    'cando.open': 'open none acts',
    'said.answer': 'said answer acts',
  };
  /**
   * Intents that answer what is up on the notch: their examples are the rows of the sections that put it up. And
   * a job that changes hands, which needs a chase under way that no state here has (./people.test.ts has those).
   */
  const ELSEWHERE = new Set(['dayone.answer', 'mail.slot', 'mail.steer', 'put.answer', 'teach.done', 'said.yes', 'said.answer', 'people.job']);

  test('every intent is in it once, and says where it stands, what kind of act it is and whether it acts at once', async () => {
    const made = await world(new Set(['job', 'held']));
    try {
      const table = made.table();
      expect(Object.fromEntries(table.map((one) => [one.id, `${one.band} ${one.act} ${one.first}`]))).toEqual(TABLE);
      expect(table.length).toBe(Object.keys(TABLE).length);
      for (const one of table) {
        expect([one.id, /^[a-z]+\.[a-z]+$/.test(one.id), one.says.length > 10, one.examples.length > 0]).toEqual([one.id, true, true, true]);
      }
    } finally { made.stop(); }
  });

  test('what acts on the screen, sends or creates shows a line first, or names the live context its words are about', async () => {
    const made = await world(new Set(['job', 'held']));
    try {
      const guarded = made.table().filter((one) => NOTCH_INTENT_ACTS_GUARDED.includes(one.act));
      expect(guarded.length).toBeGreaterThan(10);
      for (const one of guarded) expect([one.id, one.first !== 'acts' || (one.live ?? '').length > 10 || (one.alone ?? '').length > 10]).toEqual([one.id, true]);
      // And the other way: a live context is named only by what acts at once.
      for (const one of made.table()) if (one.live !== undefined) expect([one.id, one.first]).toEqual([one.id, 'acts']);
      // One intent is let off the rule, and says why: an eye is kept at once, as it always was.
      expect(made.table().filter((one) => one.alone !== undefined).map((one) => one.id)).toEqual(['standing.eye']);
      // An answer to a line is never "nothing": whoever reads the act has to ask what the line was about.
      expect(made.table().filter((one) => one.feature === 'said').map((one) => one.act)).toEqual(['answer', 'answer']);
    } finally { made.stop(); }
  });

  test('no sentence that an intent must never take is matched by it', async () => {
    const made = await world(new Set(['job', 'held']));
    try {
      const table = made.table();
      const marked = table.filter((one) => (one.never ?? []).length > 0);
      // The wrong captures the review found, each on the intent that made it.
      expect(marked.map((one) => one.id).sort()).toEqual(['agents.make', 'pause.all', 'people.time', 'teach.run']);
      const taken: string[] = [];
      for (const one of marked) for (const sentence of one.never!) if (one.match(sentence) !== null) taken.push(`${one.id} takes ${JSON.stringify(sentence)}`);
      expect(taken).toEqual([]);
      // And with the talk keys held, a moment ago: how the words came does not open a way round it.
      for (const one of marked) for (const sentence of one.never!) if (one.match(sentence, { source: 'spoken', at: Date.now() }) !== null) taken.push(`${one.id} takes ${JSON.stringify(sentence)}, said`);
      expect(taken).toEqual([]);
    } finally { made.stop(); }
  });

  test('a sentence of the corpus that two intents match is taken by the one that says so (`over`)', () => {
    expect(matchedRows.length).toBeGreaterThan(200);
    const undeclared: string[] = [];
    const witnessed = new Set<string>();
    for (const row of matchedRows) {
      const [first, ...rest] = row.ids;
      if (!first || rest.length === 0) continue;
      const over = tableSeen.get(first)!.over ?? [];
      for (const other of rest) {
        if (over === 'any') continue;
        if (over.includes(other)) witnessed.add(`${first} over ${other}`);
        else undeclared.push(`line ${row.n}: ${JSON.stringify(row.sentence)} is taken by ${first}, and ${other} matches it too`);
      }
    }
    expect(undeclared).toEqual([]);
    // And nothing is declared that no row shows: an overlap that is claimed has a sentence in the file.
    const declared = [...tableSeen.values()].flatMap((one) => (Array.isArray(one.over) ? one.over.map((other: string) => `${one.id} over ${other}`) : []));
    expect(declared.filter((pair) => !witnessed.has(pair))).toEqual([]);
    // An intent that is named in `over` is one there is, and stands further down.
    const order = [...tableSeen.keys()];
    for (const one of tableSeen.values()) {
      if (!Array.isArray(one.over)) continue;
      for (const other of one.over) expect([one.id, other, tableSeen.has(other)]).toEqual([one.id, other, true]);
    }
    expect(order.length).toBeGreaterThan(20);
  });

  test('the bands are asked in their order, and a reply to a question is asked of the control band only', async () => {
    const made = await world(new Set(['job', 'held']));
    try {
      const table = made.table();
      const bands = table.map((one) => one.band);
      expect(bands).toEqual([...bands].sort((a, b) => NOTCH_INTENT_BANDS.indexOf(a) - NOTCH_INTENT_BANDS.indexOf(b)));
      expect(table.filter((one) => one.band === 'control').map((one) => one.id)).toEqual(['pause.all']);
      // What is up stands before every command: the yes to an offer before the job that "do it" could mean.
      expect(table.findIndex((one) => one.id === 'said.yes')).toBeLessThan(table.findIndex((one) => one.id === 'teach.run'));
      // And only that: everything else said over a line is asked last, after every command and everything that opens.
      expect(table.at(-1)?.id).toBe('said.answer');
      expect(table.filter((one) => one.band === 'said').map((one) => one.id)).toEqual(['said.answer']);
      expect(table.filter((one) => one.inReply).map((one) => one.id)).toEqual(['pause.all', 'teach.undo']);
    } finally { made.stop(); }
  });

  test('every example of an intent is taken by that intent, with a job taught and a thing held', async () => {
    const made = await world(new Set(['job', 'held']));
    try {
      const table = made.table();
      const differs: string[] = [];
      for (const one of table.filter((each) => !ELSEWHERE.has(each.id))) {
        for (const example of one.examples) {
          const first = table.find((each) => each.match(example) !== null);
          if (first !== one) differs.push(`${one.id}: ${JSON.stringify(example)} is taken by ${first?.id ?? 'none'}`);
        }
      }
      expect(differs).toEqual([]);
    } finally { made.stop(); }
  });
});

describe('how often the routers are asked', () => {
  // Once. asks.ts looks at what the notch does itself in three places, and one sentence passes two of them: where
  // its line is drawn (typed) or its name is checked (spoken), and again where it is run. It used to ask the whole
  // chain each time, and day one's route notes "asked" as it goes. Now the table is asked once for an instruction
  // and the answer is kept on it.
  const ASKED_TODAY = 1;
  for (const [how, sentence, gives] of [
    ['typed', 'what is the weather in Rome', 'turn'],
    ['typed', 'settings', 'prefs: Show the settings.'],
    ['spoken', 'what is the weather in Rome', 'turn'],
    ['spoken', 'settings', 'prefs: Show the settings.'],
  ] as const) {
    test(`for one sentence, ${how}, that gives "${gives}": once`, async () => {
      const made = await world(new Set(how === 'spoken' ? ['spoken'] as const : []));
      try {
        expect(await made.decide(sentence)).toBe(gives);
        expect(made.seen.sides.filter((one) => one.text === sentence).length).toBe(ASKED_TODAY);
      } finally { made.stop(); }
    });
  }
});
