/**
 * Promises on the notch: the line with its fuse.
 *
 * A promise is a commitment with a due time (vault/commitments.ts). When one
 * is about to be kept, the executor announces it and waits out a window in
 * which it can be cancelled (daemon/commitment-executor.ts). That window was
 * never shown anywhere. Here it is a send line: the fuse burns for exactly
 * as long as the window has left, and Esc cancels the promise.
 *
 * The notch only shows the window and passes on a cancel. The executor's own
 * clock is what runs the promise, whether or not a page is there to watch:
 * the page saying "the fuse has burnt" starts nothing.
 *
 * A fuse cannot wait its turn, so it takes the notch from whatever is on it.
 * What came of a promise is told afterwards as one line: kept, not kept, or
 * cut off by a restart and therefore not run again.
 */
import type { CommitmentEvent } from '../daemon/commitment-executor.ts';
import type { NotchInbox, NotchItem } from './inbox.ts';
import type { NotchPart } from './protocol.ts';

/** How long the notch waits, after the fuse, to say what came of it in the same breath. */
const TELL_WITHIN_MS = 1500;
/** A window shorter than this is not shown: there would be no time to act in it. */
const SHORTEST_FUSE_MS = 400;
/** The most of a promise's text one line carries. The whole of it is in the dashboard. */
const LINE_CHARS = 110;

export interface NotchPromiseDeps {
  executor: {
    subscribe(listener: (event: CommitmentEvent) => void): () => void;
    cancelExecution(commitmentId: string): boolean;
  };
  now?: () => number;
}

const em = (text: string): NotchPart => ({ em: text });

/** The promise's words, cut on a code point if they are too long for a line. */
export function promiseWords(what: string): string {
  const points = [...what.trim()];
  return points.length <= LINE_CHARS ? points.join('') : `${points.slice(0, LINE_CHARS - 1).join('').trimEnd()}…`;
}

const clockTime = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The id a promise's fuse has in the inbox. */
export const notchPromiseItemId = (commitmentId: string): string => `promise:${commitmentId}`;

export function attachNotchPromises(inbox: NotchInbox, deps: NotchPromiseDeps): () => void {
  const now = deps.now ?? Date.now;
  /** Promises the notch itself is cancelling right now: its own line says so. */
  const cancelling = new Set<string>();
  /** Fuses waiting to hear what came of their promise. */
  const tellMe = new Map<string, (event: Extract<CommitmentEvent, { type: 'finished' }>) => void>();

  const outcome = (event: Extract<CommitmentEvent, { type: 'finished' }>): { say: NotchPart[]; ms: number; ok: boolean } | null => {
    const words = promiseWords(event.what);
    if (event.status === 'completed') return { say: ['Kept: ', em(words), '.'], ms: 3200, ok: true };
    if (event.status === 'failed') return { say: ['Not kept: ', em(words), '. The dashboard says why.'], ms: 4600, ok: false };
    // Parked: it stopped on an approval, and that approval is its own line.
    return null;
  };

  /** One line of news about a promise: said once, then gone. */
  const news = (commitmentId: string, say: NotchPart[], ms: number, ok: boolean): NotchItem => ({
    id: `promise-news:${commitmentId}`,
    subject: `promise-news:${commitmentId}`,
    class: 'rest',
    speaks: true,
    once: true,
    title: () => say,
    play: async (stage) => {
      await stage.say(say, ms, ok ? { mood: 'happy', mark: 'check' } : { mood: 'worried', mark: 'fail' });
      return 'settled';
    },
  });

  const fuse = (event: Extract<CommitmentEvent, { type: 'announced' }> & { fireAt: number }): NotchItem => {
    const { commitmentId, what } = event;
    const words = promiseWords(what);
    const said: NotchPart[] = event.whenDue === null
      ? ['I promised: ', em(words), '. Doing it…']
      : [`${clockTime(event.whenDue)}. I promised: `, em(words), '. Doing it…'];
    return {
      id: notchPromiseItemId(commitmentId),
      subject: notchPromiseItemId(commitmentId),
      class: 'clock',
      speaks: true,
      urgent: true,
      title: () => ['About to keep: ', em(words)],
      // Still true while its window is open.
      check: () => event.fireAt - now() > 0,
      play: async (stage) => {
        const left = event.fireAt - now();
        if (left < SHORTEST_FUSE_MS) return 'settled';
        const went = await stage.fuse(said, left, { mood: 'careful' });
        if (went === 'undo') {
          cancelling.add(commitmentId);
          let cancelled: boolean;
          try {
            cancelled = deps.executor.cancelExecution(commitmentId);
          } finally {
            cancelling.delete(commitmentId);
          }
          await stage.say(cancelled ? ['Cancelled. I will not do it.'] : ['Too late to cancel: it has started.'], 2800,
            cancelled ? { mood: 'idle', mark: 'check' } : { mood: 'worried' });
          return 'settled';
        }
        // Burnt out, or nobody was watching: either way the executor's own
        // clock runs it now. If it is quick, say what came of it right here.
        const finished = await Promise.race([
          new Promise<Extract<CommitmentEvent, { type: 'finished' }>>((resolve) => { tellMe.set(commitmentId, resolve); }),
          stage.wait(TELL_WITHIN_MS).then(() => null),
        ]).finally(() => { tellMe.delete(commitmentId); });
        const told = finished ? outcome(finished) : null;
        if (told) await stage.say(told.say, told.ms, told.ok ? { mood: 'happy', mark: 'check' } : { mood: 'worried', mark: 'fail' });
        return 'settled';
      },
    };
  };

  return deps.executor.subscribe((event) => {
    switch (event.type) {
      case 'announced':
        if (event.fireAt === null) {
          // Announce-only mode: nothing will run by itself. Said once.
          inbox.add(news(event.commitmentId, ['Due now: ', em(promiseWords(event.what)), '. It waits for your word.'], 4200, true));
          return;
        }
        inbox.add(fuse({ ...event, fireAt: event.fireAt }));
        return;
      case 'cancelled':
        // Cancelled from the notch: its own line is saying so.
        if (!cancelling.has(event.commitmentId)) inbox.remove(notchPromiseItemId(event.commitmentId));
        return;
      case 'withdrawn':
        inbox.remove(notchPromiseItemId(event.commitmentId));
        return;
      case 'started':
        return;
      case 'finished': {
        const waiting = tellMe.get(event.commitmentId);
        if (waiting) { waiting(event); return; }
        // The fuse is over, or never showed: what came of it is its own line.
        inbox.remove(notchPromiseItemId(event.commitmentId));
        const told = outcome(event);
        if (told) inbox.add(news(event.commitmentId, told.say, told.ms, told.ok));
        return;
      }
      case 'interrupted':
        inbox.add(news(event.commitmentId,
          [em(promiseWords(event.what)), ' was cut off by a restart. It may have partly run, so I did not run it again.'], 5600, false));
        return;
    }
  });
}
