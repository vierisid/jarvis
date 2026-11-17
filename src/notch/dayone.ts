/**
 * Day one: the first five minutes, in the notch.
 *
 * The prototype's eleven steps, in its order and its words: say yes, say not
 * now, change a lit word, talk, allow watching, show it something, choose an
 * AI, connect mail and calendar, let it look around, what it will take over,
 * and one rule. The first six teach the grammar by having the person do each
 * thing once. The rest set up what Jarvis works with.
 *
 * Two steps were added on 17 November 2026, when the owner had gone through
 * it: "there is a lot of functionalities that are not shown. For example,
 * dropping a file into it or asking where something is." So after the setup
 * the person hands it a file, and asks it where something is: the two that
 * are a movement of the hands. Everything else it does is on one sheet that
 * day one ends on (./cando.ts). Thirteen steps.
 *
 * Here every step is real. Nothing is pretended, so where the product cannot
 * do what the prototype played, the step says what is true:
 *
 *   3   the name is kept, and is what the assistant calls the person;
 *   4   what they say is heard by the same keys as ever. With no AI yet it
 *       cannot be made into words, and the step says so and goes on;
 *   5   yes leaves watching on, and a no switches it off;
 *   6   any real look is the lesson. It says how: the keys held down, then
 *       the mouse pressed and dragged round the thing;
 *   7   an AI is set up in the dashboard's own setup, which this opens and
 *       waits for. One that is already there is named, and nothing is asked;
 *   8   mail and calendar are reached by signing in to Google in Jarvis's
 *       own browser, which this opens and waits for;
 *   9   looking around reads the mail that waits, the week's meetings, and
 *       the names of the files on the desktop and in the documents and
 *       downloads, and draws them as they are found. It opens no file;
 *   10  a real file dropped on it is the lesson, and is asked about as any
 *       dropped file is;
 *   11  a real "where is…" is the lesson, and is pointed at as ever;
 *   12  nobody's habits are known on day one. It says how they will be
 *       found, and asks nothing.
 *
 * It starts by itself once, on a brain that was never set up, a moment after
 * the notch is first born. It can be run again from the settings, or by
 * saying "day one". Where it was left it goes on: the step is kept, and a
 * step that is ignored waits in the count like anything else.
 *
 * Its lines give way to the person: while it waits for them to talk, the
 * talking takes the notch (./asks.ts), and it has the notch back when that
 * is over.
 */
import type { NotchInbox, NotchItem, NotchItemEnd } from './inbox.ts';
import type { NotchBlock, NotchMapNode, NotchMapSource, NotchPart, NotchWord } from './protocol.ts';
import type { NotchSettings } from './settings.ts';
import { realNotchClock, type NotchClock, type NotchStage } from './stage.ts';

const em = (text: string): NotchPart => ({ em: text });
const word = (name: string, value: string, options: readonly string[], more: Partial<NotchWord> = {}): NotchPart =>
  ({ word: { name, value, options: [...options], ...more } });
const cut = (text: string, most: number): string => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return [...flat].length > most ? `${[...flat].slice(0, most - 1).join('')}…` : flat;
};

export const NOTCH_DAY_ONE_STEPS = 13;
/** How long a step waits to be answered before it goes to the count. */
export const NOTCH_DAY_ONE_FOLD_MS = 45_000;
/** How long after the notch first comes up day one says its first line: after the birth, and the stretch. */
export const NOTCH_DAY_ONE_AFTER_MS = 4300;
/** How long the setup of an AI, and a sign-in, are waited for. */
export const NOTCH_DAY_ONE_WAIT_MS = 15 * 60_000;
const ITEM = 'day-one';
const KEPT = 'dayone';

/** One place Jarvis reads when it looks around, and what it found there. */
export interface NotchAroundSource {
  name: string;
  /**
   * Reads it. `found` is said on its chip; `things` are drawn, a few at most
   * (a person, a meeting or an agent as `co`, a file as `thing`); `tool` is
   * drawn for the place itself; `say` is one sentence about what was found,
   * said under the map when the looking is over.
   */
  read(): Promise<{ found: string; tool?: boolean; things: { label: string; kind: 'person' | 'co' | 'thing' }[]; say?: NotchPart[] }>;
}

export interface NotchDayOneDeps {
  inbox: NotchInbox;
  settings: NotchSettings;
  /** A brain that was never set up: day one starts by itself there, once. */
  fresh(): boolean;
  /** What the assistant calls the person: read, and kept. */
  name?: { get(): string; set(name: string): void };
  /** The AI that answers: whether there is one, what it is called, and the way to set one up. */
  model: { ready(): boolean; name(): string; hosted(): boolean; setUp(sidecarId: string | null): void };
  /** Whether Jarvis watches the app in front, and the switch. */
  watching?: { on(): boolean; set(on: boolean): Promise<boolean> | boolean };
  /** Whether a desktop app can take a look (step 6). */
  canLook?: () => boolean;
  /** Whether a file can be dropped on the notch and asked about (step 10). */
  canDrop?: () => boolean;
  /** Whether "where is…" can be answered by pointing (step 11). */
  canPoint?: () => boolean;
  /** Whether words are a question about where something is, or how to do something, in the window in front. */
  isWhere?: (text: string) => boolean;
  /** Everything the notch can do, on one sheet: day one ends on it. */
  canDo?: (stage: NotchStage, more: { yes: string }) => Promise<void>;
  /** Mail and calendar: whether they are within reach now, and the window to sign in. */
  mail?: { reached(): Promise<boolean>; open(sidecarId: string | null): Promise<void> | void };
  /** What they said they do: kept, and answered in one line. Null when there is nothing to answer with. */
  told?: (what: string) => Promise<string | null>;
  /** The places to look around in. */
  around?: () => NotchAroundSource[];
  paused?: () => boolean;
  now?: () => number;
  clock?: NotchClock;
  log?: (line: string) => void;
}

export interface NotchDayOne {
  /** Starts it from the first step: asked for, whatever was kept. */
  again(): void;
  /** A page has come up: on a brain that is due it, day one begins a moment later. */
  cameUp(): void;
  /** Words the notch acts on itself: "day one", "look around", and whatever is said while step 4 waits to hear it. */
  route(text: string): { did: string; run(): void } | null;
  /** A look was taken. True when day one was waiting for one: it is the lesson, and nothing else comes of it. */
  shown(looked: { app: string; things: { name?: string }[] }): boolean;
  /** Nothing was made out of what was said. True when day one was waiting to hear something: it says what is true. */
  unheard(why: string): boolean;
  /** A file was dropped on the notch and taken. Day one, waiting for one, knows its lesson is learned. */
  gave(): void;
  /** The step it is on, or 0 when it is over or never began. */
  step(): number;
  /** Looks around, apart from day one. */
  around(stage: NotchStage, more?: { yes?: string; step?: string }): Promise<boolean>;
  stop(): void;
}

interface Kept { step: number; done: boolean }

/** "Day one", "show me around", "start over". */
export function dayOneRequest(text: string): boolean {
  const said = text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  return /^(?:run |start |do |show me )?(?:day one|the first day|the tour|the tutorial)(?: again)?$/.test(said) || /^show me around$/.test(said);
}

/** "Look around", "what do you see around you". */
export function aroundRequest(text: string): boolean {
  const said = text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  return /^(?:have a |take a )?look around(?: again)?$/.test(said) || /^(?:show me )?(?:the|your) map$/.test(said);
}

/** Where things stand on the map, by what they are: the prototype's places. */
const SLOTS: Record<'tool' | 'person' | 'co' | 'thing', [number, number][]> = {
  // The places themselves: mail, the calendar, the desktop.
  tool: [[222, 28], [292, 152], [120, 150]],
  person: [[128, 58], [318, 54], [356, 126], [56, 100]],
  // Meetings and agents, on the right.
  co: [[404, 70], [408, 188]],
  // Files, on the left and below: far enough apart for a name each.
  thing: [[40, 30], [40, 178], [196, 186]],
};
/** The longest name a thing has on the map. A file's name is often longer, and is cut. */
const MAP_NAME = 16;
const ME: NotchMapNode = { id: 'you', label: 'You', x: 222, y: 104, kind: 'me' };

export function attachNotchDayOne(deps: NotchDayOneDeps): NotchDayOne {
  const now = deps.now ?? Date.now;
  const clock = deps.clock ?? realNotchClock;
  const log = deps.log ?? ((line: string) => console.log(line));
  let stopped = false;
  let begun = false;
  /** Step 4: what was said, or why nothing was made out. Step 6: what was shown. */
  let told: string | null = null, missed: string | null = null, showed: string | null = null;
  let tries = 0;
  /** Whether the step on the notch is waiting to hear, or to be shown. */
  let hearing = false, looking = false;
  /** Step 10: waiting for a file, and one came. Step 11: waiting to be asked where something is, and it was asked. */
  let feeding = false, fed = false, asking = false, asked = false;

  const kept = (): Kept | null => {
    const raw = deps.settings.get<Partial<Kept> | null>(KEPT, null);
    return raw && typeof raw.step === 'number' ? { step: Math.max(1, Math.floor(raw.step)), done: raw.done === true } : null;
  };
  const keep = (state: Kept): void => { deps.settings.set(KEPT, state, now()); };
  const stepNow = (): number => { const state = kept(); return state && !state.done ? state.step : 0; };
  const counter = (n: number): string => `step ${n}/${NOTCH_DAY_ONE_STEPS}`;

  /** A step's answer: go on, go on past the next one too, or it was left and waits in the count. */
  type Went = 'on' | 'left' | 'past';

  /** A step that asks one thing: yes, not now, or left alone. */
  const ask = async (stage: NotchStage, n: number, parts: NotchPart[], yes: string, mood: 'look' | 'curious' | 'careful' = 'look'): Promise<'yes' | 'no' | 'left'> => {
    const id = stage.id();
    stage.put({ id, kind: 'offer', say: parts, yes, mood, fold: NOTCH_DAY_ONE_FOLD_MS, step: counter(n) });
    const answer = await stage.answer(id, ['yes', 'no', 'fold']);
    return answer.act === 'yes' ? 'yes' : answer.act === 'no' ? 'no' : 'left';
  };

  async function hello(stage: NotchStage): Promise<Went> {
    const said = await ask(stage, 1, ['Hi. I am Jarvis. I live up here. Say hello?'], 'hello', 'curious');
    if (said === 'left') return 'left';
    if (said === 'yes') { await stage.say(['That was a yes. One tap.'], 2300, { mood: 'happy' }); return 'on'; }
    // They pressed Esc: that is the next lesson, already learned.
    await stage.say(['That was a not now. It is all it takes.'], 2600, { mood: 'happy' });
    return 'past';
  }

  async function notNow(stage: NotchStage): Promise<Went> {
    const id = stage.id();
    stage.put({ id, kind: 'offer', keys: 'esc', say: ['For not now, press esc, or just ignore me. I never mind. Try it.'], mood: 'look', fold: 8000, step: counter(2) });
    for (;;) {
      const answer = await stage.answer(id, ['yes', 'no', 'fold']);
      if (answer.act === 'yes') {
        stage.surface.act({ gesture: 'shake' });
        stage.surface.update(id, { say: ['That says yes. Now try esc.'] });
        continue;
      }
      // Ignoring is an answer.
      await stage.say([answer.act === 'no' ? 'Good. That is all it takes to say not now.' : 'You ignored me. That works too.'], 2400, { mood: 'happy' });
      return 'on';
    }
  }

  async function litWord(stage: NotchStage): Promise<Went> {
    const known = cut(deps.name?.get() ?? '', 28);
    const first = known.split(' ')[0] ?? '';
    const options = known ? [...new Set([first, first.charAt(0).toUpperCase(), 'Boss'])] : ['Boss', 'Chief', 'Captain'];
    let name = options[0]!;
    const id = stage.id();
    stage.put({
      id, kind: 'offer', yes: 'good', mood: 'look', fold: NOTCH_DAY_ONE_FOLD_MS, step: counter(3),
      say: ['The lit words are yours to change. I call you ', word('name', name, options, { label: 'I call you', free: true }), '. Click the name.'],
    });
    for (;;) {
      const answer = await stage.answer(id, ['yes', 'no', 'fold', 'word']);
      if (answer.act === 'word') { if (answer.word === 'name' && (answer.value ?? '').trim()) name = cut(answer.value ?? '', 28); continue; }
      if (answer.act === 'fold') return 'left';
      if (answer.act === 'yes') {
        try { deps.name?.set(name); } catch (error) { log(`[notch] day one could not keep the name: ${error instanceof Error ? error.message : String(error)}`); }
        await stage.say([em(name), ' it is.'], 1900, { mood: 'happy' });
      }
      return 'on';
    }
  }

  async function talk(stage: NotchStage): Promise<Went> {
    for (;;) {
      if (told !== null) {
        const what = told;
        told = null; hearing = false;
        let reply: string | null = null;
        try { reply = (await deps.told?.(what)) ?? null; } catch (error) { log(`[notch] day one could not answer what was said: ${error instanceof Error ? error.message : String(error)}`); }
        await stage.say([reply ? cut(reply, 140) : 'Heard. That is how you tell me anything.'], 3400, { mood: 'curious' });
        return 'on';
      }
      if (missed !== null) {
        const why = missed;
        missed = null;
        if (why === 'no_stt') {
          hearing = false;
          await stage.say(['I heard a voice. I cannot make out words until I have an AI. That is step 7.'], 4200, { mood: 'look' });
          return 'on';
        }
        if (++tries >= 2) { hearing = false; await stage.say(['I did not catch it. It will come. On we go.'], 2600, { mood: 'look' }); return 'on'; }
        await stage.say(['I did not catch that. Keep the keys down while you talk.'], 2800, { mood: 'confused' });
      }
      hearing = true;
      const id = stage.id();
      stage.put({ id, kind: 'offer', keys: 'talk', yes: 'hold and talk', say: ['Now tell me what you do. Out loud.'], mood: 'listen', fold: NOTCH_DAY_ONE_FOLD_MS, step: counter(4) });
      // While they talk, the talking has the notch: this ends under it, and is back with what was said.
      const answer = await stage.answer(id, ['yes', 'no', 'fold']);
      if (answer.act === 'fold') return 'left';
      hearing = false;
      await stage.say(['Later then. Hold ', { key: 'talk' }, ' and talk, any time.'], 2800);
      return 'on';
    }
  }

  async function watch(stage: NotchStage): Promise<Went> {
    const watching = deps.watching;
    const said = await ask(stage, 5, ['May I watch which app you are in? Close my eyes any time.'], 'allow');
    if (said === 'left') return 'left';
    if (!watching) { await stage.say(['Thank you.'], 1600, { mood: 'happy' }); return 'on'; }
    let on = watching.on();
    if ((said === 'yes') !== on) {
      try { on = (await watching.set(said === 'yes')) === true; } catch (error) {
        log(`[notch] day one could not change watching: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (said === 'yes') {
      await stage.say(on ? ['Thank you. Eyes open.'] : ['Watching is switched off in the dashboard, so I still see nothing.'], on ? 2200 : 3800, { mood: on ? 'search' : 'careful' });
      return 'on';
    }
    await stage.say(on ? ['I could not close my eyes from here. "Sleep" in What I see does.'] : ['Then I see nothing. Open my eyes any time, in What I see.'], 3600, { mood: on ? 'careful' : 'closed' });
    // With its eyes closed there is nothing to show it.
    return on ? 'on' : 'past';
  }

  async function show(stage: NotchStage): Promise<Went> {
    if (deps.canLook && !deps.canLook()) return 'on';
    if (deps.watching && !deps.watching.on()) return 'on';
    let nudged = false;
    for (;;) {
      if (showed !== null) {
        const what = showed;
        showed = null; looking = false;
        await stage.say(['You showed me ', em(what), '. That works on anything on your screen.'], 3400, { mood: 'happy' });
        return 'on';
      }
      looking = true;
      const id = stage.id();
      stage.put({
        id, kind: 'offer', keys: 'talk', yes: 'hold, then drag', mood: 'curious', fold: NOTCH_DAY_ONE_FOLD_MS, step: counter(6),
        // The owner, 17 November 2026: "it doesn't specify that you need to click the hotkey and then click and drag around the circle."
        say: nudged ? ['Both at once: ', { key: 'talk' }, ' held down, and the mouse pressed and dragged round the thing.']
          : ['Now show me something. Keep ', { key: 'talk' }, ' held down, then click and drag a circle round a thing.'],
      });
      const answer = await stage.answer(id, ['yes', 'no', 'fold']);
      if (answer.act === 'fold') return 'left';
      // A yes is not a circle: said once more, more plainly.
      if (answer.act === 'yes' && !nudged) { nudged = true; continue; }
      looking = false;
      await stage.say(['Later then. It is always there.'], 1900);
      return 'on';
    }
  }

  /** Waits for something the person does in another window. True when it came about, false when they said later. */
  async function waitFor(stage: NotchStage, parts: NotchPart[], every: number, there: () => boolean | Promise<boolean>): Promise<boolean> {
    const id = stage.id();
    let later = false;
    stage.answer(id, ['stop']).then(() => { later = true; }, () => {});
    stage.put({ id, kind: 'work', say: parts, steps: 0, done: 0, mood: 'work' });
    const until = now() + NOTCH_DAY_ONE_WAIT_MS;
    while (!later && now() < until) {
      await stage.wait(every);
      if (later) break;
      let is = false;
      try { is = (await there()) === true; } catch { is = false; }
      if (is) return true;
    }
    return false;
  }

  async function brain(stage: NotchStage): Promise<Went> {
    const model = deps.model;
    if (model.ready()) {
      await stage.say(model.hosted() ? [em('Jarvis AI'), ' it is. It comes with your plan.'] : ['I think with ', em(cut(model.name() || 'the AI you set up', 40)), '. That is set.'], 2800, { mood: 'happy', mark: 'check' });
      return 'on';
    }
    const options = ['My own AI account', 'AI on this computer'];
    const id = stage.id();
    stage.put({ id, kind: 'offer', say: ['Which AI should I use?'], options, fold: NOTCH_DAY_ONE_FOLD_MS, step: counter(7) });
    const answer = await stage.answer(id, ['pick', 'no', 'fold']);
    if (answer.act === 'fold') return 'left';
    if (answer.act !== 'pick') { await stage.say(['Later then. Until I have one I cannot think, only listen.'], 3400, { mood: 'careful' }); return 'on'; }
    model.setUp(stage.from());
    const local = answer.index === 1;
    const there = await waitFor(stage, [local ? 'I opened the setup. Choose the AI on this computer there.' : 'I opened the setup. Add your account there.'], 2000, () => model.ready());
    if (!there) { await stage.say(['Later then. Until I have one I cannot think, only listen.'], 3400, { mood: 'careful' }); return 'on'; }
    await stage.say([em(cut(model.name() || 'That one', 40)), ' it is.'], 2800, { mood: 'happy', mark: 'check' });
    return 'on';
  }

  async function connect(stage: NotchStage): Promise<Went> {
    const mail = deps.mail;
    if (!mail) return 'on';
    let reached = false;
    try { reached = await mail.reached(); } catch { reached = false; }
    if (reached) { await stage.say(['Your mail and calendar are already within reach.'], 2600, { mood: 'happy', mark: 'check', src: 'mail' }); return 'on'; }
    const said = await ask(stage, 8, ['Connect your email and calendar? I learn fastest there.'], 'connect');
    if (said === 'left') return 'left';
    if (said === 'no') { await stage.say(['Later then. Connections is in Home, one step away.'], 2800); return 'on'; }
    try { await mail.open(stage.from()); } catch (error) {
      log(`[notch] day one could not open the sign-in: ${error instanceof Error ? error.message : String(error)}`);
      await stage.say(['I could not open my browser. Connections is in Home, for when it is there.'], 4200, { mood: 'sorry', mark: 'fail' });
      return 'on';
    }
    const there = await waitFor(stage, ['Sign in to Google in the window I opened.'], 5000, () => mail.reached());
    if (!there) { await stage.say(['Later then. Connections is in Home, one step away.'], 2800); return 'on'; }
    await stage.say(['Connected. I can read your mail and your calendar.'], 3000, { mood: 'happy', mark: 'check', src: 'mail' });
    return 'on';
  }

  /**
   * Looks around (the prototype's `viewScan`): each place is read in turn,
   * and what is found there is drawn as it is found. True when it was gone
   * through to the end, false when it was closed.
   */
  async function around(stage: NotchStage, more: { yes?: string; step?: string } = {}): Promise<boolean> {
    const sources = deps.around?.() ?? [];
    const chips: NotchMapSource[] = sources.map((source) => ({ name: cut(source.name, 20) }));
    const nodes: NotchMapNode[] = [ME];
    const links: [string, string][] = [];
    const used: Record<string, number> = { tool: 0, person: 0, co: 0, thing: 0 };
    const rows: NotchBlock[] = [];
    let tour: string[] | undefined;
    const place = (kind: 'tool' | 'person' | 'co' | 'thing', label: string, from: string): string | null => {
      const text = cut(label, MAP_NAME);
      const same = nodes.find((node) => node.label.toLowerCase() === text.toLowerCase());
      if (same) { if (!links.some(([a, b]) => (a === from && b === same.id) || (a === same.id && b === from)) && same.id !== from) links.push([from, same.id]); return null; }
      const slot = SLOTS[kind][used[kind]!];
      if (!slot || !text) return null;
      used[kind]!++;
      const id = `${kind}${used[kind]}`;
      nodes.push({ id, label: text, x: slot[0], y: slot[1], kind });
      links.push([from, id]);
      return id;
    };
    const blocks = (): NotchBlock[] => [{ kind: 'map', nodes: [...nodes], links: [...links], sources: chips.map((chip) => ({ ...chip })), ...(tour ? { tour } : {}) }, ...rows];
    const id = stage.id();
    let closed = false;
    // One wait for the whole sheet: its yes ("continue") and its Esc both end the looking, wherever it has got to.
    const closing = stage.answer(id, ['yes', 'no']).then(() => { closed = true; });
    closing.catch(() => {});
    stage.put({ id, kind: 'sheet', say: ['Looking around'], blocks: blocks(), mood: 'search', stay: true, no: more.yes ? 'skip' : 'close', ...(more.yes ? { yes: more.yes } : {}), ...(more.step ? { step: more.step } : {}) });
    const redraw = (): void => { if (!closed) stage.surface.update(id, { blocks: blocks() }); };
    let found = 0;
    for (let at = 0; at < sources.length && !closed; at++) {
      chips[at]!.state = 'on';
      redraw();
      let read: Awaited<ReturnType<NotchAroundSource['read']>> = { found: 'not reached', things: [] };
      try { read = await sources[at]!.read(); } catch (error) {
        log(`[notch] looking around: ${chips[at]!.name} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (closed) break;
      const from = read.tool ? place('tool', sources[at]!.name, ME.id) ?? ME.id : ME.id;
      if (read.tool) { redraw(); await stage.wait(300); }
      for (const thing of read.things.slice(0, 4)) {
        if (closed) break;
        if (place(thing.kind, thing.label, from)) { found++; redraw(); await stage.wait(300); }
      }
      chips[at]!.state = 'done';
      chips[at]!.found = cut(read.found, 28);
      // What it found there, in a sentence: said under the map, when the looking is over.
      if (read.say?.length) rows.push({ kind: 'row', lead: cut(sources[at]!.name, 20), say: read.say });
      redraw();
      await stage.wait(240);
    }
    if (closed) return false;
    // Counts, never what was found.
    log(`[notch] looked around: ${sources.length} place(s), ${nodes.length - 1} thing(s) drawn`);
    // One stroke through everything it found.
    if (nodes.length > 2) tour = [...nodes.slice(1).map((node) => node.id), ME.id];
    rows.push({ kind: 'note', say: [nodes.length > 1 ? 'That is what I can reach today. I read names, and opened no file. Ask me about any of it.' : 'I can reach nothing yet. It fills as you connect things.'] });
    stage.surface.update(id, { blocks: blocks() });
    stage.surface.act({ mood: 'proud' });
    // It stays to be read, until it is closed or gone on from.
    await closing;
    return true;
  }

  async function lookAround(stage: NotchStage): Promise<Went> {
    if (!deps.around) return 'on';
    const said = await ask(stage, 9, ['May I look around? Your mail, your calendar, and the files on this computer. I read their names and open none.'], 'allow', 'curious');
    if (said === 'left') return 'left';
    if (said === 'yes') await around(stage, { yes: 'continue', step: counter(9) });
    return 'on';
  }

  /** Step 10: hand it a file. The dropping, and what is asked about the file, are the real thing (./drop.ts). */
  async function drop(stage: NotchStage): Promise<Went> {
    if (deps.canDrop && !deps.canDrop()) return 'on';
    if (!deps.model.ready()) {
      feeding = false;
      await stage.say(['Drag any file onto me and ask about it. That needs the AI, so it waits until I have one.'], 4200, { mood: 'look' });
      return 'on';
    }
    for (;;) {
      if (fed) {
        feeding = false;
        // A beat first: what was asked about the file may be starting this very moment, and takes the notch.
        await stage.wait(600);
        await stage.say(['That is all there is to it: drop it, then ask.'], 3000, { mood: 'happy' });
        // Only now is the lesson over: said to the end, whatever took the notch in between.
        fed = false;
        return 'on';
      }
      feeding = true;
      const id = stage.id();
      stage.put({ id, kind: 'offer', keys: 'esc', say: ['Now hand me a file. Drag any file from your desktop onto me.'], mood: 'curious', fold: NOTCH_DAY_ONE_FOLD_MS, step: counter(10) });
      // While a file is over it, and while it is asked about, the file has the notch: this ends under it.
      for (;;) {
        const answer = await stage.answer(id, ['yes', 'no', 'fold']);
        if (answer.act === 'yes') { stage.surface.update(id, { say: ['Drag it here, onto me. I open my mouth when it is over me.'] }); continue; }
        if (answer.act === 'fold') return 'left';
        feeding = false;
        await stage.say(['Later then. Any file, any time.'], 2200);
        return 'on';
      }
    }
  }

  /** Step 11: ask it where something is. The pointing is the real thing (./point.ts). */
  async function whereIs(stage: NotchStage): Promise<Went> {
    const can = (!deps.canPoint || deps.canPoint()) && (!deps.watching || deps.watching.on());
    if (!can || !deps.model.ready()) {
      asking = false;
      await stage.say(deps.model.ready()
        ? ['Ask me where something is, or how to do something, and I point at it. That needs my eyes open.']
        : ['Ask me where something is, or how to do something, and I point at it. That needs the AI, so it waits until I have one.'], 4600, { mood: 'look' });
      return 'on';
    }
    let other = 0;
    for (;;) {
      if (asked) {
        asking = false;
        await stage.say(['That works in any window. Ask "how do I…" and I walk you through it, a step at a time.'], 4400, { mood: 'happy' });
        asked = false;
        return 'on';
      }
      // They said something else, twice: it is theirs to try later.
      if (asking && ++other > 2) { asking = false; return 'on'; }
      asking = true;
      const id = stage.id();
      stage.put({
        id, kind: 'offer', keys: 'talk', yes: 'hold and ask', mood: 'curious', fold: NOTCH_DAY_ONE_FOLD_MS, step: counter(11),
        say: ['Now ask me where something is. Hold ', { key: 'talk' }, ' and say: ', em('where do I close this window?')],
      });
      const answer = await stage.answer(id, ['yes', 'no', 'fold']);
      if (answer.act === 'fold') return 'left';
      asking = false;
      await stage.say(['Later then. "Where is…" and "how do I…" work in any window.'], 3000);
      return 'on';
    }
  }

  async function habits(stage: NotchStage): Promise<Went> {
    await stage.say(['When I see you do the same thing twice, I will offer to take it over.'], 4400, { mood: 'proud' });
    return 'on';
  }

  async function rule(stage: NotchStage): Promise<Went> {
    const said = await ask(stage, 13, ['One rule to start: every new agent asks before it acts.'], 'agreed', 'careful');
    if (said === 'left') return 'left';
    // Everything else it does, on one sheet, before it lets them go.
    if (deps.canDo) await deps.canDo(stage, { yes: 'done' });
    return 'on';
  }

  const STEPS = [hello, notNow, litWord, talk, watch, show, brain, connect, lookAround, drop, whereIs, habits, rule];

  async function play(stage: NotchStage): Promise<NotchItemEnd> {
    for (;;) {
      const state = kept();
      if (!state || state.done) return 'settled';
      if (deps.paused?.()) return 'waits';
      const step = STEPS[state.step - 1];
      if (!step) {
        keep({ step: state.step, done: true });
        hearing = false; looking = false; feeding = false; asking = false;
        log('[notch] day one is over');
        await stage.say(['That is all. I speak up when something needs you. Hold ', { key: 'talk' }, ' and talk, any time.'], 5200, { mood: 'happy' });
        return 'settled';
      }
      const went = await step(stage);
      if (went === 'left') return 'waits';
      tries = 0;
      // Kept as soon as it is taken: a brain that stops here goes on from the next step.
      keep({ step: state.step + (went === 'past' ? 2 : 1), done: false });
      // Which step, never what was said in it.
      log(`[notch] day one: step ${state.step} of ${NOTCH_DAY_ONE_STEPS} is done`);
    }
  }

  const item = (): NotchItem => ({
    id: ITEM, subject: ITEM, class: 'person', speaks: true, asked: true, returns: true,
    title: () => [`Day one, step ${Math.min(stepNow() || 1, NOTCH_DAY_ONE_STEPS)} of ${NOTCH_DAY_ONE_STEPS}.`],
    check: () => stepNow() > 0,
    play,
  });
  const present = (): void => { if (!stopped && stepNow() > 0) deps.inbox.add(item()); };

  function again(): void {
    if (stopped) return;
    told = missed = showed = null; tries = 0; hearing = looking = feeding = fed = asking = asked = false;
    keep({ step: 1, done: false });
    log('[notch] day one was started');
    present();
  }

  return {
    again,
    cameUp() {
      if (stopped || begun) return;
      const state = kept();
      // Under way from an earlier start: it goes on. Never begun: only on a brain that was never set up.
      if (state ? state.done : !deps.fresh()) return;
      begun = true;
      if (!state) { keep({ step: 1, done: false }); log('[notch] day one begins by itself: this brain was never set up'); }
      clock.setTimeout(() => present(), NOTCH_DAY_ONE_AFTER_MS);
    },
    route(text) {
      if (stopped) return null;
      if (hearing && stepNow() === 4) {
        // Whatever they say now is the answer to "tell me what you do".
        return { did: 'Told Jarvis what they do, on day one.', run: () => { told = cut(text, 400); present(); } };
      }
      // Step 11 waits to be asked where something is. Such a question is answered as ever, by pointing, and
      // day one only notes that it was asked: nothing is taken from it here.
      if (asking && stepNow() === 11 && deps.isWhere?.(text)) asked = true;
      if (dayOneRequest(text)) return { did: 'Start day one.', run: () => again() };
      if (aroundRequest(text) && deps.around) return { did: 'Look around.', run: () => { deps.inbox.present('around', async (stage) => { await around(stage); }); } };
      return null;
    },
    shown(looked) {
      if (stopped || !looking || stepNow() !== 6) return false;
      showed = cut(looked.things.find((thing) => (thing.name ?? '').trim())?.name ?? looked.app ?? '', 40) || 'that';
      present();
      return true;
    },
    unheard(why) {
      if (stopped) return false;
      // Holding the keys to circle makes a recording with nothing in it: that is not something to answer.
      if (stepNow() === 6 && (looking || showed !== null)) return true;
      if (!hearing || stepNow() !== 4) return false;
      missed = why;
      present();
      return true;
    },
    gave() {
      if (stopped || !feeding || stepNow() !== 10) return;
      // It is asked about as any dropped file is, and day one has the notch back after that.
      fed = true;
      present();
    },
    step: stepNow,
    around,
    stop() { stopped = true; },
  };
}
