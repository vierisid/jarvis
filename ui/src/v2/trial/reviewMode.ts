/**
 * Is somebody REVIEWING this trial run, or living it?
 *
 * There is exactly one thing on the trial surface that exists for the reviewer
 * and not for the founder: coverage of the opening's five fuel areas. It was
 * rendered in the footer as `2/5`, unconditionally, and Vieri saw it during
 * the second full run and read it as what it looks like, a progress meter.
 *
 * Two reasons it should not have been on his screen:
 *
 *   1. D12. "Do NOT tell them how long this takes, how many things you need,
 *      or how far along they are. There is no progress here." That rule is in
 *      the conductor's prompt as an instruction about what Jarvis SAYS, and a
 *      counter pinned to the bottom of the screen makes the same claim in a
 *      different medium, permanently, without anybody deciding to.
 *
 *   2. It is not even the number it appears to be. It counts the five fuel
 *      areas captured during the OPENING, not the eight room beats. A founder
 *      seeing "2/5" while they build their quarter thinks they are two ninths
 *      of the way through a conversation they are in fact well past the start
 *      of. A progress bar that lies is worse than one that does not exist.
 *
 * The reviewer's need is real, so the counter is not deleted, it is addressed
 * to the person it was written for. Add `?trialreview=1` to the dashboard URL
 * once and it stays on for that browser until `?trialreview=0` turns it off.
 *
 * Pure and injectable so it can be tested without a browser, which is the same
 * shape as trialGate.ts and pebbleState.ts beside it.
 */

export const REVIEW_KEY = 'jarvis.trialReview';
export const REVIEW_PARAM = 'trialreview';

export type Storage = {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
};

/**
 * Reads the query string first, because that is how it gets turned on, and
 * persists the answer, because a trial is an hour long and nobody wants to
 * re-add a query parameter after a reload.
 */
export function reviewModeFrom(search: string, store: Storage | null): boolean {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return false;
  }
  const asked = params.get(REVIEW_PARAM);
  if (asked !== null) {
    const on = asked !== '0' && asked !== 'false';
    try {
      if (on) store?.setItem(REVIEW_KEY, '1');
      else store?.removeItem(REVIEW_KEY);
    } catch {
      /* private mode, a blocked origin: not worth failing the trial over */
    }
    return on;
  }
  try {
    return store?.getItem(REVIEW_KEY) === '1';
  } catch {
    return false;
  }
}

/** The same question, asked of the real browser. */
export function isReviewMode(): boolean {
  if (typeof window === 'undefined') return false;
  let store: Storage | null = null;
  try {
    store = window.localStorage;
  } catch {
    store = null;
  }
  return reviewModeFrom(window.location.search, store);
}
