/**
 * The brain's hold on what the notch is showing.
 *
 * The brain is where "what is on the notch" lives; the page only draws it. So
 * a page that appears (the desktop app started, restarted, or reconnected)
 * says hello and is told the whole of it at once, and the same line comes
 * back. Nothing is pushed to a page that has not said hello on its present
 * connection: it could not hear it yet.
 *
 * The messages travel through the desktop app (`notch.push` one way, the
 * `notch.message` event the other), which carries them without reading them.
 * See docs/notch/README.md and ./protocol.ts.
 */
import { NOTCH_BIRTHS, NOTCH_PROTOCOL_VERSION, notchWhereApp, parseNotchFromPage, parseNotchToPage } from './protocol.ts';
import type { NotchBirth, NotchBlock, NotchFromPage, NotchLine, NotchMood, NotchPart, NotchToPage, NotchWhereApp } from './protocol.ts';

/** The desktop app event that carries one message from the page. */
export const NOTCH_MESSAGE_EVENT = 'notch.message';

/** What this module needs from the sidecar manager. */
export interface NotchSurfacePort {
  dispatchRPC(sidecarId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (sidecarId: string, event: { event_type: string; payload: unknown }) => void): void;
  onSidecarDisconnected(listener: (sidecarId: string) => void): void;
}

export type NotchAnswer = Extract<NotchFromPage, { type: 'answer' }>;
export type NotchAct = Omit<Extract<NotchToPage, { type: 'act' }>, 'type'>;
export type NotchUpdate = Omit<Extract<NotchToPage, { type: 'update' }>, 'type' | 'id'>;

export class NotchSurface {
  private line: NotchLine | null = null;
  private count = 0;
  private face: NotchMood = 'idle';
  private where: NotchWhereApp | null = null;
  private eye = false;
  private sound = false;
  private nextBirth: (() => NotchBirth) | null = null;
  /** Desktop apps whose page has said hello on its present connection. */
  private readonly pages = new Set<string>();
  /** Desktop apps whose page has been seen at all since the brain started. */
  private readonly met = new Set<string>();
  private births = 0;
  private readonly answerListeners = new Set<(answer: NotchAnswer, sidecarId: string) => void>();
  private readonly openListeners = new Set<(sidecarId: string) => void>();
  private readonly stopListeners = new Set<(sidecarId: string) => void>();
  private readonly dragListeners = new Set<(state: 'over' | 'left' | 'lost', sidecarId: string) => void>();
  private readonly signedOutListeners = new Set<(sidecarId: string) => void>();
  private readonly helloListeners = new Set<(sidecarId: string) => void>();
  private complaints = 0;
  private unreadable = 0;
  /** When the line on the notch was shown, by `now`. */
  private shownAt = 0;

  /** `now` is a clock in ms that only goes forward: it is only ever used to tell how long a line has been up. */
  constructor(
    private readonly port: NotchSurfacePort,
    private readonly log: (line: string) => void = (line) => console.log(line),
    private readonly now: () => number = () => performance.now(),
  ) {
    port.onEvent((sidecarId, event) => {
      if (event.event_type !== NOTCH_MESSAGE_EVENT) return;
      const payload = event.payload as { message?: unknown } | null;
      this.fromPage(sidecarId, payload?.message);
    });
    // A page that comes back says hello again. Until then it hears nothing.
    port.onSidecarDisconnected((sidecarId) => { this.pages.delete(sidecarId); });
  }

  /** Puts a line on the notch, in place of whatever is there. */
  show(line: NotchLine): void {
    this.line = structuredClone(line);
    this.shownAt = this.now();
    this.push({ type: 'show', line: this.line });
  }

  /** Back to the eyes. */
  rest(): void {
    this.line = null;
    this.push({ type: 'rest' });
  }

  /** How many things wait. */
  setCount(count: number): void {
    this.count = Math.max(0, Math.floor(count));
    this.push({ type: 'count', count: this.count });
  }

  /** The face the notch has at rest from now on. It is kept, and a page that comes back has it. */
  setFace(mood: NotchMood): void {
    if (mood === this.face) return;
    this.face = mood;
    this.push({ type: 'face', mood });
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
    this.push({ type: 'where', app: next });
  }

  /**
   * Whether an eye is being kept on something: the notch's left eye is round
   * and citron while it is. It is kept, like the face, so a page that comes
   * back still shows it (pass 11).
   */
  setEye(on: boolean): void {
    if (on === this.eye) return;
    this.eye = on;
    this.push({ type: 'act', eye: on });
  }

  /**
   * Whether the notch makes its small sounds. The person's own choice
   * (./home.ts keeps it): kept here like the face, so a page that comes back
   * is as loud as it was.
   */
  setSound(on: boolean): void {
    if (on === this.sound) return;
    this.sound = on;
    this.push({ type: 'act', sound: on });
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
    if (change.say) line.say = structuredClone(change.say);
    if (change.done !== undefined && line.kind === 'work') line.done = change.done;
    if (change.heard !== undefined && line.kind === 'listen') line.heard = change.heard;
    if (change.over !== undefined && line.kind === 'listen') line.over = change.over;
    if (change.blocks && (line.kind === 'sheet' || line.kind === 'ask')) line.blocks = structuredClone(change.blocks);
    this.push({ type: 'update', id, ...change });
  }

  /** Something the notch does with its face or body. It is not remembered. */
  act(act: NotchAct): void {
    this.push({ type: 'act', ...act });
  }

  /** What the notch is showing now. */
  current(): { line: NotchLine | null; count: number } {
    return { line: this.line ? structuredClone(this.line) : null, count: this.count };
  }

  /** How many pages are up and listening. */
  listening(): number {
    return this.pages.size;
  }

  onAnswer(listener: (answer: NotchAnswer, sidecarId: string) => void): () => void {
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
      if (message.v !== NOTCH_PROTOCOL_VERSION) {
        this.log(`[notch] the page speaks version ${message.v} of the messages, the brain version ${NOTCH_PROTOCOL_VERSION}`);
      }
      this.pages.add(sidecarId);
      const state: NotchToPage = { type: 'state', line: this.lineNow(), count: this.count };
      if (this.face !== 'idle') state.face = this.face;
      if (this.where) state.where = this.where;
      if (this.eye) state.eye = true;
      if (this.sound) state.sound = true;
      // The first time a page appears with nothing to say, the notch is born.
      // A page that comes back, or comes up in the middle of a line, just is.
      if (!this.met.has(sidecarId) && !this.line) {
        let born: NotchBirth | undefined;
        try { born = this.nextBirth?.(); } catch { born = undefined; }
        state.born = born && (NOTCH_BIRTHS as readonly string[]).includes(born) ? born : NOTCH_BIRTHS[this.births++ % NOTCH_BIRTHS.length];
      }
      this.met.add(sidecarId);
      this.push(state, sidecarId);
      for (const listener of this.helloListeners) listener(sidecarId);
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
    const line = this.line;
    // An answer about a line that is no longer there is late, not wrong.
    if (!line || line.id !== message.id) return;
    if (message.act === 'word' && message.word !== undefined && message.value !== undefined) {
      setWord(line, message.word, message.value);
    }
    // These are the answers after which the page has gone back to rest by
    // itself. After any other the line stays until the brain says what next.
    const gone = message.act === 'no' || message.act === 'fold'
      || (line.kind === 'say' && (message.act === 'done' || message.act === 'yes'));
    if (gone) {
      this.line = null;
      // The page that answered is at rest. Any other still shows the line, and would for ever: nothing more
      // is said about a line that is gone here, and an answer to it from there is dropped as late. So the
      // others are told to rest, before whoever hears the answer shows the next thing.
      for (const other of [...this.pages]) {
        if (other !== sidecarId) this.push({ type: 'rest' }, other);
      }
    }
    for (const listener of this.answerListeners) listener(message, sidecarId);
  }

  /**
   * The line as a page that comes up now is told it. A result and a fuse run
   * out by themselves: such a line says how much of its time is left, so that
   * the page goes on from there. It used to start again from the beginning,
   * while the script that waits for it here did not: a fuse then burnt past
   * the time it is waited for, and the yes behind it was dropped without a word.
   */
  private lineNow(): NotchLine | null {
    const line = this.line;
    if (!line || (line.kind !== 'say' && line.kind !== 'send')) return line;
    const total = Math.max(0, line.ms);
    const left = Math.max(0, Math.min(total, Math.round(total - (this.now() - this.shownAt))));
    return { ...line, left };
  }

  private push(message: NotchToPage, only?: string): void {
    // The page reads every message whole, and drops one it cannot read. One that the brain itself made
    // wrong is said here, where it was made and can be found. It is still sent: the page is the judge.
    if (this.unreadable < 5 && !parseNotchToPage(message)) {
      this.unreadable++;
      const kind = 'line' in message && message.line ? ` (${String(message.line.kind)}, ${String(message.line.id)})` : '';
      this.log(`[notch] a ${message.type} message${kind} is not one the page can read: it will be dropped there`);
    }
    const targets = only === undefined ? [...this.pages] : [only];
    for (const sidecarId of targets) {
      this.port.dispatchRPC(sidecarId, 'notch.push', { message }).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.log(`[notch] a message did not reach the notch: ${reason}`);
      });
    }
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

/** Sets a lit word's value wherever it stands in the line. */
function setWord(line: NotchLine, name: string, value: string): void {
  const inParts = (parts: NotchPart[] | undefined): void => {
    for (const part of parts ?? []) {
      if (typeof part === 'object' && 'word' in part && part.word.name === name) part.word.value = value;
    }
  };
  inParts(line.say);
  const blocks: NotchBlock[] = line.kind === 'sheet' || line.kind === 'ask' ? line.blocks : [];
  for (const block of blocks) {
    if (block.kind === 'row' || block.kind === 'note') inParts(block.say);
    if (block.kind === 'paper') {
      inParts(block.to);
      for (const paperLine of block.lines) inParts(paperLine);
    }
  }
}
