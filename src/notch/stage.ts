/**
 * What a script that plays on the notch works with.
 *
 * Anything that takes the notch for a while is written as a small script: show
 * a line, wait for what the person does with it, show the next. The demo's
 * moments are such scripts (./demo.ts) and so is every real thing that waits
 * for an answer (./inbox.ts). A stage gives a script its lines and its waits,
 * and ends all of them at once when something else takes the notch.
 */
import type { NotchAnswer, NotchSurface } from './surface.ts';
import type { NotchAnswerAct, NotchBlock, NotchLine, NotchPart } from './protocol.ts';

/** Thrown inside a script when its stage has ended: something else took the notch. */
export class NotchStageEnded extends Error {}

export interface NotchClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realNotchClock: NotchClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type NotchLineExtras = Partial<Pick<NotchLine, 'mood' | 'mark' | 'who' | 'src' | 'arrive'>>;

/** How long past its time a line is waited for before the script goes on without the page's word. */
const LATE = 1500;

export class NotchStage {
  private n = 0;
  private stopped = false;
  private unasked: boolean;
  private readonly timers = new Set<unknown>();
  private readonly waiters = new Set<{ take(answer: NotchAnswer): boolean; fail(): void }>();
  /**
   * Answers nobody was waiting for when they came. Two can arrive back to
   * back (a word changed, then yes), and the script is between two waits
   * when the second lands: it must still be there when the script asks.
   */
  private readonly unheard: NotchAnswer[] = [];
  private readonly openWaiters = new Set<{ done(): void; fail(): void }>();

  /**
   * `prefix` and `name` make the ids of this stage's lines. `unasked` says the
   * script was not started by the person: its first line is marked so, and the
   * page lets no yes land on it for a moment (docs/notch/README.md).
   */
  constructor(
    readonly surface: NotchSurface,
    private readonly clock: NotchClock,
    private readonly name: string,
    options: { prefix?: string; unasked?: boolean } = {},
  ) {
    this.prefix = `${options.prefix ?? 'demo'}-${name}-`;
    this.unasked = options.unasked === true;
  }

  private readonly prefix: string;
  private lastFrom: string | null = null;

  /** The desktop app the last answer came from, or null before any. */
  from(): string | null {
    return this.lastFrom;
  }

  /** A fresh id for the next line of this script. */
  id(): string {
    return `${this.prefix}${++this.n}`;
  }

  /** Whether the line called `id` is one of this stage's. */
  owns(id: string): boolean {
    return id.startsWith(this.prefix);
  }

  /** Whether the stage has been ended. */
  ended(): boolean {
    return this.stopped;
  }

  /** Ends the script: every wait it is in, or enters later, fails with NotchStageEnded. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers.clear();
    for (const waiter of [...this.waiters]) waiter.fail();
    for (const waiter of [...this.openWaiters]) waiter.fail();
  }

  /** Takes an answer from the page. `from` is the desktop app it came from. */
  heard(answer: NotchAnswer, from?: string): void {
    if (from !== undefined) this.lastFrom = from;
    for (const waiter of [...this.waiters]) {
      if (waiter.take(answer)) return;
    }
    this.unheard.push(answer);
    if (this.unheard.length > 50) this.unheard.shift();
  }

  wasOpened(): void {
    for (const waiter of [...this.openWaiters]) waiter.done();
  }

  /** Puts a line of this script on the notch. A stage that has ended shows nothing. */
  put(line: NotchLine): void {
    if (this.stopped) throw new NotchStageEnded();
    if (this.unasked) {
      this.unasked = false;
      this.surface.show({ ...line, unasked: true });
      return;
    }
    this.surface.show(line);
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new NotchStageEnded()); return; }
      const timer = this.clock.setTimeout(() => {
        this.timers.delete(timer);
        if (this.stopped) reject(new NotchStageEnded()); else resolve();
      }, ms);
      this.timers.add(timer);
    });
  }

  /** The next answer about the line `id`, of one of `acts` when given. */
  answer(id: string, acts?: NotchAnswerAct[]): Promise<NotchAnswer> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new NotchStageEnded()); return; }
      const wanted = (answer: NotchAnswer): boolean => answer.id === id && (!acts || acts.includes(answer.act));
      const kept = this.unheard.findIndex(wanted);
      if (kept >= 0) { resolve(this.unheard.splice(kept, 1)[0]!); return; }
      const waiter = {
        take: (answer: NotchAnswer): boolean => {
          if (!wanted(answer)) return false;
          this.waiters.delete(waiter);
          resolve(answer);
          return true;
        },
        fail: (): void => { this.waiters.delete(waiter); reject(new NotchStageEnded()); },
      };
      this.waiters.add(waiter);
    });
  }

  /** The next click on the resting notch. */
  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new NotchStageEnded()); return; }
      const waiter = {
        done: (): void => { this.openWaiters.delete(waiter); resolve(); },
        fail: (): void => { this.openWaiters.delete(waiter); reject(new NotchStageEnded()); },
      };
      this.openWaiters.add(waiter);
    });
  }

  /**
   * A result line. Comes back when it has left the notch: when the page says
   * so, or a little after its time if no page is there to say it.
   */
  async say(parts: NotchPart[], ms: number, extras: NotchLineExtras = {}): Promise<void> {
    const id = this.id();
    this.put({ id, kind: 'say', say: parts, ms, ...extras });
    await Promise.race([this.answer(id, ['done', 'yes']), this.wait(ms + LATE)]);
  }

  /** An offer. Comes back with what the person did with it. */
  offer(parts: NotchPart[], yes: string, extras: NotchLineExtras & { fold?: number } = {}): Promise<NotchAnswer> {
    const id = this.id();
    this.put({ id, kind: 'offer', say: parts, yes, ...extras });
    return this.answer(id, ['yes', 'no', 'fold']);
  }

  /** A row of choices. Comes back with the pick, or with no or fold. */
  choose(parts: NotchPart[], options: string[], extras: NotchLineExtras & { fold?: number } = {}): Promise<NotchAnswer> {
    const id = this.id();
    this.put({ id, kind: 'offer', say: parts, options, ...extras });
    return this.answer(id, ['pick', 'no', 'fold']);
  }

  /** A send with its window. True when it went out, false when it was taken back. */
  async send(parts: NotchPart[], ms: number, extras: NotchLineExtras = {}): Promise<boolean> {
    const id = this.id();
    this.put({ id, kind: 'send', say: parts, ms, ...extras });
    const answer = await Promise.race([this.answer(id, ['done', 'undo']), this.wait(ms + LATE)]);
    return answer?.act !== 'undo';
  }

  /**
   * A send whose going out must be witnessed. `done` only when the page said
   * its window ran out; `undo` when it was taken back; `lost` when no page
   * said either (it went away in the middle). For things that must not happen
   * on the strength of a line nobody may have seen.
   */
  async fuse(parts: NotchPart[], ms: number, extras: NotchLineExtras = {}): Promise<'done' | 'undo' | 'lost'> {
    const id = this.id();
    this.put({ id, kind: 'send', say: parts, ms, ...extras });
    const answer = await Promise.race([this.answer(id, ['done', 'undo']), this.wait(ms + LATE)]);
    return answer ? (answer.act === 'undo' ? 'undo' : 'done') : 'lost';
  }

  /**
   * A panel under a title. Comes back with the next thing done with it: its
   * action, one of its buttons or rows, or no when it was closed.
   */
  sheet(parts: NotchPart[], blocks: NotchBlock[], extras: NotchLineExtras & { yes?: string } = {}): Promise<NotchAnswer> {
    const id = this.id();
    this.put({ id, kind: 'sheet', say: parts, blocks, ...extras });
    return this.answer(id, ['yes', 'no', 'button', 'go']);
  }

  /**
   * Work in `steps` steps, one every `per` ms. Comes back with how many were
   * done: all of them, or fewer if the person asked it to stop.
   */
  async work(parts: NotchPart[], steps: number, per: number, extras: NotchLineExtras & { canTalk?: boolean; from?: number } = {}): Promise<number> {
    const id = this.id();
    const { from = 0, ...rest } = extras;
    let stopAsked = false;
    this.answer(id, ['stop']).then(() => { stopAsked = true; }, () => {});
    this.put({ id, kind: 'work', say: parts, steps, done: from, ...rest });
    for (let done = from + 1; done <= steps; done++) {
      await this.wait(per);
      if (stopAsked) return done - 1;
      this.surface.update(id, { done });
    }
    await this.wait(Math.min(per, 300));
    return stopAsked ? steps - 1 : steps;
  }
}
