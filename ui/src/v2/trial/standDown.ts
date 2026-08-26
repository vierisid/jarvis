/**
 * When the conductor lets go, as one pure function.
 *
 * ── What this file exists to make impossible ──
 *
 * Vieri, after the third full run: *"it basically doesn't give me the
 * opportunity to really use Jarvis because it stays on that onboarding thing.
 * I can't click on the pebble to open it and chat to it."*
 *
 * The conducted conversation draws its own pebble over the live shell, so the
 * shell's own pebble and its Talk panel are suppressed while it runs. Nothing
 * ever took that suppression off. The trial is 48 hours and the conducted part
 * is about one; the founder spent the other 47 unable to use the product the
 * hour had just sold them.
 *
 * So there is now a moment where the conductor lets go, and it is a STATE
 * TRANSITION, which is exactly the kind of thing that half-works. The rules it
 * has to satisfy pull against each other:
 *
 *  1. It must ALWAYS happen. Not when the model remembers to ask for it, not
 *     only when the founder presses the key they were asked to press. A
 *     handover that depends on either would reintroduce the original fault
 *     with a new cause.
 *  2. It must not cut Jarvis off mid-word. The founder has just been asked to
 *     press a key and is about to be told they got it right; standing down
 *     over the top of that sentence would make the warmest moment in the
 *     handover the one that gets clipped.
 *  3. It must not wait forever for a sentence that is not coming. A model that
 *     says nothing after the acknowledgement, a socket that dies, an OpenAI
 *     account out of credit: all of them end with the founder in their shell.
 *
 * Hence: a request to stand down waits for the next gap in the speech, with
 * two backstops behind it. Everything below is pure so all three rules can be
 * tested without a browser, a microphone or an hour of conversation.
 */

export type StandDownInput = {
  /** When the daemon asked for it, or null if it has not. */
  requestedAt: number | null;
  /** When onboarding's last building beat finished, or null. The backstop. */
  finishedAt: number | null;
  /** Is Jarvis's audio playing in their speakers right now? */
  speaking: boolean;
  /** Has any audio played since the request came in? */
  spokeSinceRequest: boolean;
  now: number;
};

/**
 * How long to hold a requested stand-down open for a sentence that has not
 * started yet.
 *
 * The tool result comes back, the model composes the acknowledgement, and the
 * first audio frame arrives a moment later. Measured on this branch, the gap
 * between an assistant's final transcript and its audio finishing has been as
 * wide as seven seconds, so the wait for a sentence to START has to be
 * comfortably longer than a network round trip and comfortably shorter than a
 * founder wondering why nothing happened.
 */
export const STANDDOWN_SPEECH_GRACE_MS = 9_000;

/** The hard ceiling. Whatever is happening, the shell comes back by now. */
export const STANDDOWN_MAX_WAIT_MS = 30_000;

/**
 * Rule 1's backstop, and the one that actually fixes the reported bug.
 *
 * If the model never calls `teach_summon` at all, nothing ever requests a
 * stand-down and the founder is exactly where they were on 26 August. So the
 * surface arms its own timer the moment onboarding's last building beat
 * completes, and hands the shell back regardless. Five minutes is long enough
 * that a founder still talking about their quarter is not interrupted, and
 * short enough that nobody sits under a finished conductor for an evening.
 */
export const STANDDOWN_BACKSTOP_MS = 5 * 60_000;

export type StandDownVerdict =
  /** Nothing has asked for it and the backstop has not run out. */
  | { stand: false; because: "not-asked" }
  /** Asked for, but Jarvis is mid-sentence. Wait for the gap. */
  | { stand: false; because: "speaking" }
  /** Asked for, silent so far, still inside the grace for a sentence to start. */
  | { stand: false; because: "waiting-for-speech" }
  /** Hand the shell back, and why. */
  | { stand: true; because: "spoke-and-stopped" | "nothing-said" | "timed-out" | "backstop" };

export function standDownVerdict(input: StandDownInput): StandDownVerdict {
  const { requestedAt, finishedAt, speaking, spokeSinceRequest, now } = input;

  if (requestedAt === null) {
    // Rule 1. Nobody asked, so the backstop is the only thing that can fire,
    // and it never fires over the top of a sentence either.
    if (finishedAt !== null && now - finishedAt >= STANDDOWN_BACKSTOP_MS && !speaking) {
      return { stand: true, because: "backstop" };
    }
    return { stand: false, because: "not-asked" };
  }

  const waited = now - requestedAt;

  // Rule 3, and it outranks everything: past the ceiling the shell comes back
  // whatever else is true, including mid-sentence. A conversation that has not
  // stopped in thirty seconds is not the acknowledgement.
  if (waited >= STANDDOWN_MAX_WAIT_MS) return { stand: true, because: "timed-out" };

  // Rule 2. Jarvis is talking; this is the sentence the founder earned.
  if (speaking) return { stand: false, because: "speaking" };

  // It spoke and it has stopped: that is the gap, and it is the good ending.
  if (spokeSinceRequest) return { stand: true, because: "spoke-and-stopped" };

  // Nothing has been said yet. Hold briefly for a sentence that is on its way,
  // then stop holding: silence is not a reason to keep the founder waiting.
  if (waited >= STANDDOWN_SPEECH_GRACE_MS) return { stand: true, because: "nothing-said" };
  return { stand: false, because: "waiting-for-speech" };
}
