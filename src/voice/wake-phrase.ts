/**
 * Wake-phrase detection for outgoing TTS text.
 *
 * Used by the daemon to flag TTS sentences that contain "Jarvis" so the
 * UI can suppress its wake-word recognizer for the duration of that
 * playback. Without this, TTS audio bleeds back through the speakers and
 * the SpeechRecognition wake matcher hears Jarvis say his own name and
 * interrupts the in-flight reply.
 *
 * Word-boundary aware so we don't false-positive on substrings like
 * "Jarvisson". Case-insensitive. Also matches the loose "hey jarvis"
 * variant the recognizer accepts on the UI side.
 */
export function containsWakePhrase(text: string): boolean {
  if (!text) return false;
  return /\bjarvis\b/i.test(text);
}

/**
 * True when outgoing TTS text contains a spoken stop command ("Jarvis
 * stop" / "Jarvis (be) quiet"). Stop phrases deliberately bypass the
 * containsWake echo suppression on the UI side so the user can interrupt
 * a reply that says "Jarvis" — but if the reply itself *speaks* a stop
 * phrase (e.g. explaining "say 'Jarvis, stop' to interrupt me"), that
 * bypass would let the echo cancel the playback. This flag closes that
 * hole: the UI re-enables suppression for stop phrases while flagged
 * audio is playing. Tolerates punctuation between the words, which is
 * how TTS text usually renders them ("Jarvis, stop").
 */
export function containsStopPhrase(text: string): boolean {
  if (!text) return false;
  return /\bjarvis\b\W+(?:stop|(?:be\s+)?quiet)\b/i.test(text);
}

/**
 * True when a transcript carries something a person actually said, as
 * opposed to punctuation an STT engine tacked onto silence. Whisper and
 * friends will happily render a door slam as "." or "?!", and every such
 * string is truthy, so a bare `if (!transcript)` guard lets it through to
 * the LLM as a whole user turn. A promptless "!" is a known trigger for a
 * degenerate completion: one answered by counting upwards for three
 * hundred lines and queued five minutes of speech behind it.
 */
export function hasSpokenContent(text: string): boolean {
  if (!text) return false;
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Separators an STT engine puts between the wake word and the command:
 * whitespace, sentence punctuation, dashes and quotes. Deliberately NOT
 * every punctuation mark -- "Jarvis, $100 budget" and "Jarvis, #general"
 * must keep the leading character, since it belongs to the command
 * rather than to the gap in front of it.
 */
const WAKE_SEPARATORS = /^[\s,.;:!?\u00a1\u00bf\u2026'"\u2018\u2019\u201c\u201d\u00ab\u00bb\-\u2013\u2014]+/;

/**
 * Pull the command out of a wake segment: everything after the LAST
 * "jarvis" in the transcript, so "I'm at home, Jarvis play music" =>
 * "play music". Returns "" when the user only said the wake word, which
 * is the caller's signal to open the mic and listen for the command
 * instead of running one.
 *
 * The separator strip has to cover sentence-final punctuation, because
 * STT renders a bare summon as "Hey Jarvis." or "Hey Jarvis!" more or
 * less at random. A leftover "!" is not a command, and it used to run as
 * one. `hasSpokenContent` is the backstop that makes that structural:
 * whatever survives the strip must contain a letter or a digit.
 */
export function wakeCommandFrom(text: string): string {
  if (!text) return '';
  const re = /\bjarvis\b/gi;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m;
  }
  if (!last) return '';
  const rest = text.slice(last.index + last[0].length).replace(WAKE_SEPARATORS, '').trim();
  return hasSpokenContent(rest) ? rest : '';
}
