/**
 * Day one: the first five minutes, in the notch.
 *
 * The prototype's eleven steps, in its words: say yes, say not now, change a
 * lit word, talk, allow watching, show it something, choose an AI, connect
 * mail and calendar, let it look around, what it will take over, and one
 * rule. Six of them teach the grammar by having the person do each thing
 * once. The rest set up what it works with.
 *
 * Two steps were added on 17 November 2026, when the owner had gone through
 * it: "there is a lot of functionalities that are not shown. For example,
 * dropping a file into it or asking where something is." So after the setup
 * the person hands it a file, and asks it where something is: the two that
 * are a movement of the hands. Everything else it does is on one sheet that
 * day one ends on (./cando.ts). Thirteen steps.
 *
 * And the AI moved to the front the same night: "it makes sense to have the
 * AI step at the beginning, because a lot of it will use AI." It is the
 * second step now, straight after hello: what is said at step 5 is made out
 * and answered with it, and so is everything after.
 *
 * On a brain that was never set up, day one is the setup. When the AI is in,
 * it finishes the product's own first steps too (`model.finish`), so that
 * what waits for them starts, and the dashboard does not ask it all again.
 *
 * Before its first word, on that brain, a small card in the middle of the
 * screen says that it is installed and where it lives (`installed`): the
 * prototype's card, in the new name.
 *
 * Here every step is real. Nothing is pretended, so where the product cannot
 * do what the prototype played, the step says what is true:
 *
 *   2   an AI is set up on the product's own AI page, which this opens in a
 *       window of its own and waits for. One that is already there is named,
 *       and nothing is asked. Said "later", the steps that need one say so.
 *       With an AI in, it asks for what makes out speech too, where that
 *       is set (the Channels page, at Voice Transcription): it has a key of
 *       its own, and the talking needs it;
 *   4   the name is kept, and is what the assistant calls the person;
 *   5   what they say is heard by the same keys as ever. With no AI it
 *       cannot be made into words, and the step says so and goes on;
 *   6   yes leaves watching on, and a no switches it off;
 *   7   any real look is the lesson. It says how: the keys held down, then
 *       the mouse pressed and dragged round the thing;
 *   8   mail and calendar are reached by signing in to Google in its own
 *       browser, which this opens and waits for;
 *   9   looking around reads the mail that waits, the week's meetings, and
 *       the files on the desktop and in the documents and downloads, and
 *       draws them as they are found. The newest few are opened, and each
 *       is said in a line (./files.ts) that is remembered. A file whose
 *       name says it is private is never opened;
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
import { NOTCH_NAME } from './name.ts';
import type { NotchBlock, NotchMapNode, NotchMapSource, NotchPart, NotchWord } from './protocol.ts';
import type { NotchSettings } from './settings.ts';
import { realNotchClock, type NotchClock, type NotchStage } from './stage.ts';
import { routeByIntents, type NotchIntent } from './intents.ts';

const em = (text: string): NotchPart => ({ em: text });
const word = (name: string, value: string, options: readonly string[], more: Partial<NotchWord> = {}): NotchPart =>
  ({ word: { name, value, options: [...options], ...more } });
const cut = (text: string, most: number): string => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return [...flat].length > most ? `${[...flat].slice(0, most - 1).join('')}…` : flat;
};

/** The steps, in the order they come. A step is known by its name here, and by its place only on the screen. */
export const NOTCH_DAY_ONE_ORDER = ['hello', 'brain', 'notNow', 'litWord', 'talk', 'watch', 'show', 'connect', 'lookAround', 'drop', 'whereIs', 'habits', 'rule'] as const;
export type NotchDayOneStep = (typeof NOTCH_DAY_ONE_ORDER)[number];
export const NOTCH_DAY_ONE_STEPS = NOTCH_DAY_ONE_ORDER.length;
/** How long the card that says it is installed stays, when nobody answers the first line. */
export const NOTCH_INSTALLED_CARD_MS = 120_000;
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
   * said under the map when the looking is over; `rows` are more lines under
   * that one, each about one thing (a file that was opened, and what it is).
   * The signal fires when the looking was left: what is still being read is
   * dropped, and nothing more is asked of a model or written down for it.
   */
  read(signal?: AbortSignal): Promise<{
    found: string; tool?: boolean; things: { label: string; kind: 'person' | 'co' | 'thing' }[];
    say?: NotchPart[]; rows?: { lead: string; say: NotchPart[] }[];
  }>;
}

export interface NotchDayOneDeps {
  inbox: NotchInbox;
  settings: NotchSettings;
  /** A brain that was never set up: day one starts by itself there, once. */
  fresh(): boolean;
  /** What the assistant calls the person: read, and kept. */
  name?: { get(): string; set(name: string): void };
  /**
   * The AI that answers: whether there is one, what it is called, and the
   * way to set one up. `finish`, when given, completes the product's own
   * first setup once an AI is there: asked for each time, and does nothing on
   * a brain that is set up already.
   */
  model: {
    ready(): boolean; name(): string; hosted(): boolean; setUp(sidecarId: string | null): void; finish?(): Promise<void> | void;
    /**
     * Whether the AI that is set up answers: one small question put to it.
     * `ready` only says that one is set up, and a mistyped key is set up too.
     * Not given: what is set up is taken to work.
     */
    works?(): Promise<boolean>;
  };
  /**
   * What makes out speech: whether anything does, and the way to set it up.
   * It has a key of its own, apart from the AI's. Asked for straight after
   * the AI, since the talking three steps on needs it.
   */
  voice?: { ready(): boolean; setUp(sidecarId: string | null): void };
  /**
   * The card that says it is installed, in the middle of the screen: shown
   * when day one begins by itself, and taken away when its first line is
   * answered.
   */
  installed?: { show(): void; hide(): void };
  /** Whether Jarvis watches the app in front, and the switch. */
  watching?: { on(): boolean; set(on: boolean): Promise<boolean> | boolean };
  /** Whether a desktop app can take a look (the step that is shown something). */
  canLook?: () => boolean;
  /** Whether a file can be dropped on the notch and asked about (step 10). */
  canDrop?: () => boolean;
  /** Whether "where is…" can be answered by pointing (step 11). */
  canPoint?: () => boolean;
  /** Whether words are a question about where something is, or how to do something, in the window in front. */
  isWhere?: (text: string) => boolean;
  /** Whether the person is on the bare desktop, with no window of a program in front. Null when that is not known. */
  onDesktop?: () => boolean | null;
  /** Which system their computer runs, when it is known: what is always on its desktop differs. */
  system?: () => 'windows' | 'mac' | null;
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
  /** Words the notch acts on itself: "day one", "look around", and whatever is said while the talking step waits to hear it. */
  route(text: string): { did: string; run(): void } | null;
  /** Its words, as intents of the one table (./intents.ts). `route` is the first of them that takes a sentence. */
  intents(): readonly NotchIntent[];
  /** A look was taken. True when day one was waiting for one: it is the lesson, and nothing else comes of it. */
  shown(looked: { app: string; things: { name?: string }[] }): boolean;
  /** Nothing was made out of what was said. True when day one was waiting to hear something: it says what is true. */
  unheard(why: string): boolean;
  /** A file was dropped on the notch and taken. Day one, waiting for one, knows its lesson is learned. */
  gave(): void;
  /** A "where is" was answered, by pointing at the thing or not. Day one, waiting to be asked one, says which. */
  pointed(shown: boolean): void;
  /** The step it is on, or 0 when it is over or never began. */
  step(): number;
  /** Looks around, apart from day one. */
  around(stage: NotchStage, more?: { yes?: string; step?: string }): Promise<boolean>;
  stop(): void;
}

interface Kept { step: number; done: boolean; /** Esc was pressed at the first line: "not now" is learned, and its own step is passed over. */ esc?: boolean }

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
  /** The talking step: what was said, or why nothing was made out. The showing step: what was shown. */
  let told: string | null = null, missed: string | null = null, showed: string | null = null;
  let tries = 0;
  /** At the "where is" step: how often something else was said instead. */
  let others = 0;
  /** The AI was named already: said once, also when its step is come back to for the hearing. */
  let thinks = false;
  /** Whether the step on the notch is waiting to hear, or to be shown. */
  let hearing = false, looking = false;
  /** Step 10: waiting for a file, and one came. Step 11: waiting to be asked where something is, and it was asked. */
  let feeding = false, fed = false, asking = false, asked = false;
  /** Step 11: whether the thing that was asked about was pointed at. Null when that was never told. */
  let shown: boolean | null = null;

  /**
   * The question step 11 suggests. It has to have an answer where the person
   * is. The owner, 17 November 2026: "I was on my desktop, I didn't have any
   * windows open, which will be something that a lot of people will have."
   * So on a bare desktop it is about something every desktop has.
   */
  const example = (): string => {
    if (deps.onDesktop?.() !== true) return 'where do I close this window?';
    const system = deps.system?.() ?? null;
    return system === 'windows' ? 'where is the Start button?' : system === 'mac' ? 'where is the Trash?' : 'where is the clock?';
  };

  const kept = (): Kept | null => {
    const raw = deps.settings.get<Partial<Kept> | null>(KEPT, null);
    return raw && typeof raw.step === 'number' ? { step: Math.max(1, Math.floor(raw.step)), done: raw.done === true, ...(raw.esc === true ? { esc: true } : {}) } : null;
  };
  const keep = (state: Kept): void => { deps.settings.set(KEPT, state, now()); };
  const stepNow = (): number => { const state = kept(); return state && !state.done ? state.step : 0; };
  /** The place of a step, from 1, and whether it is the one day one is on. */
  const at = (name: NotchDayOneStep): number => NOTCH_DAY_ONE_ORDER.indexOf(name) + 1;
  const on = (name: NotchDayOneStep): boolean => stepNow() === at(name);
  const counter = (name: NotchDayOneStep): string => `step ${at(name)}/${NOTCH_DAY_ONE_STEPS}`;
  let cardTimer: unknown = null;
  const cardOff = (): void => {
    if (cardTimer !== null) { clock.clearTimeout(cardTimer); cardTimer = null; }
    try { deps.installed?.hide(); } catch { /* it leaves by itself */ }
  };

  /**
   * With an AI in, the product's own first setup is over too: what waits for
   * it starts. Asked for once, the first time an AI is seen, at whichever
   * step that is. Never stands in day one's way.
   */
  let setUp = false;
  /** Whether the AI that is set up answers. Asked of it once it does: a key that worked is not tried again. */
  let answers = false;
  const works = async (): Promise<boolean> => {
    if (answers || !deps.model.works) return true;
    try { answers = (await deps.model.works()) === true; } catch { answers = false; }
    return answers;
  };
  const finishSetup = async (): Promise<void> => {
    if (setUp || !deps.model.ready()) return;
    // An AI that is set up and does not answer (a mistyped key) is not a setup that is finished.
    if (!(await works())) return;
    setUp = true;
    try { await deps.model.finish?.(); } catch (error) {
      setUp = false;
      log(`[notch] day one could not finish the setup: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** A step's answer: go on, go on past the next one too, or it was left and waits in the count. */
  type Went = 'on' | 'left' | 'past';

  /** A step that asks one thing: yes, not now, or left alone. */
  const ask = async (stage: NotchStage, name: NotchDayOneStep, parts: NotchPart[], yes: string, mood: 'look' | 'curious' | 'careful' = 'look'): Promise<'yes' | 'no' | 'left'> => {
    const id = stage.id();
    stage.put({ id, kind: 'offer', say: parts, yes, mood, fold: NOTCH_DAY_ONE_FOLD_MS, step: counter(name) });
    const answer = await stage.answer(id, ['yes', 'no', 'fold']);
    return answer.act === 'yes' ? 'yes' : answer.act === 'no' ? 'no' : 'left';
  };

  async function hello(stage: NotchStage): Promise<Went> {
    const said = await ask(stage, 'hello', [`Hi. I am ${NOTCH_NAME}. I live up here. Say hello?`], 'hello', 'curious');
    // They have found it: the card that said where it lives is not needed any more.
    cardOff();
    if (said === 'left') return 'left';
    if (said === 'yes') { await stage.say(['That was a yes. One tap.'], 2300, { mood: 'happy' }); return 'on'; }
    // They pressed Esc: that is a lesson of its own, already learned. Its step is passed over when it comes.
    const state = kept();
    if (state) keep({ ...state, esc: true });
    await stage.say(['That was a not now. It is all it takes.'], 2600, { mood: 'happy' });
    return 'on';
  }

  async function notNow(stage: NotchStage): Promise<Went> {
    if (kept()?.esc) return 'on';
    const id = stage.id();
    stage.put({ id, kind: 'offer', keys: 'esc', say: ['For not now, press esc, or just ignore me. I never mind. Try it.'], mood: 'look', fold: 8000, step: counter('notNow') });
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
      id, kind: 'offer', yes: 'good', mood: 'look', fold: NOTCH_DAY_ONE_FOLD_MS, step: counter('litWord'),
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
          await stage.say(['I heard a voice. I cannot make out words until speech-to-text is set up. It is in Settings, under Channels.'], 4400, { mood: 'look' });
          return 'on';
        }
        if (++tries >= 2) { hearing = false; await stage.say(['I did not catch it. It will come. On we go.'], 2600, { mood: 'look' }); return 'on'; }
        await stage.say(['I did not catch that. Keep the keys down while you talk.'], 2800, { mood: 'confused' });
      }
      hearing = true;
      const id = stage.id();
      stage.put({ id, kind: 'offer', keys: 'talk', yes: 'hold and talk', say: ['Now tell me what you do. Out loud.'], mood: 'listen', fold: NOTCH_DAY_ONE_FOLD_MS, step: counter('talk') });
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
    const said = await ask(stage, 'watch', ['May I watch which app you are in? Close my eyes any time.'], 'allow');
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
        id, kind: 'offer', keys: 'talk', yes: 'hold, then drag', mood: 'curious', fold: NOTCH_DAY_ONE_FOLD_MS, step: counter('show'),
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
  async function waitFor(stage: NotchStage, parts: NotchPart[], every: number, there: () => boolean | Promise<boolean>, meanwhile?: () => NotchPart[] | null): Promise<boolean> {
    const id = stage.id();
    let later = false;
    stage.answer(id, ['stop']).then(() => { later = true; }, () => {});
    stage.put({ id, kind: 'work', say: parts, steps: 0, done: 0, mood: 'work' });
    const until = now() + NOTCH_DAY_ONE_WAIT_MS;
    let said = parts;
    while (!later && now() < until) {
      await stage.wait(every);
      if (later) break;
      let is = false;
      try { is = (await there()) === true; } catch { is = false; }
      if (is) return true;
      // What stands in the way now, when that is known: the line says it, and goes on waiting.
      const next = meanwhile?.() ?? parts;
      if (!later && JSON.stringify(next) !== JSON.stringify(said)) { said = next; stage.surface.update(id, { say: next }); }
    }
    return false;
  }

  async function brain(stage: NotchStage): Promise<Went> {
    const model = deps.model;
    const finish = finishSetup;
    /**
     * Hearing is an AI of its own, with its own key. With an AI to answer
     * what is said, the next thing is to make out what is said: asked for
     * here, at the beginning, and not when the talking step finds it missing.
     */
    const hear = async (): Promise<Went> => {
      const voice = deps.voice;
      if (!voice || voice.ready()) return 'on';
      const said = await ask(stage, 'brain', ['To hear you I need speech-to-text too. Set that up now?'], 'set up');
      if (said === 'left') return 'left';
      const notYet = async (): Promise<Went> => {
        await stage.say(['Later then. Until then I cannot make out what you say. It is in Settings, under Channels.'], 4400, { mood: 'careful' });
        return 'on';
      };
      if (said === 'no') return notYet();
      voice.setUp(stage.from());
      const heard = await waitFor(stage, ['I opened the settings at Voice Transcription. Choose a service there, and give its key.'], 2000, () => voice.ready());
      if (!heard) return notYet();
      await stage.say(['Now I can hear you.'], 2200, { mood: 'happy', mark: 'check' });
      return 'on';
    };
    // Set up and answering. One that is set up and does not answer is asked about below, like none at all:
    // "Now I can think" was said of a mistyped key, and every step after it failed one by one without a word.
    const broken = model.ready() && !(await works());
    if (model.ready() && !broken) {
      await finish();
      if (!thinks) {
        thinks = true;
        // "Jarvis AI" is what the plan's own model is called where it is sold: a product's name, not the notch's.
        await stage.say(model.hosted() ? [em('Jarvis AI'), ' it is. It comes with your plan.'] : ['I think with ', em(cut(model.name() || 'the AI you set up', 40)), '. That is set.'], 2800, { mood: 'happy', mark: 'check' });
      }
      return hear();
    }
    const later = async (): Promise<Went> => {
      await stage.say(['Later then. Until I have one I can listen and show you round, but not think.'], 3800, { mood: 'careful' });
      return 'on';
    };
    const NOT_ANSWERING: NotchPart[] = ['The AI is set up but does not answer. Check its key and its model in the AI settings.'];
    let local = false;
    if (broken) {
      const open = await ask(stage, 'brain', ['My AI does not answer: its key or its model may be wrong. Open the AI settings?'], 'open', 'careful');
      if (open === 'left') return 'left';
      if (open !== 'yes') return later();
    } else {
      const options = ['My own AI account', 'AI on this computer'];
      const id = stage.id();
      stage.put({ id, kind: 'offer', say: ['First, an AI to think with. Which one should I use?'], options, fold: NOTCH_DAY_ONE_FOLD_MS, step: counter('brain') });
      const answer = await stage.answer(id, ['pick', 'no', 'fold']);
      if (answer.act === 'fold') return 'left';
      if (answer.act !== 'pick') return later();
      local = answer.index === 1;
    }
    model.setUp(stage.from());
    const there = await waitFor(
      stage,
      broken ? NOT_ANSWERING : [local ? 'I opened the AI settings. Choose the AI on this computer there.' : 'I opened the AI settings. Add your account and its key there.'],
      2000,
      async () => model.ready() && (await works()),
      // One is in, and it does not answer: said on the line, which goes on waiting for one that does.
      () => (model.ready() && !answers ? NOT_ANSWERING : null),
    );
    if (!there) return later();
    await finish();
    thinks = true;
    await stage.say([em(cut(model.name() || 'That one', 40)), ' it is. Now I can think.'], 2800, { mood: 'happy', mark: 'check' });
    return hear();
  }

  async function connect(stage: NotchStage): Promise<Went> {
    const mail = deps.mail;
    if (!mail) return 'on';
    let reached = false;
    try { reached = await mail.reached(); } catch { reached = false; }
    if (reached) { await stage.say(['Your mail and calendar are already within reach.'], 2600, { mood: 'happy', mark: 'check', src: 'mail' }); return 'on'; }
    const said = await ask(stage, 'connect', ['Connect your email and calendar? I learn fastest there.'], 'connect');
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
    const left = new AbortController();
    // One wait for the whole sheet: its yes ("continue") and its Esc both end the looking, wherever it has got to.
    const closing = stage.answer(id, ['yes', 'no']).then(() => { closed = true; left.abort(); }, (error: unknown) => { closed = true; left.abort(); throw error; });
    closing.catch(() => {});
    /** Ends when the looking is left, whichever way: a place that hangs does not hold the person in the sheet. */
    const gone = closing.then(() => null, () => null);
    stage.put({ id, kind: 'sheet', say: ['Looking around'], blocks: blocks(), mood: 'search', stay: true, no: more.yes ? 'skip' : 'close', ...(more.yes ? { yes: more.yes } : {}), ...(more.step ? { step: more.step } : {}) });
    const redraw = (): void => { if (!closed) stage.surface.update(id, { blocks: blocks() }); };
    let found = 0;
    for (let at = 0; at < sources.length && !closed; at++) {
      chips[at]!.state = 'on';
      redraw();
      let read: Awaited<ReturnType<NotchAroundSource['read']>> = { found: 'not reached', things: [] };
      try { read = (await Promise.race([sources[at]!.read(left.signal), gone])) ?? read; } catch (error) {
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
      for (const row of (read.rows ?? []).slice(0, 8)) rows.push({ kind: 'row', lead: cut(row.lead, 40), say: row.say });
      redraw();
      await stage.wait(240);
    }
    if (closed) return false;
    // Counts, never what was found.
    log(`[notch] looked around: ${sources.length} place(s), ${nodes.length - 1} thing(s) drawn`);
    // One stroke through everything it found.
    if (nodes.length > 2) tour = [...nodes.slice(1).map((node) => node.id), ME.id];
    rows.push({ kind: 'note', say: [nodes.length > 1 ? 'That is what I can reach today. What I remember of it is in Memory, where you can forget any of it.' : 'I can reach nothing yet. It fills as you connect things.'] });
    stage.surface.update(id, { blocks: blocks() });
    stage.surface.act({ mood: 'proud' });
    // It stays to be read, until it is closed or gone on from.
    await closing;
    return true;
  }

  async function lookAround(stage: NotchStage): Promise<Went> {
    if (!deps.around) return 'on';
    const said = await ask(stage, 'lookAround', ['May I look around? Your mail, your calendar, and the files on your desktop. I open the newest few, remember what they are, and skip anything private.'], 'allow', 'curious');
    if (said === 'left') return 'left';
    if (said === 'yes') await around(stage, { yes: 'continue', step: counter('lookAround') });
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
      stage.put({ id, kind: 'offer', keys: 'esc', say: ['Now hand me a file. Drag any file from your desktop onto me.'], mood: 'curious', fold: NOTCH_DAY_ONE_FOLD_MS, step: counter('drop') });
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
    for (;;) {
      if (asked) {
        asking = false;
        // It says what happened: pointed at, or not found this time. Never that it pointed when it did not.
        await stage.say(shown === false
          ? ['I could not find that one here. In any window, ask "where is…" or "how do I…" and I point, a step at a time.']
          : ['I point, you click. It works in any window. Ask "how do I…" and I walk you through it, a step at a time.'], 4600, { mood: shown === false ? 'look' : 'happy' });
        asked = false; shown = null;
        return 'on';
      }
      // They said something else, twice: it is theirs to try later.
      if (asking && ++others > 2) { asking = false; return 'on'; }
      asking = true;
      const id = stage.id();
      stage.put({
        id, kind: 'offer', keys: 'talk', yes: 'hold and ask', mood: 'curious', fold: NOTCH_DAY_ONE_FOLD_MS, step: counter('whereIs'),
        say: ['Now ask me where something is. Hold ', { key: 'talk' }, ' and say: ', em(example())],
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
    const said = await ask(stage, 'rule', ['One rule to start: every new agent asks before it acts.'], 'agreed', 'careful');
    if (said === 'left') return 'left';
    // Everything else it does, on one sheet, before it lets them go.
    if (deps.canDo) await deps.canDo(stage, { yes: 'done' });
    return 'on';
  }

  const STEPS: Record<NotchDayOneStep, (stage: NotchStage) => Promise<Went>> = { hello, brain, notNow, litWord, talk, watch, show, connect, lookAround, drop, whereIs, habits, rule };

  async function play(stage: NotchStage): Promise<NotchItemEnd> {
    for (;;) {
      const state = kept();
      if (!state || state.done) return 'settled';
      if (deps.paused?.()) return 'waits';
      const name = NOTCH_DAY_ONE_ORDER[state.step - 1];
      const step = name ? STEPS[name] : undefined;
      if (!step) {
        keep({ step: state.step, done: true });
        hearing = false; looking = false; feeding = false; asking = false;
        log('[notch] day one is over');
        await stage.say(['That is all. I speak up when something needs you. Hold ', { key: 'talk' }, ' and talk, any time.'], 5200, { mood: 'happy' });
        return 'settled';
      }
      // An AI that came later than its own step (the key was made while day one went on) finishes the setup
      // just the same: before, only the AI's own step did, and the product stayed "never set up" for good.
      await finishSetup();
      const went = await step(stage);
      if (went === 'left') {
        // Left in the count. It waits for nothing there: words said an hour later are not its answer, a look is
        // not its lesson, a file is not handed to it. All of that is asked for again when it is opened.
        hearing = false; looking = false; feeding = false; asking = false;
        return 'waits';
      }
      tries = 0; others = 0;
      // Kept as soon as it is taken: a brain that stops here goes on from the next step.
      // (`past`: the step after this one has nothing to stand on, and is passed over. Only ever the one beside it.)
      keep({ ...(kept() ?? state), step: state.step + (went === 'past' ? 2 : 1), done: false });
      // Which step, never what was said in it.
      log(`[notch] day one: step ${state.step} of ${NOTCH_DAY_ONE_STEPS} is done`);
    }
  }

  /**
   * `asked`: the person started it ("day one", the button) or it answers
   * what they just did. Day one coming up by itself is not asked for: it
   * waits for a still moment and for the quiet hours to end like anything
   * else, and its line does not take a yes or an Esc in its first moment.
   * (An Esc meant for a dialog once landed on "May I watch?" and switched
   * watching off.)
   */
  const item = (asked: boolean): NotchItem => ({
    id: ITEM, subject: ITEM, class: 'person', speaks: true, asked, returns: true,
    title: () => [`Day one, step ${Math.min(stepNow() || 1, NOTCH_DAY_ONE_STEPS)} of ${NOTCH_DAY_ONE_STEPS}.`],
    check: () => stepNow() > 0,
    play,
  });
  const present = (asked = true): void => { if (!stopped && stepNow() > 0) deps.inbox.add(item(asked)); };

  function again(): void {
    if (stopped) return;
    told = missed = showed = null; tries = 0; others = 0; hearing = looking = feeding = fed = asking = asked = false; shown = null; thinks = false;
    keep({ step: 1, done: false });
    log('[notch] day one was started');
    present();
  }

  const intents: NotchIntent[] = [{
    id: 'dayone.answer', feature: 'dayOne', says: 'what is said while day one waits to hear what the person does', band: 'up', act: 'none', first: 'acts',
    examples: ['I run a small bakery'],
    match(text) {
      if (stopped) return null;
      if (hearing && on('talk')) {
        // Whatever they say now is the answer to "tell me what you do".
        return { did: `Told ${NOTCH_NAME} what they do, on day one.`, run: () => { told = cut(text, 400); present(); } };
      }
      // Step 11 waits to be asked where something is. Such a question is answered as ever, by pointing, and
      // day one only notes that it was asked: nothing is taken from it here. It is noted here, in the intent
      // that is asked about every sentence, and so once for each: a sentence is resolved once (./asks.ts).
      if (asking && on('whereIs') && deps.isWhere?.(text)) { asked = true; shown = null; }
      return null;
    },
  }, {
    id: 'dayone.start', feature: 'dayOne', says: 'start day one again', band: 'open', act: 'none', first: 'acts',
    examples: ['day one', 'show me around'],
    match(text) {
      if (stopped) return null;
      return dayOneRequest(text) ? { did: 'Start day one.', run: () => again() } : null;
    },
  }, {
    id: 'dayone.around', feature: 'dayOne', says: 'look around: the map of what is here', band: 'open', act: 'none', first: 'acts',
    examples: ['look around'],
    match(text) {
      if (stopped) return null;
      return aroundRequest(text) && deps.around ? { did: 'Look around.', run: () => { deps.inbox.present('around', async (stage) => { await around(stage); }); } } : null;
    },
  }];
  return {
    again,
    cameUp() {
      if (stopped || begun) return;
      const state = kept();
      // Day one is over and the product still reads "never set up": its setup is finished now. Only day
      // one's own steps finished it, so a brain whose day one ended before it could (it was gone through
      // on a build that did not finish the setup yet) stayed never set up for good, with nothing of what
      // waits for a setup running. Found when a colleague's request was answered "no" by a Pillow that
      // had an AI and no agent to do the work (20 November 2026). It asks nothing of a brain that is set
      // up, and it finishes nothing without an AI that answers.
      if (state?.done) { if (deps.fresh()) void finishSetup(); return; }
      // Under way from an earlier start: it goes on. Never begun: only on a brain that was never set up.
      if (!state && !deps.fresh()) return;
      begun = true;
      if (!state) { keep({ step: 1, done: false }); log('[notch] day one begins by itself: this brain was never set up'); }
      // Before its first word: the card that says it is installed, and where it lives. Only where it has never
      // said that first word. It leaves when that word is answered, and by itself if nobody is there.
      if (stepNow() === 1 && deps.installed) {
        try { deps.installed.show(); } catch { /* day one goes on without it */ }
        cardTimer = clock.setTimeout(() => { cardTimer = null; cardOff(); }, NOTCH_INSTALLED_CARD_MS);
      }
      clock.setTimeout(() => present(false), NOTCH_DAY_ONE_AFTER_MS);
    },
    route: (text) => routeByIntents(intents, text),
    intents: () => intents,
    shown(looked) {
      if (stopped || !looking || !on('show')) return false;
      showed = cut(looked.things.find((thing) => (thing.name ?? '').trim())?.name ?? looked.app ?? '', 40) || 'that';
      present();
      return true;
    },
    unheard(why) {
      if (stopped) return false;
      // Holding the keys to circle makes a recording with nothing in it: that is not something to answer.
      if (on('show') && (looking || showed !== null)) return true;
      if (!hearing || !on('talk')) return false;
      missed = why;
      present();
      return true;
    },
    gave() {
      if (stopped || !feeding || !on('drop')) return;
      // It is asked about as any dropped file is, and day one has the notch back after that.
      fed = true;
      present();
    },
    pointed(was) {
      if (stopped || !asked || !on('whereIs')) return;
      shown = was;
    },
    step: stepNow,
    around,
    stop() { stopped = true; cardOff(); },
  };
}
