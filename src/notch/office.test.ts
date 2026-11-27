/**
 * Pass 12: the back office that fits in a sheet. What is remembered and
 * forgetting it, the notch's own settings, what is connected, and every
 * movement played by hand.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NotchInbox } from './inbox.ts';
import { attachNotchMemory, memoryRequest, memorySource, type NotchMemoryFact } from './memory.ts';
import { NOTCH_MOVES, NOTCH_MOVE_GROUPS, attachNotchMoves, movesRequest } from './moves.ts';
import { attachNotchPrefs, connectionsRequest, pairChoices, pairSaid, pairWritten, prefsRequest, type NotchConnection, type NotchKeyPairs } from './prefs.ts';
import { NOTCH_BIRTHS, NOTCH_MOODS, type NotchBlock, type NotchLine, type NotchPart, type NotchToPage } from './protocol.ts';
import { NotchSettings } from './settings.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string =>
  (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? part.word.value : '')).join('');

function stand() {
  const pushed: NotchToPage[] = [];
  let toSurface: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { toSurface = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 1_000_000;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => toSurface('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 2 });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const line = (): NotchLine | null => surface.current().line;
  const blocks = (): NotchBlock[] => { const l = line(); return l && (l.kind === 'sheet' || l.kind === 'ask') ? l.blocks : []; };
  const rows = (): Extract<NotchBlock, { kind: 'row' }>[] => blocks().filter((b): b is Extract<NotchBlock, { kind: 'row' }> => b.kind === 'row');
  const reply = async (act: string, more: Record<string, unknown> = {}): Promise<void> => { fromPage({ type: 'answer', id: line()!.id, act, ...more }); await settle(); };
  /** Time passes in steps, so that a script that waits, acts and waits again is followed through. */
  const pass = async (ms: number): Promise<void> => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      timers.splice(timers.indexOf(next), 1);
      next.fn();
      await settle();
    }
    now = until;
    await settle();
  };
  const acts = (): Record<string, unknown>[] => pushed.filter((m) => m.type === 'effect').map(({ type: _type, seq: _seq, ...rest }) => rest);
  return { surface, inbox, pushed, line, blocks, rows, reply, pass, acts, said: (): string => text(line()?.say), fromPage };
}

describe('what I remember', () => {
  const FACTS: NotchMemoryFact[] = [
    { id: 'f1', about: 'Sam Reed', text: 'prefers calls', source: 'you told me' },
    { id: 'f2', about: 'Anna', text: 'works at Northwind', source: 'user_profile' },
    { id: 'f3', about: 'Sam Reed', text: 'is in Lisbon until March', source: 'conversation' },
  ];
  function memory(options: { forget?: (id: string) => boolean } = {}) {
    const s = stand();
    let facts = [...FACTS];
    const forgot: string[] = [];
    const m = attachNotchMemory({
      inbox: s.inbox, log: () => {},
      list: () => facts,
      forget: (id) => { forgot.push(id); const ok = options.forget ? options.forget(id) : true; if (ok) facts = facts.filter((fact) => fact.id !== id); return ok; },
    });
    const speak = async (words: string): Promise<boolean> => { const route = m.route(words); route?.run(); await settle(); return route !== null; };
    return { ...s, m, forgot, speak };
  }

  test('the words that open it, and the name they ask about', () => {
    expect(memoryRequest('What do you remember?')).toEqual({ about: null });
    expect(memoryRequest('memory')).toEqual({ about: null });
    expect(memoryRequest('show me my memory')).toEqual({ about: null });
    expect(memoryRequest('What do you know about Sam')).toEqual({ about: 'Sam' });
    expect(memoryRequest('remember that Sam prefers calls')).toBeNull();
    expect(memoryRequest('what do you know about the weather in Lisbon and what should I wear tomorrow if it rains')).toBeNull();
  });

  test('every fact is a row, with who it is about, where it came from, and a Forget', async () => {
    const h = memory();
    expect(await h.speak('what do you remember')).toBe(true);
    expect(h.said()).toBe('What I remember');
    expect(h.line()).toMatchObject({ kind: 'sheet', mood: 'recall' });
    expect(h.rows()).toEqual([
      { kind: 'row', id: 'f1', lead: 'Sam Reed', say: ['prefers calls'], small: 'you told me', buttons: [{ id: 'forget', label: 'Forget', quiet: true }] },
      { kind: 'row', id: 'f2', lead: 'Anna', say: ['works at Northwind'], small: 'from your profile', buttons: [{ id: 'forget', label: 'Forget', quiet: true }] },
      { kind: 'row', id: 'f3', lead: 'Sam Reed', say: ['is in Lisbon until March'], small: 'conversation', buttons: [{ id: 'forget', label: 'Forget', quiet: true }] },
    ]);
    expect(memorySource('')).toBe('');
  });

  test('asked about one person, only what is known about them is shown, by first name too', async () => {
    const h = memory();
    await h.speak('what do you know about sam');
    expect(h.said()).toBe('What I know about Sam Reed');
    expect(h.rows().map((row) => row.id)).toEqual(['f1', 'f3']);
  });

  test('asked about someone nothing is known of, it says so and shows everything', async () => {
    const h = memory();
    await h.speak('what do you know about Leo');
    expect(h.said()).toBe('What I remember');
    expect(text((h.blocks()[0] as Extract<NotchBlock, { kind: 'note' }>).say)).toBe('I know nothing about Leo yet. This is everything.');
    expect(h.rows().length).toBe(3);
  });

  test('Forget asks once on its own row, and only "Forget for good" forgets: the row is struck through where it stands', async () => {
    const h = memory();
    await h.speak('memory');
    const sheet = h.line()!.id;
    await h.reply('button', { row: 'f1', button: 'forget' });
    // Nothing is forgotten by the first press.
    expect(h.forgot).toEqual([]);
    expect(h.rows()[0]).toEqual({ kind: 'row', id: 'f1', lead: 'Sam Reed', say: ['prefers calls'], buttons: [{ id: 'sure', label: 'Forget for good' }, { id: 'keep', label: 'Keep', quiet: true }] });
    await h.reply('button', { row: 'f1', button: 'sure' });
    expect(h.forgot).toEqual(['f1']);
    expect(h.rows()[0]).toEqual({ kind: 'row', id: 'f1', lead: 'Sam Reed', say: ['prefers calls'], small: 'forgotten', gone: true });
    // In place: it is the same sheet, not a new one.
    expect(h.line()!.id).toBe(sheet);
    // And it is gone from memory: opened again, it is not there.
    await h.reply('no');
    await h.speak('memory');
    expect(h.rows().map((row) => row.id)).toEqual(['f2', 'f3']);
  });

  test('Keep takes the asking back, and "Forget for good" on another row than the one asked about forgets nothing', async () => {
    const h = memory();
    await h.speak('memory');
    await h.reply('button', { row: 'f1', button: 'forget' });
    await h.reply('button', { row: 'f2', button: 'sure' });
    expect(h.forgot).toEqual([]);
    await h.reply('button', { row: 'f1', button: 'keep' });
    expect(h.rows()[0]!.buttons).toEqual([{ id: 'forget', label: 'Forget', quiet: true }]);
    await h.reply('button', { row: 'f1', button: 'sure' });
    expect(h.forgot).toEqual([]);
  });

  test('one that could not be forgotten is still there, and says so', async () => {
    const h = memory({ forget: () => false });
    await h.speak('memory');
    await h.reply('button', { row: 'f1', button: 'forget' });
    await h.reply('button', { row: 'f1', button: 'sure' });
    expect(h.rows()[0]).toMatchObject({ small: 'still here', buttons: [{ id: 'forget' }] });
    expect(h.rows()[0]!.gone).toBeUndefined();
    expect(h.acts()).toContainEqual({ gesture: 'shake' });
  });

  test('a forgotten row cannot be forgotten twice', async () => {
    const h = memory();
    await h.speak('memory');
    await h.reply('button', { row: 'f1', button: 'forget' });
    await h.reply('button', { row: 'f1', button: 'sure' });
    await h.reply('button', { row: 'f1', button: 'forget' });
    await h.reply('button', { row: 'f1', button: 'sure' });
    expect(h.forgot).toEqual(['f1']);
  });

  test('with nothing remembered it says so', async () => {
    const s = stand();
    const m = attachNotchMemory({ inbox: s.inbox, log: () => {}, list: () => [], forget: () => true });
    m.route('memory')!.run();
    await settle();
    expect(s.rows()).toEqual([{ kind: 'row', say: ['Nothing yet.'] }]);
  });
});

describe('the keys, as they are said and written', () => {
  test('a pair is said in the machine\'s own names, and read back from them', () => {
    expect(pairSaid(['ctrl', 'meta'], false)).toBe('Ctrl + Win');
    expect(pairSaid(['ctrl', 'alt'], true)).toBe('Ctrl + Option');
    expect(pairSaid(['alt', 'meta'], true)).toBe('Option + Cmd');
    expect(pairWritten('Ctrl + Win', false)).toBe('ctrl+meta');
    expect(pairWritten('option + cmd', true)).toBe('alt+meta');
    expect(pairWritten('Ctrl + Ctrl', false)).toBeNull();
    expect(pairWritten('Ctrl', false)).toBeNull();
    expect(pairWritten('Ctrl + K', false)).toBeNull();
  });

  test('the pair in force comes first, and the other one\'s pair is never offered', () => {
    expect(pairChoices(['ctrl', 'meta'], ['meta', 'alt'], false)).toEqual(['Ctrl + Win', 'Ctrl + Alt', 'Ctrl + Shift']);
    expect(pairChoices(['meta', 'alt'], ['ctrl', 'meta'], false)).toEqual(['Win + Alt', 'Ctrl + Alt', 'Ctrl + Shift']);
    expect(pairChoices(['ctrl', 'alt'], ['alt', 'meta'], true)).toEqual(['Ctrl + Option', 'Ctrl + Cmd', 'Ctrl + Shift']);
  });
});

describe('settings', () => {
  function prefs(options: { pairs?: NotchKeyPairs | null; refuse?: string; voice?: { by: string; language: string } | null; connections?: NotchConnection[] } = {}) {
    const s = stand();
    const settings = new NotchSettings(new Database(':memory:'));
    let pairs = options.pairs === undefined ? { talk: ['ctrl', 'meta'], yes: ['meta', 'alt'], mac: false } as NotchKeyPairs : options.pairs;
    const did: string[] = [];
    s.surface.setSound(false);
    const p = attachNotchPrefs({
      inbox: s.inbox, settings, log: () => {},
      setSound: (on) => { did.push(`sound ${on}`); s.surface.setSound(on); },
      keys: {
        read: async () => pairs,
        change: async (_id, change) => {
          did.push(`keys ${JSON.stringify(change)}`);
          if (options.refuse) return { why: options.refuse };
          const split = (written: string): [string, string] => written.split('+') as [string, string];
          pairs = { ...pairs!, ...(change.talk ? { talk: split(change.talk) } : {}), ...(change.yes ? { yes: split(change.yes) } : {}) };
          return pairs;
        },
      },
      voice: () => (options.voice === undefined ? { by: 'OpenAI', language: 'any language' } : options.voice),
      see: async (stage) => { did.push('see'); await stage.sheet(['What I see'], []); },
      moves: async (stage) => { did.push('moves'); await stage.sheet(['How I move'], []); },
      dayOne: () => { did.push('day one'); },
      connections: () => options.connections ?? [],
      connect: (id) => { did.push(`connect ${id}`); },
      openDashboard: (_id, page) => { did.push(`dashboard ${page ?? ''}`); },
    });
    const speak = async (words: string): Promise<boolean> => { const route = p.route(words); route?.run(); await settle(); return route !== null; };
    return { ...s, p, did, settings, speak };
  }
  const rowText = (row: Extract<NotchBlock, { kind: 'row' }>): string => `${row.lead}: ${text(row.say)}`;

  test('the words that open them', () => {
    expect(prefsRequest('Settings')).toBe(true);
    expect(prefsRequest('open your settings.')).toBe(true);
    expect(prefsRequest('change the talk keys')).toBe(true);
    expect(prefsRequest('change the settings of the meeting')).toBe(false);
    expect(connectionsRequest('connections')).toBe(true);
    expect(connectionsRequest('what are you connected to?')).toBe(true);
    expect(connectionsRequest('connect me to Sam')).toBe(false);
  });

  test('each row is a sentence, with a lit word where something can be changed', async () => {
    const h = prefs();
    expect(await h.speak('settings')).toBe(true);
    expect(h.said()).toBe('Settings');
    expect(h.rows().map(rowText)).toEqual([
      'Talk: Hold Ctrl + Win and speak.',
      'Yes: Tap Win + Alt.',
      'Sounds: My small sounds are off.',
      'Voice: I make out what you say with OpenAI, in any language.',
      'Watching: What I see, and what I never watch.',
    ]);
    const talk = h.rows()[0]!.say[1] as { word: { name: string; options: string[] } };
    expect(talk.word).toMatchObject({ name: 'talk', options: ['Ctrl + Win', 'Ctrl + Alt', 'Ctrl + Shift'] });
  });

  test('another pair for talk is asked of that computer, and the sheet shows what it answered', async () => {
    const h = prefs();
    await h.speak('settings');
    const sheet = h.line()!.id;
    await h.reply('word', { word: 'talk', value: 'Ctrl + Alt' });
    expect(h.did).toEqual(['keys {"talk":"ctrl+alt"}']);
    expect(rowText(h.rows()[0]!)).toBe('Talk: Hold Ctrl + Alt and speak.');
    // Yes may not be the same two keys now: that pair is no longer offered for it.
    expect((h.rows()[1]!.say[1] as { word: { options: string[] } }).word.options).toEqual(['Win + Alt', 'Ctrl + Win', 'Ctrl + Shift']);
    expect(h.line()!.id).toBe(sheet);
  });

  test('a pair that computer refuses is refused here: the word goes back, why is said beside it, and it shakes', async () => {
    const h = prefs({ refuse: 'Talk and yes cannot be the same two keys.' });
    await h.speak('settings');
    // One of the pairs offered (a value that is none of them is the brain's to refuse, below).
    await h.reply('word', { word: 'talk', value: 'Ctrl + Alt' });
    expect(rowText(h.rows()[0]!)).toBe('Talk: Hold Ctrl + Win and speak.');
    expect(h.rows()[0]!.small).toBe('Talk and yes cannot be the same two keys.');
    expect(h.acts()).toContainEqual({ gesture: 'shake' });
  });

  test('words that are not two keys never reach that computer', async () => {
    const h = prefs();
    await h.speak('settings');
    // None of the pairs offered: the brain reads it as typed, cannot, and the settings never hear of it
    // (docs/notch/fixes/07-page-renderer.md, review of steps 5 and 6).
    await h.reply('word', { word: 'talk', value: 'the space bar' });
    expect(h.did).toEqual([]);
    expect(rowText(h.rows()[0]!)).toBe('Talk: Hold Ctrl + Win and speak.');
  });

  test('its sounds are switched on at once, and are kept', async () => {
    const h = prefs();
    await h.speak('settings');
    await h.reply('word', { word: 'sound', value: 'on' });
    expect(h.did).toEqual(['sound true']);
    expect(h.p.sound()).toBe(true);
    expect(h.settings.get('sound', false)).toBe(true);
    expect(rowText(h.rows()[2]!)).toBe('Sounds: My small sounds are on.');
    expect(h.pushed.some((m) => m.type === 'patch' && m.sound === true)).toBe(true);
    await h.reply('word', { word: 'sound', value: 'off' });
    expect(h.p.sound()).toBe(false);
  });

  test('a computer that cannot tell its keys says where they are, and offers no word to change', async () => {
    const h = prefs({ pairs: null });
    await h.speak('settings');
    expect(rowText(h.rows()[0]!)).toBe('Keys: This computer cannot tell me its keys. They are in its tray menu, under Settings.');
    expect(h.rows()[0]!.say.some((part) => typeof part === 'object' && 'word' in part)).toBe(false);
  });

  // The owner, 17 November 2026: "it brought me to the voice section instead of to the channel where there is the speech to text."
  test('with nothing to make out speech it says so, and the way to set it up is where speech-to-text is set, not the voice page', async () => {
    const h = prefs({ voice: null });
    await h.speak('settings');
    expect(rowText(h.rows()[2]!)).toBe('Sounds: My small sounds are off.');
    expect(h.rows()[3]).toMatchObject({ lead: 'Voice', say: ['Nothing turns your speech into words yet.'], buttons: [{ id: 'voice', label: 'Set up', quiet: true }] });
    await h.reply('button', { button: 'voice' });
    expect(h.did).toEqual(['dashboard speech']);
  });

  test('Watching leads to what I see, How I move to the library, and the settings are back after each', async () => {
    const h = prefs();
    await h.speak('settings');
    await h.reply('go', { row: 'see' });
    expect(h.said()).toBe('What I see');
    await h.reply('no');
    expect(h.said()).toBe('Settings');
    await h.reply('button', { button: 'moves' });
    expect(h.said()).toBe('How I move');
    await h.reply('no');
    expect(h.said()).toBe('Settings');
    await h.reply('button', { button: 'dayone' });
    expect(h.did).toEqual(['see', 'moves', 'day one']);
  });

  test('connections say what is reached and what is not, and take the person to where one is connected', async () => {
    const h = prefs({ connections: [
      { id: 'gmail', name: 'Gmail', state: 'on', how: 'I read it in my own browser, signed in as you.' },
      { id: 'calendar', name: 'Calendar', state: 'again', how: 'Google wants you to sign in again.' },
    ] });
    await h.speak('connections');
    expect(h.rows()).toEqual([
      { kind: 'row', id: 'gmail', lead: 'Gmail', say: ['I read it in my own browser, signed in as you.'], small: 'Connected' },
      { kind: 'row', id: 'calendar', lead: 'Calendar', say: ['Google wants you to sign in again.'], small: 'Needs you to sign in again', buttons: [{ id: 'connect', label: 'Sign in' }] },
    ]);
    await h.reply('button', { row: 'calendar', button: 'connect' });
    expect(h.did).toEqual(['connect calendar']);
    expect(h.said()).toBe('I opened it. Sign in there, and come back.');
  });
});

describe('how I move', () => {
  test('the library is the prototype\'s: 36 animations in four groups, 22 eye looks, 9 eye movements, and one more', () => {
    const count = (group: string): number => NOTCH_MOVES.filter((move) => move.group === group).length;
    // The tenth eye movement is not the prototype's: the gecko's blink, asked for on 18 November 2026.
    expect(NOTCH_MOVE_GROUPS.map(count)).toEqual([14, 8, 8, 6, 22, 10]);
    expect(NOTCH_MOVES.find((move) => move.id === 'move-gecko')).toMatchObject({ group: 'Eye movements', label: 'Gecko blink' });
    expect(count('The lip') + count('The body') + count('Along the edge') + count('Being born')).toBe(36);
    // Every look the notch has is in it, but the one that only follows its own cursor.
    expect(NOTCH_MOVES.filter((move) => move.group === 'Eye looks').map((move) => move.id.slice(5)).sort()).toEqual(NOTCH_MOODS.filter((mood) => mood !== 'track').slice().sort());
    expect(NOTCH_MOVES.filter((move) => move.group === 'Being born').map((move) => move.id.slice(6))).toEqual([...NOTCH_BIRTHS]);
    expect(new Set(NOTCH_MOVES.map((move) => move.id)).size).toBe(NOTCH_MOVES.length);
  });

  test('the words that open it', () => {
    expect(movesRequest('Show me how you move')).toBe(true);
    expect(movesRequest('your animations')).toBe(true);
    expect(movesRequest('how do you move?')).toBe(true);
    expect(movesRequest('move the meeting to Friday')).toBe(false);
    expect(movesRequest('show me the numbers')).toBe(false);
  });

  function moves(resting: 'idle' | 'away' = 'idle') {
    const s = stand();
    const m = attachNotchMoves({ inbox: s.inbox, resting: () => resting, log: () => {} });
    const open = async (): Promise<void> => { m.route('show me how you move')!.run(); await settle(); };
    return { ...s, m, open };
  }

  test('the sheet has a heading and its buttons for each group', async () => {
    const h = moves();
    await h.open();
    expect(h.said()).toBe('How I move');
    const notes = h.blocks().filter((b): b is Extract<NotchBlock, { kind: 'note' }> => b.kind === 'note').map((b) => text(b.say));
    expect(notes.slice(0, 6)).toEqual(['The lip, 14', 'The body, 8', 'Along the edge, 8', 'Being born, 6', 'Eye looks, 22', 'Eye movements, 10']);
    const buttons = h.blocks().filter((b): b is Extract<NotchBlock, { kind: 'buttons' }> => b.kind === 'buttons').flatMap((b) => b.buttons);
    // The prototype's 67, and the gecko's blink.
    expect(buttons.length).toBe(68);
    expect(buttons.every((button) => !button.quiet)).toBe(true);
  });

  test('a button plays its movement with the prototype\'s caption and timing, and then the sheet is back', async () => {
    const h = moves();
    await h.open();
    await h.reply('button', { button: 'lip-laughs' });
    expect(h.said()).toBe('Ha.');
    expect(h.line()).toMatchObject({ kind: 'say', mood: 'happy', ms: 3400 });
    expect(h.acts()).toEqual([]);
    await h.pass(520);
    expect(h.acts()).toEqual([{ lip: 'laugh' }]);
    await h.pass(5000);
    expect(h.said()).toBe('How I move');
    // The face it has at rest is given back, whatever the movement did to it.
    expect(h.acts().at(-1)).toEqual({ mood: 'idle' });
  });

  test('a line that arrives is shown arriving, though it was asked for', async () => {
    const h = moves();
    await h.open();
    await h.reply('button', { button: 'edge-pair' });
    await h.pass(260);
    expect(h.line()).toMatchObject({ kind: 'say', arrive: 'pair' });
    expect(h.said()).toBe('Two things: Gmail and Stripe.');
  });

  test('a birth starts from rest, and an agent buds off half a second after it is met', async () => {
    const h = moves();
    await h.open();
    await h.reply('button', { button: 'birth-gather' });
    expect(h.line()).toBeNull();
    await h.pass(450);
    expect(h.acts()).toEqual([{ birth: 'gather' }]);
    await h.pass(2400);
    expect(h.said()).toBe('How I move');
    await h.reply('button', { button: 'edge-buds' });
    expect(h.said()).toBe('Meet Tony.');
    await h.pass(500);
    expect(h.acts()).toContainEqual({ edge: 'bud' });
  });

  test('every one of them plays to its end and gives the sheet back', async () => {
    const h = moves('away');
    await h.open();
    for (const move of NOTCH_MOVES) {
      await h.reply('button', { button: move.id });
      await h.pass(9000);
      expect([move.id, h.said()]).toEqual([move.id, 'How I move']);
      expect([move.id, h.acts().at(-1)]).toEqual([move.id, { mood: 'away' }]);
    }
  });
});
