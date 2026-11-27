import { describe, expect, test } from 'bun:test';
import { attachNotchActions } from './actions.ts';
import { Database } from 'bun:sqlite';
import type { RawInteraction } from '../skills/recorder.ts';
import type { NotchCatch } from './catch.ts';
import { NotchInbox } from './inbox.ts';
import { attachNotchJobs, type NotchActResult, type NotchJobEnd, type NotchJobHands } from './jobs.ts';
import type { NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import type { WatchWin } from './rounds.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';
import {
  NOTCH_PLACED_TEXT_MAX, NOTCH_SCHEDULE_LATE_MS, NOTCH_TEACH_FRESH_MS, advanceRounds, attachNotchTeach, keysSaid, nextScheduled, parseSchedule, runItRequest, teachDoneWord, teachPlaced,
  teachShapes, teachStepSaid, undoRequest, watchMeRequest, type NotchSaved, type NotchSkillEffect,
} from './teach.ts';
import { findRounds } from './rounds.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string =>
  (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? part.word.value : '')).join('');

const FILE: WatchWin = { id: '0x1a', pid: 100, w: 900, h: 700 };
const SHEET: WatchWin = { id: '0x2b', pid: 200, w: 1200, h: 800 };
const ref = (name: string) => ({ role: 'Button', name, path: [], ordinal: 0, sig: name });

describe('what is said to start, to end and to run a showing', () => {
  test('"Watch me" and its kin begin one', () => {
    for (const said of ['Watch me', 'watch me.', 'Okay, watch me', 'Jarvis, watch me do this', 'Watch me paste these rows', 'watch this', 'Let me show you', "I'll show you how", 'learn this', 'Guardami', 'ti faccio vedere']) {
      expect(watchMeRequest(said)).toBe(true);
    }
    for (const said of ['Watch this video and summarise it for me', 'What should I watch tonight', 'Can you watch my inbox', 'show me the numbers', '',
      'Watch me and then tell me what you think about the way I write these very long emails to investors please']) {
      expect(watchMeRequest(said)).toBe(false);
    }
  });

  test('"done" and its kin end one, and nothing longer does', () => {
    for (const said of ['Done', 'done.', "I'm done", 'Okay, done', "That's it", 'that is all', 'Finished', 'fatto', 'stop watching']) expect(teachDoneWord(said)).toBe(true);
    for (const said of ['Are you done', 'Done with the deck, send it to Anna', 'that is it for the budget', '']) expect(teachDoneWord(said)).toBe(false);
  });

  // The plan's test, step 2: "Run it on nine rows."
  test('"run it" with a number, as digits or as a word', () => {
    expect(runItRequest('Run it on nine rows')).toEqual({ count: 9 });
    expect(runItRequest('run it on 9 rows.')).toEqual({ count: 9 });
    expect(runItRequest('Do it again')).toEqual({ count: null });
    expect(runItRequest('do the rest')).toEqual({ count: null });
    expect(runItRequest('Do the next twenty')).toEqual({ count: 20 });
    expect(runItRequest('take it from here')).toEqual({ count: null });
    expect(runItRequest('Go on for five more')).toEqual({ count: 5 });
    expect(runItRequest('Jarvis, do that for the other 12')).toEqual({ count: 12 });
    expect(runItRequest('do it twice')).toEqual({ count: 2 });
    expect(runItRequest('do three more')).toEqual({ count: 3 });
    expect(runItRequest('Do 5 more')).toEqual({ count: 5 });
    expect(runItRequest('finisci il resto')).toEqual({ count: null });
    for (const said of ['Run the numbers for October', 'Do it in a way that Anna will understand, and keep it short, and send it to her today', 'What is it', 'do', 'continue the email to Marco', 'go on holiday']) {
      expect(runItRequest(said)).toBeNull();
    }
  });

  // The review of 26 November 2026: with one job ever shown, each of these replayed its clicks and keys.
  test('the words for the job are the whole sentence: one word that is not about the job, and it is an instruction', () => {
    for (const said of [
      'do it by email', 'do that tomorrow morning instead', 'do this for all the files in downloads', 'do them one at a time please',
      'continue with the draft to Sam', 'carry on with the summary', 'finish it by Friday', 'run the same report as last week',
      'repeat that please, I did not hear', 'go on, tell me more', 'do it yourself', 'run it past Anna first', 'do the rest tomorrow',
      'finish the rest of the report', 'do the same for Leo', 'keep going until Friday', 'take over the meeting', 'do some more research',
      // The second review: each of these says something that is not a count of the job.
      'do the same for the other file', 'do it on the other file', 'do the other thing', 'do it for me', 'do it with me', 'continue with the rest',
      'do it at 5', 'do the same thing again', 'continue with the next five', 'go on with the rest', 'do it on a row', 'run it on the files',
      'do it for all the files', 'do it for the team', 'do it on Monday', 'do it once and for all', 'run it on', 'do it for',
      // A word that every object has is not a number.
      'do it constructor', 'run it toString',
    ]) expect([said, runItRequest(said)]).toEqual([said, null]);
    for (const [said, count] of [
      ['do it', null], ['Do it.', null], ['do it again please', null], ['ok, run it now', null], ['run it once more', 1], ['do that 3 more times', 3],
      ['do it for the next 4 rows please', 4], ['run it on all the rows', null], ['do the same for the other 12', 12], ['do the same again', null],
      ['continue for the next five', 5], ['go on for 3 more rows', 3], ['keep going', null], ['take it from here', null], ['finish the rest', null],
      ['do some more', null], ['do twenty more', 20], ['repeat that', null], ['finisci il resto per favore', null],
      // A please or a thanks after any of them, and it is still the job.
      ['continue please', null], ['do it thanks', null], ['keep going, please', null], ['take over now', null], ['do the rest, thank you', null],
      ['run it on all of them', null], ['do the next 12 lines', 12],
    ] as const) expect([said, runItRequest(said)]).toEqual([said, { count }]);
  });

  test('"undo that" is taking a paste back, and not undoing anything else', () => {
    for (const said of ['Undo', 'undo that', 'Undo the paste.', 'take it back', 'Jarvis, undo that', 'annulla']) expect(undoRequest(said)).toBe(true);
    for (const said of ['Undo the last commit', 'undo my changes to the deck', 'take it back to the shop', '']) expect(undoRequest(said)).toBe(false);
  });
});

describe('a time of the week', () => {
  test('it is read as the lit word writes it, and nothing else is', () => {
    expect(parseSchedule('Monday at 9:00')).toEqual({ days: [1], hour: 9, minute: 0 });
    expect(parseSchedule('Friday at 16:30')).toEqual({ days: [5], hour: 16, minute: 30 });
    expect(parseSchedule('day at 7:05')).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], hour: 7, minute: 5 });
    // A weekday is Monday to Friday, and what the notch writes for it is read back.
    expect(parseSchedule('weekday at 9:00')).toEqual({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0 });
    expect(parseSchedule('Monday to Friday at 9:00')).toEqual({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0 });
    // As the notch writes it, the hour is what it says: six is six in the morning.
    expect(parseSchedule('day at 6:00')).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], hour: 6, minute: 0 });
    expect(parseSchedule('every Monday at 9:00')).toEqual({ days: [1], hour: 9, minute: 0 });
    for (const bad of ['', 'Monday', 'at 9:00', 'Funday at 9:00', 'Monday at 25:00', 'Monday at 9:75', 'every 2 weeks at 9:00', 'month at 9:00', 'tomorrow at 9:00', 'next week',
      'Monday at 9:00 and Friday at 16:00']) expect(parseSchedule(bad)).toBeNull();
  });

  test('the next time is the next one after now, on that day', () => {
    // Wednesday 18 November 2026, 10:00.
    const wed = new Date(2026, 10, 18, 10, 0, 0).getTime();
    expect(new Date(nextScheduled({ days: [1], hour: 9, minute: 0 }, wed))).toEqual(new Date(2026, 10, 23, 9, 0, 0));
    expect(new Date(nextScheduled({ days: [3], hour: 16, minute: 0 }, wed))).toEqual(new Date(2026, 10, 18, 16, 0, 0));
    // The same day, an hour that has passed: next week.
    expect(new Date(nextScheduled({ days: [3], hour: 9, minute: 0 }, wed))).toEqual(new Date(2026, 10, 25, 9, 0, 0));
    const every = [0, 1, 2, 3, 4, 5, 6];
    expect(new Date(nextScheduled({ days: every, hour: 9, minute: 0 }, wed))).toEqual(new Date(2026, 10, 19, 9, 0, 0));
    expect(new Date(nextScheduled({ days: every, hour: 11, minute: 30 }, wed))).toEqual(new Date(2026, 10, 18, 11, 30, 0));
    // Monday to Friday, asked on a Friday evening: Monday, not the weekend.
    const fri = new Date(2026, 10, 20, 18, 0, 0).getTime();
    expect(new Date(nextScheduled({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }, fri))).toEqual(new Date(2026, 10, 23, 9, 0, 0));
  });
});

describe('what a showing is made of', () => {
  test('each step is said in a few plain words', () => {
    expect(teachStepSaid({ action: 'click', ref: ref('Add Source'), ts: 1 })).toBe('clicked Add Source');
    expect(teachStepSaid({ action: 'click', ref: ref(''), ts: 1 })).toBe('a click');
    expect(teachStepSaid({ action: 'set_value', ref: ref('Name'), value: 'Lumen', ts: 1 })).toBe('typed into Name');
    expect(teachStepSaid({ action: 'press_keys', value: 'ctrl,shift,v', ts: 1 })).toBe('pressed Ctrl + Shift + V');
    expect(keysSaid('enter')).toBe('Enter');
    expect(keysSaid('alt,f4')).toBe('Alt + F4');
  });

  test('as shapes, a click is a place and typing is only "typed"', () => {
    const shapes = teachShapes([
      { action: 'click', ref: ref('row'), ts: 1, app: 'notepad', win: FILE, pt: { x: 120, y: 200 } },
      { action: 'press_keys', value: 'ctrl,c', ts: 2, app: 'notepad', win: FILE },
      { action: 'set_value', ref: ref('Name'), value: 'what was typed', ts: 3, app: 'excel', win: SHEET },
      { action: 'click', ref: ref('no place'), ts: 4 },
      { action: 'press_keys', value: 'a', ts: 5, win: SHEET },
    ]);
    expect(shapes).toEqual([
      { kind: 'click', app: 'notepad', win: FILE, x: 120, y: 200, at: 1 },
      { kind: 'keys', app: 'notepad', win: FILE, keys: 'ctrl,c', at: 2 },
      { kind: 'typed', at: 3 },
      { kind: 'gap', at: 4 },
      { kind: 'gap', at: 5 },
    ]);
    expect(JSON.stringify(shapes)).not.toContain('what was typed');
  });
});

/** One row of the file copied into the sheet, as the recorder tells it. */
const rowShown = (n: number, at: number): RawInteraction[] => [
  { action: 'click', ref: ref(`line ${n}`), ts: at, app: 'notepad', win: FILE, pt: { x: 120, y: 200 + 22 * n } },
  { action: 'press_keys', value: 'ctrl,c', ts: at + 1, app: 'notepad', win: FILE },
  { action: 'click', ref: ref(`cell ${n}`), ts: at + 2, app: 'excel', win: SHEET, pt: { x: 300, y: 400 + 20 * n } },
  { action: 'press_keys', value: 'ctrl,v', ts: at + 3, app: 'excel', win: SHEET },
];

function harness(options: {
  left?: number | null; effect?: Partial<NotchSkillEffect>; start?: { ok: false; why: string }; describe?: string | null; save?: NotchSaved; rows?: 'unseen'; byPlace?: boolean; window?: 'gone';
  /** The window that is in front. Not given: none is. 'lost': the machine was asked and never answered. 'off': no machine to ask. */
  front?: { app: string; win: WatchWin } | 'lost' | 'off'; paused?: () => boolean;
  /** A job begun by hand and not shown: what has it (./catch.ts). */
  catcher?: NotchCatch;
} = {}) {
  let toSurface: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { toSurface = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  // Wednesday 18 November 2026, 10:00.
  let now = new Date(2026, 10, 18, 10, 0, 0).getTime();
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => toSurface('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 2 });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const sent: Record<string, unknown>[] = [];
  const hands: NotchJobHands = {
    act(request) {
      sent.push(request);
      if (request.do === 'pitch') return Promise.resolve(options.rows === 'unseen' ? { done: true, known: false } : { done: true, known: true, dy: request.dy as number });
      if (request.do === 'find') return Promise.resolve(options.window === 'gone' ? { done: false, why: 'gone' } : { done: true, win: request.win as WatchWin });
      if (request.do === 'front') {
        if (options.front === 'lost') return Promise.reject(new Error('no answer'));
        if (options.front === 'off') return Promise.resolve(null);
        return Promise.resolve(options.front ? { done: true, win: options.front.win, app: options.front.app } : { done: false, why: 'gone' });
      }
      const answer: NotchActResult = request.do === 'copy' ? { done: true, empty: false, rows: 1, cols: 2, hash: 'h' } : { done: true };
      return Promise.resolve(answer);
    },
  };
  const db = new Database(':memory:');
  // What is written down of a job that was done (./actions.ts), in the same database.
  const actions = attachNotchActions(db, { log: () => {} });
  const jobs = attachNotchJobs(inbox, { db, hands, sleep: async () => {}, actions, log: () => {} });
  let recording = false;
  const shownSoFar: RawInteraction[] = [];
  const hearers = new Set<(interaction: RawInteraction, count: number) => void>();
  const calls: string[] = [];
  const ran: { skill: string; from: number }[] = [];
  let runEnd: { end: NotchJobEnd; next: number } = { end: { how: 'done' }, next: 3 };
  const teach = attachNotchTeach({
    inbox, jobs, hands, db, now: () => now, log: () => {},
    recorder: {
      async start() { calls.push('start'); if (options.start) return options.start; recording = true; return { ok: true }; },
      async stop() { calls.push('stop'); recording = false; return shownSoFar.splice(0); },
      onStep(listener) { hearers.add(listener); return () => { hearers.delete(listener); }; },
    },
    save(interactions) {
      calls.push(`save ${interactions.length}`);
      return options.save ?? { ok: true, skill: 'shown-notepad', steps: interactions.length, notes: interactions.map((it) => it.action), apps: ['Notepad', 'Excel'] };
    },
    describe: async () => (options.describe === undefined ? 'renames the file and saves it' : options.describe),
    forget(skill) { calls.push(`forget ${skill}`); },
    effect: () => ({ pays: false, deletes: false, missing: false, ...options.effect }),
    async runSkill(skill, from, run) { ran.push({ skill, from }); run.onProgress(runEnd.next); return runEnd; },
    count: options.left === undefined ? undefined : async () => options.left ?? null,
    byPlace: options.byPlace === undefined ? undefined : () => options.byPlace!,
    paused: options.paused,
    ...(options.catcher ? { catcher: () => options.catcher! } : {}),
  });
  const line = (): NotchLine | null => surface.current().line;
  const said = (): string => text(line()?.say);
  const reply = async (act: string, more: Record<string, unknown> = {}): Promise<void> => {
    fromPage({ type: 'answer', id: line()!.id, act, ...more });
    await settle();
  };
  const pass = async (ms: number): Promise<void> => {
    now += ms;
    for (const timer of [...timers]) if (timer.at <= now) { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); timer.fn(); }
    await settle();
  };
  /** The person does a step while being watched. */
  const does = async (interaction: RawInteraction): Promise<void> => {
    if (!recording) return;
    shownSoFar.push(interaction);
    for (const hear of [...hearers]) hear(interaction, shownSoFar.length);
    await settle();
  };
  /** Says something on the notch, as asking does: the words are routed, and what they set off is run. */
  const say = async (words: string): Promise<string | null> => {
    const route = teach.route(words);
    route?.run();
    await settle();
    return route?.did ?? null;
  };
  return {
    teach, jobs, sent, calls, ran, line, said, reply, pass, does, say, db, inbox, actions,
    setRunEnd: (end: { end: NotchJobEnd; next: number }) => { runEnd = end; },
    advance: (ms: number) => { now += ms; },
    now: () => now,
    acts: () => pushed.filter((message) => message.type === 'effect'),
  };
}

describe('showing Jarvis a job', () => {
  // The plan's test, step 1.
  test('"Watch me": it says it is watching, counts the steps, and "done" ends it', async () => {
    const h = harness();
    expect(await h.say('Watch me')).toBe('Began watching what you show me.');
    expect(h.calls).toEqual(['start']);
    expect(h.said()).toBe('Watching. Do it once by hand, then press done.');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'done', fold: 0 });
    expect(h.teach.watching()).toBe(true);
    await h.does({ action: 'click', ref: ref('File'), ts: 1, app: 'notepad' });
    expect(h.said()).toBe('Watching. Step 1: clicked File.');
    await h.does({ action: 'press_keys', value: 'ctrl,s', ts: 2, app: 'notepad' });
    expect(h.said()).toBe('Watching. Step 2: pressed Ctrl + S.');
    // A nod for each step it saw.
    expect(h.acts().length).toBe(2);
    await h.does({ action: 'set_value', ref: ref('File name'), value: 'notes', ts: 3, app: 'notepad' });
    await h.reply('yes');
    await settle();
    expect(h.calls).toEqual(['start', 'stop', 'save 3']);
    expect(h.teach.watching()).toBe(false);
    expect(h.said()).toBe('Learned it in 3 steps: renames the file and saves it. Do it every Monday at 9:00?');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'yes', mood: 'proud' });
  });

  test('saying "done" ends it as the key does', async () => {
    const h = harness();
    await h.say('Watch me');
    await h.does({ action: 'click', ref: ref('File'), ts: 1, app: 'notepad' });
    expect(await h.say('Done')).toBe('Ended the showing.');
    expect(h.calls).toEqual(['start', 'stop', 'save 1']);
    expect(h.said()).toContain('Learned it in 1 step');
    // With no showing under way, "done" is not the notch's word.
    await h.reply('no');
    await h.pass(4000);
    expect(h.teach.route('Done')).toBeNull();
  });

  test('Esc throws it away: nothing is saved', async () => {
    const h = harness();
    await h.say('Watch me');
    await h.does({ action: 'click', ref: ref('File'), ts: 1, app: 'notepad' });
    await h.reply('no');
    expect(h.calls).toEqual(['start', 'stop']);
    expect(h.line()).toBeNull();
    expect(h.teach.row()).toBeNull();
  });

  test('nothing shown, nothing learned', async () => {
    const h = harness();
    await h.say('Watch me');
    await h.reply('yes');
    expect(h.said()).toBe('I saw nothing to learn. Show me any time.');
    expect(h.calls).toEqual(['start', 'stop']);
  });

  test('when it cannot watch, it says why and is not watching', async () => {
    const h = harness({ start: { ok: false, why: 'Desktop control is switched off in settings, so I cannot watch.' } });
    await h.say('Watch me');
    expect(h.said()).toBe('Desktop control is switched off in settings, so I cannot watch.');
    expect(h.teach.watching()).toBe(false);
  });

  test('when it cannot be saved it says so, and is not left watching', async () => {
    const h = harness({ save: { ok: false, why: 'I could not make steps out of that. Nothing was saved.' } });
    await h.say('Watch me');
    await h.does({ action: 'click', ref: ref('File'), ts: 1, app: 'notepad' });
    await h.reply('yes');
    await settle();
    expect(h.said()).toBe('I could not make steps out of that. Nothing was saved.');
    expect(h.teach.row()).toBeNull();
    expect(h.teach.watching()).toBe(false);
  });

  test('with no model to name it, it is named by its steps and where they were', async () => {
    const h = harness({ describe: null });
    await h.say('Watch me');
    await h.does({ action: 'click', ref: ref('File'), ts: 1, app: 'notepad' });
    await h.reply('yes');
    await settle();
    expect(h.said()).toBe('Learned it in 1 step. Do it every Monday at 9:00?');
    expect(h.teach.row()).toMatchObject({ kind: 'row', id: 'learned' });
  });
});

describe('a job to do again at a time of the week', () => {
  async function learned(h: ReturnType<typeof harness>): Promise<void> {
    await h.say('Watch me');
    await h.does({ action: 'click', ref: ref('File'), ts: 1, app: 'notepad' });
    await h.does({ action: 'press_keys', value: 'ctrl,s', ts: 2, app: 'notepad' });
    await h.reply('yes');
    await settle();
  }

  test('the time can be changed where it is said, and a yes keeps it', async () => {
    const h = harness();
    await learned(h);
    await h.reply('word', { word: 'when', value: 'Friday at 16:00' });
    expect(h.said()).toBe('Learned it in 2 steps: renames the file and saves it. Do it every Friday at 16:00?');
    // A value that is not a time of the week changes nothing.
    await h.reply('word', { word: 'when', value: 'whenever' });
    expect(h.said()).toContain('every Friday at 16:00?');
    await h.reply('yes');
    // It asks first: a job that drives the screen does not start while nobody is looking.
    expect(h.said()).toBe('Every Friday at 16:00, I will ask you here and do it on your yes.');
    const row = h.db.query<{ schedule: string; next_at: number }, []>('SELECT schedule, next_at FROM notch_learned').get()!;
    expect(row.schedule).toBe('Friday at 16:00');
    expect(new Date(row.next_at)).toEqual(new Date(2026, 10, 20, 16, 0, 0));
  });

  test('at its time it asks, and does it on a yes', async () => {
    const h = harness();
    await learned(h);
    await h.reply('word', { word: 'when', value: 'day at 11:00' });
    await h.reply('yes');
    await h.pass(7000);
    // Not yet.
    h.teach.tick();
    await settle();
    expect(h.line()).toBeNull();
    h.advance(61 * 60_000);
    h.teach.tick();
    await settle();
    expect(h.said()).toBe('It is 11:00. Shall I do it now: renames the file and saves it?');
    // Its next time is tomorrow: it is not offered again a minute later.
    expect(new Date(h.db.query<{ next_at: number }, []>('SELECT next_at FROM notch_learned').get()!.next_at)).toEqual(new Date(2026, 10, 19, 11, 0, 0));
    await h.reply('yes');
    await settle();
    expect(h.ran).toEqual([{ skill: 'shown-notepad', from: 0 }]);
    expect(h.said()).toBe('Done. 3 steps.');
  });

  // Fix 05: a job done at its time leaves one entry in the list of what the notch did, with the yes it went on.
  test('done at its time on a yes, it is written down once: asked on a line, by the yes key', async () => {
    const h = harness();
    await learned(h);
    await h.reply('word', { word: 'when', value: 'day at 11:00' });
    await h.reply('yes');
    await h.pass(7000);
    h.advance(61 * 60_000);
    h.teach.tick();
    await settle();
    expect(h.actions.since(0)).toEqual([]);
    await h.reply('yes');
    await settle();
    expect(h.said()).toBe('Done. 3 steps.');
    expect(h.actions.since(0)).toHaveLength(1);
    expect(h.actions.since(0)[0]).toMatchObject({ kind: 'job_skill', outcome: 'done', what: expect.stringContaining('Did what you showed me: renames the file and saves it'), seen: 'line', how: 'key', fuseMs: null });
  });

  test('left alone at its time, nothing is done and nothing is written', async () => {
    const h = harness();
    await learned(h);
    await h.reply('word', { word: 'when', value: 'day at 11:00' });
    await h.reply('yes');
    await h.pass(7000);
    h.advance(61 * 60_000);
    h.teach.tick();
    await settle();
    await h.reply('no');
    await settle();
    expect(h.ran).toEqual([]);
    expect(h.actions.since(0)).toEqual([]);
  });

  test('a time that passed while nobody could be asked is not done late', async () => {
    const h = harness();
    await learned(h);
    await h.reply('word', { word: 'when', value: 'day at 11:00' });
    await h.reply('yes');
    await h.pass(7000);
    h.advance(60 * 60_000 + NOTCH_SCHEDULE_LATE_MS + 60_000);
    h.teach.tick();
    await settle();
    expect(h.line()).toBeNull();
    expect(h.ran).toEqual([]);
  });

  test('"no" keeps the job for when it is asked for', async () => {
    const h = harness();
    await learned(h);
    await h.reply('no');
    expect(h.said()).toBe('Kept. Say "run it" when you want it done.');
    await h.pass(4000);
    expect(await h.say('Run it')).toBe('Did the job again.');
    await settle();
    // Shown a moment ago: it is done with nothing asked.
    expect(h.ran).toEqual([{ skill: 'shown-notepad', from: 0 }]);
    // The same words when three minutes have gone by: it asks before it does (owner decision 5).
    await h.pass(8000);
    h.advance(NOTCH_TEACH_FRESH_MS);
    expect(await h.say('Run it')).toBe('Did the job again.');
    await settle();
    expect(h.said()).toBe('Do renames the file and saves it again?');
    expect(h.ran).toHaveLength(1);
    await h.reply('yes');
    await settle();
    expect(h.ran).toHaveLength(2);
  });

  test('a job that stopped half way goes on from the step it stopped at', async () => {
    const h = harness();
    await learned(h);
    await h.reply('no');
    await h.pass(4000);
    h.setRunEnd({ end: { how: 'failed', why: 'I could not find the next thing to click on the screen.' }, next: 1 });
    await h.say('run it');
    await settle();
    expect(h.said()).toBe('I stopped at 1 of 2. I could not find the next thing to click on the screen. What now?');
    h.setRunEnd({ end: { how: 'done' }, next: 2 });
    await h.reply('pick', { option: 'Go on', index: 0 });
    await settle();
    expect(h.ran).toEqual([{ skill: 'shown-notepad', from: 0 }, { skill: 'shown-notepad', from: 1 }]);
  });

  // A payment is never on a key.
  test('a job that pays is not run from the notch, and one that deletes asks first', async () => {
    const pays = harness({ effect: { pays: true } });
    await learned(pays);
    await pays.reply('no');
    await pays.pass(4000);
    await pays.say('run it');
    expect(pays.said()).toBe('That job pays for something. I do not do that from here.');
    expect(pays.ran).toEqual([]);

    const deletes = harness({ effect: { deletes: true } });
    await learned(deletes);
    await deletes.reply('no');
    await deletes.pass(4000);
    await deletes.say('run it');
    expect(deletes.said()).toBe('That job deletes something. Do it?');
    expect(deletes.ran).toEqual([]);
    await deletes.reply('yes');
    await settle();
    expect(deletes.ran.length).toBe(1);
  });

  test('"run it" with nothing ever shown is an instruction like any other', () => {
    const h = harness();
    expect(h.teach.route('Run it on nine rows')).toBeNull();
    expect(h.teach.route('What is on my calendar')).toBeNull();
  });
});

describe('the same thing shown twice', () => {
  async function twoRows(h: ReturnType<typeof harness>): Promise<void> {
    await h.say('Watch me');
    for (const step of [...rowShown(0, h.now()), ...rowShown(1, h.now() + 10)]) await h.does(step);
    await h.reply('yes');
    await settle();
  }

  test('it says so, and offers to go on from there', async () => {
    const h = harness({ left: 7 });
    await twoRows(h);
    expect(h.said()).toBe('Learned it in 4 steps, done twice. I can take it from here: 7 left.');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'take over' });
    await h.reply('yes');
    await settle();
    // The third row: one on from the last one shown.
    expect(h.sent.find((request) => request.do === 'click')).toEqual({ do: 'click', win: FILE, x: 120, y: 244, hand: 0 });
    expect(h.said()).toBe('Done. 7 pasted.');
  });

  // The plan's test, step 2.
  test('"Run it on nine rows" does nine, from where the showing ended', async () => {
    const h = harness({ left: null });
    await twoRows(h);
    expect(h.said()).toBe('Learned it in 4 steps, done twice. I can take it from here.');
    await h.reply('no');
    expect(await h.say('Run it on nine rows')).toBe('Did the job again.');
    await settle();
    expect(h.sent.filter((request) => request.do === 'keys' && request.keys === 'ctrl,v').length).toBe(9);
    expect(h.said()).toBe('Done. 9 pasted.');
    // Asked again, it goes on after the nine, not from the beginning.
    h.sent.length = 0;
    await h.pass(5000);
    await h.say('do three more');
    await settle();
    expect(h.sent.find((request) => request.do === 'click')).toMatchObject({ win: FILE, y: 200 + 22 * 11 });
  });

  test('where the rows cannot be seen it keeps what it learned, and does not offer to go on', async () => {
    const h = harness({ left: 7, rows: 'unseen' });
    await twoRows(h);
    expect(h.said()).toBe('Learned it in 4 steps, done twice. I cannot see the rows clearly enough there to go on by myself.');
    expect(h.line()).toMatchObject({ kind: 'say' });
    expect(h.sent.filter((request) => request.do === 'click').length).toBe(0);
    // The job is kept all the same.
    expect(h.teach.row()).toMatchObject({ id: 'learned' });
  });

  test('too long after, it does not guess where the rows are now', async () => {
    const h = harness({ left: null });
    await twoRows(h);
    await h.reply('no');
    h.advance(4 * 60_000);
    await h.say('Run it on nine rows');
    expect(h.said()).toBe('Do one by hand first, then say it again. I go on from where you are.');
    expect(h.sent.filter((request) => request.do === 'click').length).toBe(0);
  });
});

describe('a shown job is done again where it was done', () => {
  test('what was shown is kept as places: clicks, keys, and what a field held', () => {
    expect(teachPlaced([
      { action: 'click', ref: ref('File'), ts: 1, app: 'TextEdit', win: FILE, pt: { x: 40, y: 12 }, mods: 'cmd' },
      { action: 'press_keys', value: 'cmd,s', ts: 2, app: 'TextEdit', win: FILE },
      { action: 'set_value', ref: ref('Save As'), value: 'notes', ts: 3, app: 'TextEdit', win: FILE },
      { action: 'set_value', ref: ref('Tags'), value: '', ts: 4, app: 'TextEdit', win: FILE },
      { action: 'set_value', ref: ref('Password'), value: '{{REDACTED}}', secure: true, ts: 5, app: 'TextEdit', win: FILE },
    ])).toEqual([
      { kind: 'click', app: 'TextEdit', win: FILE, x: 40, y: 12, mods: 'cmd' },
      { kind: 'keys', app: 'TextEdit', win: FILE, keys: 'cmd,s' },
      { kind: 'type', app: 'TextEdit', win: FILE, text: 'notes' },
      // A field left empty typed nothing. A password was never kept: the step is the person's.
      { kind: 'secret' },
    ]);
  });

  test('a job with a step that has no place is not kept as places at all: half a job is worse than none', () => {
    const click: RawInteraction = { action: 'click', ref: ref('File'), ts: 1, app: 'TextEdit', win: FILE, pt: { x: 40, y: 12 } };
    for (const odd of [
      { action: 'click', ref: ref('File'), ts: 2 } as RawInteraction,                                  // told with no window
      { action: 'click', ref: ref('File'), ts: 2, win: FILE, pt: { x: 4000, y: 12 } } as RawInteraction, // outside its window
      { action: 'launch_app', value: 'TextEdit', ts: 2 } as RawInteraction,
      { action: 'press_keys', value: 'a', ts: 2, win: FILE } as RawInteraction,                        // a key that types
      { action: 'set_value', ref: ref('Body'), value: 'x'.repeat(NOTCH_PLACED_TEXT_MAX + 1), ts: 2, win: FILE } as RawInteraction,
    ]) expect(teachPlaced([click, odd])).toBeNull();
    expect(teachPlaced([])).toBeNull();
  });

  async function shown(h: ReturnType<typeof harness>): Promise<void> {
    await h.say('Watch me');
    await h.does({ action: 'click', ref: ref('File'), ts: 1, app: 'TextEdit', win: FILE, pt: { x: 40, y: 12 } });
    await h.does({ action: 'press_keys', value: 'cmd,s', ts: 2, app: 'TextEdit', win: FILE });
    await h.reply('yes');
    await settle();
    await h.reply('no');
    await h.pass(4000);
  }

  test('"run it" does the steps at their places, and not through the product\'s own replay', async () => {
    const h = harness({ byPlace: true });
    await shown(h);
    await h.say('run it');
    await settle();
    expect(h.ran).toEqual([]);
    expect(h.sent).toEqual([
      { do: 'find', app: 'TextEdit', win: FILE, front: true },
      { do: 'click', win: FILE, x: 40, y: 12, hand: 0 },
      { do: 'keys', win: FILE, keys: 'cmd,s' },
      { do: 'home' },
    ]);
    expect(h.said()).toBe('Done. 2 steps.');
    // Fix 05: asked for in words, with no line before it. That is what is written down of it.
    expect(h.actions.since(0)).toMatchObject([{ kind: 'job_skill', outcome: 'done', seen: 'nothing', how: 'said' }]);
  });

  test('asked for in words a model read: the line is put first, and the job is written down as a yes on that line', async () => {
    const h = harness({ byPlace: true });
    await shown(h);
    const intent = h.teach.intents().find((one) => one.id === 'teach.run')!;
    intent.match('run it', { source: 'typed', at: 0, read: true })!.run();
    await settle();
    expect(h.said()).toBe('Do renames the file and saves it again?');
    expect(h.actions.since(0)).toEqual([]);
    await h.reply('yes');
    await settle();
    expect(h.said()).toBe('Done. 2 steps.');
    expect(h.actions.since(0)).toMatchObject([{ kind: 'job_skill', outcome: 'done', seen: 'line', how: 'key' }]);
  });

  // Fix 05: a job begun by hand and never shown is the catcher's. Asked for in words a model read, its line
  // was put and said yes to, and the catcher wrote it down as said with nothing shown.
  test('asked for in words a model read, a job the catcher has is handed the yes on its line', async () => {
    const took: unknown[][] = [];
    const catcher: NotchCatch = {
      last: () => ({}) as ReturnType<NotchCatch['last']>,
      take: async (...args) => { took.push(args); return 'started'; },
      reset() {}, stop() {},
    };
    const h = harness({ catcher });
    const intent = h.teach.intents().find((one) => one.id === 'teach.run')!;
    intent.match('do the rest', { source: 'typed', at: 0, read: true })!.run();
    await settle();
    expect(h.said()).toBe('Go on with what you began?');
    expect(took).toEqual([]);
    await h.reply('yes');
    await settle();
    expect(took).toEqual([[null, { seen: 'line', how: 'key' }]]);
  });

  test('asked for by the fixed words, a job the catcher has is handed "said, nothing shown"', async () => {
    const took: unknown[][] = [];
    const catcher: NotchCatch = {
      last: () => ({}) as ReturnType<NotchCatch['last']>,
      take: async (...args) => { took.push(args); return 'started'; },
      reset() {}, stop() {},
    };
    const h = harness({ catcher });
    await h.say('do the rest');
    expect(took).toEqual([[null, { seen: 'nothing', how: 'said' }]]);
  });

  // The owner's first "run it", 16 November 2026: a job shown in a sheet in a
  // browser stopped at "0 of 12. I could not find the next thing to click".
  // A field on a page has no name to be found by. Where it was typed is known.
  test('on Windows too, when the window is there as it was: words typed into a page, and Enter', async () => {
    const h = harness({ byPlace: false });
    await h.say('Watch me');
    await h.does({ action: 'set_value', ref: ref(''), value: '12', ts: 1, app: 'chrome', win: SHEET });
    await h.does({ action: 'press_keys', value: 'enter', ts: 2, app: 'chrome', win: SHEET });
    await h.does({ action: 'set_value', ref: ref(''), value: '15', ts: 3, app: 'chrome', win: SHEET });
    await h.does({ action: 'press_keys', value: 'enter', ts: 4, app: 'chrome', win: SHEET });
    await h.reply('yes');
    await settle();
    await h.reply('no');
    await h.pass(4000);
    await h.say('run it');
    await settle();
    // Not through the replay that looks for each thing by its name.
    expect(h.ran).toEqual([]);
    expect(h.sent).toEqual([
      // Asked first whether the window is there: that touches nothing.
      { do: 'find', app: 'chrome', win: SHEET },
      // Then for real, and brought forward: what is typed goes to whichever window is in front.
      { do: 'find', app: 'chrome', win: SHEET, front: true },
      { do: 'type', win: SHEET, text: '12' },
      { do: 'keys', win: SHEET, keys: 'enter' },
      { do: 'type', win: SHEET, text: '15' },
      { do: 'keys', win: SHEET, keys: 'enter' },
      { do: 'home' },
    ]);
    expect(h.said()).toBe('Done. 4 steps.');
  });

  test('with the window gone or another size, each thing is looked for by its name instead', async () => {
    const h = harness({ byPlace: false, window: 'gone' });
    await shown(h);
    await h.say('run it');
    await settle();
    expect(h.ran).toEqual([{ skill: 'shown-notepad', from: 0 }]);
    expect(h.sent.some((request) => request.do === 'click' || request.do === 'keys')).toBe(false);
  });

  test('a job with a step that has no place is done by name, where that can be done', async () => {
    const h = harness({ byPlace: false });
    await h.say('Watch me');
    await h.does({ action: 'click', ref: ref('File'), ts: 1, app: 'Notepad' });
    await h.reply('yes');
    await settle();
    await h.reply('no');
    await h.pass(4000);
    await h.say('run it');
    await settle();
    expect(h.ran).toEqual([{ skill: 'shown-notepad', from: 0 }]);
    // Nothing is pressed by place: the pointer only goes home when the job is over.
    expect(h.sent.filter((request) => request.do !== 'pitch' && request.do !== 'home')).toEqual([]);
  });

  test('a job with a step that has no place says so, and does nothing', async () => {
    const h = harness({ byPlace: true });
    await h.say('Watch me');
    await h.does({ action: 'click', ref: ref('File'), ts: 1, app: 'TextEdit' });
    await h.reply('yes');
    await settle();
    await h.reply('no');
    await h.pass(4000);
    await h.say('run it');
    expect(h.said()).toBe('I cannot do that one again here: one of its steps has no place I can go back to. Show me again, with clicks and keys only.');
    expect(h.sent.filter((request) => request.do !== 'pitch')).toEqual([]);
  });

  // Owner decision 5, 26 November 2026: "do it again" with nothing of the job fresh acts at once only when the
  // job's window is in front. Otherwise it shows a line and waits for the yes.
  describe('asked for by words alone, some time after it was shown', () => {
    const acted = (h: ReturnType<typeof harness>): Record<string, unknown>[] => h.sent.filter((request) => !['front', 'find', 'pitch'].includes(request.do as string));
    /** More than the three minutes a job counts as only just shown. */
    const LATER = NOTCH_TEACH_FRESH_MS + 1000;
    /** Shown, and then left for a while. */
    const shownEarlier = async (h: ReturnType<typeof harness>): Promise<void> => { await shown(h); h.advance(LATER); };

    test('for three minutes after it was shown it is done at once, as it always was; one moment later it asks', async () => {
      const h = harness({ byPlace: false, front: { app: 'chrome', win: SHEET } });
      await shown(h);
      h.advance(NOTCH_TEACH_FRESH_MS - 4000 - 1000);
      await h.say('do it again');
      await settle();
      expect(acted(h).map((request) => request.do)).toEqual(['click', 'keys', 'home']);
      // Nothing was asked of the machine to find out: it was only just shown.
      expect(h.sent.filter((request) => request.do === 'front')).toEqual([]);
      await h.pass(8000);
      h.advance(2000);
      await h.say('do it again');
      await settle();
      expect(h.said()).toBe('Do renames the file and saves it again?');
      expect(acted(h)).toHaveLength(3);
    });

    test('another window of the same program at the same size is not its window: it asks', async () => {
      // Two browser windows, both as large as the screen: the job was shown in one, and the other is in front.
      for (const win of [{ id: '0x99', pid: FILE.pid, w: FILE.w, h: FILE.h }, { id: FILE.id, pid: 4321, w: FILE.w, h: FILE.h }]) {
        const h = harness({ byPlace: false, front: { app: 'TextEdit', win } });
        await shownEarlier(h);
        await h.say('do it again');
        await settle();
        expect([win.id, h.said()]).toEqual([win.id, 'Do renames the file and saves it again?']);
        expect(acted(h)).toEqual([]);
      }
    });

    test('its window gone, and one that looks like it in front: it asks, and does not take the lookalike for it', async () => {
      const h = harness({ byPlace: false, window: 'gone', front: { app: 'TextEdit', win: { id: '0x99', pid: 4321, w: FILE.w, h: FILE.h } } });
      await shownEarlier(h);
      await h.say('run it');
      await settle();
      expect(h.said()).toBe('Do renames the file and saves it again?');
      expect([acted(h), h.ran]).toEqual([[], []]);
      // Nothing was looked for before the yes.
      expect(h.sent.filter((request) => request.do === 'find')).toEqual([]);
    });

    test('with another window in front it asks, does nothing until the yes, and nothing at all on a no', async () => {
      const h = harness({ byPlace: false, front: { app: 'chrome', win: SHEET } });
      await shownEarlier(h);
      expect(await h.say('do it again')).toBe('Did the job again.');
      await settle();
      expect(h.said()).toBe('Do renames the file and saves it again?');
      expect(h.line()).toMatchObject({ kind: 'offer', yes: 'do it' });
      expect([acted(h), h.ran, h.jobs.busy()]).toEqual([[], [], false]);
      await h.reply('no');
      await h.pass(5000);
      expect([acted(h), h.ran, h.jobs.busy()]).toEqual([[], [], false]);
      // And it is asked again the next time: a no is not remembered as a yes, nor a yes for the next time.
      await h.say('run it');
      await settle();
      expect(h.said()).toBe('Do renames the file and saves it again?');
      await h.reply('yes');
      await settle();
      expect(acted(h).map((request) => request.do)).toEqual(['click', 'keys', 'home']);
      await h.pass(8000);
      await h.say('do it');
      await settle();
      expect(h.said()).toBe('Do renames the file and saves it again?');
    });

    test('with its own window in front it is done at once, and nothing is asked', async () => {
      const h = harness({ byPlace: false, front: { app: 'TextEdit', win: FILE } });
      await shownEarlier(h);
      await h.say('do it again');
      await settle();
      expect(acted(h).map((request) => request.do)).toEqual(['click', 'keys', 'home']);
      expect(h.said()).toBe('Done. 2 steps.');
    });

    test('when the machine cannot say which window is in front, it asks', async () => {
      for (const front of [undefined, 'lost', 'off'] as const) {
        const h = harness({ byPlace: false, front });
        await shownEarlier(h);
        await h.say('do it');
        await settle();
        expect([front, h.said()]).toEqual([front, 'Do renames the file and saves it again?']);
        expect(acted(h)).toEqual([]);
      }
    });

    test('where a job is only ever done by place (a Mac), it still asks when its window is not in front', async () => {
      const h = harness({ byPlace: true, front: { app: 'Safari', win: SHEET } });
      await shownEarlier(h);
      await h.say('run it');
      await settle();
      expect(h.said()).toBe('Do renames the file and saves it again?');
      // Its window was not brought forward to find out.
      expect(h.sent.filter((request) => request.do === 'find')).toEqual([]);
      await h.reply('yes');
      await settle();
      expect(acted(h).map((request) => request.do)).toEqual(['click', 'keys', 'home']);
    });

    test('everything stopped between the question and the yes: the yes does nothing', async () => {
      let paused = false;
      const h = harness({ byPlace: false, paused: () => paused });
      await shownEarlier(h);
      await h.say('run it');
      await settle();
      expect(h.said()).toBe('Do renames the file and saves it again?');
      paused = true;
      await h.reply('yes');
      await settle();
      expect(h.said()).toBe('Everything is stopped. Wake me first.');
      expect([acted(h), h.ran]).toEqual([[], []]);
    });

    test('a job that deletes is asked about once, not twice, wherever its window is', async () => {
      for (const front of [{ app: 'TextEdit', win: FILE }, { app: 'chrome', win: SHEET }]) {
        const h = harness({ byPlace: false, front, effect: { deletes: true } });
        await shownEarlier(h);
        await h.say('run it');
        await settle();
        expect(h.said()).toBe('That job deletes something. Do it?');
        await h.reply('yes');
        await settle();
        expect(acted(h).map((request) => request.do)).toEqual(['click', 'keys', 'home']);
      }
    });

    test('pressed on its own row, it is done as before: the press is the asking', async () => {
      const h = harness({ byPlace: false, front: { app: 'chrome', win: SHEET } });
      await shownEarlier(h);
      await h.pass(7000);
      h.inbox.present('home', (stage) => h.teach.open(stage));
      await settle();
      expect(h.said()).toBe('Jobs you showed me: 1');
      await h.reply('button', { row: h.db.query<{ id: string }, []>('SELECT id FROM notch_learned').get()!.id, button: 'run' });
      for (let round = 0; round < 4; round++) { await settle(); await h.pass(10); }
      await settle();
      expect(acted(h).map((request) => request.do)).toEqual(['click', 'keys', 'home']);
      expect(h.sent.filter((request) => request.do === 'front')).toEqual([]);
      // Fix 05: pressed on its row of the sheet. That is what is written down of it.
      expect(h.actions.since(0)).toMatchObject([{ kind: 'job_skill', outcome: 'done', seen: 'sheet', how: 'pick' }]);
    });
  });

  test('how a Mac shortcut is said', () => {
    expect(keysSaid('cmd,shift,v')).toBe('Cmd + Shift + V');
    expect(teachStepSaid({ action: 'press_keys', value: 'cmd,c', ts: 1 })).toBe('pressed Cmd + C');
  });
});

describe('where a round has got to', () => {
  test('after Jarvis did some, the next one begins that much further on', () => {
    const shapes = teachShapes([...rowShown(0, 1000), ...rowShown(1, 2000)]);
    const rounds = findRounds(shapes)!;
    const on = advanceRounds(rounds, 5, 9000);
    expect(on.at).toBe(9000);
    expect(on.steps[0]).toMatchObject({ kind: 'click', x: 120, y: 222 + 5 * 22, dy: 22 });
    expect(on.steps[2]).toMatchObject({ kind: 'click', x: 300, y: 420 + 5 * 20, dy: 20 });
  });
});

describe('the jobs it was shown, in Home', () => {
  test('there is a row for them once there is one', async () => {
    const h = harness();
    expect(h.teach.row()).toBeNull();
    await h.say('Watch me');
    await h.does({ action: 'click', ref: ref('File'), ts: 1, app: 'notepad' });
    await h.reply('yes');
    await settle();
    expect(text((h.teach.row() as { say: NotchPart[] }).say)).toBe('1 job you showed me.');
  });

  test('the sheet lists them; one can be taken off its time, and forgetting one asks first', async () => {
    const h = harness();
    await h.say('Watch me');
    await h.does({ action: 'click', ref: ref('File'), ts: 1, app: 'notepad' });
    await h.reply('yes');
    await settle();
    await h.reply('yes');
    await h.pass(7000);
    h.inbox.present('home', (stage) => h.teach.open(stage));
    await settle();
    const rows = (): { id?: string; small?: string; buttons?: { id: string }[] }[] => {
      const now = h.line();
      return now && 'blocks' in now ? (now.blocks as { id?: string; small?: string; buttons?: { id: string }[] }[]) : [];
    };
    expect(h.said()).toBe('Jobs you showed me: 1');
    expect(rows()[0]).toMatchObject({ small: 'every Monday at 9:00' });
    expect(rows()[0]!.buttons!.map((button) => button.id)).toEqual(['run', 'unschedule', 'forget']);
    const id = rows()[0]!.id!;
    await h.reply('button', { button: 'unschedule', row: id });
    expect(rows()[0]).toMatchObject({ small: 'on request' });
    expect(rows()[0]!.buttons!.map((button) => button.id)).toEqual(['run', 'forget']);
    // A delete asks.
    await h.reply('button', { button: 'forget', row: id });
    expect(h.said()).toBe('Forget renames the file and saves it?');
    expect(h.calls).not.toContain('forget shown-notepad');
    await h.reply('yes');
    expect(h.calls).toContain('forget shown-notepad');
    expect(h.teach.row()).toBeNull();
    expect(h.said()).toBe('Jobs you showed me: 0');
  });
});
