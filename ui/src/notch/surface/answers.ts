/**
 * The answers the page has given and the brain has not yet said it has.
 *
 * An answer used to be said once and trusted to arrive. One that was lost on
 * the way (the desktop app's queue was full, the connection was down) left
 * its line dimmed for good: the page waited for the brain, and the brain had
 * heard nothing. Now each answer has a number, the brain says `ack` to it,
 * and until then the page says it again: NOTCH_ANSWER_SENDS times in all,
 * NOTCH_ANSWER_AGAIN_MS apart. The brain takes a number once, so saying it
 * again is safe.
 *
 * Nothing here knows what an answer means or what the notch shows: it is told
 * what to say and tells back what became of it.
 */
import { NOTCH_ANSWER_AGAIN_MS, NOTCH_ANSWER_SENDS, NOTCH_ANSWERS_WAITING_MAX } from '../../../../src/notch/protocol.ts';
import type { NotchFromPage } from '../../../../src/notch/protocol.ts';
import type { Timers } from './dom.ts';

export type NotchPageAnswer = Extract<NotchFromPage, { type: 'answer' }>;

export interface NotchAnswers {
  /**
   * Says an answer and keeps it until the brain has it. With `once` it is
   * the answer that settles its line (a yes, a pick, an undo): the very same
   * answer said a second time for the same line (the same act, choice, text)
   * has the same number, not a new one, so that a line which came back to be
   * answered (its answer was given up) cannot be answered twice by a first
   * try that was only slow. A different one (another choice) is a new answer:
   * the brain takes the first that reached it, and tells the page so.
   */
  say(answer: Omit<NotchPageAnswer, 'n'>, once?: boolean): void;
  /** The brain has the answer numbered `n`. */
  ack(n: number, took: boolean): void;
  /** A line is drawn anew: an answer to it is a new answer again. */
  fresh(): void;
  /** How many answers wait for the brain. */
  waiting(): number;
  /** Whether an answer about the line `id` waits for the brain. */
  waitsFor(id: string): boolean;
  /** Forgets everything: the page is going away. */
  clear(): void;
}

interface Waiting { answer: NotchPageAnswer; sends: number; timer: number }

export function createNotchAnswers(options: {
  send: (message: NotchFromPage) => void;
  timers: Pick<Timers, 'after' | 'cancel'>;
  /** The brain never said it has this answer: it was said NOTCH_ANSWER_SENDS times, or gave way to newer ones. */
  lost: (answer: NotchPageAnswer) => void;
  /** The brain has it, and it came for a line that was no longer on the notch. */
  late: (answer: NotchPageAnswer) => void;
}): NotchAnswers {
  const { send, timers } = options;
  let last = 0;
  const waiting = new Map<number, Waiting>();
  /** The number each settling answer of a line was given, by line and by what was answered. */
  const given = new Map<string, number>();
  /** The whole of an answer but for when it was given and to which run of the brain. */
  const which = (answer: Omit<NotchPageAnswer, 'n'>): string => {
    const { since: _since, brain: _brain, ...rest } = answer;
    return JSON.stringify(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)));
  };

  const giveUp = (n: number): void => {
    const entry = waiting.get(n);
    if (!entry) return;
    timers.cancel(entry.timer);
    waiting.delete(n);
    options.lost(entry.answer);
  };

  const wait = (n: number, entry: Waiting): void => {
    entry.timer = timers.after(NOTCH_ANSWER_AGAIN_MS, () => {
      if (waiting.get(n) !== entry) return;
      if (entry.sends >= NOTCH_ANSWER_SENDS) { giveUp(n); return; }
      entry.sends++;
      wait(n, entry);
      send(entry.answer);
    });
  };

  return {
    say(answer, once = false) {
      const key = which(answer);
      const before = once ? given.get(key) : undefined;
      const n = before ?? ++last;
      if (once) given.set(key, n);
      const old = waiting.get(n);
      if (old) timers.cancel(old.timer);
      // A word that is changed again before the brain has the last change: only what it is now is worth saying.
      if (answer.act === 'word') {
        for (const [other, entry] of waiting) {
          if (entry.answer.act === 'word' && entry.answer.id === answer.id && entry.answer.word === answer.word) {
            timers.cancel(entry.timer);
            waiting.delete(other);
          }
        }
      }
      const entry: Waiting = { answer: { ...answer, n }, sends: 1, timer: 0 };
      waiting.set(n, entry);
      // Never more than a handful: with the brain away, what a person keeps pressing is not kept for ever.
      while (waiting.size > NOTCH_ANSWERS_WAITING_MAX) giveUp(waiting.keys().next().value as number);
      if (waiting.get(n) !== entry) return;
      // It waits before it is said: whoever is told may answer at once.
      wait(n, entry);
      send(entry.answer);
    },
    ack(n, took) {
      const entry = waiting.get(n);
      if (!entry) return;
      timers.cancel(entry.timer);
      waiting.delete(n);
      if (!took) options.late(entry.answer);
    },
    fresh() {
      // One line's settling answers are remembered at a time: the line before it is gone from the notch.
      given.clear();
    },
    waiting: () => waiting.size,
    waitsFor: (id) => [...waiting.values()].some((entry) => entry.answer.id === id),
    clear() {
      for (const entry of waiting.values()) timers.cancel(entry.timer);
      waiting.clear();
      given.clear();
    },
  };
}
