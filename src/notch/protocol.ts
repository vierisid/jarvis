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
}

export const NOTCH_MOODS = [
  'idle', 'look', 'listen', 'read', 'write', 'think', 'recall', 'search', 'work', 'happy', 'proud',
  'urgent', 'careful', 'curious', 'confused', 'worried', 'sorry', 'surprised', 'sleepy', 'closed',
  'focus', 'away', 'track',
] as const;
export type NotchMood = (typeof NOTCH_MOODS)[number];

export const NOTCH_GESTURES = [
  'blink', 'sq', 'wink', 'peek-l', 'peek-r', 'pop', 'nodg', 'shake', 'hop', 'wake', 'doze', 'shrug',
] as const;
export type NotchGesture = (typeof NOTCH_GESTURES)[number];

/** One-shot movements of the notch's lower edge. */
export const NOTCH_LIPS = ['ripple', 'shiver', 'laugh', 'gasp', 'zip', 'yawn', 'reach'] as const;
export type NotchLip = (typeof NOTCH_LIPS)[number];

/** The ways the notch can first appear. */
export const NOTCH_BIRTHS = ['run', 'meet', 'trace', 'bead', 'eye', 'gather'] as const;
export type NotchBirth = (typeof NOTCH_BIRTHS)[number];

/** How a line comes in along the top edge of the screen before it is said. */
export type NotchArrival = 'left' | 'right' | 'urgent' | 'hop';

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
}

/** A result. Nothing is asked; it leaves by itself after `ms`. */
export interface NotchSayLine extends NotchLineBase {
  kind: 'say';
  ms: number;
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
}

/**
 * Something going out, with a window to take it back. A fuse burns along the
 * notch's edge for `ms`. Esc inside the window is "undo"; when it burns out
 * the page answers "done".
 */
export interface NotchSendLine extends NotchLineBase {
  kind: 'send';
  ms: number;
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
  | { kind: 'row'; id?: string; lead?: string; say: NotchPart[]; tail?: string; small?: string; buttons?: NotchButton[]; go?: boolean }
  /** A white sheet of paper: a draft, an answer, a list. */
  | { kind: 'paper'; to?: NotchPart[]; lines: NotchPart[][]; numbered?: boolean; file?: { name: string; size: string } }
  /** A quiet line of explanation. */
  | { kind: 'note'; say: NotchPart[] }
  | { kind: 'buttons'; buttons: NotchButton[] }
  /** A file that was handed over. */
  | { kind: 'file'; icon: 'doc' | 'image' | 'audio' | 'video' | 'sheet'; name: string; meta: string };

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

/** Brain to page. */
export type NotchToPage =
  /** The answer to hello: everything the notch should be showing, at once. */
  | { type: 'state'; line: NotchLine | null; count: number; born?: NotchBirth; face?: NotchMood; where?: NotchWhereApp | null }
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
  }
  /** A click on the resting notch, or yes with nothing on it. */
  | { type: 'open' }
  /** Esc twice: stop everything that is running, and start nothing until told. */
  | { type: 'stop' };

const ANSWER_ACTS: ReadonlySet<string> = new Set<NotchAnswerAct>([
  'yes', 'no', 'fold', 'pick', 'button', 'go', 'word', 'ask', 'stop', 'undo', 'done',
]);

const short = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length <= max ? value : undefined;

/**
 * Reads one message from the page. The page is the brain's own, but what
 * arrives has crossed two processes as text, so nothing about it is assumed:
 * anything that is not exactly one of its four messages is null.
 */
export function parseNotchFromPage(raw: unknown): NotchFromPage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.type === 'open') return { type: 'open' };
  if (m.type === 'stop') return { type: 'stop' };
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
  return answer;
}
