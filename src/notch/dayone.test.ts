/**
 * Pass 12: day one in the notch. Eleven steps, each of them real: what is
 * tested here is that each does what it says, that a step which is left
 * waits and is gone on from, and that it begins by itself once and only on
 * a brain that was never set up.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  NOTCH_DAY_ONE_AFTER_MS, NOTCH_DAY_ONE_FOLD_MS, NOTCH_DAY_ONE_ORDER, NOTCH_INSTALLED_CARD_MS, aroundRequest, attachNotchDayOne, dayOneRequest,
  type NotchAroundSource, type NotchDayOneDeps, type NotchDayOneStep,
} from './dayone.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchBlock, NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import { NotchSettings } from './settings.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 120; i++) await Promise.resolve(); };
/** The place of each step, from 1. A step is known by its name here: the order is the product's to change. */
const S = Object.fromEntries(NOTCH_DAY_ONE_ORDER.map((name, at) => [name, at + 1])) as Record<NotchDayOneStep, number>;
const of = (name: NotchDayOneStep): string => `step ${S[name]}/${NOTCH_DAY_ONE_ORDER.length}`;
const text = (parts: NotchPart[] | undefined): string =>
  (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? part.word.value : 'key' in part ? `[${part.key}]` : '')).join('');

interface World {
  fresh: boolean;
  name: string;
  model: { ready: boolean; name: string; hosted: boolean };
  /** Whether anything makes out speech. Null: day one is not told, and does not ask. */
  voice: boolean | null;
  watching: boolean;
  canSwitch: boolean;
  mailReached: boolean;
  reply: string | null;
  sources: NotchAroundSource[] | null;
  canPoint: boolean;
  onDesktop: boolean | null;
  system: 'windows' | 'mac' | null;
  db: Database;
}

function harness(given: Partial<World> = {}) {
  const world: World = {
    fresh: true, name: '', model: { ready: true, name: 'gpt-test', hosted: false }, voice: null, watching: true, canSwitch: true,
    mailReached: false, reply: null, sources: null, canPoint: true, onDesktop: false, system: 'windows', db: new Database(':memory:'), ...given,
  };
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
  fromPage({ type: 'hello', v: 1 });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const settings = new NotchSettings(world.db);
  const did: string[] = [];
  const card: string[] = [];
  const logs: string[] = [];
  const deps: NotchDayOneDeps = {
    inbox, settings, clock, now: () => now, log: (line) => logs.push(line),
    fresh: () => world.fresh,
    name: { get: () => world.name, set: (name) => { did.push(`name ${name}`); world.name = name; } },
    model: {
      ready: () => world.model.ready, name: () => world.model.name, hosted: () => world.model.hosted,
      setUp: (id) => { did.push(`set up on ${id}`); }, finish: () => { did.push('finish setup'); },
    },
    ...(world.voice !== null ? { voice: { ready: () => world.voice === true, setUp: (id: string | null) => { did.push(`voice on ${id}`); } } } : {}),
    installed: { show: () => { card.push('show'); }, hide: () => { card.push('hide'); } },
    watching: { on: () => world.watching, set: (on) => { did.push(`watch ${on}`); if (world.canSwitch) world.watching = on; return world.watching; } },
    canLook: () => true,
    canDrop: () => true,
    canPoint: () => world.canPoint,
    isWhere: (words) => /^(where|how do i)\b/i.test(words),
    onDesktop: () => world.onDesktop,
    system: () => world.system,
    canDo: async (stage, more) => { did.push(`can do, with ${more.yes}`); await stage.sheet(['What I can do'], [], { yes: more.yes }); },
    mail: { reached: async () => world.mailReached, open: async () => { did.push('open mail'); } },
    told: async (what) => { did.push(`told ${what}`); return world.reply; },
    ...(world.sources ? { around: () => world.sources! } : {}),
  };
  const day = attachNotchDayOne(deps);
  const line = (): NotchLine | null => surface.current().line;
  const said = (): string => text(line()?.say);
  const reply = async (act: string, more: Record<string, unknown> = {}): Promise<void> => { fromPage({ type: 'answer', id: line()!.id, act, ...more }); await settle(); };
  /** A line that only says something has been read: on to what comes after it. */
  const seen = async (): Promise<void> => { expect(line()?.kind).toBe('say'); await reply('done'); };
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
  const acts = (): Record<string, unknown>[] => pushed.filter((m) => m.type === 'act').map(({ type: _type, ...rest }) => rest);
  /** Goes through the steps before `step` the short way: yes to each, and nothing said. */
  const upTo = async (name: NotchDayOneStep): Promise<void> => { settings.set('dayone', { step: S[name], done: false }); day.cameUp(); await pass(NOTCH_DAY_ONE_AFTER_MS); };
  return { world, day, inbox, surface, settings, did, card, logs, line, said, reply, seen, pass, acts, upTo, fromPage, count: (): number => surface.current().count };
}

describe('when it begins', () => {
  test('by itself, a moment after the notch first comes up, on a brain that was never set up', async () => {
    const h = harness();
    h.day.cameUp();
    expect(h.line()).toBeNull();
    await h.pass(NOTCH_DAY_ONE_AFTER_MS - 1);
    expect(h.line()).toBeNull();
    await h.pass(1);
    expect(h.said()).toBe('Hi. I am Pillow. I live up here. Say hello?');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'hello', mood: 'curious', step: of('hello'), fold: NOTCH_DAY_ONE_FOLD_MS });
    expect(h.day.step()).toBe(S.hello);
  });

  test('before its first word, a card says that it is installed; the card leaves when that word is answered', async () => {
    const h = harness();
    h.day.cameUp();
    // At once, while it is being born: not after the first line.
    expect(h.card).toEqual(['show']);
    await h.pass(NOTCH_DAY_ONE_AFTER_MS);
    expect(h.card).toEqual(['show']);
    await h.reply('yes');
    expect(h.card).toEqual(['show', 'hide']);
  });

  test('with nobody there to answer, the card leaves by itself', async () => {
    const h = harness();
    h.day.cameUp();
    await h.pass(NOTCH_INSTALLED_CARD_MS - 1);
    expect(h.card).toEqual(['show']);
    await h.pass(1);
    expect(h.card).toEqual(['show', 'hide']);
  });

  test('no card when day one is asked for again, when it goes on from a later step, or on a brain that is set up', async () => {
    const again = harness({ fresh: false });
    again.day.route('day one')!.run();
    await settle();
    expect(again.card).toEqual([]);
    const later = harness();
    await later.upTo('litWord');
    expect(later.card).toEqual([]);
    const old = harness({ fresh: false });
    old.day.cameUp();
    await old.pass(60_000);
    expect(old.card).toEqual([]);
  });

  test('never by itself on a brain that is set up', async () => {
    const h = harness({ fresh: false });
    h.day.cameUp();
    await h.pass(60_000);
    expect(h.line()).toBeNull();
    expect(h.day.step()).toBe(0);
  });

  test('once: a page that comes up again does not begin it again', async () => {
    const h = harness();
    h.day.cameUp();
    h.day.cameUp();
    await h.pass(NOTCH_DAY_ONE_AFTER_MS);
    await h.reply('yes');
    h.day.cameUp();
    await h.pass(NOTCH_DAY_ONE_AFTER_MS);
    // It has gone on to the second step, and not back to the first.
    expect(h.day.step()).toBe(S.brain);
    expect(h.said()).not.toContain('Say hello');
  });

  test('when it is asked for, whatever was kept: "day one", and from the settings', async () => {
    expect(dayOneRequest('Day one')).toBe(true);
    expect(dayOneRequest('show me around')).toBe(true);
    expect(dayOneRequest('run the tutorial again.')).toBe(true);
    expect(dayOneRequest('what did I do on day one of the trip')).toBe(false);
    expect(aroundRequest('look around')).toBe(true);
    expect(aroundRequest('look around the office for a venue')).toBe(false);
    const h = harness({ fresh: false });
    h.settings.set('dayone', { step: 9, done: true });
    const route = h.day.route('day one');
    expect(route?.did).toBe('Start day one.');
    route!.run();
    await settle();
    expect(h.said()).toBe('Hi. I am Pillow. I live up here. Say hello?');
  });
});

describe('the grammar, by doing each thing once', () => {
  test('a yes is named as one, and the AI comes straight after it', async () => {
    const h = harness();
    await h.upTo('hello');
    await h.reply('yes');
    expect(h.said()).toBe('That was a yes. One tap.');
    await h.seen();
    // The owner: "put that at the beginning ... because a lot of it will use AI."
    expect(S.brain).toBe(2);
    expect(h.said()).toBe('I think with gpt-test. That is set.');
    await h.seen();
    expect(h.said()).toBe('For not now, press esc, or just ignore me. I never mind. Try it.');
    expect(h.line()).toMatchObject({ kind: 'offer', keys: 'esc', step: of('notNow'), fold: 8000 });
  });

  test('Esc at the first line is the "not now" lesson already learned: its own step is passed over when it comes', async () => {
    const h = harness();
    await h.upTo('hello');
    await h.reply('no');
    expect(h.said()).toBe('That was a not now. It is all it takes.');
    await h.seen();
    // The AI still comes next: only the lesson that was learned is left out.
    expect(h.said()).toBe('I think with gpt-test. That is set.');
    await h.seen();
    expect(h.line()).toMatchObject({ step: of('litWord') });
  });

  test('that it was learned is kept: a brain that stops in between still passes over it', async () => {
    const h = harness();
    await h.upTo('hello');
    await h.reply('no');
    await h.seen();
    const next = harness({ db: h.world.db, fresh: false });
    next.day.cameUp();
    await next.pass(NOTCH_DAY_ONE_AFTER_MS);
    await next.seen();
    expect(next.line()).toMatchObject({ step: of('litWord') });
  });

  test('2: a yes shakes and says so on the same line; Esc is the answer; so is being ignored', async () => {
    const h = harness();
    await h.upTo('notNow');
    const id = h.line()!.id;
    await h.reply('yes');
    expect(h.acts()).toContainEqual({ gesture: 'shake' });
    expect(h.said()).toBe('That says yes. Now try esc.');
    expect(h.line()!.id).toBe(id);
    await h.reply('no');
    expect(h.said()).toBe('Good. That is all it takes to say not now.');

    const ignored = harness();
    await ignored.upTo('notNow');
    await ignored.reply('fold');
    expect(ignored.said()).toBe('You ignored me. That works too.');
    await ignored.seen();
    expect(ignored.day.step()).toBe(S.litWord);
  });

  test('3: the name is a lit word, and the one that is agreed to is kept', async () => {
    const h = harness();
    await h.upTo('litWord');
    expect(h.said()).toBe('The lit words are yours to change. I call you Boss. Click the name.');
    const lit = h.line()!.say[1] as { word: { name: string; options: string[]; free?: boolean; label?: string } };
    expect(lit.word).toMatchObject({ name: 'name', options: ['Boss', 'Chief', 'Captain'], free: true, label: 'I call you' });
    await h.reply('word', { word: 'name', value: 'Sam' });
    expect(h.did).toEqual([]);
    await h.reply('yes');
    expect(h.did).toEqual(['name Sam']);
    expect(h.said()).toBe('Sam it is.');
  });

  test('3: a name that is already known is offered first, with its initial', async () => {
    const h = harness({ name: 'Sam Reed' });
    await h.upTo('litWord');
    expect((h.line()!.say[1] as { word: { options: string[] } }).word.options).toEqual(['Sam', 'S', 'Boss']);
  });

  test('4: what is said while it waits is its answer, whatever the words are', async () => {
    const h = harness({ reply: 'A founder. I will look for leads, invoices and follow-ups.' });
    await h.upTo('talk');
    expect(h.said()).toBe('Now tell me what you do. Out loud.');
    expect(h.line()).toMatchObject({ kind: 'offer', keys: 'talk', yes: 'hold and talk', mood: 'listen', step: of('talk') });
    // Words that would otherwise make an agent are, here, what they do.
    const route = h.day.route('Every Monday I send Sam the numbers');
    expect(route?.did).toBe('Told Pillow what they do, on day one.');
    route!.run();
    await settle();
    expect(h.did).toEqual(['told Every Monday I send Sam the numbers']);
    expect(h.said()).toBe('A founder. I will look for leads, invoices and follow-ups.');
    await h.seen();
    expect(h.day.step()).toBe(S.watch);
    // And from then on words are words again.
    expect(h.day.route('Every Monday I send Sam the numbers')).toBeNull();
  });

  test('4: with nothing to answer with, it says what is true of what it heard', async () => {
    const h = harness({ reply: null });
    await h.upTo('talk');
    h.day.route('I run a small studio')!.run();
    await settle();
    expect(h.said()).toBe('Heard. That is how you tell me anything.');
  });

  test('4: with no way to make out words, it says so and goes on; it does not ask again', async () => {
    const h = harness();
    await h.upTo('talk');
    expect(h.day.unheard('no_stt')).toBe(true);
    await settle();
    expect(h.said()).toBe('I heard a voice. I cannot make out words until speech-to-text is set up. It is under Voice in Settings.');
    await h.seen();
    expect(h.day.step()).toBe(S.watch);
  });

  test('4: not caught twice, and it goes on by itself', async () => {
    const h = harness();
    await h.upTo('talk');
    expect(h.day.unheard('silence')).toBe(true);
    await settle();
    expect(h.said()).toBe('I did not catch that. Keep the keys down while you talk.');
    await h.seen();
    expect(h.said()).toBe('Now tell me what you do. Out loud.');
    expect(h.day.unheard('too_little')).toBe(true);
    await settle();
    expect(h.said()).toBe('I did not catch it. It will come. On we go.');
  });

  test('4: at any other step, what was not made out is not day one\'s to answer', async () => {
    const h = harness();
    await h.upTo('watch');
    expect(h.day.unheard('silence')).toBe(false);
  });

  test('5: yes leaves watching on, and switches it on where it was off', async () => {
    const h = harness();
    await h.upTo('watch');
    expect(h.said()).toBe('May I watch which app you are in? Close my eyes any time.');
    await h.reply('yes');
    expect(h.did).toEqual([]);
    expect(h.said()).toBe('Thank you. Eyes open.');
    expect(h.line()).toMatchObject({ mood: 'search' });

    const off = harness({ watching: false });
    await off.upTo('watch');
    await off.reply('yes');
    expect(off.did).toEqual(['watch true']);
    expect(off.said()).toBe('Thank you. Eyes open.');
  });

  test('5: a no switches watching off, and there is then nothing to show it', async () => {
    const h = harness();
    await h.upTo('watch');
    await h.reply('no');
    expect(h.did).toEqual(['watch false']);
    expect(h.world.watching).toBe(false);
    expect(h.said()).toBe('Then I see nothing. Open my eyes any time, in What I see.');
    expect(h.line()).toMatchObject({ mood: 'closed' });
    await h.seen();
    // The step after it, showing it something, is passed over.
    expect(h.day.step()).toBe(S.connect);
  });

  test('5: where the switch cannot be reached, it does not say its eyes are closed when they are not', async () => {
    const h = harness({ canSwitch: false });
    await h.upTo('watch');
    await h.reply('no');
    expect(h.said()).toBe('I could not close my eyes from here. "Sleep" in What I see does.');
  });

  test('6: any real look is the lesson, named by what was shown, and nothing else comes of it', async () => {
    const h = harness();
    await h.upTo('show');
    // It says how: the keys held down, then the mouse pressed and dragged.
    expect(h.said()).toBe('Now show me something. Keep [talk] held down, then click and drag a circle round a thing.');
    expect(h.line()).toMatchObject({ keys: 'talk', yes: 'hold, then drag', step: of('show') });
    expect(h.day.shown({ app: 'notepad', things: [{ name: '' }, { name: 'Quarterly numbers' }] })).toBe(true);
    // The keys were held to circle, so a recording with nothing in it comes too: that is not answered.
    expect(h.day.unheard('silence')).toBe(true);
    await settle();
    expect(h.said()).toBe('You showed me Quarterly numbers. That works on anything on your screen.');
    await h.seen();
    expect(h.day.step()).toBe(S.connect);
    // A look after the lesson is anybody's again.
    expect(h.day.shown({ app: 'notepad', things: [] })).toBe(false);
  });

  test('6: a yes is not a circle, so it is said once more, more plainly; Esc leaves it for later', async () => {
    const h = harness();
    await h.upTo('show');
    await h.reply('yes');
    expect(h.said()).toBe('Both at once: [talk] held down, and the mouse pressed and dragged round the thing.');
    await h.reply('no');
    expect(h.said()).toBe('Later then. It is always there.');
  });
});

describe('what it works with', () => {
  test('an AI that is there is named, nothing is asked, and the product\'s own first setup is finished with it', async () => {
    const h = harness();
    await h.upTo('brain');
    expect(h.said()).toBe('I think with gpt-test. That is set.');
    expect(h.line()).toMatchObject({ kind: 'say', mark: 'check' });
    expect(h.did).toEqual(['finish setup']);
    const hosted = harness({ model: { ready: true, name: '', hosted: true } });
    await hosted.upTo('brain');
    expect(hosted.said()).toBe('Jarvis AI it is. It comes with your plan.');
  });

  test('with none, the choice opens the page where one is added and waits for it; when it is in, the setup is finished', async () => {
    const h = harness({ model: { ready: false, name: '', hosted: false } });
    await h.upTo('brain');
    expect(h.said()).toBe('First, an AI to think with. Which one should I use?');
    expect(h.line()).toMatchObject({ kind: 'offer', options: ['My own AI account', 'AI on this computer'], step: of('brain') });
    await h.reply('pick', { option: 'My own AI account', index: 0 });
    expect(h.did).toEqual(['set up on pc']);
    expect(h.said()).toBe('I opened the AI settings. Add your account and its key there.');
    expect(h.line()).toMatchObject({ kind: 'work', steps: 0 });
    await h.pass(6000);
    expect(h.line()?.kind).toBe('work');
    // Nothing is finished while there is no AI.
    expect(h.did).toEqual(['set up on pc']);
    h.world.model = { ready: true, name: 'claude-test', hosted: false };
    await h.pass(2000);
    expect(h.did).toEqual(['set up on pc', 'finish setup']);
    expect(h.said()).toBe('claude-test it is. Now I can think.');
  });

  test('Esc while it waits is "later", said truthfully: the setup is not called finished, and day one goes on', async () => {
    const h = harness({ model: { ready: false, name: '', hosted: false } });
    await h.upTo('brain');
    await h.reply('pick', { option: 'AI on this computer', index: 1 });
    expect(h.said()).toBe('I opened the AI settings. Choose the AI on this computer there.');
    await h.reply('stop');
    await h.pass(2000);
    expect(h.said()).toBe('Later then. Until I have one I can listen and show you round, but not think.');
    expect(h.did).toEqual(['set up on pc']);
    await h.seen();
    expect(h.day.step()).toBe(S.notNow);
  });


  test('with an AI in and nothing to make out speech, it asks for that too, opens its page and waits', async () => {
    const h = harness({ voice: false });
    await h.upTo('brain');
    expect(h.said()).toBe('I think with gpt-test. That is set.');
    await h.seen();
    // Still the AI's step: hearing is part of what it thinks and listens with.
    expect(h.day.step()).toBe(S.brain);
    expect(h.said()).toBe('To hear you I need speech-to-text too. Set that up now?');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'set up', step: of('brain') });
    await h.reply('yes');
    expect(h.did).toEqual(['finish setup', 'voice on pc']);
    expect(h.said()).toBe('I opened the voice settings. Choose a speech-to-text service there, and give its key.');
    await h.pass(6000);
    expect(h.line()?.kind).toBe('work');
    h.world.voice = true;
    await h.pass(2000);
    expect(h.said()).toBe('Now I can hear you.');
    await h.seen();
    expect(h.day.step()).toBe(S.notNow);
  });

  test('the same after an AI that was just set up', async () => {
    const h = harness({ model: { ready: false, name: '', hosted: false }, voice: false });
    await h.upTo('brain');
    await h.reply('pick', { option: 'My own AI account', index: 0 });
    h.world.model = { ready: true, name: 'claude-test', hosted: false };
    await h.pass(2000);
    expect(h.said()).toBe('claude-test it is. Now I can think.');
    await h.seen();
    expect(h.said()).toBe('To hear you I need speech-to-text too. Set that up now?');
  });

  test('a no to that, and Esc while it waits, are "later": it says what it then cannot do, and where to set it up', async () => {
    const no = harness({ voice: false });
    await no.upTo('brain');
    await no.seen();
    await no.reply('no');
    expect(no.said()).toBe('Later then. Until then I cannot make out what you say. It is under Voice in Settings.');
    expect(no.did).toEqual(['finish setup']);
    await no.seen();
    expect(no.day.step()).toBe(S.notNow);

    const esc = harness({ voice: false });
    await esc.upTo('brain');
    await esc.seen();
    await esc.reply('yes');
    await esc.reply('stop');
    await esc.pass(2000);
    expect(esc.said()).toBe('Later then. Until then I cannot make out what you say. It is under Voice in Settings.');
  });

  test('speech that is already made out is not asked about, and neither is it with no AI', async () => {
    const there = harness({ voice: true });
    await there.upTo('brain');
    await there.seen();
    expect(there.day.step()).toBe(S.notNow);

    const none = harness({ model: { ready: false, name: '', hosted: false }, voice: false });
    await none.upTo('brain');
    await none.reply('no');
    expect(none.said()).toBe('Later then. Until I have one I can listen and show you round, but not think.');
    await none.seen();
    expect(none.day.step()).toBe(S.notNow);
    expect(none.did).toEqual([]);
  });

  test('left alone at the hearing, it waits in the count, and the AI is not named a second time when it is opened', async () => {
    const h = harness({ voice: false });
    await h.upTo('brain');
    await h.seen();
    expect(h.said()).toBe('To hear you I need speech-to-text too. Set that up now?');
    // The page folds a line that nobody answered, and says so.
    await h.reply('fold');
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    expect(h.day.step()).toBe(S.brain);
    h.fromPage({ type: 'open' });
    await settle();
    expect(h.said()).toBe('To hear you I need speech-to-text too. Set that up now?');
    // The setup was finished once, when the AI was named, and asked for again harmlessly: it does nothing the second time.
    expect(h.did.filter((what) => what === 'finish setup').length).toBe(2);
  });

  test('8: mail that is already within reach is said, and nothing is opened', async () => {
    const h = harness({ mailReached: true });
    await h.upTo('connect');
    expect(h.said()).toBe('Your mail and calendar are already within reach.');
    expect(h.did).toEqual([]);
  });

  test('8: connect opens the sign-in and waits until the mailbox can be read', async () => {
    const h = harness();
    await h.upTo('connect');
    expect(h.said()).toBe('Connect your email and calendar? I learn fastest there.');
    await h.reply('yes');
    expect(h.did).toEqual(['open mail']);
    expect(h.said()).toBe('Sign in to Google in the window I opened.');
    await h.pass(10_000);
    expect(h.line()?.kind).toBe('work');
    h.world.mailReached = true;
    await h.pass(5000);
    expect(h.said()).toBe('Connected. I can read your mail and your calendar.');
  });

  const SOURCES: NotchAroundSource[] = [
    { name: 'Memory', read: async () => ({ found: '2 things remembered', things: [{ label: 'Sam', kind: 'person' }] }) },
    { name: 'Gmail', read: async () => ({ found: '2 people wait', tool: true, things: [{ label: 'Anna', kind: 'person' }, { label: 'Sam', kind: 'person' }] }) },
    { name: 'Calendar', read: async () => { throw new Error('the calendar did not answer'); } },
  ];
  const map = (line: NotchLine | null): Extract<NotchBlock, { kind: 'map' }> =>
    (line as Extract<NotchLine, { kind: 'sheet' }>).blocks.find((b): b is Extract<NotchBlock, { kind: 'map' }> => b.kind === 'map')!;

  test('9: looking around draws what each place holds as it is read, and one thing is never drawn twice', async () => {
    const h = harness({ sources: SOURCES });
    await h.upTo('lookAround');
    expect(h.said()).toBe('May I look around? Your mail, your calendar, and the files on your desktop. I open the newest few, remember what they are, and skip anything private.');
    await h.reply('yes');
    expect(h.said()).toBe('Looking around');
    expect(h.line()).toMatchObject({ kind: 'sheet', mood: 'search', stay: true, yes: 'continue', no: 'skip', step: of('lookAround') });
    // It starts with the person alone, and the places it will read.
    expect(map(h.line()).nodes.map((node) => node.label)).toEqual(['You', 'Sam']);
    await h.pass(4000);
    const drawn = map(h.line());
    expect(drawn.nodes.map((node) => `${node.kind}:${node.label}`)).toEqual(['me:You', 'person:Sam', 'tool:Gmail', 'person:Anna']);
    // Sam is known from two places: one dot, with a line to each.
    expect(drawn.links).toEqual([['you', 'person1'], ['you', 'tool1'], ['tool1', 'person2'], ['tool1', 'person1']]);
    expect(drawn.sources).toEqual([
      { name: 'Memory', state: 'done', found: '2 things remembered' },
      { name: 'Gmail', state: 'done', found: '2 people wait' },
      // A place that could not be read says so, and the looking goes on.
      { name: 'Calendar', state: 'done', found: 'not reached' },
    ]);
    expect(drawn.tour).toEqual(['person1', 'tool1', 'person2', 'you']);
    await h.reply('yes');
    expect(h.day.step()).toBe(S.drop);
  });

  test('9: Esc in the middle ends the looking where it is, and day one goes on', async () => {
    const h = harness({ sources: SOURCES });
    await h.upTo('lookAround');
    await h.reply('yes');
    await h.reply('no');
    await h.pass(4000);
    expect(h.day.step()).toBe(S.drop);
  });

  test('9: with nothing to look around in, the step is not there', async () => {
    const h = harness();
    await h.upTo('lookAround');
    expect(h.line()).toMatchObject({ step: of('drop') });
  });

  test('9: the files of the desktop are drawn by name, a long name is cut, and each place says a sentence under the map', async () => {
    const h = harness({ sources: [
      { name: 'Desktop', read: async () => ({
        found: '14 files', tool: true,
        things: [{ label: 'Budget for the fourth quarter final.xlsx', kind: 'thing' }, { label: 'Pitch.pptx', kind: 'thing' }],
        say: [{ em: '14 files' }, ' and ', { em: '3 folders' }, '. Mostly spreadsheets.'],
      }) },
      { name: 'Downloads', read: async () => ({ found: 'not reached', things: [] }) },
    ] });
    await h.upTo('lookAround');
    await h.reply('yes');
    await h.pass(4000);
    const sheet = h.line() as Extract<NotchLine, { kind: 'sheet' }>;
    expect(map(sheet).nodes.map((node) => `${node.kind}:${node.label}`)).toEqual(['me:You', 'tool:Desktop', 'thing:Budget for the …', 'thing:Pitch.pptx']);
    // The files hang from the desktop, not from the person.
    expect(map(sheet).links).toEqual([['you', 'tool1'], ['tool1', 'thing1'], ['tool1', 'thing2']]);
    const rows = sheet.blocks.filter((b): b is Extract<NotchBlock, { kind: 'row' }> => b.kind === 'row');
    expect(rows.map((row) => `${row.lead}: ${text(row.say)}`)).toEqual(['Desktop: 14 files and 3 folders. Mostly spreadsheets.']);
    const note = sheet.blocks.find((b): b is Extract<NotchBlock, { kind: 'note' }> => b.kind === 'note')!;
    expect(text(note.say)).toBe('That is what I can reach today. What I remember of it is in Memory, where you can forget any of it.');
  });

  test('9: each file that was opened gets a line of its own under the sentence about them', async () => {
    const h = harness({ sources: [
      { name: 'Reading', read: async () => ({
        found: '2 files opened', things: [],
        say: ['I opened the newest 2, to see what they are.'],
        rows: [{ lead: 'Budget Q4.xlsx', say: ['Revenue by month for the fourth quarter.'] }, { lead: 'Pitch.pptx', say: ['A pitch for investors, twelve slides.'] }],
      }) },
    ] });
    await h.upTo('lookAround');
    await h.reply('yes');
    await h.pass(4000);
    const sheet = h.line() as Extract<NotchLine, { kind: 'sheet' }>;
    const rows = sheet.blocks.filter((b): b is Extract<NotchBlock, { kind: 'row' }> => b.kind === 'row');
    expect(rows.map((row) => `${row.lead}: ${text(row.say)}`)).toEqual([
      'Reading: I opened the newest 2, to see what they are.',
      'Budget Q4.xlsx: Revenue by month for the fourth quarter.',
      'Pitch.pptx: A pitch for investors, twelve slides.',
    ]);
  });

  test('10: a real file dropped on it is the lesson, and day one says so only when the file has been asked about', async () => {
    const h = harness();
    await h.upTo('drop');
    expect(h.said()).toBe('Now hand me a file. Drag any file from your desktop onto me.');
    expect(h.line()).toMatchObject({ kind: 'offer', keys: 'esc', step: of('drop') });
    // A yes is not a file: it says where to drag it, on the same line.
    const id = h.line()!.id;
    await h.reply('yes');
    expect(h.said()).toBe('Drag it here, onto me. I open my mouth when it is over me.');
    expect(h.line()!.id).toBe(id);
    // The file is dropped: what is wanted from it takes the notch, as for any file, and day one has it back after.
    h.inbox.add({ id: 'drop-1', subject: 'drop', class: 'person', speaks: true, urgent: true, asked: true, returns: true, title: () => ['A file.'],
      play: async (stage) => { await stage.offer(['What do you want from it?'], 'ask'); return 'settled'; } });
    h.day.gave();
    await settle();
    expect(h.said()).toBe('What do you want from it?');
    await h.reply('yes');
    await h.pass(600);
    expect(h.said()).toBe('That is all there is to it: drop it, then ask.');
    await h.seen();
    expect(h.day.step()).toBe(S.whereIs);
    // A file dropped at any other time is nobody's lesson.
    h.day.gave();
    await settle();
    expect(h.day.step()).toBe(S.whereIs);
  });

  test('10: its line is said to the end, even when what was asked about the file takes the notch in between', async () => {
    const h = harness();
    await h.upTo('drop');
    h.day.gave();
    await settle();
    // Before it has said a word, an instruction takes the notch.
    h.inbox.add({ id: 'ask-1', subject: 'ask-1', class: 'person', speaks: true, urgent: true, asked: true, title: () => ['Working.'],
      play: async (stage) => { await stage.offer(['Summarising it.'], 'ok'); return 'settled'; } });
    await settle();
    expect(h.said()).toBe('Summarising it.');
    expect(h.day.step()).toBe(S.drop);
    await h.reply('yes');
    await h.pass(600);
    expect(h.said()).toBe('That is all there is to it: drop it, then ask.');
  });

  test('10 and 11: with no AI they say what each needs, and ask for nothing', async () => {
    const h = harness({ model: { ready: false, name: '', hosted: false } });
    await h.upTo('drop');
    expect(h.said()).toBe('Drag any file onto me and ask about it. That needs the AI, so it waits until I have one.');
    await h.seen();
    expect(h.said()).toBe('Ask me where something is, or how to do something, and I point at it. That needs the AI, so it waits until I have one.');
    await h.seen();
    expect(h.day.step()).toBe(S.habits);
  });

  test('11: a real "where is" is the lesson: it is answered as ever, and day one only notes that it was asked', async () => {
    const h = harness();
    await h.upTo('whereIs');
    expect(h.said()).toBe('Now ask me where something is. Hold [talk] and say: where do I close this window?');
    expect(h.line()).toMatchObject({ kind: 'offer', keys: 'talk', yes: 'hold and ask', step: of('whereIs') });
    // Nothing is taken from the question: it goes on to be pointed at.
    expect(h.day.route('where do I close this window')).toBeNull();
    h.inbox.add({ id: 'ask-1', subject: 'ask-1', class: 'person', speaks: true, urgent: true, asked: true, title: () => ['Pointing.'],
      play: async (stage) => { await stage.say(['Close is top right. I am pointing at it.'], 1000); return 'settled'; } });
    await settle();
    h.day.pointed(true);
    await h.reply('done');
    expect(h.said()).toBe('I point, you click. It works in any window. Ask "how do I…" and I walk you through it, a step at a time.');
    await h.seen();
    expect(h.day.step()).toBe(S.habits);
  });

  test('11: on a bare desktop the question is about something every desktop has, by its system', async () => {
    const windows = harness({ onDesktop: true, system: 'windows' });
    await windows.upTo('whereIs');
    expect(windows.said()).toBe('Now ask me where something is. Hold [talk] and say: where is the Start button?');
    const mac = harness({ onDesktop: true, system: 'mac' });
    await mac.upTo('whereIs');
    expect(mac.said()).toBe('Now ask me where something is. Hold [talk] and say: where is the Trash?');
    const other = harness({ onDesktop: true, system: null });
    await other.upTo('whereIs');
    expect(other.said()).toBe('Now ask me where something is. Hold [talk] and say: where is the clock?');
    // When it is not known what is in front, the question is the one about a window.
    const unknown = harness({ onDesktop: null });
    await unknown.upTo('whereIs');
    expect(unknown.said()).toBe('Now ask me where something is. Hold [talk] and say: where do I close this window?');
  });

  test('11: when the thing could not be pointed at, it says so, and never that it pointed', async () => {
    const h = harness();
    await h.upTo('whereIs');
    expect(h.day.route('where is the export button')).toBeNull();
    h.inbox.add({ id: 'ask-1', subject: 'ask-1', class: 'person', speaks: true, urgent: true, asked: true, title: () => ['An answer.'],
      play: async (stage) => { await stage.say(['I cannot see one here.'], 1000); return 'settled'; } });
    await settle();
    h.day.pointed(false);
    await h.reply('done');
    expect(h.said()).toBe('I could not find that one here. In any window, ask "where is…" or "how do I…" and I point, a step at a time.');
    await h.seen();
    expect(h.day.step()).toBe(S.habits);
    // What is told of pointing at any other time is nobody's lesson.
    h.day.pointed(true);
    expect(h.day.step()).toBe(S.habits);
  });

  test('11: something else said there is answered as ever too, and the step is still there', async () => {
    const h = harness();
    await h.upTo('whereIs');
    expect(h.day.route('what is two plus two')).toBeNull();
    h.inbox.add({ id: 'ask-1', subject: 'ask-1', class: 'person', speaks: true, urgent: true, asked: true, title: () => ['Four.'],
      play: async (stage) => { await stage.say(['Four.'], 1000); return 'settled'; } });
    await settle();
    await h.reply('done');
    expect(h.said()).toBe('Now ask me where something is. Hold [talk] and say: where do I close this window?');
    expect(h.day.step()).toBe(S.whereIs);
  });

  test('11: with its eyes closed, or nothing to point with, it says what that needs', async () => {
    const closed = harness({ watching: false });
    await closed.upTo('whereIs');
    expect(closed.said()).toBe('Ask me where something is, or how to do something, and I point at it. That needs my eyes open.');
    const none = harness({ canPoint: false });
    await none.upTo('whereIs');
    expect(none.said()).toBe('Ask me where something is, or how to do something, and I point at it. That needs my eyes open.');
  });

  test('12 and 13: what it will take over is said, the one rule is agreed, everything it can do is shown, and it is over for good', async () => {
    const h = harness();
    await h.upTo('habits');
    expect(h.said()).toBe('When I see you do the same thing twice, I will offer to take it over.');
    await h.seen();
    expect(h.said()).toBe('One rule to start: every new agent asks before it acts.');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'agreed', mood: 'careful', step: of('rule') });
    await h.reply('yes');
    // Everything else it does, on one sheet, before it lets them go.
    expect(h.did).toEqual(['can do, with done']);
    expect(h.said()).toBe('What I can do');
    await h.reply('yes');
    expect(h.said()).toBe('That is all. I speak up when something needs you. Hold [talk] and talk, any time.');
    await h.seen();
    expect(h.day.step()).toBe(0);
    expect(h.settings.get('dayone', null)).toMatchObject({ done: true });
    // Never again by itself, not even on a brain that still counts as never set up.
    const later = harness({ db: h.world.db });
    later.day.cameUp();
    await later.pass(60_000);
    expect(later.line()).toBeNull();
  });
});

describe('left alone, and come back to', () => {
  test('a step that is ignored waits in the count, and is the same step when it is opened', async () => {
    const h = harness();
    await h.upTo('watch');
    await h.reply('fold');
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    expect(h.day.step()).toBe(S.watch);
    h.fromPage({ type: 'open' });
    await settle();
    expect(h.said()).toBe('May I watch which app you are in? Close my eyes any time.');
  });

  test('a brain that stops in the middle goes on from the step it was on', async () => {
    const h = harness();
    await h.upTo('notNow');
    await h.reply('no');
    await h.seen();
    expect(h.day.step()).toBe(S.litWord);
    // The same data, another start. It no longer counts as never set up, and goes on all the same.
    const next = harness({ db: h.world.db, fresh: false });
    next.day.cameUp();
    await next.pass(NOTCH_DAY_ONE_AFTER_MS);
    expect(next.said()).toBe('The lit words are yours to change. I call you Boss. Click the name.');
  });

  test('nothing of what was said or shown is written to the log: only which step', async () => {
    const h = harness({ reply: null, name: 'Sam Reed' });
    await h.upTo('litWord');
    await h.reply('yes');
    await h.seen();
    h.day.route('I run a small studio in Lisbon')!.run();
    await settle();
    expect(h.logs.join('\n')).not.toMatch(/Sam|studio|Lisbon/);
    expect(h.logs.some((line) => line.includes(`step ${S.litWord} of 13 is done`))).toBe(true);
  });
});
