/**
 * Pass 12: day one in the notch. Eleven steps, each of them real: what is
 * tested here is that each does what it says, that a step which is left
 * waits and is gone on from, and that it begins by itself once and only on
 * a brain that was never set up.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NOTCH_DAY_ONE_AFTER_MS, NOTCH_DAY_ONE_FOLD_MS, aroundRequest, attachNotchDayOne, dayOneRequest, type NotchAroundSource, type NotchDayOneDeps } from './dayone.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchBlock, NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import { NotchSettings } from './settings.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 120; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string =>
  (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? part.word.value : 'key' in part ? `[${part.key}]` : '')).join('');

interface World {
  fresh: boolean;
  name: string;
  model: { ready: boolean; name: string; hosted: boolean };
  watching: boolean;
  canSwitch: boolean;
  mailReached: boolean;
  reply: string | null;
  sources: NotchAroundSource[] | null;
  db: Database;
}

function harness(given: Partial<World> = {}) {
  const world: World = {
    fresh: true, name: '', model: { ready: true, name: 'gpt-test', hosted: false }, watching: true, canSwitch: true,
    mailReached: false, reply: null, sources: null, db: new Database(':memory:'), ...given,
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
  const logs: string[] = [];
  const deps: NotchDayOneDeps = {
    inbox, settings, clock, now: () => now, log: (line) => logs.push(line),
    fresh: () => world.fresh,
    name: { get: () => world.name, set: (name) => { did.push(`name ${name}`); world.name = name; } },
    model: { ready: () => world.model.ready, name: () => world.model.name, hosted: () => world.model.hosted, setUp: (id) => { did.push(`set up on ${id}`); } },
    watching: { on: () => world.watching, set: (on) => { did.push(`watch ${on}`); if (world.canSwitch) world.watching = on; return world.watching; } },
    canLook: () => true,
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
  const upTo = async (step: number): Promise<void> => { settings.set('dayone', { step, done: false }); day.cameUp(); await pass(NOTCH_DAY_ONE_AFTER_MS); };
  return { world, day, inbox, surface, settings, did, logs, line, said, reply, seen, pass, acts, upTo, fromPage, count: (): number => surface.current().count };
}

describe('when it begins', () => {
  test('by itself, a moment after the notch first comes up, on a brain that was never set up', async () => {
    const h = harness();
    h.day.cameUp();
    expect(h.line()).toBeNull();
    await h.pass(NOTCH_DAY_ONE_AFTER_MS - 1);
    expect(h.line()).toBeNull();
    await h.pass(1);
    expect(h.said()).toBe('Hi. I am Jarvis. I live up here. Say hello?');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'hello', mood: 'curious', step: 'step 1/11', fold: NOTCH_DAY_ONE_FOLD_MS });
    expect(h.day.step()).toBe(1);
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
    expect(h.line()).toMatchObject({ step: 'step 2/11' });
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
    expect(h.said()).toBe('Hi. I am Jarvis. I live up here. Say hello?');
  });
});

describe('the grammar, by doing each thing once', () => {
  test('1: a yes is named as one', async () => {
    const h = harness();
    await h.upTo(1);
    await h.reply('yes');
    expect(h.said()).toBe('That was a yes. One tap.');
    await h.seen();
    expect(h.said()).toBe('For not now, press esc, or just ignore me. I never mind. Try it.');
    expect(h.line()).toMatchObject({ kind: 'offer', keys: 'esc', step: 'step 2/11', fold: 8000 });
  });

  test('1: Esc there is the second lesson already learned, and step 2 is passed over', async () => {
    const h = harness();
    await h.upTo(1);
    await h.reply('no');
    expect(h.said()).toBe('That was a not now. It is all it takes.');
    await h.seen();
    expect(h.line()).toMatchObject({ step: 'step 3/11' });
  });

  test('2: a yes shakes and says so on the same line; Esc is the answer; so is being ignored', async () => {
    const h = harness();
    await h.upTo(2);
    const id = h.line()!.id;
    await h.reply('yes');
    expect(h.acts()).toContainEqual({ gesture: 'shake' });
    expect(h.said()).toBe('That says yes. Now try esc.');
    expect(h.line()!.id).toBe(id);
    await h.reply('no');
    expect(h.said()).toBe('Good. That is all it takes to say not now.');

    const ignored = harness();
    await ignored.upTo(2);
    await ignored.reply('fold');
    expect(ignored.said()).toBe('You ignored me. That works too.');
    await ignored.seen();
    expect(ignored.day.step()).toBe(3);
  });

  test('3: the name is a lit word, and the one that is agreed to is kept', async () => {
    const h = harness();
    await h.upTo(3);
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
    await h.upTo(3);
    expect((h.line()!.say[1] as { word: { options: string[] } }).word.options).toEqual(['Sam', 'S', 'Boss']);
  });

  test('4: what is said while it waits is its answer, whatever the words are', async () => {
    const h = harness({ reply: 'A founder. I will look for leads, invoices and follow-ups.' });
    await h.upTo(4);
    expect(h.said()).toBe('Now tell me what you do. Out loud.');
    expect(h.line()).toMatchObject({ kind: 'offer', keys: 'talk', yes: 'hold and talk', mood: 'listen', step: 'step 4/11' });
    // Words that would otherwise make an agent are, here, what they do.
    const route = h.day.route('Every Monday I send Sam the numbers');
    expect(route?.did).toBe('Told Jarvis what they do, on day one.');
    route!.run();
    await settle();
    expect(h.did).toEqual(['told Every Monday I send Sam the numbers']);
    expect(h.said()).toBe('A founder. I will look for leads, invoices and follow-ups.');
    await h.seen();
    expect(h.day.step()).toBe(5);
    // And from then on words are words again.
    expect(h.day.route('Every Monday I send Sam the numbers')).toBeNull();
  });

  test('4: with nothing to answer with, it says what is true of what it heard', async () => {
    const h = harness({ reply: null });
    await h.upTo(4);
    h.day.route('I run a small studio')!.run();
    await settle();
    expect(h.said()).toBe('Heard. That is how you tell me anything.');
  });

  test('4: with no way to make out words, it says so and goes on; it does not ask again', async () => {
    const h = harness();
    await h.upTo(4);
    expect(h.day.unheard('no_stt')).toBe(true);
    await settle();
    expect(h.said()).toBe('I heard a voice. I cannot make out words until I have an AI. That is step 7.');
    await h.seen();
    expect(h.day.step()).toBe(5);
  });

  test('4: not caught twice, and it goes on by itself', async () => {
    const h = harness();
    await h.upTo(4);
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
    await h.upTo(5);
    expect(h.day.unheard('silence')).toBe(false);
  });

  test('5: yes leaves watching on, and switches it on where it was off', async () => {
    const h = harness();
    await h.upTo(5);
    expect(h.said()).toBe('May I watch which app you are in? Close my eyes any time.');
    await h.reply('yes');
    expect(h.did).toEqual([]);
    expect(h.said()).toBe('Thank you. Eyes open.');
    expect(h.line()).toMatchObject({ mood: 'search' });

    const off = harness({ watching: false });
    await off.upTo(5);
    await off.reply('yes');
    expect(off.did).toEqual(['watch true']);
    expect(off.said()).toBe('Thank you. Eyes open.');
  });

  test('5: a no switches watching off, and there is then nothing to show it', async () => {
    const h = harness();
    await h.upTo(5);
    await h.reply('no');
    expect(h.did).toEqual(['watch false']);
    expect(h.world.watching).toBe(false);
    expect(h.said()).toBe('Then I see nothing. Open my eyes any time, in What I see.');
    expect(h.line()).toMatchObject({ mood: 'closed' });
    await h.seen();
    // Step 6 is passed over.
    expect(h.day.step()).toBe(7);
  });

  test('5: where the switch cannot be reached, it does not say its eyes are closed when they are not', async () => {
    const h = harness({ canSwitch: false });
    await h.upTo(5);
    await h.reply('no');
    expect(h.said()).toBe('I could not close my eyes from here. "Sleep" in What I see does.');
  });

  test('6: any real look is the lesson, named by what was shown, and nothing else comes of it', async () => {
    const h = harness();
    await h.upTo(6);
    expect(h.said()).toBe('Now show me something. Hold [talk] and circle a thing with the mouse.');
    expect(h.line()).toMatchObject({ keys: 'talk', yes: 'hold and circle', step: 'step 6/11' });
    expect(h.day.shown({ app: 'notepad', things: [{ name: '' }, { name: 'Quarterly numbers' }] })).toBe(true);
    // The keys were held to circle, so a recording with nothing in it comes too: that is not answered.
    expect(h.day.unheard('silence')).toBe(true);
    await settle();
    expect(h.said()).toBe('You showed me Quarterly numbers. That works on anything on your screen.');
    await h.seen();
    expect(h.day.step()).toBe(7);
    // A look after the lesson is anybody's again.
    expect(h.day.shown({ app: 'notepad', things: [] })).toBe(false);
  });

  test('6: a yes is not a circle, so it is said once more, more plainly; Esc leaves it for later', async () => {
    const h = harness();
    await h.upTo(6);
    await h.reply('yes');
    expect(h.said()).toBe('Keep [talk] down and draw a circle round anything.');
    await h.reply('no');
    expect(h.said()).toBe('Later then. It is always there.');
  });
});

describe('what Jarvis works with', () => {
  test('7: an AI that is there is named, and nothing is asked', async () => {
    const h = harness();
    await h.upTo(7);
    expect(h.said()).toBe('I think with gpt-test. That is set.');
    expect(h.line()).toMatchObject({ kind: 'say', mark: 'check' });
    const hosted = harness({ model: { ready: true, name: '', hosted: true } });
    await hosted.upTo(7);
    expect(hosted.said()).toBe('Jarvis AI it is. It comes with your plan.');
  });

  test('7: with none, the choice opens the dashboard\'s own setup and waits for it', async () => {
    const h = harness({ model: { ready: false, name: '', hosted: false } });
    await h.upTo(7);
    expect(h.said()).toBe('Which AI should I use?');
    expect(h.line()).toMatchObject({ kind: 'offer', options: ['My own AI account', 'AI on this computer'], step: 'step 7/11' });
    await h.reply('pick', { option: 'My own AI account', index: 0 });
    expect(h.did).toEqual(['set up on pc']);
    expect(h.said()).toBe('I opened the setup. Add your account there.');
    expect(h.line()).toMatchObject({ kind: 'work', steps: 0 });
    await h.pass(6000);
    expect(h.line()?.kind).toBe('work');
    h.world.model = { ready: true, name: 'claude-test', hosted: false };
    await h.pass(2000);
    expect(h.said()).toBe('claude-test it is.');
  });

  test('7: Esc while it waits is "later", said truthfully, and day one goes on', async () => {
    const h = harness({ model: { ready: false, name: '', hosted: false } });
    await h.upTo(7);
    await h.reply('pick', { option: 'AI on this computer', index: 1 });
    expect(h.said()).toBe('I opened the setup. Choose the AI on this computer there.');
    await h.reply('stop');
    await h.pass(2000);
    expect(h.said()).toBe('Later then. Until I have one I cannot think, only listen.');
    await h.seen();
    expect(h.day.step()).toBe(8);
  });

  test('8: mail that is already within reach is said, and nothing is opened', async () => {
    const h = harness({ mailReached: true });
    await h.upTo(8);
    expect(h.said()).toBe('Your mail and calendar are already within reach.');
    expect(h.did).toEqual([]);
  });

  test('8: connect opens the sign-in and waits until the mailbox can be read', async () => {
    const h = harness();
    await h.upTo(8);
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
    await h.upTo(9);
    expect(h.said()).toBe('May I look around what I can reach, and show you what I find?');
    await h.reply('yes');
    expect(h.said()).toBe('Looking around');
    expect(h.line()).toMatchObject({ kind: 'sheet', mood: 'search', stay: true, yes: 'continue', no: 'skip', step: 'step 9/11' });
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
    expect(h.day.step()).toBe(10);
  });

  test('9: Esc in the middle ends the looking where it is, and day one goes on', async () => {
    const h = harness({ sources: SOURCES });
    await h.upTo(9);
    await h.reply('yes');
    await h.reply('no');
    await h.pass(4000);
    expect(h.day.step()).toBe(10);
  });

  test('9: with nothing to look around in, the step is not there', async () => {
    const h = harness();
    await h.upTo(9);
    expect(h.said()).toBe('When I see you do the same thing twice, I will offer to take it over.');
  });

  test('10 and 11: what it will take over is said, the one rule is agreed, and it is over for good', async () => {
    const h = harness();
    await h.upTo(10);
    expect(h.said()).toBe('When I see you do the same thing twice, I will offer to take it over.');
    await h.seen();
    expect(h.said()).toBe('One rule to start: every new agent asks before it acts.');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'agreed', mood: 'careful', step: 'step 11/11' });
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
    await h.upTo(5);
    await h.reply('fold');
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    expect(h.day.step()).toBe(5);
    h.fromPage({ type: 'open' });
    await settle();
    expect(h.said()).toBe('May I watch which app you are in? Close my eyes any time.');
  });

  test('a brain that stops in the middle goes on from the step it was on', async () => {
    const h = harness();
    await h.upTo(1);
    await h.reply('yes');
    await h.seen();
    await h.reply('no');
    await h.seen();
    expect(h.day.step()).toBe(3);
    // The same data, another start. It no longer counts as never set up, and goes on all the same.
    const next = harness({ db: h.world.db, fresh: false });
    next.day.cameUp();
    await next.pass(NOTCH_DAY_ONE_AFTER_MS);
    expect(next.said()).toBe('The lit words are yours to change. I call you Boss. Click the name.');
  });

  test('nothing of what was said or shown is written to the log: only which step', async () => {
    const h = harness({ reply: null, name: 'Sam Reed' });
    await h.upTo(3);
    await h.reply('yes');
    await h.seen();
    h.day.route('I run a small studio in Lisbon')!.run();
    await settle();
    expect(h.logs.join('\n')).not.toMatch(/Sam|studio|Lisbon/);
    expect(h.logs.some((line) => line.includes('step 3 of 11 is done'))).toBe(true);
  });
});
