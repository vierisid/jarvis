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
