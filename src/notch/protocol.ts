/**
 * The messages between the brain and the notch's page, version 1.
 *
 * The brain says what the notch shows, as data. The page draws it, and says
 * back what the person did. The page decides nothing: it never knows what a
 * yes means, only that it was given. Everything here is plain JSON, because it
 * travels through the desktop app as text (docs/notch/README.md).
 *
 * Only one thing is on the notch at a time. A new `show` replaces whatever is
 * there.
 */
export const NOTCH_PROTOCOL_VERSION = 1;

/**
 * One piece of a sentence. A plain string is ordinary words. `em` is the word
 * or two the sentence is about. `key` draws a keycap inside the sentence.
 * `word` is a lit word: one the person can change by clicking, scrolling or
 * typing.
 */
export type NotchPart =
  | string
  | { em: string }
  | { key: 'yes' | 'talk' | 'esc' | 'enter' }
  | { word: NotchWord };

/**
 * A lit word. `name` is how an answer refers to it, unique within one line.
 * `read` names the reader that understands a typed value (a day, a day and a
 * time, a schedule, a list of days, a lead time, a place). `syn` gives other
 * ways of saying each option. `free` accepts any typed text as it is.
 */
export interface NotchWord {
  name: string;
  value: string;
  options: string[];
  label?: string;
  read?: 'day' | 'dayTime' | 'sched' | 'days' | 'lead' | 'where';
  syn?: Record<string, string[]>;
  free?: boolean;
  /**
   * It takes a sentence, not a word: something the person tells Jarvis in
   * their own words. Pressing it opens a field to type in at once, wider and
   * longer than a word's, and there is nothing to step through.
   */
  long?: boolean;
}

/** The most a word that takes a sentence may hold. */
export const NOTCH_WORD_LONG_MAX = 200;

export const NOTCH_MOODS = [
  'idle', 'look', 'listen', 'read', 'write', 'think', 'recall', 'search', 'work', 'happy', 'proud',
  'urgent', 'careful', 'curious', 'confused', 'worried', 'sorry', 'surprised', 'sleepy', 'closed',
  'focus', 'away', 'track',
] as const;
export type NotchMood = (typeof NOTCH_MOODS)[number];

export const NOTCH_GESTURES = [
  'blink', 'sq', 'wink', 'peek-l', 'peek-r', 'pop', 'nodg', 'shake', 'hop', 'wake', 'doze', 'shrug',
  // One eye closes and opens, and then the other: the way a gecko blinks. Not in the prototype: asked for on 18 November 2026.
  'gecko',
] as const;
export type NotchGesture = (typeof NOTCH_GESTURES)[number];

/** One-shot movements of the notch's lower edge. */
export const NOTCH_LIPS = ['ripple', 'shiver', 'laugh', 'gasp', 'zip', 'yawn', 'reach'] as const;
export type NotchLip = (typeof NOTCH_LIPS)[number];

/** The ways the notch can first appear. */
export const NOTCH_BIRTHS = ['run', 'meet', 'trace', 'bead', 'eye', 'gather'] as const;
export type NotchBirth = (typeof NOTCH_BIRTHS)[number];

/**
 * How a line comes in along the top edge of the screen before it is said:
 * from one side, two fast ones for something that cannot wait, hopping for
 * an agent that is done, or one from each side at once for a line that tells
 * of several things.
 */
export const NOTCH_ARRIVALS = ['left', 'right', 'urgent', 'hop', 'pair'] as const;
export type NotchArrival = (typeof NOTCH_ARRIVALS)[number];

/**
 * What the body of the notch does by itself, apart from the eyes: a nod (the
 * bottom edge gulps), two small hops, or a duck out of the way and back.
 */
export const NOTCH_BODIES = ['nod', 'hops', 'duck'] as const;
export type NotchBody = (typeof NOTCH_BODIES)[number];

/**
 * What happens along the top edge of the screen, beside the notch: something
 * that was sent leaves, a new agent buds off and hops away, or a thing is
 * carried through Jarvis from one side to the other.
 */
export const NOTCH_EDGES = ['depart', 'bud', 'carry'] as const;
export type NotchEdge = (typeof NOTCH_EDGES)[number];

/** What is common to everything the notch can show. */
interface NotchLineBase {
  /** Names this line in every answer about it. */
  id: string;
  say: NotchPart[];
  mood?: NotchMood;
  /** A drawn check, or a red dot. */
  mark?: 'check' | 'fail';
  /** Who is speaking, when it is not Jarvis: an agent or a teammate. */
  who?: string;
  /** The app the line is about: its icon is shown with a ring. */
  src?: NotchApp;
  arrive?: NotchArrival;
  /**
   * The line came by itself: the person did not ask for it. No yes lands on it
   * for the first 0.7 seconds, so a tap meant for something else cannot.
   */
  unasked?: boolean;
  /** A few small words beside the hints, saying where in a sequence this is: "step 3/11". */
  step?: string;
}

/** A result. Nothing is asked; it leaves by itself after `ms`. */
export interface NotchSayLine extends NotchLineBase {
  kind: 'say';
  ms: number;
  /**
   * How much of `ms` is left, when the line is told to a page that comes up
   * in the middle of it (the brain fills it in the `state` that answers a
   * hello). Not given: all of it.
   */
  left?: number;
}

/**
 * Something Jarvis offers to do. With `options` it is a row of choices, and
 * the answer is a pick. Without, `yes` is the word for doing it ("show",
 * "send") and the answer is yes or no. Left alone for `fold` ms it leaves as
 * unanswered (9 s for a line and 14 s for choices when not given; 0 stays).
 */
export interface NotchOfferLine extends NotchLineBase {
  kind: 'offer';
  yes?: string;
  options?: string[];
  fold?: number;
  /**
   * Which keys the line shows, when it is not the usual yes and Esc (day
   * one teaches them one at a time):
   *   esc    only Esc is shown. A yes is still told to the brain, and the
   *          line stays, for the brain to say what it says to that.
   *   talk   the pair that is held to talk is shown, with `yes` as the word
   *          for what holding it does ("hold and talk"), and Esc beside it.
   */
  keys?: 'esc' | 'talk';
}

/** A panel under a title. `yes` is the word for its main action, if any. */
export interface NotchSheetLine extends NotchLineBase {
  kind: 'sheet';
  blocks: NotchBlock[];
  yes?: string;
  /**
   * It asks something that must be answered on purpose: a click somewhere
   * else does not close it. Only yes and Esc answer it.
   */
  stay?: boolean;
  /**
   * What Esc does on a sheet that stays, in a word, when it is not a no to
   * what the sheet asks: "back", "close". The answer it sends is the same.
   */
  no?: string;
  /**
   * What the sheet shows must have been seen to its end before its yes is a
   * yes: something that is about to leave the machine, or a request that is
   * about to be done. While its end has not been on screen, the yes key
   * moves the sheet down a page, and answers nothing.
   */
  whole?: boolean;
}

/** A text field in place of the sentence, with a panel under it. */
export interface NotchAskLine extends NotchLineBase {
  kind: 'ask';
  placeholder: string;
  /** The word for sending what was typed. */
  yes: string;
  blocks: NotchBlock[];
  /**
   * The person opened this to type: the field takes the keyboard as soon as
   * it is shown, without a click. Where the system will not hand it over, a
   * click on the field still does.
   */
  focus?: boolean;
  /**
   * What is typed here answers something that must not be answered by
   * accident (a name for a device that is being joined): a press somewhere
   * else on the screen is not Esc. Only Esc itself closes it.
   */
  stay?: boolean;
}

/**
 * Jarvis doing something step by step. `done` of `steps` beads are lit; the
 * brain moves them on with `update`. Esc asks to stop. With `steps` 0 how many
 * there will be is not known: no beads are drawn, and the sentence says what
 * is being done.
 */
export interface NotchWorkLine extends NotchLineBase {
  kind: 'work';
  steps: number;
  done: number;
  /** Show that it can be spoken to while it works. */
  canTalk?: boolean;
  /**
   * It leads straight into something the person must see (a letter under
   * its fuse): the window is not to be out of sight while it is up, as for a
   * question. Where the notch hides behind a fullscreen video it comes back
   * for this line, so that it is there when the letter comes.
   */
  asks?: boolean;
}

/**
 * Something going out, with a window to take it back. A fuse burns along the
 * notch's edge for `ms`. Esc inside the window is "undo"; when it burns out
 * the page answers "done".
 */
export interface NotchSendLine extends NotchLineBase {
  kind: 'send';
  ms: number;
  /**
   * How much of the window is left, when the line is told to a page that
   * comes up in the middle of it: the fuse goes on from there, and does not
   * start again. Not given: all of it. With none left the page burns nothing
   * and says nothing ran out: a fuse it did not see burn is not one it can
   * vouch for. Esc is still an undo.
   */
  left?: number;
  /**
   * What is going out, shown under the sentence for as long as the fuse
   * burns: a letter on paper. When the fuse runs out the page's `done`
   * carries `seen: true` only if it drew the letter, showed it from the
   * start or for long enough, had its end on screen and was not out of
   * sight. A `done` without it (an older page that draws no letter says
   * such) is not proof that anybody saw it, and the brain sends nothing on
   * it. Nothing in the letter is answered: a click away from it is not an
   * undo, and only Esc is.
   */
  blocks?: NotchBlock[];
}

/**
 * The person is speaking, or has just spoken. `heard` is what has been made
 * out so far. Esc turns it away (the answer is no): it is not acted on.
 */
export interface NotchListenLine extends NotchLineBase {
  kind: 'listen';
  heard: string;
  /**
   * The keys are up: nothing more is being heard, and `heard` is being made
   * out or is final. The hint to let go gives way to the one for Esc.
   */
  over?: boolean;
}

export type NotchLine =
  | NotchSayLine | NotchOfferLine | NotchSheetLine | NotchAskLine
  | NotchWorkLine | NotchSendLine | NotchListenLine;

/** A button in a sheet. `key` is the digit that presses it. */
export interface NotchButton {
  id: string;
  label: string;
  key?: number;
  /** A text link rather than a button. */
  quiet?: boolean;
}

/** What a sheet is made of, top to bottom. */
export type NotchBlock =
  /** A row: who or what on the left, a sentence, something small on the right. */
  | { kind: 'row'; id?: string; lead?: string; say: NotchPart[]; tail?: string; small?: string; buttons?: NotchButton[]; go?: boolean;
    /** No longer there: drawn struck through. A memory that was just forgotten, a habit that was turned down. */
    gone?: boolean;
    /**
     * A few small dots on the right, the oldest first: how each of the last
     * runs of something ended. `ok` went well, `ask` stopped to ask, `bad`
     * failed. The prototype's beads on an agent's card.
     */
    beads?: NotchBead[] }
  /** A white sheet of paper: a draft, an answer, a list. */
  | { kind: 'paper'; to?: NotchPart[]; lines: NotchPart[][]; numbered?: boolean; file?: { name: string; size: string } }
  /** A quiet line of explanation. */
  | { kind: 'note'; say: NotchPart[] }
  | { kind: 'buttons'; buttons: NotchButton[] }
  /** A file that was handed over. */
  | { kind: 'file'; icon: 'doc' | 'image' | 'audio' | 'video' | 'sheet'; name: string; meta: string }
  /**
   * What Jarvis found when it looked around, drawn as it finds it: the person
   * in the middle, the tools, people and things round them, and a line
   * between two that belong together. Sent again with more in it as more is
   * found: what was already drawn stays as it is, and only what is new comes
   * in. `sources` are the places it reads, one chip each. `tour`, at the end,
   * is one stroke drawn once through the things named.
   */
  | { kind: 'map'; nodes: NotchMapNode[]; links: [string, string][]; sources: NotchMapSource[]; tour?: string[] };

/** How one run ended, as a dot. */
export type NotchBead = 'ok' | 'ask' | 'bad';
/** The most dots a row carries. */
export const NOTCH_BEADS_MAX = 8;

/** One thing on the map. `x` and `y` are in a field 444 wide and 204 high. */
export interface NotchMapNode { id: string; label: string; x: number; y: number; kind: 'me' | 'person' | 'tool' | 'co' | 'thing' }

/** One place that is read: its name, what was found there once it is done, and whether it is being read now. */
export interface NotchMapSource { name: string; found?: string; state?: 'on' | 'done' }

/** The apps whose icon a line can carry. */
export const NOTCH_APPS = ['desk', 'mail', 'sheets', 'pay', 'cal', 'slack', 'call', 'form', 'term', 'dash', 'bank'] as const;
export type NotchApp = (typeof NOTCH_APPS)[number];

/**
 * The app in front on that machine, as the resting notch shows it: its name,
 * and its own icon as a small PNG in a data URL. The icon is a picture and is
 * only ever drawn as one (an `<img>`), never set as markup.
 */
export interface NotchWhereApp { name: string; icon?: string }

/** The longest icon the page will draw, as characters of its data URL (a 48 px PNG is a few thousand). */
export const NOTCH_ICON_MAX = 60_000;

/** An icon as the page may draw it: a PNG data URL of sane length, or nothing. */
export function notchIconUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > NOTCH_ICON_MAX) return undefined;
  return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined;
}

/** The app in front, checked: a name of one line, and an icon only if it is one. Null when it is not an app. */
export function notchWhereApp(value: unknown): NotchWhereApp | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? [...raw.name.replace(/\s+/g, ' ').trim()].slice(0, 60).join('') : '';
  if (!name) return null;
  const icon = notchIconUrl(raw.icon);
  return icon ? { name, icon } : { name };
}

/**
 * The least of a fuse a page must be told is left for it to say, at its end,
 * that it ran out. A page that comes up in the middle of a fuse did not show
 * what went before: with less than this left, nobody had the time to read the
 * line and press Esc, so the page burns nothing and says nothing ran out (the
 * brain then counts the fuse as lost, and the yes behind it decides nothing).
 * Esc is still an undo. A page that showed the fuse from its start is not
 * held to this. The owner's to tune.
 */
export const NOTCH_FUSE_SEEN_MS = 2000;

/** Brain to page. */
export type NotchToPage =
  /** The answer to hello: everything the notch should be showing, at once. */
  | { type: 'state'; line: NotchLine | null; count: number; born?: NotchBirth; face?: NotchMood; where?: NotchWhereApp | null; eye?: boolean; sound?: boolean }
  /**
   * The app in front, for the icon beside the resting eyes. Null: none is
   * shown (nothing is in front, or the notch is not watching it). The brain
   * keeps it, like the face.
   */
  | { type: 'where'; app: NotchWhereApp | null }
  | { type: 'show'; line: NotchLine }
  /** Back to the eyes. */
  | { type: 'rest' }
  /** How many things wait. Shown beside the eyes at rest. */
  | { type: 'count'; count: number }
  /**
   * The face the notch has at rest, until told otherwise: `closed` while
   * everything is stopped. Unlike a mood given with `act`, the brain keeps it,
   * so a page that comes back has the same face.
   */
  | { type: 'face'; mood: NotchMood }
  /**
   * A change to the line on screen, in place: steps done, a new sentence,
   * words heard, or a sheet's content after one of its buttons was pressed.
   */
  | { type: 'update'; id: string; done?: number; say?: NotchPart[]; heard?: string; over?: boolean; blocks?: NotchBlock[] }
  /** Something the notch does with its face or body, without saying anything. */
  | {
    type: 'act'; mood?: NotchMood; gesture?: NotchGesture; lip?: NotchLip; birth?: NotchBirth;
    /**
     * With the lip `reach`: where along the lower edge it reaches down, from
     * 0 (its left end) to 1 (its right end). It leans toward the thing it
     * means. The middle when not given.
     */
    aim?: number;
    /** The body alone: a nod, two hops, a duck. */
    body?: NotchBody;
    /**
     * A push on the bottom edge, as a speed: positive bulges it downward (a
     * gulp), negative pulls it up (a small jump). Held to 400 either way.
     */
    kick?: number;
    /** Along the top edge of the screen. `side` is where it goes: left when not given. */
    edge?: NotchEdge;
    side?: 'left' | 'right';
    /** The watching eye: the left eye turns round and citron. */
    eye?: boolean;
    /** The mouth that takes a file: open, open wide with the file over it, shut, or the gulp after a drop. */
    mouth?: 'open' | 'over' | 'shut' | 'gulp';
    /** How many small bumps wait on the screen's top edge beside the notch. */
    park?: number;
    /** Sounds on or off. They start off. */
    sound?: boolean;
  };

/**
 * What the person did with the line named `id`:
 *   yes     agreed to an offer, a sheet's action, or "got it" on a result
 *   no      turned it down: Esc, "not now", or a click away from it
 *   fold    left it unanswered until it went away by itself
 *   pick    chose `option` (position `index`) of the choices
 *   button  pressed the sheet button `button`, in the row `row` if it has one
 *   go      opened the sheet row `row`
 *   word    changed the lit word `word` to `value`
 *   ask     sent `text` from the text field
 *   stop    asked a piece of work to stop
 *   undo    took a send back inside its window
 *   done    a result finished being shown, or a send's window ran out
 */
export type NotchAnswerAct =
  | 'yes' | 'no' | 'fold' | 'pick' | 'button' | 'go' | 'word' | 'ask' | 'stop' | 'undo' | 'done';

/** Page to brain. */
export type NotchFromPage =
  /** The page is up and can draw. `v` is the protocol version it speaks. */
  | { type: 'hello'; v: number }
  | {
    type: 'answer'; id: string; act: NotchAnswerAct;
    option?: string; index?: number; button?: string; row?: string; word?: string; value?: string; text?: string;
    /**
     * With `done` on a send that carried blocks: this page drew what was
     * going out, and its end was on screen while the fuse burnt. Only ever
     * true. A page that knows nothing of blocks never says it.
     */
    seen?: boolean;
  }
  /** A click on the resting notch, or yes with nothing on it. */
  | { type: 'open' }
  /** Esc twice: stop everything that is running, and start nothing until told. */
  | { type: 'stop' }
  /**
   * A file is being dragged over the notch (`over`), was taken away again
   * (`left`), or was dropped and could not be handed to the brain (`lost`).
   * A file that was dropped and handed over arrives by itself, not as a
   * message: it is too large for one.
   */
  | { type: 'drag'; state: 'over' | 'left' | 'lost' }
  /**
   * The page's sign-in with the brain has ended (it lasts twelve hours at
   * most): what it asks of the brain itself, like taking a dropped file, is
   * refused from now on. The brain opens the page again, signed in anew.
   */
  | { type: 'signed-out' };

const ANSWER_ACTS: ReadonlySet<string> = new Set<NotchAnswerAct>([
  'yes', 'no', 'fold', 'pick', 'button', 'go', 'word', 'ask', 'stop', 'undo', 'done',
]);

const short = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length <= max ? value : undefined;

/**
 * Reads one message from the page. The page is the brain's own, but what
 * arrives has crossed two processes as text, so nothing about it is assumed:
 * anything that is not exactly one of its messages is null.
 */
export function parseNotchFromPage(raw: unknown): NotchFromPage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.type === 'open') return { type: 'open' };
  if (m.type === 'stop') return { type: 'stop' };
  if (m.type === 'signed-out') return { type: 'signed-out' };
  if (m.type === 'drag') return m.state === 'over' || m.state === 'left' || m.state === 'lost' ? { type: 'drag', state: m.state } : null;
  if (m.type === 'hello') {
    return typeof m.v === 'number' && Number.isInteger(m.v) && m.v > 0 ? { type: 'hello', v: m.v } : null;
  }
  if (m.type !== 'answer') return null;
  const id = short(m.id, 200);
  if (!id || typeof m.act !== 'string' || !ANSWER_ACTS.has(m.act)) return null;
  const answer: NotchFromPage = { type: 'answer', id, act: m.act as NotchAnswerAct };
  for (const key of ['option', 'button', 'row', 'word', 'value'] as const) {
    if (m[key] === undefined) continue;
    const text = short(m[key], 500);
    if (text === undefined) return null;
    answer[key] = text;
  }
  if (m.text !== undefined) {
    const text = short(m.text, 4000);
    if (text === undefined) return null;
    answer.text = text;
  }
  if (m.index !== undefined) {
    if (typeof m.index !== 'number' || !Number.isInteger(m.index) || m.index < 0 || m.index > 99) return null;
    answer.index = m.index;
  }
  // Only the word itself counts: anything else in its place is not a yes to "it was seen".
  if (m.seen === true) answer.seen = true;
  return answer;
}

type Raw = Record<string, unknown>;

const isRaw = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A field that was left out. One that is null was left out too: that is what a number that is not one becomes on the way. */
const absent = (value: unknown): value is undefined | null => value === undefined || value === null;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const oneOf = <T extends string>(all: readonly T[], value: unknown): T | undefined =>
  (typeof value === 'string' && (all as readonly string[]).includes(value) ? (value as T) : undefined);

/** Thrown while a message is read, when something it needs is not what it must be. It never leaves this file. */
class NotchUnread extends Error {}
const unread = (): never => { throw new NotchUnread(); };

const text = (value: unknown): string => (typeof value === 'string' ? value : unread());
const number = (value: unknown): number => (isNumber(value) ? value : unread());
const optText = (value: unknown): string | undefined => (absent(value) ? undefined : text(value));
const optFlag = (value: unknown): boolean | undefined => (absent(value) ? undefined : typeof value === 'boolean' ? value : unread());
const optNumber = (value: unknown): number | undefined => (absent(value) ? undefined : number(value));
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : unread());
const texts = (value: unknown): string[] => list(value).map(text);
/** Sets a field only when it was given, so that what is read is what was sent, and no more. */
const put = <T extends object, K extends keyof T>(into: T, key: K, value: T[K] | undefined): void => {
  if (value !== undefined) into[key] = value;
};

const WORD_READS = ['day', 'dayTime', 'sched', 'days', 'lead', 'where'] as const;
const PART_KEYS = ['yes', 'talk', 'esc', 'enter'] as const;
const FILE_ICONS = ['doc', 'image', 'audio', 'video', 'sheet'] as const;
const MAP_KINDS = ['me', 'person', 'tool', 'co', 'thing'] as const;
const BEADS = ['ok', 'ask', 'bad'] as const;
const MOUTHS = ['open', 'over', 'shut', 'gulp'] as const;
/** The longest name a line may have: an answer that names a longer one is not read by the brain. */
const LINE_ID_MAX = 200;

function readWord(value: unknown): NotchWord {
  const raw = isRaw(value) ? value : unread();
  const word: NotchWord = { name: text(raw.name), value: text(raw.value), options: texts(raw.options) };
  put(word, 'label', optText(raw.label));
  if (!absent(raw.read)) word.read = oneOf(WORD_READS, raw.read) ?? unread();
  if (!absent(raw.syn)) {
    const syn = isRaw(raw.syn) ? raw.syn : unread();
    word.syn = Object.fromEntries(Object.entries(syn).map(([option, ways]) => [option, texts(ways)]));
  }
  put(word, 'free', optFlag(raw.free));
  put(word, 'long', optFlag(raw.long));
  return word;
}

function readPart(value: unknown): NotchPart {
  if (typeof value === 'string') return value;
  const raw = isRaw(value) ? value : unread();
  if ('em' in raw) return { em: text(raw.em) };
  if ('key' in raw) return { key: oneOf(PART_KEYS, raw.key) ?? unread() };
  if ('word' in raw) return { word: readWord(raw.word) };
  return unread();
}
const readParts = (value: unknown): NotchPart[] => list(value).map(readPart);

function readButton(value: unknown): NotchButton {
  const raw = isRaw(value) ? value : unread();
  const button: NotchButton = { id: text(raw.id), label: text(raw.label) };
  put(button, 'key', optNumber(raw.key));
  put(button, 'quiet', optFlag(raw.quiet));
  return button;
}

/**
 * The map is drawn from what is found as it is found, and takes what it can
 * of what it is given: a thing with no name is left out, a place off the
 * field is brought into it, and a kind nobody knows is a thing.
 */
function readMap(raw: Raw): Extract<NotchBlock, { kind: 'map' }> {
  const within = (value: unknown, most: number): number => (isNumber(value) ? Math.max(0, Math.min(most, value)) : 0);
  const each = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const nodes: NotchMapNode[] = [];
  for (const node of each(raw.nodes)) {
    if (!isRaw(node) || typeof node.id !== 'string' || typeof node.label !== 'string') continue;
    nodes.push({ id: node.id, label: node.label, x: within(node.x, 444), y: within(node.y, 204), kind: oneOf(MAP_KINDS, node.kind) ?? 'thing' });
  }
  const links: [string, string][] = [];
  for (const pair of each(raw.links)) {
    if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') links.push([pair[0], pair[1]]);
  }
  const sources: NotchMapSource[] = [];
  for (const source of each(raw.sources)) {
    if (!isRaw(source) || typeof source.name !== 'string') continue;
    const read: NotchMapSource = { name: source.name };
    if (typeof source.found === 'string') read.found = source.found;
    put(read, 'state', oneOf(['on', 'done'] as const, source.state));
    sources.push(read);
  }
  const map: Extract<NotchBlock, { kind: 'map' }> = { kind: 'map', nodes, links, sources };
  if (Array.isArray(raw.tour)) map.tour = raw.tour.filter((id): id is string => typeof id === 'string');
  return map;
}

function readBlock(value: unknown): NotchBlock {
  const raw = isRaw(value) ? value : unread();
  if (raw.kind === 'row') {
    const row: Extract<NotchBlock, { kind: 'row' }> = { kind: 'row', say: readParts(raw.say) };
    put(row, 'id', optText(raw.id));
    put(row, 'lead', optText(raw.lead));
    put(row, 'tail', optText(raw.tail));
    put(row, 'small', optText(raw.small));
    if (!absent(raw.buttons)) row.buttons = list(raw.buttons).map(readButton);
    put(row, 'go', optFlag(raw.go));
    put(row, 'gone', optFlag(raw.gone));
    // The dots only tell how the last runs went: one that is not a dot is left out, and the row stands.
    if (Array.isArray(raw.beads)) row.beads = raw.beads.filter((bead): bead is NotchBead => oneOf(BEADS, bead) !== undefined);
    return row;
  }
  if (raw.kind === 'paper') {
    const paper: Extract<NotchBlock, { kind: 'paper' }> = { kind: 'paper', lines: list(raw.lines).map(readParts) };
    if (!absent(raw.to)) paper.to = readParts(raw.to);
    put(paper, 'numbered', optFlag(raw.numbered));
    if (!absent(raw.file)) {
      const file = isRaw(raw.file) ? raw.file : unread();
      paper.file = { name: text(file.name), size: text(file.size) };
    }
    return paper;
  }
  if (raw.kind === 'note') return { kind: 'note', say: readParts(raw.say) };
  if (raw.kind === 'buttons') return { kind: 'buttons', buttons: list(raw.buttons).map(readButton) };
  if (raw.kind === 'file') return { kind: 'file', icon: oneOf(FILE_ICONS, raw.icon) ?? unread(), name: text(raw.name), meta: text(raw.meta) };
  if (raw.kind === 'map') return readMap(raw);
  return unread();
}
const readBlocks = (value: unknown): NotchBlock[] => list(value).map(readBlock);

function readLine(value: unknown): NotchLine {
  const raw = isRaw(value) ? value : unread();
  const id = text(raw.id);
  if (!id || id.length > LINE_ID_MAX) unread();
  const say = readParts(raw.say);
  let line: NotchLine;
  if (raw.kind === 'say' || raw.kind === 'send') {
    const timed: NotchSayLine | NotchSendLine = { id, kind: raw.kind, say, ms: number(raw.ms) };
    put(timed, 'left', optNumber(raw.left));
    // What goes out under the fuse is read as strictly as a sheet: a paper that cannot be read is no fuse at all.
    if (timed.kind === 'send' && !absent(raw.blocks)) timed.blocks = readBlocks(raw.blocks);
    line = timed;
  } else if (raw.kind === 'offer') {
    line = { id, kind: 'offer', say };
    put(line, 'yes', optText(raw.yes));
    if (!absent(raw.options)) line.options = texts(raw.options);
    put(line, 'fold', optNumber(raw.fold));
    if (!absent(raw.keys)) line.keys = oneOf(['esc', 'talk'] as const, raw.keys) ?? unread();
  } else if (raw.kind === 'sheet') {
    line = { id, kind: 'sheet', say, blocks: readBlocks(raw.blocks) };
    put(line, 'yes', optText(raw.yes));
    put(line, 'stay', optFlag(raw.stay));
    put(line, 'no', optText(raw.no));
    put(line, 'whole', optFlag(raw.whole));
  } else if (raw.kind === 'ask') {
    line = { id, kind: 'ask', say, placeholder: text(raw.placeholder), yes: text(raw.yes), blocks: readBlocks(raw.blocks) };
    put(line, 'focus', optFlag(raw.focus));
    put(line, 'stay', optFlag(raw.stay));
  } else if (raw.kind === 'work') {
    line = { id, kind: 'work', say, steps: number(raw.steps), done: number(raw.done) };
    put(line, 'canTalk', optFlag(raw.canTalk));
    put(line, 'asks', optFlag(raw.asks));
  } else if (raw.kind === 'listen') {
    line = { id, kind: 'listen', say, heard: text(raw.heard) };
    put(line, 'over', optFlag(raw.over));
  } else {
    return unread();
  }
  // What only dresses a line is left out when it is not known, and the line is still said.
  put(line, 'mood', oneOf(NOTCH_MOODS, raw.mood));
  put(line, 'mark', oneOf(['check', 'fail'] as const, raw.mark));
  if (typeof raw.who === 'string') line.who = raw.who;
  put(line, 'src', oneOf(NOTCH_APPS, raw.src));
  put(line, 'arrive', oneOf(NOTCH_ARRIVALS, raw.arrive));
  if (typeof raw.step === 'string') line.step = raw.step;
  // Not this one: it is what keeps a yes that was on its way to something else from landing here.
  put(line, 'unasked', optFlag(raw.unasked));
  return line;
}

/**
 * A message as the page reads it. Three things can come of it:
 *   - a message. With `lineLost`, a `state` whose line could not be read: the
 *     rest of it stands (how many wait, the face, the app in front) and its
 *     line is null, so that a page which comes up is not left with nothing.
 *   - `unknown`: well formed, and of a kind this page has never heard of (a
 *     `type` it does not have, a face it cannot make). A brain newer than the
 *     page says such things. They are passed over without a word.
 *   - `malformed`: it says it is something the page knows, and is not.
 */
export type NotchRead =
  | { message: NotchToPage; lineLost?: true }
  | { message: null; why: 'unknown' | 'malformed' };

function readToPage(m: Raw): NotchRead {
  if (typeof m.type !== 'string') return unread();
  if (m.type === 'rest') return { message: { type: 'rest' } };
  if (m.type === 'show') return { message: { type: 'show', line: readLine(m.line) } };
  if (m.type === 'count') return { message: { type: 'count', count: number(m.count) } };
  if (m.type === 'face') {
    const mood = oneOf(NOTCH_MOODS, text(m.mood));
    return mood ? { message: { type: 'face', mood } } : { message: null, why: 'unknown' };
  }
  if (m.type === 'where') return { message: { type: 'where', app: notchWhereApp(m.app) } };
  if (m.type === 'state') {
    const state: Extract<NotchToPage, { type: 'state' }> = { type: 'state', line: null, count: number(m.count) };
    let lineLost = false;
    if (!absent(m.line)) {
      try { state.line = readLine(m.line); } catch (error) {
        if (!(error instanceof NotchUnread)) throw error;
        lineLost = true;
      }
    }
    put(state, 'born', oneOf(NOTCH_BIRTHS, m.born));
    put(state, 'face', oneOf(NOTCH_MOODS, m.face));
    if (m.where !== undefined) state.where = notchWhereApp(m.where);
    put(state, 'eye', optFlag(m.eye));
    put(state, 'sound', optFlag(m.sound));
    return lineLost ? { message: state, lineLost: true } : { message: state };
  }
  if (m.type === 'update') {
    const id = text(m.id);
    if (!id || id.length > LINE_ID_MAX) unread();
    const update: Extract<NotchToPage, { type: 'update' }> = { type: 'update', id };
    put(update, 'done', optNumber(m.done));
    if (!absent(m.say)) update.say = readParts(m.say);
    put(update, 'heard', optText(m.heard));
    put(update, 'over', optFlag(m.over));
    if (!absent(m.blocks)) update.blocks = readBlocks(m.blocks);
    return { message: update };
  }
  if (m.type === 'act') {
    // A movement is never worth losing the others for: one that is not known is left out.
    const act: Extract<NotchToPage, { type: 'act' }> = { type: 'act' };
    put(act, 'mood', oneOf(NOTCH_MOODS, m.mood));
    put(act, 'gesture', oneOf(NOTCH_GESTURES, m.gesture));
    put(act, 'lip', oneOf(NOTCH_LIPS, m.lip));
    put(act, 'birth', oneOf(NOTCH_BIRTHS, m.birth));
    if (isNumber(m.aim)) act.aim = m.aim;
    put(act, 'body', oneOf(NOTCH_BODIES, m.body));
    if (isNumber(m.kick)) act.kick = m.kick;
    put(act, 'edge', oneOf(NOTCH_EDGES, m.edge));
    put(act, 'side', oneOf(['left', 'right'] as const, m.side));
    if (typeof m.eye === 'boolean') act.eye = m.eye;
    put(act, 'mouth', oneOf(MOUTHS, m.mouth));
    if (isNumber(m.park)) act.park = m.park;
    if (typeof m.sound === 'boolean') act.sound = m.sound;
    return { message: act };
  }
  return { message: null, why: 'unknown' };
}

/**
 * Reads one message from the brain, for the page. The counterpart of
 * `parseNotchFromPage`: what arrives has crossed two processes as text, and
 * the page must be able to draw whatever it lets in. So a message is read
 * whole before anything on the notch changes, and one that is not exactly a
 * message (a line with no id, a sheet with no blocks, a part of a sentence
 * that is not one) is not let in: the notch stays as it was.
 *
 * Two things are taken more lightly, as the page always took them. What only
 * dresses a line or moves the notch (a mood, a mark, an app, a way of
 * arriving, the movements of `act`) is left out when it is not known, and the
 * rest stands. And the map takes what it can of what it is given.
 *
 * A message that is read is a new object with nothing in it but what a
 * message has. See `NotchRead` for what else can come of it.
 */
export function readNotchToPage(raw: unknown): NotchRead {
  if (!isRaw(raw)) return { message: null, why: 'malformed' };
  try {
    return readToPage(raw);
  } catch (error) {
    if (error instanceof NotchUnread) return { message: null, why: 'malformed' };
    throw error;
  }
}

/** The same, for whoever only asks whether it is a message, whole: that message, or null. */
export function parseNotchToPage(raw: unknown): NotchToPage | null {
  const read = readNotchToPage(raw);
  return read.message && !read.lineLost ? read.message : null;
}
