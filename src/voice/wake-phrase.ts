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
