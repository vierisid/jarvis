/**
 * What the trial's pebble looks like right now, as one pure function.
 *
 * ── The bug this file exists to make impossible ──
 *
 * The reported symptom was a message from Jarvis sitting in the bubble while
 * the pebble showed the resting vermilion. Measured in a live session, that
 * state lasted 19.0s and then 13.3s in a single conversation, and the pebble
 * also claimed to be speaking for 491 seconds of pure silence.
 *
 * The cause was that the two halves were driven by different, unrelated
 * signals. The pebble's colour came from TRANSCRIPT events (an assistant
 * delta meant "speaking", a final user transcript meant "listening") and the
 * caption was set by assistant deltas and never cleared. Transcripts are not
 * audio: OpenAI's input transcription completes asynchronously and lands
 * whenever whisper is done, so a user transcript routinely arrives while
 * Jarvis is mid-sentence, and nothing at all is emitted when Jarvis STOPS
 * talking. So the colour and the words drifted apart and stayed apart.
 *
 * The fix is one invariant, enforced here rather than by being careful:
 *
 *   THE BUBBLE SHOWS JARVIS'S WORDS ONLY WHILE THE PEBBLE IS SPEAKING.
 *
 * `speaking` now means exactly one thing: output audio is playing in the
 * founder's speakers. That comes from the RealtimeVoiceController's
 * `onPlaybackStart` / `onPlaybackIdle`, which is what the shell's own pebble
 * has always used (`useVoice.ts`) for the same reason: "the realtime server
 * streams audio without the tts_start/tts_end envelope".
 */

export type ConductorPhase = "connecting" | "speaking" | "listening" | "closed" | "error";

export type PebbleBubble =
  /** Jarvis's words, as they are being spoken. */
  | { kind: "caption"; text: string }
  /** Where the pebble has flown to and what it is pointing at. */
  | { kind: "point"; text: string }
  /** Something went wrong and the founder needs to know. */
  | { kind: "error"; text: string }
  /** Nothing to say: the floor is theirs, or we are still connecting. */
  | { kind: "hint"; text: string };

export type PebbleView = {
  /** The class suffix on `.tc-drop`, and therefore the colour. */
  state: ConductorPhase;
  bubble: PebbleBubble;
};

/** Said in the gaps when the page's credential could not be renewed, so the
 *  rooms have stopped updating under a conversation that has not. */
export const STALE_ROOMS_TEXT = "The rooms have stopped updating. Reload to bring them back.";

export function pebbleView(input: {
  phase: ConductorPhase;
  caption: string;
  error: string | null;
  pointing: string | null;
  /**
   * The page's credential could not be renewed, so every room under this
   * conversation is now refusing to load and anything Jarvis writes will land
   * invisibly. Deliberately does NOT change the colour: the conversation is
   * genuinely still live and painting it as broken would be its own lie. It
   * takes the place of the hint, so it never eats Jarvis's own words.
   */
  stale?: boolean;
}): PebbleView {
  const state: ConductorPhase = input.error ? "error" : input.phase;

  // Pointing is a gesture that replaces the words for as long as it lasts:
  // the founder is meant to be looking at where the pebble went, not reading.
  if (input.pointing) return { state, bubble: { kind: "point", text: input.pointing } };

  if (input.error) return { state, bubble: { kind: "error", text: input.error } };

  // THE INVARIANT. A caption is Jarvis speaking, so it is shown when and only
  // when Jarvis is speaking. Everything else falls through to a hint.
  if (state === "speaking" && input.caption) {
    return { state, bubble: { kind: "caption", text: input.caption } };
  }

  if (input.stale) return { state, bubble: { kind: "error", text: STALE_ROOMS_TEXT } };

  return { state, bubble: { kind: "hint", text: hintFor(state) } };
}

function hintFor(state: ConductorPhase): string {
  switch (state) {
    case "listening": return "your turn";
    case "speaking": return "…";
    case "connecting": return "…";
    default: return "…";
  }
}
