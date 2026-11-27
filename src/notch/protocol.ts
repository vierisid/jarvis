/**
 * The messages between the brain and the notch's page, version 2.
 *
 * The brain says what the notch shows, as data. The page draws it, and says
 * back what the person did. The page decides nothing: it never knows what a
 * yes means, only that it was given. It measures what only it can see (when a
 * line was drawn, a hand on it, the end of a sheet) and reports it.
 * Everything here is plain JSON, because it travels through the desktop app
 * as text (docs/notch/README.md).
 *
 * Only one thing is on the notch at a time. A new line replaces whatever is
 * there.
 *
 * What version 2 is, against version 1:
 *   - What the notch IS (`state`, whole; `patch`, a change to it) and what it
 *     DOES once (`effect`) are different messages. Version 1's `act` carried
 *     both, and what was kept could be lost like a movement.
 *   - Each of those three has a number, one row of numbers for each page. A
 *     page that misses one sees the gap and asks for the whole again.
 *   - An answer has a number too. The brain says `ack` to each, the page
 *     sends it again until it does, and the brain takes a number once.
 *   - The rules of a line are written into it by the brain (`after`, `away`,
 *     `asking`, `gate`, and an offer's `fold`): the page keeps none of its own.
 *   - The brain folds an offer that was left alone. The page says when a hand
 *     is on it (`hand`).
 *   - Both sides say their version, and a page of another version is refused.
 */
export const NOTCH_PROTOCOL_VERSION = 2;
/**
 * The first version whose page loads itself again when it is refused. A page
 * older than this cannot, and the brain opens it again itself.
 */
export const NOTCH_PAGE_RELOADS_SINCE = 2;

/** How long the page waits for the brain's `ack` before it sends an answer again, and how often it sends one in all. */
export const NOTCH_ANSWER_AGAIN_MS = 1000;
export const NOTCH_ANSWER_SENDS = 4;
/** The most answers the page keeps for sending again. One more, and the oldest is given up. */
export const NOTCH_ANSWERS_WAITING_MAX = 16;
/** How many of a page's answers the brain remembers the numbers of. A number older than all of them was taken long ago. */
export const NOTCH_ANSWERS_KEPT = 128;
/** How often a page says again that a hand is on the line, and for how long the brain believes it was told so. */
export const NOTCH_HAND_AGAIN_MS = 2000;
export const NOTCH_HAND_HOLDS_MS = 5000;
/**
 * How often a page says which message it last read, so that the brain can
 * tell one that fell behind (a lost rest or fold leaves no gap to see): this
 * often while a line is up, and NOTCH_AT_RESTING_MS at rest, which is what
 * finds a brain that was started again under a resting page, and a lost line.
 */
export const NOTCH_AT_EVERY_MS = 5000;
export const NOTCH_AT_RESTING_MS = 60_000;
/**
 * For how long after the brain folded an offer an answer the person gave it
 * while it was up is still taken in place of the fold: one that was on its
 * way, or lost once and sent again (NOTCH_ANSWER_AGAIN_MS). The script that
 * waits on the offer hears the fold this much later.
 */
export const NOTCH_FOLD_GRACE_MS = 1500;
/**
 * The page's claim on Esc is a lease: it says `__notch_esc(true)` again this
 * often for as long as it wants Esc, and `false` once when it stops. A claim
 * that was not said again for NOTCH_ESC_LEASE_MS (three sayings) is one the
 * desktop app need not honour. See "The lease on Esc" in docs/notch/README.md
 * for what the desktop app does with it today.
 */
export const NOTCH_ESC_RENEW_MS = 2000;
export const NOTCH_ESC_LEASE_MS = 6000;
/** After how long an offer that was left alone is folded when it does not say: a line, and a row of choices. */
export const NOTCH_FOLD_MS = 9000;
export const NOTCH_FOLD_CHOICES_MS = 14000;
/** How long after a hand was found on an offer that is due to fold the brain looks again. */
export const NOTCH_FOLD_HELD_MS = 2000;
/**
 * The moments a line takes no answer in, counted by the page from when it
 * drew the line, as the brain writes them into a line's `gate`: no yes from
 * the keys on any line, no yes, pick or Esc on a line that came by itself,
 * and how long the end of a sheet marked `whole` must have been on screen.
 */
export const NOTCH_GATE_MS = { dead: 350, unasked: 700, whole: 600 } as const;

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
  /**
   * The rules of the line, written by the brain as it tells the line to a
   * page (`notchRuled`): nothing that shows a line sets them, and whatever it
   * set is written over. The page reads a line without them as wrong.
   *
   * `after` says what an answer does to the line on the page that gave it:
   * `rest` (it goes; the brain takes the line off every other page too),
   * `hold` (it stays, dimmed, until the brain says what next). An answer that
   * is not named leaves the line as it is.
   */
  after?: NotchAfters;
  /** What a press somewhere else on the screen is: a no, or nothing. */
  away?: 'no' | 'none';
  /** It waits for the person: the window is not to hide behind a fullscreen video while it is up. */
  asking?: boolean;
  gate?: NotchGate;
  /**
   * The brain has taken an answer that holds this line (a yes, a pick, a
   * `done` or an undo on a fuse): a page that is told it draws it answered,
   * dimmed, and takes nothing more on it. A fuse that is held burns nothing
   * and offers no undo: it was decided. Written by the brain as it tells the
   * line, like the rules.
   */
  held?: boolean;
}

/** What an answer does to its line. */
export type NotchAfter = 'rest' | 'hold';
export type NotchAfters = Partial<Record<NotchAnswerAct, NotchAfter>>;

/**
 * For how many ms after it is drawn a line takes no yes from the keys
 * (`dead`), and no yes, pick or Esc at all (`esc`). `whole`: for how long the
 * end of the sheet must have been on screen before its yes is one; not given
 * when the sheet need not be seen whole.
 */
export interface NotchGate { dead: number; esc: number; whole?: number }

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
 * unanswered (NOTCH_FOLD_MS for a line and NOTCH_FOLD_CHOICES_MS for choices
 * when not given; 0 stays). The brain folds it: the page only says when a
 * hand is on it. Told to a page, `fold` is always given.
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

/** The mouth that takes a file: open, open wide with the file over it, or shut. Kept by the brain. */
export const NOTCH_MOUTHS = ['open', 'over', 'shut'] as const;
export type NotchMouth = (typeof NOTCH_MOUTHS)[number];

/**
 * A change to the line on screen, in place: steps done, a new sentence,
 * words heard, or a sheet's content after one of its buttons was pressed.
 * `away` comes with it when the new content changes what a press elsewhere is.
 */
export interface NotchEdit { id: string; done?: number; say?: NotchPart[]; heard?: string; over?: boolean; blocks?: NotchBlock[]; away?: 'no' | 'none' }

/** What the notch is, apart from its line. Each is kept by the brain, and a page that comes back has it. */
export interface NotchKept {
  /** How many things wait. Shown beside the eyes at rest. */
  count?: number;
  /**
   * The face the notch has at rest, until told otherwise: `closed` while
   * everything is stopped. Unlike a mood given with an `effect`, the brain
   * keeps it, so a page that comes back has the same face.
   */
  face?: NotchMood;
  /**
   * The app in front, for the icon beside the resting eyes. Null: none is
   * shown (nothing is in front, or the notch is not watching it).
   */
  where?: NotchWhereApp | null;
  /** The watching eye: the left eye turns round and citron. */
  eye?: boolean;
  /** Sounds on or off. They start off. */
  sound?: boolean;
  /** How many small bumps wait on the screen's top edge beside the notch. */
  park?: number;
  mouth?: NotchMouth;
}

/**
 * Something the notch does once with its face or body, without saying
 * anything. It is not kept: a page that was not there when it was done never
 * does it.
 */
export interface NotchEffect {
  /** A look in passing. The face the notch rests with is `face`, which is kept. */
  mood?: NotchMood;
  gesture?: NotchGesture;
  lip?: NotchLip;
  birth?: NotchBirth;
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
  /** The gulp after a file was dropped into the mouth. The mouth itself is shut by a `patch`. */
  gulp?: true;
}

/**
 * Brain to page.
 *
 * `state`, `patch` and `effect` carry `seq`: a number that goes up by one
 * with every such message to that page, for as long as the brain runs. A
 * page that reads one whose number is not the next has missed something, and
 * asks for the whole again (hello). One whose number it has already read is
 * a copy, and is passed over.
 */
export type NotchToPage =
  /**
   * Everything the notch is, at once: the answer to hello, and to a page that
   * says it fell behind. `v` is the version the brain speaks, and `brain`
   * names this run of it: after another run's `state` nothing the page holds
   * from before stands (the numbers start again, and a line of the same name
   * is another line).
   */
  | ({ type: 'state'; v: number; brain: string; seq: number; line: NotchLine | null; count: number; born?: NotchBirth } & Omit<NotchKept, 'count'>)
  /**
   * A change to what the notch is. `line`: a line is put on the notch in
   * place of whatever is there, and null is back to the eyes. `edit` changes
   * the line that is up, in place. The rest as in `state`. Only what is named
   * changes.
   */
  | ({ type: 'patch'; seq: number; line?: NotchLine | null; edit?: NotchEdit } & NotchKept)
  | ({ type: 'effect'; seq: number } & NotchEffect)
  /**
   * The brain has the answer numbered `n`. `took`: it was about the line on
   * the notch and was taken (now, or when it first came). Not `took`: it came
   * for a line that is no longer there. Either way the page stops sending it.
   * `unread`: it was a value typed into a lit word (`text`), and the brain
   * could not read it. The word keeps its value; the page says it was not
   * read and keeps the field. A page that knows nothing of it passes it over.
   */
  | { type: 'ack'; n: number; took: boolean; unread?: true }
  /**
   * The brain does not count this page as one that listens, and takes no
   * answer from it. `v` is the version the brain speaks: a page of another
   * version loads itself again once (the brain serves the page, so that
   * brings the one that fits), and a page of that version says hello.
   */
  | { type: 'refuse'; v: number };

/**
 * What the person did with the line named `id`:
 *   yes     agreed to an offer, a sheet's action, or "got it" on a result
 *   no      turned it down: Esc, "not now", or a click away from it
 *   fold    left it unanswered until it went away by itself. The brain says
 *           this to itself when the offer's time is up; the page does not
 *   pick    chose `option` (position `index`) of the choices
 *   button  pressed the sheet button `button`, in the row `row` if it has one
 *   go      opened the sheet row `row`
 *   word    changed the lit word `word` to `value`, one of its options; or typed
 *           `text` into it, which the brain reads (./words.ts) and answers
 *           with the value it read, or with `unread` on the `ack`
 *   ask     sent `text` from the text field
 *   stop    asked a piece of work to stop
 *   undo    took a send back inside its window
 *   done    a result finished being shown, or a send's window ran out
 */
export type NotchAnswerAct =
  | 'yes' | 'no' | 'fold' | 'pick' | 'button' | 'go' | 'word' | 'ask' | 'stop' | 'undo' | 'done';

/** Page to brain. */
export type NotchFromPage =
  /**
   * The page is up and can draw. `v` is the protocol version it speaks, and
   * `page` names this loading of it: the numbers of its answers start again
   * with every loading, and the brain tells them apart by it.
   */
  | { type: 'hello'; v: number; page?: string }
  | {
    type: 'answer'; id: string; act: NotchAnswerAct;
    /**
     * The number of this answer, from 1 up for as long as the page is loaded.
     * The same answer sent again has the same number, and the brain takes a
     * number once. An answer without one is not acknowledged and cannot be
     * told from another like it: the page always gives one.
     */
    n?: number;
    option?: string; index?: number; button?: string; row?: string; word?: string; value?: string; text?: string;
    /**
     * With `done` on a send that carried blocks: this page drew what was
     * going out, and its end was on screen while the fuse burnt. Only ever
     * true. A page that knows nothing of blocks never says it.
     */
    seen?: boolean;
    /** How many ms after the page drew the line the answer was given. */
    since?: number;
    /**
     * The run of the brain whose line this answers, as its `state` named it.
     * The brain takes no answer meant for another run: line names repeat from
     * one run to the next. The page always says it; one without it is taken
     * as it comes.
     */
    brain?: string;
  }
  /**
   * A hand is on the line `id`, or no longer: the pointer is on the notch, a
   * field in it is being typed in, or a word's choices are open. Said when it
   * changes, and again every NOTCH_HAND_AGAIN_MS while one is. The brain does
   * not fold an offer under a hand.
   */
  | { type: 'hand'; id: string; on: boolean }
  /**
   * The number of the last `state`, `patch` or `effect` this page read. Said
   * every NOTCH_AT_EVERY_MS for as long as the page is up and has been told
   * the whole once, and when an answer came too late. If the brain has sent more than that, something was lost on the
   * way, and it tells the whole again.
   */
  | { type: 'at'; seq: number }
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
/** A whole number from `least` up that a counter can hold. */
const whole = (value: unknown, least: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= least;
/** The longest name a page or a run of the brain may have. */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

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
    if (typeof m.v !== 'number' || !Number.isInteger(m.v) || m.v <= 0) return null;
    if (m.page === undefined) return { type: 'hello', v: m.v };
    return typeof m.page === 'string' && NAME.test(m.page) ? { type: 'hello', v: m.v, page: m.page } : null;
  }
  if (m.type === 'hand') {
    const line = short(m.id, 200);
    return line && typeof m.on === 'boolean' ? { type: 'hand', id: line, on: m.on } : null;
  }
  if (m.type === 'at') return whole(m.seq, 0) ? { type: 'at', seq: m.seq } : null;
  if (m.type !== 'answer') return null;
  const id = short(m.id, 200);
  if (!id || typeof m.act !== 'string' || !ANSWER_ACTS.has(m.act)) return null;
  const answer: Extract<NotchFromPage, { type: 'answer' }> = { type: 'answer', id, act: m.act as NotchAnswerAct };
  if (m.n !== undefined) {
    if (!whole(m.n, 1)) return null;
    answer.n = m.n;
  }
  if (m.since !== undefined) {
    if (!whole(m.since, 0)) return null;
    answer.since = m.since;
  }
  if (m.brain !== undefined) {
    if (typeof m.brain !== 'string' || !NAME.test(m.brain)) return null;
    answer.brain = m.brain;
  }
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

/**
 * The rules of a line, as the brain writes them into it. They follow from
 * what the line is, and from nothing else: this is the one place that says
 * what an answer does to a line, what a press elsewhere is, which lines wait
 * for the person, and for how long a line takes no answer. The brain reads
 * the same rules when an answer comes (`notchAfter`).
 */
/**
 * A no and a fold take any line off the notch, whatever it is: so the brain always took them, and so it still
 * does. (A page says no only to a line that has one, and the fold is the brain's own.)
 */
const GONE: NotchAfters = { no: 'rest', fold: 'rest' };

export function notchRules(line: NotchLine): { after: NotchAfters; away: 'no' | 'none'; asking: boolean; gate: NotchGate; fold?: number } {
  const unasked = line.unasked === true;
  const gate: NotchGate = { dead: unasked ? NOTCH_GATE_MS.unasked : NOTCH_GATE_MS.dead, esc: unasked ? NOTCH_GATE_MS.unasked : 0 };
  switch (line.kind) {
    case 'say':
      // "Got it", Esc, or its time: it has been seen, and goes.
      return { after: { ...GONE, yes: 'rest', done: 'rest' }, away: 'none', asking: false, gate };
    case 'offer': {
      const fold = Math.max(0, line.fold ?? (line.options?.length ? NOTCH_FOLD_CHOICES_MS : NOTCH_FOLD_MS));
      const after: NotchAfters = line.options?.length ? { ...GONE, pick: 'hold' }
        // Only Esc is shown: a yes is told and nothing more. The brain says what it says to that, on this same line.
        : line.keys === 'esc' ? { ...GONE }
        : { ...GONE, yes: 'hold' };
      return { after, away: 'none', asking: true, gate, fold };
    }
    case 'sheet': {
      if (line.whole) gate.whole = NOTCH_GATE_MS.whole;
      // A sheet that asks for a decision is not answered by a click meant for another app: one that stays,
      // and one with a yes.
      return { after: line.yes ? { ...GONE, yes: 'hold' } : { ...GONE }, away: line.stay || line.yes ? 'none' : 'no', asking: line.stay === true && !!line.yes, gate };
    }
    case 'ask':
      // Nor is a question about a file that was dropped, nor a field that says it stays.
      return { after: { ...GONE, ask: 'hold' }, away: line.stay || line.blocks.some((block) => block.kind === 'file') ? 'none' : 'no', asking: true, gate };
    case 'work':
      return { after: { ...GONE, stop: 'hold' }, away: 'none', asking: line.asks === true, gate };
    case 'send':
      // A letter under its fuse waits for the person as a question does. Only Esc takes it back.
      return { after: { ...GONE, undo: 'hold', done: 'hold' }, away: 'none', asking: !!line.blocks?.length, gate };
    case 'listen':
      return { after: { ...GONE }, away: 'none', asking: false, gate };
  }
}

/** The line with its rules written into it: what a page is told. */
export function notchRuled<T extends NotchLine>(line: T): T {
  return { ...line, ...notchRules(line) };
}

/** What the answer `act` does to `line`: it goes, it is held, or (undefined) it stays as it is. */
export function notchAfter(line: NotchLine, act: NotchAnswerAct): NotchAfter | undefined {
  return notchRules(line).after[act];
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

/** A line's rules are read as strictly as the line: a page that has no rule of its own cannot guess one. */
function readRules(line: NotchLine, raw: Raw): void {
  const after = isRaw(raw.after) ? raw.after : unread();
  line.after = {};
  for (const [act, what] of Object.entries(after)) {
    if (!ANSWER_ACTS.has(act)) continue;
    line.after[act as NotchAnswerAct] = oneOf(['rest', 'hold'] as const, what) ?? unread();
  }
  line.away = oneOf(['no', 'none'] as const, raw.away) ?? unread();
  line.asking = typeof raw.asking === 'boolean' ? raw.asking : unread();
  const gate = isRaw(raw.gate) ? raw.gate : unread();
  line.gate = { dead: atLeastZero(gate.dead), esc: atLeastZero(gate.esc) };
  if (!absent(gate.whole)) line.gate.whole = atLeastZero(gate.whole);
  if (raw.held === true) line.held = true;
  else if (!absent(raw.held) && raw.held !== false) unread();
}
const atLeastZero = (value: unknown): number => (isNumber(value) && value >= 0 ? value : unread());

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
    // When it folds is the brain's to say, and it always says.
    line = { id, kind: 'offer', say, fold: atLeastZero(raw.fold) };
    put(line, 'yes', optText(raw.yes));
    if (!absent(raw.options)) line.options = texts(raw.options);
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
  put(line, 'unasked', optFlag(raw.unasked));
  // Not these: they are what keeps a yes that was on its way to something else from landing here, and what
  // says which answer ends the line.
  readRules(line, raw);
  return line;
}

function readEdit(value: unknown): NotchEdit {
  const raw = isRaw(value) ? value : unread();
  const id = text(raw.id);
  if (!id || id.length > LINE_ID_MAX) unread();
  const edit: NotchEdit = { id };
  put(edit, 'done', optNumber(raw.done));
  if (!absent(raw.say)) edit.say = readParts(raw.say);
  put(edit, 'heard', optText(raw.heard));
  put(edit, 'over', optFlag(raw.over));
  if (!absent(raw.blocks)) edit.blocks = readBlocks(raw.blocks);
  if (!absent(raw.away)) edit.away = oneOf(['no', 'none'] as const, raw.away) ?? unread();
  return edit;
}

/** What the notch is apart from its line, as a `state` or a `patch` says it. What is not known of it is left out. */
function readKept(into: NotchKept, m: Raw): void {
  put(into, 'face', oneOf(NOTCH_MOODS, m.face));
  if (m.where !== undefined) into.where = notchWhereApp(m.where);
  put(into, 'eye', optFlag(m.eye));
  put(into, 'sound', optFlag(m.sound));
  if (isNumber(m.park)) into.park = Math.max(0, Math.floor(m.park));
  put(into, 'mouth', oneOf(NOTCH_MOUTHS, m.mouth));
}

/**
 * A message as the page reads it. Four things can come of it:
 *   - a message. With `lineLost`, a `state` whose line could not be read: the
 *     rest of it stands (how many wait, the face, the app in front) and its
 *     line is null, so that a page which comes up is not left with nothing.
 *   - `unknown`: well formed, and of a kind this page has never heard of (a
 *     `type` it does not have). A brain newer than the page says such things.
 *     They are passed over without a word. `seq`, when it carried a number:
 *     the page counts it as read, so that the next message is not a gap.
 *   - `malformed`: it says it is something the page knows, and is not. `seq`
 *     as for `unknown`: wrong as it is, it was the next in the row.
 *   - `version`: a `state` from a brain that speaks version `v`, which is
 *     not this page's (a brain of version 1 says no version at all). Nothing
 *     of it is read.
 */
export type NotchRead =
  | { message: NotchToPage; lineLost?: true }
  | { message: null; why: 'unknown'; seq?: number }
  | { message: null; why: 'malformed'; seq?: number }
  | { message: null; why: 'version'; v: number };

const seqOf = (value: unknown): number => (whole(value, 0) ? value : unread());

function readToPage(m: Raw): NotchRead {
  if (typeof m.type !== 'string') return unread();
  if (m.type === 'state') {
    // Before anything else of it: a state of another version is not this page's to read.
    const v = absent(m.v) ? 1 : whole(m.v, 1) ? m.v : unread();
    if (v !== NOTCH_PROTOCOL_VERSION) return { message: null, why: 'version', v };
    const brain = text(m.brain);
    if (!NAME.test(brain)) unread();
    const state: Extract<NotchToPage, { type: 'state' }> = { type: 'state', v, brain, seq: seqOf(m.seq), line: null, count: number(m.count) };
    let lineLost = false;
    if (!absent(m.line)) {
      try { state.line = readLine(m.line); } catch (error) {
        if (!(error instanceof NotchUnread)) throw error;
        lineLost = true;
      }
    }
    put(state, 'born', oneOf(NOTCH_BIRTHS, m.born));
    readKept(state, m);
    return lineLost ? { message: state, lineLost: true } : { message: state };
  }
  if (m.type === 'patch') {
    const patch: Extract<NotchToPage, { type: 'patch' }> = { type: 'patch', seq: seqOf(m.seq) };
    // Null is a thing a patch says of its line (back to the eyes), so here it is not "left out".
    if (m.line === null) patch.line = null;
    else if (m.line !== undefined) patch.line = readLine(m.line);
    if (!absent(m.edit)) patch.edit = readEdit(m.edit);
    put(patch, 'count', optNumber(m.count));
    readKept(patch, m);
    return { message: patch };
  }
  if (m.type === 'effect') {
    // A movement is never worth losing the others for: one that is not known is left out.
    const effect: Extract<NotchToPage, { type: 'effect' }> = { type: 'effect', seq: seqOf(m.seq) };
    put(effect, 'mood', oneOf(NOTCH_MOODS, m.mood));
    put(effect, 'gesture', oneOf(NOTCH_GESTURES, m.gesture));
    put(effect, 'lip', oneOf(NOTCH_LIPS, m.lip));
    put(effect, 'birth', oneOf(NOTCH_BIRTHS, m.birth));
    if (isNumber(m.aim)) effect.aim = m.aim;
    put(effect, 'body', oneOf(NOTCH_BODIES, m.body));
    if (isNumber(m.kick)) effect.kick = m.kick;
    put(effect, 'edge', oneOf(NOTCH_EDGES, m.edge));
    put(effect, 'side', oneOf(['left', 'right'] as const, m.side));
    if (m.gulp === true) effect.gulp = true;
    return { message: effect };
  }
  if (m.type === 'ack') {
    if (!whole(m.n, 1) || typeof m.took !== 'boolean') unread();
    // Only the word itself counts, as with `seen`.
    return { message: { type: 'ack', n: m.n as number, took: m.took as boolean, ...(m.unread === true ? { unread: true as const } : {}) } };
  }
  if (m.type === 'refuse') return { message: { type: 'refuse', v: whole(m.v, 1) ? m.v : unread() } };
  return whole(m.seq, 0) ? { message: null, why: 'unknown', seq: m.seq } : { message: null, why: 'unknown' };
}

/**
 * Reads one message from the brain, for the page. The counterpart of
 * `parseNotchFromPage`: what arrives has crossed two processes as text, and
 * the page must be able to draw whatever it lets in. So a message is read
 * whole before anything on the notch changes, and one that is not exactly a
 * message (a line with no id, a sheet with no blocks, a part of a sentence
 * that is not one, a line without its rules, a patch without its number) is
 * not let in: the notch stays as it was.
 *
 * Two things are taken more lightly, as the page always took them. What only
 * dresses a line or moves the notch (a mood, a mark, an app, a way of
 * arriving, the movements of an `effect`) is left out when it is not known,
 * and the rest stands. And the map takes what it can of what it is given.
 *
 * A message that is read is a new object with nothing in it but what a
 * message has. See `NotchRead` for what else can come of it.
 */
export function readNotchToPage(raw: unknown): NotchRead {
  if (!isRaw(raw)) return { message: null, why: 'malformed' };
  try {
    return readToPage(raw);
  } catch (error) {
    if (!(error instanceof NotchUnread)) throw error;
    // What it was numbered, if it was: the page counts it as read, wrong as it is.
    return whole(raw.seq, 0) ? { message: null, why: 'malformed', seq: raw.seq } : { message: null, why: 'malformed' };
  }
}

/** The same, for whoever only asks whether it is a message, whole: that message, or null. */
export function parseNotchToPage(raw: unknown): NotchToPage | null {
  const read = readNotchToPage(raw);
  return read.message && !read.lineLost ? read.message : null;
}
