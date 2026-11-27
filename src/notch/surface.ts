/**
 * The brain's hold on what the notch is showing.
 *
 * The brain is where "what is on the notch" lives; the page only draws it. So
 * a page that appears (the desktop app started, restarted, or reconnected)
 * says hello and is told the whole of it at once, and the same line comes
 * back. Nothing is pushed to a page that has not said hello on its present
 * connection: it could not hear it yet. Nor is an answer taken from one: it
 * is refused, and says hello.
 *
 * The messages travel through the desktop app (`notch.push` one way, the
 * `notch.message` event the other), which carries them without reading them.
 * See docs/notch/README.md and ./protocol.ts (version 2).
 */
import {
  NOTCH_ANSWERS_KEPT, NOTCH_BIRTHS, NOTCH_FOLD_GRACE_MS, NOTCH_FOLD_HELD_MS, NOTCH_FOLD_MS, NOTCH_HAND_HOLDS_MS, NOTCH_PROTOCOL_VERSION,
  notchAfter, notchRuled, notchRules, notchWhereApp, parseNotchFromPage, parseNotchToPage,
} from './protocol.ts';
import { notchReadWord, notchSetWord, notchWordEdit, notchWordIn } from './words.ts';
import type {
  NotchBirth, NotchBlock, NotchEdit, NotchEffect, NotchFromPage, NotchLine, NotchMood, NotchMouth, NotchPart, NotchToPage, NotchWhereApp,
} from './protocol.ts';

/** The desktop app event that carries one message from the page. */
export const NOTCH_MESSAGE_EVENT = 'notch.message';

/** What this module needs from the sidecar manager. */
export interface NotchSurfacePort {
  dispatchRPC(sidecarId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (sidecarId: string, event: { event_type: string; payload: unknown }) => void): void;
  onSidecarDisconnected(listener: (sidecarId: string) => void): void;
}

/** A call after a while, for the fold. The same shape as a stage's clock (./stage.ts). */
export interface NotchTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real ones. A fold that is still to come does not keep a program that is ending alive. */
export const realNotchTimers: NotchTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * An answer as the brain hands it on. `key` names this very answer among all
 * that any page ever gave: the surface sets it on an answer that came with a
 * number, and a stage takes a key once (./stage.ts).
 */
export type NotchAnswer = Extract<NotchFromPage, { type: 'answer' }> & { key?: string };
/** Something the notch does once. What it IS has setters of its own, so that it cannot travel as a movement and be lost like one. */
export type NotchAct = NotchEffect;
export type NotchUpdate = Omit<NotchEdit, 'id' | 'away'>;

type Numbered = Extract<NotchToPage, { seq: number }>;
type Unnumbered = Numbered extends infer M ? (M extends Numbered ? Omit<M, 'seq'> : never) : never;

/** The offer that folds when left alone: for how long, and since when it has been where somebody could answer it (null: on no page). */
interface NotchFold { id: string; ms: number; from: number | null; timer: unknown }

/** What the brain remembers of one page's answers: which loading of the page it is, and which numbers it has had. */
interface NotchHeard {
  page: string;
  took: Map<number, boolean>;
  floor: number;
  /** The numbers of typed values that could not be read: told again with `unread`, as they were told first. */
  unread?: Set<number>;
}

/** A name for one run of the brain, or one loading of a page. */
export function notchRunName(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export class NotchSurface {
  /** Names this run of the brain in every `state`. */
  private readonly brain = notchRunName();
  private line: NotchLine | null = null;
  private count = 0;
  private face: NotchMood = 'idle';
  private where: NotchWhereApp | null = null;
  private eye = false;
  private sound = false;
  private park = 0;
  private mouth: NotchMouth = 'shut';
  private nextBirth: (() => NotchBirth) | null = null;
  /** Desktop apps whose page has said hello, in this version, on its present connection. */
  private readonly pages = new Set<string>();
  /** Desktop apps whose page has been seen at all since the brain started. */
  private readonly met = new Set<string>();
  /**
   * The number of the last message to each desktop app's page. It is kept
   * when the desktop app goes away: a page that outlives its connection must
   * not be told a number it has already read.
   */
  private readonly seqs = new Map<string, number>();
  /**
   * The answers each desktop app's page has given. Kept when the desktop app
   * goes away, for the same reason: the page that comes back may send again
   * what was taken before, and it must not count twice.
   */
  private readonly heard = new Map<string, NotchHeard>();
  /** Desktop apps whose page was refused on its present connection: said once, not at every hello. */
  private readonly refused = new Set<string>();
  /** When each desktop app's page last said a hand is on the line that is up. */
  private readonly hands = new Map<string, number>();
  private fold: NotchFold | null = null;
  /**
   * An offer the brain has just folded, for NOTCH_FOLD_GRACE_MS: an answer
   * the person gave it while it was up, still on its way, is taken in place of
   * the fold. Whoever waits on the offer hears the fold when that time is out.
   */
  private folded: { line: NotchLine; ms: number; timer: unknown } | null = null;
  /** The answer that holds the line on the notch (a yes, a pick, a fuse's done or undo): the first one taken stands. */
  private held: NotchAnswer | null = null;
  private births = 0;
  private readonly answerListeners = new Set<(answer: NotchAnswer, sidecarId?: string) => void>();
  private readonly openListeners = new Set<(sidecarId: string) => void>();
  private readonly stopListeners = new Set<(sidecarId: string) => void>();
  private readonly dragListeners = new Set<(state: 'over' | 'left' | 'lost', sidecarId: string) => void>();
  private readonly signedOutListeners = new Set<(sidecarId: string) => void>();
  private readonly helloListeners = new Set<(sidecarId: string) => void>();
  private readonly refusedListeners = new Set<(sidecarId: string, v: number) => void>();
  private complaints = 0;
  private unreadable = 0;
  private early = 0;
  /** When the line on the notch was shown, by `now`. */
  private shownAt = 0;

  /**
   * `now` is a clock in ms that only goes forward: it is only ever used to
   * tell how long a line has been up. `timers` is what folds an offer that
   * was left alone. Without it nothing is folded here, and an offer waits
   * until it is answered: the brain gives the real ones (src/daemon), and a
   * test that does not ask for folds gets none behind its back.
   */
  constructor(
    private readonly port: NotchSurfacePort,
    private readonly log: (line: string) => void = (line) => console.log(line),
    private readonly now: () => number = () => performance.now(),
    private readonly timers: NotchTimers | null = null,
  ) {
    port.onEvent((sidecarId, event) => {
      if (event.event_type !== NOTCH_MESSAGE_EVENT) return;
      const payload = event.payload as { message?: unknown } | null;
      this.fromPage(sidecarId, payload?.message);
    });
    // A page that comes back says hello again. Until then it hears nothing.
    port.onSidecarDisconnected((sidecarId) => {
      this.pages.delete(sidecarId);
      this.refused.delete(sidecarId);
      this.hands.delete(sidecarId);
      this.unlistened();
    });
  }

  /** Nobody can answer an offer while it is on no page: its time does not run then. */
  private unlistened(): void {
    if (this.pages.size === 0 && this.fold) {
      this.timers?.clearTimeout(this.fold.timer);
      this.fold.from = null;
    }
  }

  /** Puts a line on the notch, in place of whatever is there. */
  show(line: NotchLine): void {
    // A fold that waited for an answer on its way is heard now: something else is on the notch.
    this.foldedNow();
    this.line = structuredClone(line);
    this.held = null;
    this.shownAt = this.now();
    this.hands.clear();
    this.endFold();
    const fold = this.line.kind === 'offer' ? notchRules(this.line).fold ?? 0 : 0;
    if (fold > 0) {
      this.fold = { id: this.line.id, ms: fold, from: this.pages.size > 0 ? this.shownAt : null, timer: null };
      this.armFold();
    }
    this.push({ type: 'patch', line: notchRuled(this.line) });
  }

  /** Back to the eyes. */
  rest(): void {
    this.foldedNow();
    this.line = null;
    this.held = null;
    this.endFold();
    this.hands.clear();
    this.push({ type: 'patch', line: null });
  }

  /** How many things wait. */
  setCount(count: number): void {
    this.count = Math.max(0, Math.floor(count));
    this.push({ type: 'patch', count: this.count });
  }

  /** The face the notch has at rest from now on. It is kept, and a page that comes back has it. */
  setFace(mood: NotchMood): void {
    if (mood === this.face) return;
    this.face = mood;
    this.push({ type: 'patch', face: mood });
  }

  /** The face the notch has at rest now. */
  resting(): NotchMood {
    return this.face;
  }

  /** The app in front, for the icon at rest. It is kept, like the face. Null takes the icon away. */
  setWhere(app: NotchWhereApp | null): void {
    const next = app ? notchWhereApp(app) : null;
    if (JSON.stringify(next) === JSON.stringify(this.where)) return;
    this.where = next;
    this.push({ type: 'patch', where: next });
  }

  /**
   * Whether an eye is being kept on something: the notch's left eye is round
   * and citron while it is. It is kept, like the face, so a page that comes
   * back still shows it (pass 11).
   */
  setEye(on: boolean): void {
    if (on === this.eye) return;
    this.eye = on;
    this.push({ type: 'patch', eye: on });
  }

  /**
   * Whether the notch makes its small sounds. The person's own choice
   * (./home.ts keeps it): kept here like the face, so a page that comes back
   * is as loud as it was.
   */
  setSound(on: boolean): void {
    if (on === this.sound) return;
    this.sound = on;
    this.push({ type: 'patch', sound: on });
  }

  /**
   * How many small bumps wait on the screen's top edge beside the notch (the
   * things held back during a call). Kept: they used to be told as a movement,
   * and a desktop app that was started again in the call had none until the
   * number changed.
   */
  setPark(many: number): void {
    const next = Math.max(0, Math.floor(Number(many) || 0));
    if (next === this.park) return;
    this.park = next;
    this.push({ type: 'patch', park: next });
  }

  /** The mouth that takes a file: open, open wide with the file over it, or shut. Kept, like the bumps. */
  setMouth(mouth: NotchMouth): void {
    if (mouth === this.mouth) return;
    this.mouth = mouth;
    this.push({ type: 'patch', mouth });
  }

  /** A file was dropped in: the mouth shuts, and the notch gulps once. */
  gulp(): void {
    this.setMouth('shut');
    this.push({ type: 'effect', gulp: true });
  }

  /**
   * How the notch is born the next time a page first appears. Without this
   * the six ways are gone through in order from the first.
   */
  setBirths(next: () => NotchBirth): void {
    this.nextBirth = next;
  }

  /** Changes the line on the notch. Ignored unless `id` is that line. */
  update(id: string, change: NotchUpdate): void {
    const line = this.line;
    if (!line || line.id !== id) return;
    const away = notchRules(line).away;
    if (change.say) line.say = structuredClone(change.say);
    if (change.done !== undefined && line.kind === 'work') line.done = change.done;
    if (change.heard !== undefined && line.kind === 'listen') line.heard = change.heard;
    if (change.over !== undefined && line.kind === 'listen') line.over = change.over;
    if (change.blocks && (line.kind === 'sheet' || line.kind === 'ask')) line.blocks = structuredClone(change.blocks);
    // What a press elsewhere is follows from what the line holds (a file that was handed over): said with the change that changes it.
    const now = notchRules(line).away;
    this.push({ type: 'patch', edit: { id, ...change, ...(now !== away ? { away: now } : {}) } });
  }

  /**
   * Something the notch does once with its face or body (an `effect`). It is
   * not remembered, and a page that was not there never does it. What the
   * notch is has setters of its own: `setEye`, `setSound`, `setPark`, `setMouth`.
   */
  act(act: NotchAct): void {
    this.push({ type: 'effect', ...act });
  }

  /** What the notch is showing now. */
  current(): { line: NotchLine | null; count: number } {
    return { line: this.line ? structuredClone(this.line) : null, count: this.count };
  }

  /** How many pages are up and listening. */
  listening(): number {
    return this.pages.size;
  }

  /** `sidecarId` is the desktop app the answer came from. None: the brain folded the line itself. */
  onAnswer(listener: (answer: NotchAnswer, sidecarId?: string) => void): () => void {
    this.answerListeners.add(listener);
    return () => { this.answerListeners.delete(listener); };
  }

  onOpen(listener: (sidecarId: string) => void): () => void {
    this.openListeners.add(listener);
    return () => { this.openListeners.delete(listener); };
  }

  /** A page has come up and been told everything: it can be shown things from now on. */
  onHello(listener: (sidecarId: string) => void): () => void {
    this.helloListeners.add(listener);
    return () => { this.helloListeners.delete(listener); };
  }

  /**
   * A page said hello in another version (`v`) and was refused. Told once for
   * each connection of a desktop app. A page from version 2 on loads itself
   * again; an older one cannot, and is opened again from here (src/daemon).
   */
  onRefused(listener: (sidecarId: string, v: number) => void): () => void {
    this.refusedListeners.add(listener);
    return () => { this.refusedListeners.delete(listener); };
  }

  /** Esc twice: the person wants everything stopped. */
  onStop(listener: (sidecarId: string) => void): () => void {
    this.stopListeners.add(listener);
    return () => { this.stopListeners.delete(listener); };
  }

  /** A page says its sign-in with the brain has ended: it has to be opened again, signed in anew. */
  onSignedOut(listener: (sidecarId: string) => void): () => void {
    this.signedOutListeners.add(listener);
    return () => { this.signedOutListeners.delete(listener); };
  }

  /** A file is over the notch, was taken away again, or was dropped and lost on the way. */
  onDrag(listener: (state: 'over' | 'left' | 'lost', sidecarId: string) => void): () => void {
    this.dragListeners.add(listener);
    return () => { this.dragListeners.delete(listener); };
  }

  private fromPage(sidecarId: string, raw: unknown): void {
    const message = parseNotchFromPage(raw);
    if (!message) {
      // Said a few times, not for ever: a page that is wrong is wrong often.
      if (this.complaints++ < 5) this.log('[notch] a message from the page was not understood and was dropped');
      return;
    }
    if (message.type === 'hello') {
      this.hello(sidecarId, message);
      return;
    }
    if (message.type === 'open') {
      for (const listener of this.openListeners) listener(sidecarId);
      return;
    }
    if (message.type === 'stop') {
      for (const listener of this.stopListeners) listener(sidecarId);
      return;
    }
    if (message.type === 'drag') {
      for (const listener of this.dragListeners) listener(message.state, sidecarId);
      return;
    }
    if (message.type === 'signed-out') {
      for (const listener of this.signedOutListeners) listener(sidecarId);
      return;
    }
    // What is left says something about the line: an answer to it, a hand on it, how far the page has read.
    // That is taken only from a page that has said hello here, in this version: one that has not may be
    // showing anything (another version's page, a page that outlived the brain it was talking to), and a
    // `done` from it is no proof that a fuse was seen. It is told so, and says hello.
    if (!this.pages.has(sidecarId)) {
      this.tell(sidecarId, { type: 'refuse', v: NOTCH_PROTOCOL_VERSION });
      // An answer without a number is one only a page of version 1 gives: one that was left up across an
      // update of the brain, and never says hello again. It cannot load itself again: it is opened anew,
      // once for each connection (and no more often than src/daemon allows).
      if (message.type === 'answer' && message.n === undefined) this.refusedPage(sidecarId, 1);
      return;
    }
    if (message.type === 'hand') {
      if (this.line?.id !== message.id) return;
      if (message.on) this.hands.set(sidecarId, this.now()); else this.hands.delete(sidecarId);
      return;
    }
    if (message.type === 'at') {
      // The page has not read all that was sent to it: something was lost on the way. It is told the whole again.
      if ((this.seqs.get(sidecarId) ?? 0) !== message.seq) this.push(this.stateNow(), sidecarId);
      return;
    }
    this.answered(sidecarId, message);
  }

  private hello(sidecarId: string, message: Extract<NotchFromPage, { type: 'hello' }>): void {
    if (message.v !== NOTCH_PROTOCOL_VERSION) {
      // A page of another version draws by other rules and answers in other words: it is not limped along
      // with. It is counted as no page at all until it says hello in this version.
      this.pages.delete(sidecarId);
      this.hands.delete(sidecarId);
      // Such a page is no page: an offer's time does not run for it.
      this.unlistened();
      this.tell(sidecarId, { type: 'refuse', v: NOTCH_PROTOCOL_VERSION });
      this.refusedPage(sidecarId, message.v);
      return;
    }
    this.refused.delete(sidecarId);
    // Another loading of the page counts its answers from 1 again: what is remembered is of the one before.
    const page = message.page ?? '';
    if (this.heard.get(sidecarId)?.page !== page) this.heard.set(sidecarId, { page, took: new Map(), floor: 0 });
    this.pages.add(sidecarId);
    const state = this.stateNow();
    // The first time a page appears with nothing to say, the notch is born.
    // A page that comes back, or comes up in the middle of a line, just is.
    if (!this.met.has(sidecarId) && !this.line) {
      let born: NotchBirth | undefined;
      try { born = this.nextBirth?.(); } catch { born = undefined; }
      state.born = born && (NOTCH_BIRTHS as readonly string[]).includes(born) ? born : NOTCH_BIRTHS[this.births++ % NOTCH_BIRTHS.length];
    }
    this.met.add(sidecarId);
    this.push(state, sidecarId);
    // An offer that was on no page is on one now: its time starts here.
    if (this.fold && this.fold.from === null) {
      this.fold.from = this.now();
      this.armFold();
    }
    for (const listener of this.helloListeners) listener(sidecarId);
  }

  /** Says once for each connection that a page of another version was refused, and who may open it anew. */
  private refusedPage(sidecarId: string, v: number): void {
    if (this.refused.has(sidecarId)) return;
    this.refused.add(sidecarId);
    this.log(`[notch] the page speaks version ${v} of the messages, the brain version ${NOTCH_PROTOCOL_VERSION}: it is refused until it has loaded itself again`);
    for (const listener of this.refusedListeners) listener(sidecarId, v);
  }

  private answered(sidecarId: string, message: Extract<NotchFromPage, { type: 'answer' }>): void {
    // An answer to another run of the brain: line names repeat from one run to the next, and a line of the
    // same name here is another line. It is not taken, nor its number kept: the page is told it is not
    // known here, says hello, and learns what this run shows.
    if (message.brain !== undefined && message.brain !== this.brain) {
      this.tell(sidecarId, { type: 'refuse', v: NOTCH_PROTOCOL_VERSION });
      return;
    }
    const heard = this.heard.get(sidecarId) ?? { page: '', took: new Map<number, boolean>(), floor: 0 };
    this.heard.set(sidecarId, heard);
    // An offer the brain folded a moment ago, answered while it was up: the answer was on its way. It is
    // taken in place of the fold, and the offer is back for whatever the answer does to it.
    const folded = this.folded;
    let revived = false;
    if (!this.line && folded && folded.line.id === message.id && message.act !== 'fold' && notchAfter(folded.line, message.act) !== undefined
      && (message.since === undefined || message.since < folded.ms) && !(message.n !== undefined && (heard.took.has(message.n) || message.n <= heard.floor))) {
      this.timers?.clearTimeout(folded.timer);
      this.folded = null;
      this.line = folded.line;
      this.held = null;
      revived = true;
    }
    const line = this.line;
    const rules = line ? notchRules(line) : null;
    // An answer about a line that is no longer there is late, not wrong. So is one that would settle a line
    // another answer already holds (a second pick, another desktop's no after a yes, an undo after the fuse
    // was done): the first that was taken stands.
    const settles = rules?.after[message.act] !== undefined;
    const took = line !== null && line.id === message.id && !(settles && this.held !== null);
    // A value typed into a lit word is read here, by the one reader (./words.ts), before the page is told it
    // was had: what cannot be read is said on the `ack`, and the word keeps its value.
    // A `value` that is none of the word's options was not stepped to: it is read as if it were typed (a page
    // that read it itself, or one that is wrong), and is not put among the options unread.
    const named = took && line !== null && message.act === 'word' && message.word !== undefined;
    const lit = named && line ? notchWordIn(line, message.word!) : null;
    const asTyped = !named ? undefined
      : message.value === undefined ? message.text
      : lit && !lit.options.includes(message.value) ? message.value : undefined;
    const typed = asTyped !== undefined;
    const read = typed && lit ? notchReadWord(lit, asTyped) : null;
    const unread = typed && read === null;
    if (message.n !== undefined) {
      // The same answer again (its `ack` was lost, or was slow): it was taken, or found late, when it first
      // came. It is told the same again and is not taken a second time. A number older than all that are
      // remembered was dealt with long ago.
      const before = heard.took.get(message.n);
      if (before !== undefined || message.n <= heard.floor) {
        this.tell(sidecarId, { type: 'ack', n: message.n, took: before ?? true, ...(heard.unread?.has(message.n) ? { unread: true as const } : {}) });
        return;
      }
      heard.took.set(message.n, took);
      if (unread) (heard.unread ??= new Set()).add(message.n);
      if (heard.took.size > NOTCH_ANSWERS_KEPT) {
        const oldest = heard.took.keys().next().value as number;
        heard.took.delete(oldest);
        heard.unread?.delete(oldest);
        heard.floor = Math.max(heard.floor, oldest);
      }
      // Before anybody hears of it: whoever does may throw, and the page would send it again for nothing.
      this.tell(sidecarId, { type: 'ack', n: message.n, took, ...(unread ? { unread: true as const } : {}) });
    }
    if (!line || !took) {
      // The page gave a second answer to a line that holds the first: it is told the line as it stands,
      // answered, so that it shows what was taken and not what it nodded at.
      if (line && line.id === message.id && this.pages.has(sidecarId)) this.push({ type: 'patch', line: this.lineNow() }, sidecarId);
      return;
    }
    let said = message;
    if (message.act === 'word' && message.word !== undefined && (message.value !== undefined || typed)) {
      const value = typed ? read : message.value!;
      if (value !== null) {
        notchSetWord(line, message.word, value);
        if (typed) {
          // Whoever waits on the line hears the value as it was read, with what was typed beside it.
          said = { ...message, value, text: asTyped };
          // Every page draws the word as it was read, the one it was typed on too and also when it reads as it
          // stood: that page draws nothing of its own, and a yes there answers the line as the brain holds it.
          this.push({ type: 'patch', edit: notchWordEdit(line, message.word) });
        }
      }
      // A hand was on it a moment ago: it is given its time again, a line's time, as the page used to give it.
      if (this.fold?.id === line.id) {
        this.fold.ms = NOTCH_FOLD_MS;
        if (this.fold.from !== null) this.fold.from = this.now();
        this.armFold();
      }
      // Not read: nothing changed, and nothing is made of it.
      if (value === null) return;
    }
    const after = notchRules(line);
    // The page holds a line that came by itself shut for its first moment. It says how long after drawing
    // the line the answer was given, and one that came sooner than the line allows is said here. It is
    // still taken: whether it should be is the owner's to decide (docs/notch/fixes/07-page-renderer.md).
    if ((message.act === 'yes' || message.act === 'pick') && message.since !== undefined && message.since < after.gate.esc && this.early++ < 5) {
      this.log(`[notch] a ${message.act} came ${message.since} ms after its line was drawn, sooner than the ${after.gate.esc} ms the line allows`);
    }
    // It was answered and waits, dimmed, for what the brain says next: it does not fold meanwhile. Not a
    // letter's done that does not vouch for the letter: it decides nothing, and a page that saw the letter
    // may still say so.
    const unvouched = line.kind === 'send' && !!line.blocks?.length && message.act === 'done' && message.seen !== true;
    if (after.after[message.act] === 'hold' && !unvouched) {
      // The first answer that holds the line stands: whatever else would settle it is late (above).
      this.held = message;
      if (this.fold?.id === line.id) this.endFold();
      // Every page had put the offer away with the fold: it comes back, answered, until the brain says what next.
      if (revived) this.push({ type: 'patch', line: this.lineNow() });
    }
    // After these the page that answered has gone back to rest by itself. After any other the line stays
    // until the brain says what next.
    if (after.after[message.act] === 'rest') {
      this.line = null;
      this.held = null;
      this.endFold();
      this.hands.clear();
      // The page that answered is at rest. Any other still shows the line, and would for ever: nothing more
      // is said about a line that is gone here, and an answer to it from there is dropped as late. So the
      // others are told to rest, before whoever hears the answer shows the next thing.
      for (const other of [...this.pages]) {
        if (other !== sidecarId) this.push({ type: 'patch', line: null }, other);
      }
    }
    const answer: NotchAnswer = said.n === undefined ? said : { ...said, key: `${sidecarId}\n${heard.page}\n${said.n}` };
    for (const listener of this.answerListeners) listener(answer, sidecarId);
  }

  private endFold(): void {
    if (this.fold) this.timers?.clearTimeout(this.fold.timer);
    this.fold = null;
  }

  private armFold(): void {
    const fold = this.fold;
    if (!fold || !this.timers) return;
    this.timers.clearTimeout(fold.timer);
    fold.timer = null;
    if (fold.from === null) return;
    fold.timer = this.timers.setTimeout(() => { this.foldDue(fold); }, Math.max(0, fold.from + fold.ms - this.now()));
  }

  /**
   * An offer's time is up. The brain folds it, and not the page: with two
   * desktops the one nobody sat at folded the line under the hand of the
   * person at the other, and a fold that was lost on the way left the brain
   * waiting on a line no page showed.
   */
  private foldDue(fold: NotchFold): void {
    if (this.fold !== fold || !this.timers) return;
    const line = this.line;
    if (!line || line.id !== fold.id) { this.endFold(); return; }
    if (this.pages.size === 0) { fold.from = null; return; }
    const now = this.now();
    for (const [page, at] of this.hands) if (now - at >= NOTCH_HAND_HOLDS_MS) this.hands.delete(page);
    // Not while a hand is on it, on any page: looked at again in a moment.
    if (this.hands.size > 0) {
      fold.timer = this.timers.setTimeout(() => { this.foldDue(fold); }, NOTCH_FOLD_HELD_MS);
      return;
    }
    this.line = null;
    this.held = null;
    this.fold = null;
    this.hands.clear();
    this.push({ type: 'patch', line: null });
    // Whoever waits hears of it in a moment: a yes given in the last of its time may still be on its way.
    const folded = { line, ms: fold.ms, timer: null as unknown };
    this.folded = folded;
    folded.timer = this.timers.setTimeout(() => { if (this.folded === folded) this.foldedNow(); }, NOTCH_FOLD_GRACE_MS);
  }

  /** The offer that was folded is heard of as folded now, if it has not been yet. */
  private foldedNow(): void {
    const folded = this.folded;
    if (!folded) return;
    this.folded = null;
    this.timers?.clearTimeout(folded.timer);
    for (const listener of this.answerListeners) listener({ type: 'answer', id: folded.line.id, act: 'fold' });
  }

  /** Everything the notch is, as a page is told it at once. */
  private stateNow(): Omit<Extract<NotchToPage, { type: 'state' }>, 'seq'> {
    const state: Omit<Extract<NotchToPage, { type: 'state' }>, 'seq'> = {
      type: 'state', v: NOTCH_PROTOCOL_VERSION, brain: this.brain, line: this.lineNow(), count: this.count,
    };
    if (this.face !== 'idle') state.face = this.face;
    if (this.where) state.where = this.where;
    if (this.eye) state.eye = true;
    if (this.sound) state.sound = true;
    if (this.park > 0) state.park = this.park;
    if (this.mouth !== 'shut') state.mouth = this.mouth;
    return state;
  }

  /**
   * The line as a page that comes up now is told it, with its rules. A result
   * and a fuse run out by themselves: such a line says how much of its time
   * is left, so that the page goes on from there. It used to start again from
   * the beginning, while the script that waits for it here did not: a fuse
   * then burnt past the time it is waited for, and the yes behind it was
   * dropped without a word.
   */
  private lineNow(): NotchLine | null {
    const line = this.line;
    if (!line) return null;
    // A line that holds an answer says so: a page that comes up draws it answered (a fuse that was done shows no undo).
    const held = this.held ? { held: true } : {};
    if (line.kind !== 'say' && line.kind !== 'send') return { ...notchRuled(line), ...held };
    const total = Math.max(0, line.ms);
    const left = Math.max(0, Math.min(total, Math.round(total - (this.now() - this.shownAt))));
    return { ...notchRuled({ ...line, left }), ...held };
  }

  /** What is said to one page outside the row of numbered messages: that an answer came, or that the page is refused. */
  private tell(sidecarId: string, message: Extract<NotchToPage, { type: 'ack' | 'refuse' }>): void {
    this.dispatch(sidecarId, message);
  }

  private push(message: Unnumbered, only?: string): void {
    // The page reads every message whole, and drops one it cannot read. One that the brain itself made
    // wrong is said here, where it was made and can be found. It is still sent: the page is the judge.
    if (this.unreadable < 5 && !parseNotchToPage({ ...message, seq: 0 })) {
      this.unreadable++;
      const line = 'line' in message ? message.line : null;
      const kind = line ? ` (${String(line.kind)}, ${String(line.id)})` : '';
      this.log(`[notch] a ${message.type} message${kind} is not one the page can read: it will be dropped there`);
    }
    const targets = only === undefined ? [...this.pages] : [only];
    for (const sidecarId of targets) {
      // Each page has its own row of numbers: what is said to one alone would be a gap to the others.
      const seq = (this.seqs.get(sidecarId) ?? 0) + 1;
      this.seqs.set(sidecarId, seq);
      this.dispatch(sidecarId, { ...message, seq } as NotchToPage);
    }
  }

  private dispatch(sidecarId: string, message: NotchToPage): void {
    this.port.dispatchRPC(sidecarId, 'notch.push', { message }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`[notch] a message did not reach the notch: ${reason}`);
    });
  }
}

/**
 * A birth that is not the one before it: "every start is a different birth,
 * never the same twice", so starting Jarvis does not get old (the
 * prototype's `anyBirth`). `last` is the one before, as it was kept;
 * `random` is a number from 0 up to 1.
 */
export function notchBirthAfter(last: unknown, random: () => number = Math.random): NotchBirth {
  const others = NOTCH_BIRTHS.filter((birth) => birth !== last);
  return others[Math.min(others.length - 1, Math.max(0, Math.floor(random() * others.length)))]!;
}
