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
import { NOTCH_BIRTHS, NOTCH_PROTOCOL_VERSION, parseNotchFromPage } from './protocol.ts';
import type { NotchBlock, NotchFromPage, NotchLine, NotchPart, NotchToPage } from './protocol.ts';

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
  /** Desktop apps whose page has said hello on its present connection. */
  private readonly pages = new Set<string>();
  /** Desktop apps whose page has been seen at all since the brain started. */
  private readonly met = new Set<string>();
  private births = 0;
  private readonly answerListeners = new Set<(answer: NotchAnswer, sidecarId: string) => void>();
  private readonly openListeners = new Set<(sidecarId: string) => void>();
  private complaints = 0;

  constructor(
    private readonly port: NotchSurfacePort,
    private readonly log: (line: string) => void = (line) => console.log(line),
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

  /** Changes the line on the notch. Ignored unless `id` is that line. */
  update(id: string, change: NotchUpdate): void {
    const line = this.line;
    if (!line || line.id !== id) return;
    if (change.say) line.say = structuredClone(change.say);
    if (change.done !== undefined && line.kind === 'work') line.done = change.done;
    if (change.heard !== undefined && line.kind === 'listen') line.heard = change.heard;
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
      const state: NotchToPage = { type: 'state', line: this.line, count: this.count };
      // The first time a page appears with nothing to say, the notch is born.
      // A page that comes back, or comes up in the middle of a line, just is.
      if (!this.met.has(sidecarId) && !this.line) {
        state.born = NOTCH_BIRTHS[this.births++ % NOTCH_BIRTHS.length];
      }
      this.met.add(sidecarId);
      this.push(state, sidecarId);
      return;
    }
    if (message.type === 'open') {
      for (const listener of this.openListeners) listener(sidecarId);
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
    if (gone) this.line = null;
    for (const listener of this.answerListeners) listener(message, sidecarId);
  }

  private push(message: NotchToPage, only?: string): void {
    const targets = only === undefined ? [...this.pages] : [only];
    for (const sidecarId of targets) {
      this.port.dispatchRPC(sidecarId, 'notch.push', { message }).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.log(`[notch] a message did not reach the notch: ${reason}`);
      });
    }
  }
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
