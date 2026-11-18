import { describe, expect, test } from 'bun:test';
import { NOTCH_DAY_ONE_ORDER, attachNotchDayOne, type NotchDayOne, type NotchDayOneStep } from './dayone.ts';
import { NotchSettings } from './settings.ts';
import { Database } from 'bun:sqlite';
import type { BriefChatEvent, BriefChatPayload, BriefTurnRef, BriefTurnState } from '../brief/contracts.ts';
import { NOTCH_HEARD_MS, NOTCH_NOT_CAUGHT, NotchFilesNotKept, answerShape, attachNotchAsks, ledgerDetail, ledgerWord, plainLines, rememberSentence } from './asks.ts';
import type { NotchAskFile, NotchAsksDeps, NotchRemembered, NotchTurnDoor } from './asks.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchItem } from './inbox.ts';
import { NotchLedger } from './ledger.ts';
import type { NotchAnswerAct, NotchLine, NotchToPage } from './protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** A turn store that does what it is told, turn by turn. */
function fakeDoor() {
  const listeners = new Set<(event: BriefChatEvent) => void>();
  const turns = new Map<string, { ref: BriefTurnRef; text: string; state: BriefTurnState; reply: string; error?: { code: string; message: string } }>();
  let sequence = 0;
  let busy = false;
  let ready = true;
  const marks: string[] = [];
  const emit = (turnId: string, payload: BriefChatPayload): void => {
    const turn = turns.get(turnId)!;
    if (payload.kind === 'delta') turn.reply += payload.text;
    if (payload.kind === 'terminal') { turn.state = payload.state; turn.error = payload.error; }
    for (const listener of [...listeners]) listener({ ...turn.ref, eventId: `e${++sequence}`, sequence, payload });
  };
  const door: NotchTurnDoor = {
    ready: () => ready,
    conversation: () => 'conv-notch',
    submit(turn) {
      if (busy) throw Object.assign(new Error('Conversation already has an active turn'), { status: 409 });
      if (turns.has(turn.turnId)) return;
      turns.set(turn.turnId, { ref: { conversationId: turn.conversationId, turnId: turn.turnId, requestId: turn.requestId }, text: turn.text, state: 'running', reply: '' });
    },
    cancel(ref) { if (turns.get(ref.turnId)?.state === 'running') emit(ref.turnId, { kind: 'terminal', state: 'cancelled' }); },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    look(ref) { const turn = turns.get(ref.turnId); return turn ? { state: turn.state, text: turn.reply, error: turn.error } : null; },
    mark(ref, text) { marks.push(`${ref.turnId}: ${text}`); },
  };
  return {
    door, turns, emit, marks,
    setBusy: (value: boolean) => { busy = value; },
    setReady: (value: boolean) => { ready = value; },
    /** The one turn that is running. */
    running: (): string => [...turns.values()].find((turn) => turn.state === 'running')!.ref.turnId,
    say: (turnId: string, text: string) => emit(turnId, { kind: 'delta', messageId: 'm', text }),
    activity: (turnId: string, summary: string, phase: 'started' | 'completed' = 'started') =>
      emit(turnId, { kind: 'activity', activity: { activityId: `a${sequence}`, phase, summary, refs: [] } }),
    end: (turnId: string, state: 'completed' | 'failed' | 'cancelled' = 'completed', error?: { code: string; message: string }) =>
      emit(turnId, { kind: 'terminal', state, ...(error ? { error } : {}) }),
    texts: (): string[] => [...turns.values()].map((turn) => turn.text),
  };
}

function harness(options: { deps?: Partial<NotchAsksDeps>; db?: Database; page?: boolean } = {}) {
  const pushed: NotchToPage[] = [];
  const logs: string[] = [];
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({ pushed: true }); },
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
  const db = options.db ?? new Database(':memory:');
  const ledger = new NotchLedger(db);
  const door = fakeDoor();
  const opened: (string | null)[] = [];
  const raised: string[] = [];
  const withdrawn: string[] = [];
  let shakes = 0;
  let asks!: ReturnType<typeof attachNotchAsks>;
  const inbox = new NotchInbox(surface, { clock, log: (line) => logs.push(line), home: (stage) => asks.home(stage) });
  asks = attachNotchAsks(inbox, {
    ledger, turns: () => door.door, modelReady: () => true, log: (line) => logs.push(line),
    openDashboard: (sidecarId) => { opened.push(sidecarId); },
    raiseApproval: (id) => { raised.push(id); },
    withdrawApproval: (id) => { withdrawn.push(id); },
    attention: () => { shakes++; },
    today: () => [{ kind: 'note', say: ['Nothing done yet today.'] }],
    ...options.deps,
  });
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  if (options.page !== false) fromPage({ type: 'hello', v: 1 });
  const line = (): NotchLine | null => surface.current().line;
  const text = (parts: NotchLine['say'] | undefined): string =>
    (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
  return {
    surface, inbox, asks, ledger, door, db, pushed, logs, opened, raised, withdrawn, shakes: () => shakes, line, fromPage,
    said: (): string => text(line()?.say),
    count: (): number => surface.current().count,
    async answer(act: NotchAnswerAct, more: Record<string, unknown> = {}): Promise<void> {
      const id = line()?.id;
      if (!id) throw new Error('nothing is on the notch');
      fromPage({ type: 'answer', id, act, ...more });
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
    /** Types `words` into Home and sends them. */
    async type(words: string): Promise<void> {
      fromPage({ type: 'open' });
      await settle();
      if (line()?.kind !== 'ask') throw new Error(`Home is not open: ${line()?.kind}`);
      fromPage({ type: 'answer', id: line()!.id, act: 'ask', text: words });
      await settle();
    },
    /** Speaks `words`: keys down, keys up, the words arrive, and the moment they are shown passes. */
    async speak(talkId: string, words: string): Promise<void> {
      asks.listen(talkId);
      await settle();
      asks.released(talkId);
      await settle();
      asks.words(talkId, words);
      await settle();
    },
  };
}

type H = ReturnType<typeof harness>;
const row = (h: H, at = 0) => h.ledger.recent(10)[at]!;

describe('typing in Home', () => {
  test('yes at rest opens the text field, with today under it', async () => {
    const h = harness();
    await h.open();
    expect(h.line()).toMatchObject({ kind: 'ask', placeholder: 'Ask, or tell me what to do' });
    expect(h.line()?.unasked).toBeUndefined();
  });

  test('what is typed becomes one stored turn, and its short answer is said as one line', async () => {
    const h = harness();
    await h.type('what is two plus two?');
    expect(h.line()).toMatchObject({ kind: 'work', steps: 0 });
    expect(h.said()).toBe('On it: what is two plus two?');
    expect(h.door.texts()).toEqual(['what is two plus two?']);
    const turn = h.door.running();
    h.door.say(turn, 'It is four.');
    h.door.end(turn);
    await settle();
    expect(h.line()).toMatchObject({ kind: 'say' });
    expect(h.said()).toBe('It is four.');
    expect(row(h)).toMatchObject({ source: 'typed', state: 'done', kind: 'turn', heard: 'what is two plus two?', answer: 'It is four.', seenAt: null });
    await h.answer('done');
    expect(h.line()).toBeNull();
    expect(row(h).seenAt).not.toBeNull();
    expect(h.count()).toBe(0);
  });

  test('the request carries the instruction\'s id, so the store can refuse it a second time', async () => {
    const h = harness();
    await h.type('hello');
    const id = row(h).id;
    expect(row(h)).toMatchObject({ turnId: `notch-${id}`, requestId: `notch-typed-${id}`, conversationId: 'conv-notch' });
  });

  test('what it does while it works is shown, and written down in order', async () => {
    const h = harness();
    await h.type('check the disk');
    const turn = h.door.running();
    h.door.say(turn, 'Looking into it now.');
    h.door.activity(turn, 'Running a command.');
    await settle();
    expect(h.said()).toBe('Running a command.');
    h.door.activity(turn, 'Running a command.', 'completed');
    h.door.say(turn, 'The disk is half full.');
    h.door.end(turn);
    await settle();
    // The acknowledgment before the work is not the answer.
    expect(h.said()).toBe('The disk is half full.');
    expect(row(h)).toMatchObject({ did: ['Running a command.'], answer: 'The disk is half full.' });
  });

  test('a long answer opens as a sheet and stays until it is closed', async () => {
    const h = harness();
    await h.type('explain it');
    const turn = h.door.running();
    h.door.say(turn, '## Three things\n\n- **First**, this.\n- Second, `that`.\n\nAnd a last paragraph that says more.');
    h.door.end(turn);
    await settle();
    const line = h.line();
    expect(line).toMatchObject({ kind: 'sheet' });
    expect(h.said()).toBe('You asked: explain it');
    const paper = line?.kind === 'sheet' ? line.blocks.find((block) => block.kind === 'paper') : null;
    expect(paper?.kind === 'paper' ? paper.lines.map((parts) => parts.join('')) : []).toEqual(
      ['Three things', '• First, this.', '• Second, that.', 'And a last paragraph that says more.']);
    await h.advance(60_000);
    expect(h.line()?.kind).toBe('sheet');
    expect(row(h).seenAt).toBeNull();
    await h.answer('button', { button: 'dashboard' });
    expect(h.opened).toEqual(['pc']);
    expect(h.line()?.kind).toBe('sheet');
    await h.answer('no');
    expect(row(h).seenAt).not.toBeNull();
  });

  test('Esc while it works stops the turn, and says so', async () => {
    const h = harness();
    await h.type('do something long');
    await h.answer('stop');
    expect(h.said()).toBe('Stopped. What was already done stays done.');
    expect(row(h).state).toBe('stopped');
    expect([...h.door.turns.values()][0]!.state).toBe('cancelled');
  });

  test('a turn that fails says why in one line', async () => {
    const h = harness();
    await h.type('do it');
    h.door.end(h.door.running(), 'failed', { code: 'provider', message: 'This response could not finish. You can send a new message to try again.' });
    await settle();
    expect(h.line()).toMatchObject({ kind: 'say', mark: 'fail' });
    expect(h.said()).toContain('could not finish');
    expect(row(h)).toMatchObject({ state: 'failed' });
  });

  test('with no model set up nothing is started, and yes opens the dashboard', async () => {
    const h = harness({ deps: { modelReady: () => false } });
    await h.type('hello');
    expect(h.line()?.kind).toBe('offer');
    expect(h.said()).toContain('No model is set up yet');
    expect(h.door.texts()).toEqual([]);
    expect(row(h)).toMatchObject({ state: 'refused', note: 'no_model' });
    await h.answer('yes');
    expect(h.opened).toEqual(['pc']);
  });

  test('while one thing runs a second is not started, and says what is still running', async () => {
    const h = harness();
    await h.type('first thing');
    h.asks.typed('second thing');
    await settle();
    expect(h.said()).toBe('I am still on the last thing: first thing');
    expect(h.door.texts()).toEqual(['first thing']);
    expect(row(h)).toMatchObject({ heard: 'second thing', state: 'refused' });
    // The first one gets the notch back, and is still running.
    await h.answer('done');
    expect(h.line()).toMatchObject({ kind: 'work' });
    expect(h.said()).toBe('On it: first thing');
  });

  test('a conversation the dashboard is using refuses the turn, and it is written down as failed', async () => {
    const h = harness();
    h.door.setBusy(true);
    await h.type('hello');
    expect(h.said()).toContain('busy with something sent from the dashboard');
    expect(row(h)).toMatchObject({ state: 'failed' });
  });

  test('while everything is stopped nothing is started', async () => {
    const h = harness({ deps: { paused: () => true } });
    h.asks.typed('do it');
    await settle();
    expect(h.door.texts()).toEqual([]);
    expect(row(h)).toMatchObject({ state: 'refused', note: 'Everything is stopped. Wake me first.' });
  });
});

describe('speaking', () => {
  test('the words are shown as heard, stay a moment, and then run as the same kind of turn', async () => {
    const h = harness();
    h.asks.listen('t1');
    await settle();
    expect(h.line()).toMatchObject({ kind: 'listen', heard: '' });
    // The person started it: no dead time on its first line.
    expect(h.line()?.unasked).toBeUndefined();
    h.asks.released('t1');
    await settle();
    expect(row(h).state).toBe('transcribing');
    // The keys are up: the line no longer asks to let go.
    expect(h.line()).toMatchObject({ kind: 'listen', over: true });
    h.asks.words('t1', 'what is two plus two');
    await settle();
    expect(h.line()).toMatchObject({ kind: 'listen', heard: 'what is two plus two' });
    expect(h.door.texts()).toEqual([]);
    await h.advance(900);
    expect(h.line()).toMatchObject({ kind: 'work' });
    expect(h.door.texts()).toEqual(['what is two plus two']);
    expect(row(h)).toMatchObject({ source: 'spoken', state: 'running', requestId: `notch-spoken-${row(h).id}` });
  });

  test('said and typed, the same words make the same turn', async () => {
    const said = harness(), typed = harness();
    await said.speak('t1', 'send Leo the numbers');
    await said.advance(900);
    await typed.type('send Leo the numbers');
    expect(said.door.texts()).toEqual(typed.door.texts());
    expect(said.said()).toBe(typed.said());
  });

  test('silence and too little say the same sentence, and nothing runs', async () => {
    for (const why of ['silence', 'too_little'] as const) {
      const h = harness();
      h.asks.listen('t1');
      await settle();
      h.asks.nothing('t1', why);
      await settle();
      expect(h.said()).toBe(NOTCH_NOT_CAUGHT);
      expect(h.door.texts()).toEqual([]);
      expect(row(h)).toMatchObject({ state: 'missed', note: why });
    }
  });

  test('with no speech-to-text set up it says so after the same sentence', async () => {
    const h = harness();
    h.asks.listen('t1');
    await settle();
    h.asks.nothing('t1', 'no_stt');
    await settle();
    expect(h.said()).toBe(`${NOTCH_NOT_CAUGHT} Speech-to-text is not set up yet: add a key in the dashboard.`);
  });

  test('Esc while the words are shown turns them away: they never run', async () => {
    const h = harness();
    await h.speak('t1', 'delete everything');
    await h.answer('no');
    expect(h.line()).toBeNull();
    await h.advance(5000);
    expect(h.door.texts()).toEqual([]);
    expect(row(h)).toMatchObject({ state: 'dismissed', heard: 'delete everything' });
  });

  test('Esc while still listening turns the recording away, and its words arriving later are dropped', async () => {
    const h = harness();
    h.asks.listen('t1');
    await settle();
    await h.answer('no');
    // The keys come up after the Esc: there is nothing left to transcribe for.
    expect(h.asks.released('t1')).toBe(false);
    h.asks.words('t1', 'delete everything');
    await h.advance(5000);
    expect(h.door.texts()).toEqual([]);
    expect(row(h)).toMatchObject({ state: 'dismissed', heard: '' });
    expect(h.line()).toBeNull();
  });

  test('pressed three times fast: only the last recording can run', async () => {
    const h = harness();
    h.asks.listen('t1');
    h.asks.released('t1');
    h.asks.listen('t2');
    h.asks.released('t2');
    h.asks.listen('t3');
    await settle();
    // The first two come back from transcription late.
    h.asks.words('t1', 'one');
    h.asks.words('t2', 'two');
    h.asks.released('t3');
    h.asks.words('t3', 'three');
    await settle();
    await h.advance(900);
    expect(h.door.texts()).toEqual(['three']);
    expect(h.ledger.recent(10).map((entry) => entry.state)).toEqual(['running', 'dismissed', 'dismissed']);
  });

  test('a recording thrown away where it was made leaves the notch', async () => {
    const h = harness();
    h.asks.listen('t1');
    await settle();
    h.asks.dropped('t1');
    await settle();
    expect(h.line()).toBeNull();
    expect(row(h).state).toBe('dismissed');
  });

  test('talking takes the notch from a line that was on it, which goes back to the count', async () => {
    const h = harness();
    const waiting: NotchItem = {
      id: 'x', subject: 'x', class: 'rest', speaks: true, title: () => ['x waits'],
      play: async (stage) => ((await stage.offer(['x?'], 'yes')).act === 'yes' ? 'settled' : 'waits'),
    };
    h.inbox.add(waiting);
    await settle();
    h.asks.listen('t1');
    await settle();
    expect(h.line()?.kind).toBe('listen');
    expect(h.count()).toBe(1);
  });
});

describe('"Remember that"', () => {
  const remembered = (result: NotchRemembered) => {
    const calls: string[][] = [];
    return { calls, remember: async (what: string, sentence: string) => { calls.push([what, sentence]); return result; } };
  };

  test('is written to memory and read back, and no turn is started', async () => {
    const memory = remembered({ ok: true, said: 'Remembered: Anna prefers calls.', understood: 'Anna · prefers · calls' });
    const h = harness({ deps: { remember: memory.remember } });
    await h.type('Remember that Anna prefers calls.');
    await settle();
    expect(memory.calls).toEqual([['Anna prefers calls', 'Remember that Anna prefers calls.']]);
    expect(h.door.texts()).toEqual([]);
    expect(h.said()).toBe('Remembered: Anna prefers calls.');
    expect(row(h)).toMatchObject({ state: 'done', kind: 'remember', understood: 'Anna · prefers · calls', did: ['Wrote it to memory.'] });
  });

  test('spoken, it goes the same way', async () => {
    const memory = remembered({ ok: true, said: 'Remembered: Anna prefers calls.', understood: 'Anna · prefers · calls' });
    const h = harness({ deps: { remember: memory.remember } });
    await h.speak('t1', 'remember that Anna prefers calls');
    await h.advance(900);
    expect(memory.calls).toHaveLength(1);
    expect(h.said()).toBe('Remembered: Anna prefers calls.');
  });

  test('one that cannot be written says so, and is not left as done', async () => {
    const memory = remembered({ ok: false, why: 'I could not work out what to remember. Nothing was saved.' });
    const h = harness({ deps: { remember: memory.remember } });
    await h.type('Remember that thing.');
    await settle();
    expect(h.said()).toBe('I could not work out what to remember. Nothing was saved.');
    expect(row(h)).toMatchObject({ state: 'failed' });
  });

  test('only a plain fact is taken as one', () => {
    expect(rememberSentence('Remember that Anna prefers calls.')).toBe('Anna prefers calls');
    expect(rememberSentence('  please remember Anna prefers calls  ')).toBe('Anna prefers calls');
    expect(rememberSentence('Remember to call Anna')).toBeNull();
    expect(rememberSentence('Do you remember that call?')).toBeNull();
    expect(rememberSentence('Remember that?')).toBeNull();
    expect(rememberSentence('What do you remember about Anna')).toBeNull();
  });
});

describe('an approval the turn asks for', () => {
  // The hardening audit, 17 November 2026: an approval an instruction waits on
  // could become unreachable. Something urgent took the notch for a moment,
  // and the notch went back to the work line: "Waiting for your yes." with
  // nothing to say yes to.
  test('has the notch back after something urgent took it for a moment', async () => {
    const h = harness();
    await h.type('run the command');
    const turn = h.door.running();
    h.door.emit(turn, { kind: 'approval', approvalId: 'ap1', status: 'pending' });
    await settle();
    // What raising does: the approval's item takes the notch, urgent, and it is one that comes back.
    h.inbox.add({
      id: 'approval:ap1', subject: 'approval:ap1', class: 'clock', speaks: true, urgent: true, returns: true, title: () => ['ap1'],
      play: async (stage) => { await stage.offer(['Run it?'], 'approve'); return 'settled'; },
    });
    await settle();
    expect(h.said()).toBe('Run it?');
    // Something urgent: a line that says itself and goes.
    h.inbox.add({
      id: 'urgent', subject: 'urgent', class: 'person', speaks: true, urgent: true, once: true, title: () => ['A meeting'],
      play: async (stage) => { await stage.say(['Your call starts in two minutes.'], 1500); return 'settled'; },
    });
    await settle();
    expect(h.said()).toBe('Your call starts in two minutes.');
    await h.answer('done');
    // The approval again, and not the work line that only says it waits.
    expect(h.said()).toBe('Run it?');
  });

  test('is brought up again when the work line comes back alone and still waits for it', async () => {
    const h = harness();
    await h.type('run the command');
    const turn = h.door.running();
    h.door.emit(turn, { kind: 'approval', approvalId: 'ap1', status: 'pending' });
    await settle();
    expect(h.raised).toEqual(['ap1']);
    expect(h.said()).toBe('Waiting for your yes.');
    // Something urgent takes the notch from the work line, and hands it back.
    h.inbox.add({
      id: 'urgent', subject: 'urgent', class: 'person', speaks: true, urgent: true, once: true, title: () => ['A meeting'],
      play: async (stage) => { await stage.say(['Your call starts in two minutes.'], 1500); return 'settled'; },
    });
    await settle();
    await h.answer('done');
    expect(h.said()).toBe('Waiting for your yes.');
    // Right after the first raising it is not pushed again.
    expect(h.raised).toEqual(['ap1']);
  });

  test('is raised to the notch at once, and the work gets the notch back after it', async () => {
    const h = harness();
    await h.type('run the command');
    const turn = h.door.running();
    h.door.emit(turn, { kind: 'approval', approvalId: 'ap1', status: 'pending' });
    await settle();
    expect(h.raised).toEqual(['ap1']);
    expect(h.asks.mine('ap1')).toBe(true);
    expect(h.said()).toBe('Waiting for your yes.');
    // What raising does: the approval's item takes the notch, as urgent.
    let yes = 0;
    h.inbox.add({
      id: 'approval:ap1', subject: 'approval:ap1', class: 'clock', speaks: true, urgent: true, title: () => ['ap1'],
      play: async (stage) => { if ((await stage.offer(['Run it?'], 'approve')).act === 'yes') yes++; return 'settled'; },
    });
    await settle();
    expect(h.said()).toBe('Run it?');
    expect(h.count()).toBe(1);
    await h.answer('yes');
    expect(yes).toBe(1);
    h.door.emit(turn, { kind: 'approval', approvalId: 'ap1', status: 'approved' });
    await settle();
    // Back to the work, without being asked.
    expect(h.line()).toMatchObject({ kind: 'work' });
    expect(h.said()).toBe('On it: run the command');
    h.door.say(turn, 'It ran.');
    h.door.end(turn);
    await settle();
    expect(h.said()).toBe('It ran.');
    expect(h.asks.mine('ap1')).toBe(false);
  });
});

describe('with nobody looking, and after a restart', () => {
  test('an answer that arrives while something else has the notch waits in the count', async () => {
    const h = harness();
    await h.type('slow thing');
    const turn = h.door.running();
    h.inbox.add({
      id: 'u', subject: 'u', class: 'clock', speaks: true, urgent: true, title: () => ['u'],
      play: async (stage) => { await stage.offer(['Urgent?'], 'yes'); return 'settled'; },
    });
    await settle();
    expect(h.said()).toBe('Urgent?');
    h.door.say(turn, 'Finished.');
    h.door.end(turn);
    await settle();
    expect(h.said()).toBe('Urgent?');
    expect(h.count()).toBe(1);
    await h.answer('yes');
    expect(h.said()).toBe('Finished.');
  });

  test('a long answer nobody closed comes back after a restart', async () => {
    const db = new Database(':memory:');
    const before = harness({ db });
    await before.type('explain it');
    const turn = before.door.running();
    before.door.say(turn, 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
    before.door.end(turn);
    await settle();
    expect(before.line()?.kind).toBe('sheet');
    // The brain stops here. A new one starts on the same data.
    const after = harness({ db, page: false });
    after.asks.resume();
    after.fromPage({ type: 'hello', v: 1 });
    await settle();
    expect(after.line()).toMatchObject({ kind: 'sheet' });
    expect(after.said()).toBe('You asked: explain it');
    await after.answer('no');
    expect(after.ledger.unseen()).toHaveLength(0);
    // And it does not come back a second time.
    const third = harness({ db, page: false });
    third.asks.resume();
    third.fromPage({ type: 'hello', v: 1 });
    await settle();
    expect(third.line()).toBeNull();
  });

  test('a restart in the middle: what was running is closed as failed, what had not run can never run', async () => {
    const db = new Database(':memory:');
    const before = harness({ db });
    await before.type('a long job');
    const second = harness({ db });
    second.asks.listen('t9');
    await settle();
    const after = harness({ db, page: false });
    after.asks.resume();
    after.fromPage({ type: 'hello', v: 1 });
    await settle();
    const rows = after.ledger.recent(10);
    expect(rows.map((entry) => entry.state)).toEqual(['dismissed', 'failed']);
    expect(after.said()).toBe('I restarted in the middle of it. Nothing is tried again.');
    expect(after.door.texts()).toEqual([]);
  });

  test('a turn that finished while the brain was down is taken from the store', async () => {
    const db = new Database(':memory:');
    const before = harness({ db });
    await before.type('quick one');
    const id = before.ledger.recent(1)[0]!.id;
    const after = harness({ db, page: false });
    after.door.door.submit({ conversationId: 'conv-notch', turnId: `notch-${id}`, requestId: `notch-typed-${id}`, text: 'quick one' });
    after.door.say(`notch-${id}`, 'Here it is.');
    after.door.end(`notch-${id}`);
    after.asks.resume();
    after.fromPage({ type: 'hello', v: 1 });
    await settle();
    expect(after.said()).toBe('Here it is.');
  });
});

describe('the ledger on the notch', () => {
  test('lists what was asked, newest first, and opens one in full', async () => {
    const h = harness();
    await h.type('first question');
    const turn = h.door.running();
    h.door.activity(turn, 'Searching the web.');
    h.door.say(turn, 'An answer.');
    h.door.end(turn);
    await settle();
    await h.answer('done');
    h.asks.listen('t1');
    await settle();
    h.asks.nothing('t1', 'silence');
    await settle();
    await h.answer('done');
    await h.open();
    await h.answer('button', { button: 'asked' });
    const list = h.line();
    // A hold of the keys in which nothing was caught is not something asked.
    expect(h.said()).toBe('What you asked: 1 thing');
    const rows = list?.kind === 'sheet' ? list.blocks.filter((block) => block.kind === 'row') : [];
    expect(rows.map((block) => (block.kind === 'row' ? [block.say.join(''), block.small] : []))).toEqual([['first question', 'done']]);
    await h.answer('go', { row: h.ledger.recent(2)[1]!.id });
    expect(h.said()).toBe('You typed');
    const detail = h.line();
    const leads = detail?.kind === 'sheet' ? detail.blocks.map((block) => (block.kind === 'row' ? block.lead : block.kind)) : [];
    expect(leads).toEqual(['Typed', 'Did', 'paper']);
    // Closing the one goes back to the list, closing the list goes back to Home.
    await h.answer('no');
    expect(h.said()).toBe('What you asked: 1 thing');
    await h.answer('no');
    expect(h.line()?.kind).toBe('ask');
  });

  test('says how each one ended in a word', () => {
    expect(ledgerWord({ state: 'done', kind: 'remember' })).toBe('remembered');
    expect(ledgerWord({ state: 'dismissed', kind: null })).toBe('turned away');
    const blocks = ledgerDetail({
      id: 'a', createdAt: 0, source: 'spoken', state: 'dismissed', heard: 'delete it', kind: null, understood: null, did: [],
      answer: null, note: null, conversationId: null, turnId: null, requestId: null, endedAt: 1, seenAt: null,
    });
    expect(blocks.map((block) => (block.kind === 'row' ? block.say.join('') : ''))).toEqual(['delete it', 'Turned away before it ran. Nothing was done.']);
  });
});

describe('the shape of an answer', () => {
  test('one short sentence is a line, anything else a sheet', () => {
    expect(answerShape('It is four.')).toEqual({ kind: 'line', text: 'It is four.' });
    expect(answerShape('')).toEqual({ kind: 'line', text: 'Done.' });
    expect(answerShape('x'.repeat(141)).kind).toBe('sheet');
    expect(answerShape('One.\n\nTwo.\n\nThree.').kind).toBe('sheet');
    // Two short sentences on two lines are still read at a glance.
    expect(answerShape('Done.\nSaved to the folder.')).toEqual({ kind: 'line', text: 'Done. Saved to the folder.' });
    expect(answerShape('- one\n- two').kind).toBe('sheet');
  });

  test('a very long answer is cut, and says so', () => {
    const shape = answerShape(Array.from({ length: 200 }, (_, i) => `Line ${i}`).join('\n'));
    expect(shape).toMatchObject({ kind: 'sheet', cut: true });
    expect(shape.kind === 'sheet' ? shape.lines.length : 0).toBe(60);
  });

  test('marks written for a web page are taken out, code is left as it is', () => {
    expect(plainLines('# Title\n\n**Bold** and *soft* and `code` and [a link](https://x.y).\n\n```sh\necho **hi**\n```')).toEqual(
      ['Title', 'Bold and soft and code and a link (https://x.y).', 'echo **hi**']);
    // What only looks like a mark is left alone: maths, and names with underscores.
    expect(plainLines('2 * 3 * 4 = 24')).toEqual(['2 * 3 * 4 = 24']);
    expect(plainLines('Call `__init__` or __init__ once.')).toEqual(['Call __init__ or __init__ once.']);
    expect(plainLines('| Name | Size |\n|---|---|\n| a.txt | 2 KB |')).toEqual(['Name · Size', 'a.txt · 2 KB']);
  });
});

describe('first batch of the edge-case audit', () => {
  test('a long answer is not closed by a click meant for another app', async () => {
    const h = harness();
    await h.type('explain it');
    const turn = h.door.running();
    h.door.say(turn, 'One.\n\nTwo.\n\nThree.');
    h.door.end(turn);
    await settle();
    expect(h.line()).toMatchObject({ kind: 'sheet', stay: true });
  });

  test('a speech-to-text failure says so, after the same sentence', async () => {
    const h = harness();
    h.asks.listen('t1');
    await settle();
    h.asks.nothing('t1', 'failed');
    await settle();
    expect(h.said()).toBe(`${NOTCH_NOT_CAUGHT} Speech-to-text is not answering: check its key in the dashboard.`);
  });

  test('a stopped turn is written into the conversation as over, so the next turn does not pick it up', async () => {
    const h = harness();
    await h.type('do something long');
    const turn = h.door.running();
    await h.answer('stop');
    expect(h.door.marks).toEqual([`${turn}: (The owner stopped this request before it finished. It is over: do not continue it unless they ask again.)`]);
  });

  test('a failed turn is written as over too, a finished one is not', async () => {
    const h = harness();
    await h.type('do it');
    h.door.end(h.door.running(), 'failed', { code: 'provider', message: 'It broke.' });
    await settle();
    expect(h.door.marks).toHaveLength(1);
    await h.answer('done');
    await h.type('again');
    h.door.say(h.door.running(), 'Fine.');
    h.door.end(h.door.running());
    await settle();
    expect(h.door.marks).toHaveLength(1);
  });

  test('when a turn ends, what it was still asking approval for is asked no more', async () => {
    const h = harness();
    await h.type('run the command');
    const turn = h.door.running();
    h.door.emit(turn, { kind: 'approval', approvalId: 'ap1', status: 'pending' });
    await settle();
    h.door.say(turn, 'I am waiting for approval.');
    h.door.end(turn);
    await settle();
    expect(h.withdrawn).toEqual(['ap1']);
    expect(h.asks.mine('ap1')).toBe(false);
  });

  test('spoken while everything is stopped: turned away at the first key, and it never runs later', async () => {
    let paused = true;
    const h = harness({ deps: { paused: () => paused } });
    h.asks.listen('t1');
    h.asks.released('t1');
    h.asks.words('t1', 'delete the folder');
    await settle();
    expect(h.shakes()).toBe(1);
    expect(h.line()).toBeNull();
    paused = false;
    await h.advance(5000);
    expect(h.door.texts()).toEqual([]);
    expect(row(h)).toMatchObject({ state: 'refused', note: 'Everything is stopped. Wake me first.', heard: '' });
  });

  // The hardening audit, 17 November 2026: said during a call it was taken in
  // silence, with no line and no shake, and ran an hour later when the call
  // was over.
  test('spoken during a call: turned away at the first key, and it never runs when the call is over', async () => {
    let onCall = true;
    const h = harness({ deps: { onCall: () => onCall } });
    h.asks.listen('t1');
    h.asks.released('t1');
    h.asks.words('t1', 'send Sam the deck');
    await settle();
    expect(h.shakes()).toBe(1);
    expect(h.line()).toBeNull();
    onCall = false;
    await h.advance(5000);
    expect(h.door.texts()).toEqual([]);
    expect(row(h)).toMatchObject({ state: 'refused', note: 'You were on a call, and I hold everything until it is over.', heard: '' });
    // After the call it is heard as ever.
    await h.speak('t2', 'send Sam the deck');
    await h.advance(1500);
    expect(h.door.texts()).toEqual(['send Sam the deck']);
  });

  test('spoken while something runs: refused at the first key, not after it was all said', async () => {
    const h = harness();
    await h.type('first thing');
    h.asks.listen('t2');
    await settle();
    expect(h.shakes()).toBe(1);
    // The work is still on the notch, and nothing listens.
    expect(h.line()).toMatchObject({ kind: 'work' });
    h.asks.words('t2', 'second thing');
    await h.advance(2000);
    expect(h.door.texts()).toEqual(['first thing']);
    expect(row(h)).toMatchObject({ state: 'refused' });
  });

  test('a turn waiting behind another chat says so', async () => {
    const h = harness();
    await h.type('hello');
    const turn = h.door.running();
    h.door.emit(turn, { kind: 'status', state: 'queued' });
    await settle();
    expect(h.said()).toBe('Waiting for another chat to finish.');
    h.door.emit(turn, { kind: 'status', state: 'running' });
    await settle();
    expect(h.said()).toBe('On it: hello');
  });

  test('a turn whose end was never heard is concluded from the turn store', async () => {
    const h = harness();
    await h.type('quick one');
    const turn = h.door.running();
    // The store has it finished, but no event said so.
    const stored = h.door.turns.get(turn)!;
    stored.state = 'completed';
    stored.reply = 'Here it is.';
    h.asks.reconcile();
    await settle();
    expect(h.said()).toBe('Here it is.');
    expect(row(h).state).toBe('done');
  });

  test('words that were in when the brain restarted are not dropped without a word', async () => {
    const db = new Database(':memory:');
    const before = harness({ db });
    await before.speak('t1', 'send Leo the numbers');
    const after = harness({ db, page: false });
    after.asks.resume();
    after.fromPage({ type: 'hello', v: 1 });
    await settle();
    expect(after.said()).toBe('I restarted before I started on: send Leo the numbers. Say it again.');
    expect(after.door.texts()).toEqual([]);
  });
});

describe('second batch of the edge-case audit', () => {
  test('a spoken memory is shown as it would be saved and takes one yes; a no saves nothing and says nothing', async () => {
    const saved: string[] = [];
    const remember: NotchAsksDeps['remember'] = async (what, _sentence, _askId, confirm) => {
      if (confirm && !(await confirm('Anna prefers colds'))) return { ok: false, why: 'Not saved.' };
      saved.push(what);
      return { ok: true, said: 'Remembered: Anna prefers colds.', understood: 'Anna · prefers · colds' };
    };
    const no = harness({ deps: { remember } });
    await no.speak('t1', 'remember that Anna prefers colds');
    await no.advance(900);
    expect(no.line()).toMatchObject({ kind: 'offer', yes: 'remember', fold: 0 });
    expect(no.said()).toBe('Remember: Anna prefers colds?');
    await no.answer('no');
    expect(saved).toEqual([]);
    expect(no.line()).toBeNull();
    expect(row(no)).toMatchObject({ state: 'stopped', note: 'Not saved.' });
    const yes = harness({ deps: { remember } });
    await yes.speak('t1', 'remember that Anna prefers colds');
    await yes.advance(900);
    await yes.answer('yes');
    expect(saved).toEqual(['Anna prefers colds']);
    expect(yes.said()).toBe('Remembered: Anna prefers colds.');
  });

  test('a typed memory is the person\'s own letters, and is saved as written', async () => {
    let asked = false;
    const h = harness({ deps: { remember: async (_what, _sentence, _askId, confirm) => { asked = confirm !== undefined; return { ok: true, said: 'Remembered: Anna prefers calls.', understood: 'x' }; } } });
    await h.type('Remember that Anna prefers calls.');
    await settle();
    expect(asked).toBe(false);
    expect(h.said()).toBe('Remembered: Anna prefers calls.');
  });

  test('what is tied to a time is not a memory, and Italian is understood', () => {
    expect(rememberSentence('Remember that I have a meeting tomorrow at 3')).toBeNull();
    expect(rememberSentence('Remember that the call is on Friday')).toBeNull();
    expect(rememberSentence('Ricorda che Anna preferisce le chiamate')).toBe('Anna preferisce le chiamate');
    expect(rememberSentence('Ricordati che domani ho il dentista')).toBeNull();
    expect(rememberSentence('Remember this: Leo covers support')).toBe('Leo covers support');
  });

  test('a question back stays as a question, and what is typed there is the next instruction', async () => {
    const h = harness();
    await h.type('send the notes to Anna');
    const turn = h.door.running();
    h.door.say(turn, 'Which Anna do you mean?');
    h.door.end(turn);
    await settle();
    expect(h.line()).toMatchObject({ kind: 'ask', yes: 'answer' });
    await h.advance(60_000);
    expect(h.line()?.kind).toBe('ask');
    await h.answer('ask', { text: 'Anna Rossi' });
    expect(h.door.texts()).toEqual(['send the notes to Anna', 'Anna Rossi']);
    expect(h.line()).toMatchObject({ kind: 'work' });
  });

  test('a spoken reply answers the question too, and the question is not shown again', async () => {
    const h = harness();
    await h.type('send the notes to Anna');
    h.door.say(h.door.running(), 'Which Anna do you mean?');
    h.door.end(h.door.running());
    await settle();
    await h.speak('t1', 'Anna Rossi');
    await h.advance(900);
    expect(h.door.texts()).toEqual(['send the notes to Anna', 'Anna Rossi']);
    expect(h.ledger.unseen()).toHaveLength(0);
  });

  test('the last answer is one step away in Home for a while', async () => {
    const h = harness();
    await h.type('what is two plus two?');
    h.door.say(h.door.running(), 'It is four.');
    h.door.end(h.door.running());
    await settle();
    await h.answer('done');
    await h.open();
    const home = h.line();
    const first = home?.kind === 'ask' ? home.blocks[0] : null;
    expect(first).toMatchObject({ kind: 'row', id: 'last', lead: 'Last answer', say: ['It is four.'] });
    await h.answer('go', { row: 'last' });
    expect(h.line()).toMatchObject({ kind: 'sheet', stay: true });
  });
});

describe('a spoken instruction that ran past a minute', () => {
  const cutShort = async (h: ReturnType<typeof harness>, words: string): Promise<void> => {
    h.asks.listen('t1');
    await settle();
    h.asks.released('t1');
    await settle();
    h.asks.words('t1', words, { cut: true });
    await settle();
    await h.advance(900);
  };

  test('is shown whole and asked about before anything runs, and a yes runs it once', async () => {
    const h = harness();
    await cutShort(h, 'delete the old exports in Downloads but not');
    // Nothing has run: the words may stop in the middle of a sentence.
    expect(h.door.texts()).toEqual([]);
    const sheet = h.line();
    expect(sheet).toMatchObject({ kind: 'sheet', yes: 'go on', stay: true });
    expect(h.said()).toBe('I stopped listening after a minute. Go on with what I heard?');
    const paper = sheet?.kind === 'sheet' ? sheet.blocks.find((block) => block.kind === 'paper') : null;
    expect(paper?.kind === 'paper' ? paper.lines.map((parts) => parts.join('')) : []).toEqual(['delete the old exports in Downloads but not']);
    expect(row(h).state).toBe('heard');
    await h.answer('yes');
    expect(h.door.texts()).toEqual(['delete the old exports in Downloads but not']);
    expect(row(h).state).toBe('running');
    expect(h.line()).toMatchObject({ kind: 'work' });
  });

  test('a no turns it away: nothing runs, then or later', async () => {
    const h = harness();
    await cutShort(h, 'delete the old exports in Downloads but not');
    await h.answer('no');
    expect(h.door.texts()).toEqual([]);
    expect(row(h)).toMatchObject({ state: 'dismissed', note: 'It ran past a minute, and you turned it away.' });
    expect(h.line()).toBeNull();
    await h.advance(60_000);
    expect(h.door.texts()).toEqual([]);
  });

  test('something urgent taking the notch while it asks does not count as a yes', async () => {
    const h = harness();
    await cutShort(h, 'delete the old exports in Downloads but not');
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'go on' });
    // The microphone was refused meanwhile: that is said at once, over the question.
    h.asks.tell(['The microphone is muted.']);
    await settle();
    expect(h.said()).toBe('The microphone is muted.');
    // Until the question is back: the other line's time, then the words shown again for their moment.
    for (let waited = 0; waited < 12 && h.line()?.kind !== 'sheet'; waited++) await h.advance(900);
    // The question is back. Nothing ran while it was away, and nothing runs now.
    expect(h.door.texts()).toEqual([]);
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'go on', stay: true });
    expect(row(h).state).toBe('heard');
    await h.answer('yes');
    expect(h.door.texts()).toEqual(['delete the old exports in Downloads but not']);
  });

  test('words that were not cut short run as before, with no question', async () => {
    const h = harness();
    await h.speak('t1', 'what is two plus two');
    await h.advance(900);
    expect(h.line()).toMatchObject({ kind: 'work' });
    expect(h.door.texts()).toEqual(['what is two plus two']);
  });
});

// Pass 9: what was circled on the screen, or a file that was dropped, goes with the words.
describe('an instruction that carries files', () => {
  const file = (name: string): NotchAskFile => ({ kind: 'document', name, mediaType: 'text/plain', bytes: new Uint8Array([1, 2, 3]) });
  /** Keeps what the door was given, and takes its time, as the real one does while it stores the files. */
  function keeping(h: H, fail?: Error) {
    const kept: string[][] = [];
    const real = h.door.door.submit.bind(h.door.door);
    h.door.door.submit = async (turn) => {
      await Promise.resolve();
      if (fail) throw fail;
      kept.push((turn.files ?? []).map((entry) => entry.name));
      await real(turn);
    };
    return kept;
  }

  test('a question about them runs as one turn, with them, and its answer is said', async () => {
    const h = harness();
    const kept = keeping(h);
    h.asks.typed('What is this?', [file('circled-on-screen.txt'), file('circled-on-screen.png')]);
    await settle();
    expect(kept).toEqual([['circled-on-screen.txt', 'circled-on-screen.png']]);
    expect(h.door.texts()).toEqual(['What is this?']);
    expect(h.said()).toBe('On it: What is this?');
    const turn = h.door.running();
    h.door.say(turn, 'Invoice 114 from Acme, 9 days late.');
    h.door.end(turn);
    await settle();
    expect(h.said()).toBe('Invoice 114 from Acme, 9 days late.');
    expect(row(h)).toMatchObject({ state: 'done', heard: 'What is this?' });
  });

  test('spoken words carry them too, and words without any carry none', async () => {
    const h = harness();
    const kept = keeping(h);
    h.asks.listen('t1');
    await settle();
    h.asks.released('t1');
    await settle();
    h.asks.words('t1', 'is this one late', { files: [file('circled-on-screen.txt')] });
    await settle();
    await h.advance(900);
    expect(kept).toEqual([['circled-on-screen.txt']]);
    h.door.end(h.door.running());
    await settle();
    if (h.line()) await h.answer('done');
    await h.speak('t2', 'what is two plus two');
    await h.advance(900);
    expect(kept).toEqual([['circled-on-screen.txt'], []]);
  });

  test('when they cannot be kept with it nothing is asked, and the reason is what is said', async () => {
    const h = harness();
    keeping(h, new NotchFilesNotKept('That is too large for me to read yet, so nothing was asked.'));
    h.asks.typed('Summarise this file', [file('big.pdf')]);
    await settle();
    expect(h.door.texts()).toEqual([]);
    expect(h.said()).toContain('That is too large for me to read yet, so nothing was asked.');
    expect(row(h)).toMatchObject({ state: 'failed', note: 'That is too large for me to read yet, so nothing was asked.' });
  });

  test('a conversation that is busy is still said to be busy', async () => {
    const h = harness();
    keeping(h);
    h.door.setBusy(true);
    h.asks.typed('What is this?', [file('circled-on-screen.txt')]);
    await settle();
    expect(row(h)).toMatchObject({ state: 'failed', note: 'Its conversation is busy with something sent from the dashboard. Ask again when that is done.' });
  });
});

// Pass 9: "Where is…?" is answered by pointing at it on the screen.
describe('a question about where something is', () => {
  test('is answered by pointing, in one line, and no turn is started', async () => {
    const asked: string[] = [];
    const h = harness({ deps: { point: async (question) => { asked.push(question); return { ok: true, said: 'Close, the button, top right of the window. I am pointing at it.' }; } } });
    await h.type('Where do I close this window?');
    expect(asked).toEqual(['Where do I close this window?']);
    expect(h.door.texts()).toEqual([]);
    expect(h.said()).toBe('Close, the button, top right of the window. I am pointing at it.');
    expect(row(h)).toMatchObject({ state: 'done', answer: 'Close, the button, top right of the window. I am pointing at it.', did: ['Showed it on the screen.'] });
  });

  test('while the window is read the line says so', async () => {
    let tell: (pointed: { ok: true; said: string } | null) => void = () => {};
    const h = harness({ deps: { point: () => new Promise((resolve) => { tell = resolve; }) } });
    await h.type('Where is the export button?');
    expect(h.line()).toMatchObject({ kind: 'work' });
    expect(h.said()).toBe('Looking for it in the window.');
    tell({ ok: true, said: 'Export, the button, at the bottom of the window. I am pointing at it.' });
    await settle();
    expect(h.said()).toBe('Export, the button, at the bottom of the window. I am pointing at it.');
  });

  test('when the window has no answer it runs as any other instruction', async () => {
    const h = harness({ deps: { point: async () => null } });
    await h.type('Where is the invoice from Acme?');
    expect(h.door.texts()).toEqual(['Where is the invoice from Acme?']);
    expect(h.said()).toBe('On it: Where is the invoice from Acme?');
    const turn = h.door.running();
    h.door.say(turn, 'In your Downloads folder.');
    h.door.end(turn);
    await settle();
    expect(h.said()).toBe('In your Downloads folder.');
  });

  test('a pointer that fails is not the end of the question either', async () => {
    const h = harness({ deps: { point: async () => { throw new Error('the machine went away'); } } });
    await h.type('Where do I close this window?');
    expect(h.door.texts()).toEqual(['Where do I close this window?']);
  });

  test('where Jarvis looks away, that is what is said, and nothing is asked', async () => {
    const h = harness({ deps: { point: async () => ({ ok: false, why: 'Your bank. I look away in here, so I cannot point in it.' }) } });
    await h.type('Where do I close this window?');
    expect(h.door.texts()).toEqual([]);
    expect(h.said()).toContain('Your bank. I look away in here, so I cannot point in it.');
    expect(row(h)).toMatchObject({ state: 'failed' });
  });

  test('words that are not such a question never reach the pointer, and neither does a question about what was circled', async () => {
    const asked: string[] = [];
    const h = harness({ deps: { point: async (question) => { asked.push(question); return null; } } });
    await h.type('send Leo the numbers');
    h.door.end(h.door.running());
    await settle();
    if (h.line()) await h.answer('done');
    h.asks.typed('Where is this from?', [{ kind: 'document', name: 'circled-on-screen.txt', mediaType: 'text/plain', bytes: new Uint8Array([1]) }]);
    await settle();
    expect(asked).toEqual([]);
    expect(h.door.texts()).toEqual(['send Leo the numbers', 'Where is this from?']);
  });

  // The owner, 16 November 2026: the pointer "waits until I click it, and then shows me the next step again".
  test('a walk of several clicks: the line says the step that is being shown, and the last line says it is over', async () => {
    let during: { step?: (said: string) => void; signal?: AbortSignal } = {};
    let tell: (pointed: { ok: true; said: string }) => void = () => {};
    const h = harness({ deps: { point: (_question, how) => { during = how ?? {}; return new Promise((resolve) => { tell = resolve; }); } } });
    await h.type('How do I add an audio input capture?');
    expect(h.said()).toBe('Looking for it in the window.');
    during.step?.('Step 1: click Add Source, bottom left of the window.');
    await settle();
    expect(h.line()).toMatchObject({ kind: 'work' });
    expect(h.said()).toBe('Step 1: click Add Source, bottom left of the window.');
    during.step?.('Last step: click Audio Input Capture.');
    await settle();
    expect(h.said()).toBe('Last step: click Audio Input Capture.');
    tell({ ok: true, said: 'That was the last step.' });
    await settle();
    expect(h.said()).toBe('That was the last step.');
    expect(h.door.texts()).toEqual([]);
    expect(row(h)).toMatchObject({ state: 'done', answer: 'That was the last step.' });
  });

  test('Esc while a step waits for its click: the walk is told to stop, and it says it stopped', async () => {
    let signal: AbortSignal | undefined;
    const h = harness({ deps: { point: (_question, how) => new Promise((resolve) => {
      signal = how?.signal;
      signal?.addEventListener('abort', () => resolve({ ok: 'stopped' }));
    }) } });
    await h.type('How do I add an audio input capture?');
    expect(signal?.aborted).toBe(false);
    h.fromPage({ type: 'answer', id: h.line()!.id, act: 'stop' });
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(row(h)).toMatchObject({ state: 'stopped' });
    expect(h.said()).toBe('Stopped. What was already done stays done.');
    expect(h.door.texts()).toEqual([]);
  });

  test('a walk that something else took off the screen says nothing more', async () => {
    const h = harness({ deps: { point: async () => ({ ok: 'stopped' }) } });
    await h.type('How do I add an audio input capture?');
    await settle();
    expect(row(h)).toMatchObject({ state: 'stopped' });
    expect(h.line()).toBeNull();
    expect(h.door.texts()).toEqual([]);
    // The hardening audit, 17 November 2026: it was left unseen, and came back
    // after every restart as "Stopped. What was already done stays done."
    expect(h.ledger.unseen()).toEqual([]);
  });

  test('a new question while a step waits for its click ends the walk: it is not told "I am still on the last thing"', async () => {
    let signal: AbortSignal | undefined;
    let walks = 0;
    const h = harness({ deps: { point: (question, how) => {
      if (!question.startsWith('How do I add')) return Promise.resolve(null);
      walks++;
      signal = how?.signal;
      return new Promise(() => {});
    } } });
    await h.type('How do I add an audio input capture?');
    expect(h.line()).toMatchObject({ kind: 'work' });
    h.asks.typed('send Leo the numbers');
    await settle();
    // The pointer was taken off the screen, and the new instruction runs.
    expect(signal?.aborted).toBe(true);
    expect(walks).toBe(1);
    expect(h.door.texts()).toEqual(['send Leo the numbers']);
    expect(h.said()).toBe('On it: send Leo the numbers');
    // The walk that was ended has nothing left to be seen: it does not come back after a restart as "Stopped".
    expect(h.ledger.unseen().map((entry) => entry.heard)).not.toContain('How do I add an audio input capture?');
    // Spoken, the same: the keys are not refused.
    const again = harness({ deps: { point: (_question, how) => { signal = how?.signal; return new Promise(() => {}); } } });
    await again.type('How do I add an audio input capture?');
    again.asks.listen('talk-1');
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(again.said()).not.toContain('I am still on the last thing');
  });

  test('stopped while the window is read: nothing is pointed at afterwards and no turn starts', async () => {
    let tell: (pointed: { ok: true; said: string } | null) => void = () => {};
    const h = harness({ deps: { point: () => new Promise((resolve) => { tell = resolve; }) } });
    await h.type('Where is the export button?');
    expect(h.line()).toMatchObject({ kind: 'work' });
    h.fromPage({ type: 'answer', id: h.line()!.id, act: 'stop' });
    await settle();
    tell(null);
    await settle();
    expect(h.door.texts()).toEqual([]);
    expect(row(h)).toMatchObject({ state: 'stopped' });
  });
});

describe('words the notch acts on itself (pass 10)', () => {
  function sided(more: Partial<NotchAsksDeps> = {}) {
    const ran: string[] = [];
    const h = harness({ deps: { side: (words) => (/^watch me/i.test(words) ? { did: 'Began watching what you show me.', run: () => { ran.push(words); } } : null), ...more } });
    return { h, ran };
  }

  test('typed: no turn is started, it is done once, and the ledger says what was done', async () => {
    const { h, ran } = sided();
    await h.type('Watch me');
    expect(ran).toEqual(['Watch me']);
    expect(h.door.texts()).toEqual([]);
    // It has no line of its own: what it set off shows itself.
    expect(h.line()).toBeNull();
    expect(row(h)).toMatchObject({ state: 'done', kind: 'notch', did: ['Began watching what you show me.'], answer: 'Began watching what you show me.' });
    // Seen: it does not come back after a restart as an answer nobody closed.
    expect(h.ledger.unseen()).toEqual([]);
  });

  test('spoken: the words are shown for their moment, then acted on, once', async () => {
    const { h, ran } = sided();
    await h.speak('t1', 'Watch me');
    expect(h.line()).toMatchObject({ kind: 'listen', heard: 'Watch me' });
    expect(ran).toEqual([]);
    await h.advance(NOTCH_HEARD_MS);
    expect(ran).toEqual(['Watch me']);
    expect(h.door.texts()).toEqual([]);
    expect(h.line()).toBeNull();
    // Esc in that moment turns them away like any other words.
    await h.speak('t2', 'Watch me');
    await h.answer('no');
    await h.advance(NOTCH_HEARD_MS);
    expect(ran).toEqual(['Watch me']);
  });

  test('it needs no model, and what is running does not stand in its way', async () => {
    const { h, ran } = sided({ modelReady: () => false });
    await h.type('Watch me');
    expect(ran).toEqual(['Watch me']);
    const busy = sided();
    await busy.h.type('Summarise my inbox');
    expect(busy.h.door.texts()).toEqual(['Summarise my inbox']);
    // Typed while a turn is running: it is not told "I am still on the last thing".
    busy.h.asks.typed('Watch me');
    await settle();
    expect(busy.ran).toEqual(['Watch me']);
    expect(row(busy.h)).toMatchObject({ state: 'done', kind: 'notch' });
  });

  test('with everything stopped it is not done', async () => {
    const { h, ran } = sided({ paused: () => true });
    await h.type('Watch me');
    expect(ran).toEqual([]);
    expect(h.said()).toBe('Everything is stopped. Wake me first.');
  });

  test('other words are an instruction like any other, and so are words that carry a file', async () => {
    const { h, ran } = sided();
    await h.type('What is on my calendar?');
    expect(h.door.texts()).toEqual(['What is on my calendar?']);
    const withFile = sided();
    withFile.h.asks.typed('Watch me', [{ kind: 'document', name: 'a.txt', mediaType: 'text/plain', bytes: new Uint8Array([1]) }]);
    await settle();
    expect(withFile.ran).toEqual([]);
    expect(ran).toEqual([]);
  });

  test('one that breaks is said in the log, and is still done only once', async () => {
    const h = harness({ deps: { side: () => ({ did: 'Tried.', run: () => { throw new Error('it broke'); } }) } });
    await h.type('Watch me');
    expect(h.logs.join('\n')).toContain('something the notch does itself failed: it broke');
    expect(row(h)).toMatchObject({ state: 'done', kind: 'notch' });
  });
});

describe('Home, with jobs in it (pass 10)', () => {
  test('the jobs Jarvis was shown have a row, and it opens their sheet', async () => {
    const opened: string[] = [];
    const h = harness({ deps: { learned: {
      row: () => ({ kind: 'row', id: 'learned', say: ['1 job you showed me.'], go: true }),
      open: async (stage) => { opened.push('learned'); await stage.sheet(['Jobs you showed me: 1'], []); },
    } } });
    await h.open();
    const blocks = (h.line() as { blocks: { id?: string }[] }).blocks;
    expect(blocks.some((block) => block.id === 'learned')).toBe(true);
    await h.answer('go', { row: 'learned' });
    expect(opened).toEqual(['learned']);
    expect(h.said()).toBe('Jobs you showed me: 1');
  });

  // The plan's test, step 6: "Undo the paste from Today. The rows are gone."
  test('Undo on a row of today takes that job back', async () => {
    const undone: string[] = [];
    const h = harness({ deps: {
      today: () => [{ kind: 'row', id: 'job:abc', lead: '10:02', say: ['Pasted 7 from Notepad into Excel'], buttons: [{ id: 'undo', label: 'Undo', quiet: true }] }],
      undoJob: (id) => { undone.push(id); },
    } });
    await h.open();
    await h.answer('button', { button: 'undo', row: 'job:abc' });
    expect(undone).toEqual(['abc']);
    // A button of another row, or of no job, undoes nothing.
    await h.open();
    await h.answer('button', { button: 'undo', row: 'mail' });
    expect(undone).toEqual(['abc']);
  });
});

describe('pass 12: what was said is seen to land', () => {
  test('it nods as it takes the words, and shakes when nothing was made out', async () => {
    let nods = 0;
    const h = harness({ deps: { nod: () => { nods++; } } });
    h.asks.listen('t1');
    h.asks.released('t1');
    h.asks.words('t1', 'what is two plus two');
    expect(nods).toBe(1);
    expect(h.shakes()).toBe(0);
    h.asks.listen('t2');
    h.asks.released('t2');
    h.asks.nothing('t2', 'silence');
    expect(nods).toBe(1);
    expect(h.shakes()).toBe(1);
  });

  test('words that were cut short are asked about first: no nod for those', async () => {
    let nods = 0;
    const h = harness({ deps: { nod: () => { nods++; } } });
    h.asks.listen('t1');
    h.asks.released('t1');
    h.asks.words('t1', 'send the numbers to', { cut: true });
    expect(nods).toBe(0);
  });
});

describe('pass 12: day one and talking share the notch', () => {
  const now = { setTimeout: (fn: () => void) => { fn(); return 0; }, clearTimeout: () => {} };
  const place = (name: NotchDayOneStep): number => NOTCH_DAY_ONE_ORDER.indexOf(name) + 1;
  function dayOne(name: NotchDayOneStep) {
    const step = place(name);
    let day: NotchDayOne | null = null;
    const told: string[] = [];
    // No model at all: day one's lessons need none.
    const h = harness({ deps: { modelReady: () => false, side: (text) => day?.route(text) ?? null, unheard: (why) => day?.unheard(why) ?? false } });
    const settings = new NotchSettings(h.db);
    settings.set('dayone', { step, done: false });
    day = attachNotchDayOne({
      inbox: h.inbox, settings, clock: now, log: () => {},
      fresh: () => true,
      model: { ready: () => false, name: () => '', hosted: () => false, setUp: () => {} },
      told: async (what) => { told.push(what); return null; },
    });
    day.cameUp();
    return { h, day, told };
  }

  test('while day one waits to hear the person, what they say is its answer: no model is asked, and day one has the notch back', async () => {
    const { h, day, told } = dayOne('talk');
    await h.advance(0);
    expect(h.said()).toBe('Now tell me what you do. Out loud.');
    // The keys go down: the talking takes the notch from day one.
    h.asks.listen('t1');
    await h.advance(0);
    expect(h.line()?.kind).toBe('listen');
    h.asks.released('t1');
    h.asks.words('t1', 'Every Monday I send Sam the numbers');
    await h.advance(3000);
    await h.advance(3000);
    // Taken as what they do: not as an agent to make, and not refused for want of a model.
    expect(told).toEqual(['Every Monday I send Sam the numbers']);
    expect(h.said()).toBe('Heard. That is how you tell me anything.');
    expect(row(h).state).toBe('done');
    expect(row(h).answer).toBe('Told Pillow what they do, on day one.');
    await h.answer('done');
    expect(day.step()).toBe(place('watch'));
    expect(h.said()).toBe('May I watch which app you are in? Close my eyes any time.');
  });

  test('with nothing to make words of the voice, day one says what is true, and the usual "I did not catch that" is not said as well', async () => {
    const { h, day } = dayOne('talk');
    await h.advance(0);
    h.asks.listen('t1');
    await h.advance(0);
    h.asks.released('t1');
    h.asks.nothing('t1', 'no_stt');
    await h.advance(3000);
    expect(h.said()).toBe('I heard a voice. I cannot make out words until speech-to-text is set up. It is in Settings, under Channels.');
    // It shook for nothing: nothing of the usual refusal happened.
    expect(h.shakes()).toBe(0);
    await h.answer('done');
    expect(day.step()).toBe(place('watch'));
  });

  test('at a step that is not listening, talking is talking as ever', async () => {
    const { h, told } = dayOne('watch');
    await h.advance(0);
    await h.speak('t1', 'what is two plus two');
    await h.advance(3000);
    expect(told).toEqual([]);
    // No model is set up, and it says so, as it always did.
    expect(row(h).state).not.toBe('done');
  });
});

describe('pass 12: whether a "where is" was answered by pointing is told', () => {
  test('true when the thing was shown on the screen, false when there was nothing to point at and it went on as any question', async () => {
    const told: boolean[] = [];
    const shown = harness({ deps: { point: async () => ({ ok: true, said: 'Close is at the top right. I am pointing at it.' }), pointed: (was) => { told.push(was); } } });
    await shown.type('where do I close this window');
    await shown.advance(0);
    expect(told).toEqual([true]);
    const none = harness({ deps: { point: async () => null, pointed: (was) => { told.push(was); } } });
    await none.type('where is the Start button');
    await none.advance(0);
    expect(told).toEqual([true, false]);
  });

  test('a question that is not about where something is tells nothing', async () => {
    const told: boolean[] = [];
    const h = harness({ deps: { point: async () => null, pointed: (was) => { told.push(was); } } });
    await h.type('what is two plus two');
    await h.advance(0);
    expect(told).toEqual([]);
  });
});
