/**
 * What a sentence means today, pinned.
 *
 * Every row of ./intents-corpus.txt is one sentence under one stated state
 * of the notch, and what is done with it now: which of the thirteen routers
 * of ./real.ts takes it, or what comes after them when none does (the
 * reading of words that name somebody, the memory, the pointing, the
 * assistant's turn). A row marked `## wrong:` is pinned as it behaves today
 * and says beside it what is meant to happen: the fix that changes it flips
 * that row, and no other.
 *
 * Nothing here is a stand-in for the deciding itself. The routers are the
 * product's own, made with `attachNotch...`, and which of them takes a
 * sentence is decided by the product's own resolver: `notchSide` of
 * ./real.ts, the one function the notch itself calls. Step C2 of the fix
 * replaces the body of that function with the table of intents; this corpus
 * keeps calling the product's resolver, whatever it is then, and never has a
 * copy of the order. The sentence is typed into Home or said with the talk
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
import { PeerLink } from '../peers/link.ts';
import { PeerStore } from '../peers/store.ts';
import { FakeEngine, FakeServer } from '../peers/testing/fake-engines.ts';
import { READ as PAGE_READ, readLive } from '../../ui/src/notch/surface/readers.ts';
import { agentSentence, attachNotchAgents } from './agents.ts';
import { attachNotchAsks, type NotchAskHow, type NotchTurnDoor } from './asks.ts';
import { attachNotchCalls } from './call.ts';
import { attachNotchCanDo } from './cando.ts';
import { notchMoveAt } from './day.ts';
import { NOTCH_DAY_ONE_AFTER_MS, NOTCH_DAY_ONE_ORDER, attachNotchDayOne } from './dayone.ts';
import { NotchInbox } from './inbox.ts';
import { attachNotchJobs, type NotchJobHands } from './jobs.ts';
import { NotchLedger } from './ledger.ts';
import type { NotchLooked } from './look.ts';
import { attachNotchMail } from './mail/notch.ts';
import { MailStore, mailProposalId } from './mail/store.ts';
import { mailPerson } from './mail/thread.ts';
import { attachNotchMemory } from './memory.ts';
import { attachNotchMoves } from './moves.ts';
import { attachNotchPeople } from './people.ts';
import { createNotchPoint, whereKind, whereQuestion } from './point.ts';
import { attachNotchPrefs } from './prefs.ts';
import type { NotchLine, NotchWord } from './protocol.ts';
import { attachNotchPut } from './put.ts';
import { notchSide, type NotchSideRouters } from './real.ts';
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
  job: 'a job was taught once, some time ago (nothing of it is fresh)',
  held: 'a thing that was circled is held',
  draft: 'a draft of a mail reply is open on the notch',
  line: 'an offer is up on the notch ("Every day at 9:00, send me the news." with the key "make agent")',
  dayone: 'day one is on its talking step, waiting to hear the person',
  reply: 'the assistant has just asked "Shall I send it?" and the sentence is the reply typed into that line',
  spoken: 'said with the talk keys held, not typed',
  browser: 'a browser is in front: a window that says too little about itself, so it can only be looked at',
  alone: 'no organisation: there is nobody whose Jarvis this one talks to',
} as const;
type Context = keyof typeof CONTEXTS;

const quiet = (): void => {};
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

  // --- the thirteen, each the product's own ---
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
    took: null as { text: string; router: Router; did: string } | null,
    /** How often the model that reads words about people was really asked. */
    asked: 0,
    remembered: [] as string[],
    point: [] as string[],
    /** A taught job was let run, and how often the hands were then asked to do a step of it. */
    ran: 0, hands: 0,
  };
  const hands: NotchJobHands = { act: async () => { seen.hands++; return { done: true }; } };
  const jobs = attachNotchJobs(inbox, { db, hands, log: quiet });
  const put = attachNotchPut({ inbox, jobs, hands, hold: quiet, log: quiet });
  const teach = attachNotchTeach({
    inbox, jobs, hands, db, log: quiet,
    recorder: { start: async () => ({ ok: true }), stop: async () => [], onStep: () => quiet },
    save: () => ({ ok: false, why: 'nothing is saved in this test' }) as never,
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
  // Each router is handed to the product's resolver as it is, with a note taken of which one answered. What it
  // would do is not done: the row says who took the words. A taught job done again is the exception (see above).
  const noted = (router: Router, real: { route(text: string, how?: NotchAskHow): { did: string; run(): void } | null } | null) => (real ? {
    route(text: string, how?: NotchAskHow) {
      // Asked the way the resolver asked: with `how` only when it was given, and on the router itself.
      const hit = how === undefined ? real.route(text) : real.route(text, how);
      if (!hit) return null;
      seen.took = { text, router, did: hit.did };
      return { did: hit.did, run: router === 'teach' && hit.did === JOB_AGAIN ? () => { seen.ran++; hit.run(); } : quiet };
    },
  } : null);
  const routers: NotchSideRouters = {
    dayOne: noted('dayOne', dayOne), mail: noted('mail', mail), put: noted('put', put), teach: noted('teach', teach), people: noted('people', people),
    standing: noted('standing', standing), agents: noted('agents', agents), memory: noted('memory', memory), calls: noted('calls', calls),
    prefs: noted('prefs', prefs), moves: noted('moves', moves)!, canDo: noted('canDo', canDo)!, saidLine: noted('saidLine', saidLine)!,
  };
  const side = (text: string, how?: NotchAskHow): { did: string; run(): void } | null => {
    seen.took = null;
    const hit = notchSide(routers, text, how);
    seen.sides.push({ text, router: hit ? seen.took!.router : null, did: hit?.did ?? '' });
    return hit;
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
    side,
    read: (text) => {
      const reading = people?.read(text) ?? null;
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
  if (contexts.has('job')) new NotchLearnedStore(db).add('shown-notepad', 'saves the file', 3);
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
    if (contexts.has('reply')) {
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
    if (row.kind === 'notch') {
      if (first?.router && seen.ran > 0) {
        // A taught job done again: whether the hands were set to work with nothing asked, or a line came up first.
        for (let round = 0; round < 4; round++) { await advance(50); await new Promise((resolve) => setTimeout(resolve, 0)); }
        const up = line();
        const how = seen.hands > 0 ? 'acts at once' : up && (up.kind === 'offer' || up.kind === 'ask') ? 'a line first' : 'nothing seen to happen';
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

  return { decide, seen, stop: () => { for (const stop of stops) { try { stop(); } catch { /* it is over either way */ } } db.close(); } };
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
  '@ route': [125, 23],
  '@ route job': [34, 26],
  '@ route job reply': [20, 10],
  '@ route reply': [6, 0],
  '@ route held': [8, 1],
  '@ route draft spoken': [10, 1],
  '@ route line spoken': [9, 0],
  '@ route line job spoken': [3, 1],
  '@ route dayone spoken': [4, 0],
  '@ route spoken': [6, 1],
  '@ route job spoken': [1, 1],
  '@ route browser': [7, 4],
  '@ route alone': [9, 0],
  '@ when agent': [26, 8],
  '@ when teach': [9, 2],
  '@ when move': [10, 0],
  '@ when said': [13, 4],
  '@ when page-sched': [12, 4],
  '@ when page-daytime': [4, 2],
  '@ when page-day': [4, 2],
  '@ when page-free': [2, 1],
};
const TOTALS = { routing: 242, routingWrong: 68, times: 80, timesWrong: 23 };

const read = corpus();
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
        try { now = await made.decide(row.sentence); } finally { made.stop(); }
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

describe('how often the routers are asked', () => {
  // wrong: once. asks.ts asks the whole chain in three places, and one sentence passes two of them: where its line
  // is drawn (typed) or its name is checked (spoken), and again where it is run. Day one's route notes "asked" as
  // it goes, so a router that is not pure is a trap. Step C2 resolves once and keeps the answer on the instruction.
  const ASKED_TODAY = 2;
  for (const [how, sentence, gives] of [
    ['typed', 'what is the weather in Rome', 'turn'],
    ['typed', 'settings', 'prefs: Show the settings.'],
    ['spoken', 'what is the weather in Rome', 'turn'],
    ['spoken', 'settings', 'prefs: Show the settings.'],
  ] as const) {
    test(`for one sentence, ${how}, that gives "${gives}": twice`, async () => {
      const made = await world(new Set(how === 'spoken' ? ['spoken'] as const : []));
      try {
        expect(await made.decide(sentence)).toBe(gives);
        expect(made.seen.sides.filter((one) => one.text === sentence).length).toBe(ASKED_TODAY);
      } finally { made.stop(); }
    });
  }
});
