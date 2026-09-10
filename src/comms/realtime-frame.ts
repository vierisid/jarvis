/**
 * Wire tag for realtime voice PCM on the dashboard socket.
 *
 * The daemon sends two kinds of binary frame down the same socket: encoded TTS
 * (MP3/WAV, bracketed by tts_start/tts_end) and raw 24 kHz PCM from a live
 * realtime session, which has no envelope at all. The dashboard used to guess
 * which one a frame was from its voice state, and every wrong guess was
 * audible: MP3 bytes fed to the PCM player come out as static, and PCM fed to
 * the decoder is dropped. The tag makes each frame say what it is.
 *
 * Shared by the daemon (src/daemon/ws-service.ts) and the dashboard
 * (ui/src/hooks/useVoice.ts), so it stays free of Node and DOM APIs.
 *
 * The tag is 4 bytes, an even length, and reads as the samples +1 and -1: a
 * dashboard bundle older than this plays two samples of silence instead of a
 * click, and every sample after it stays aligned.
 *
 * Encoded TTS is chunked at arbitrary byte offsets, so a chunk could begin with
 * these exact bytes and be routed as PCM. That is about 1 in 2^32 per chunk,
 * and only matters while a realtime session is active on the dashboard.
 */
export const REALTIME_PCM_TAG = Uint8Array.of(0x01, 0x00, 0xff, 0xff);

/** Prefix a realtime PCM frame with the tag. */
export function tagRealtimePcm(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(REALTIME_PCM_TAG.length + pcm.byteLength);
  out.set(REALTIME_PCM_TAG, 0);
  out.set(pcm, REALTIME_PCM_TAG.length);
  return out;
}

/** The PCM payload of a tagged frame, or null for any other frame (encoded TTS). */
export function untagRealtimePcm(frame: ArrayBuffer): ArrayBuffer | null {
  if (frame.byteLength < REALTIME_PCM_TAG.length) return null;
  const head = new Uint8Array(frame, 0, REALTIME_PCM_TAG.length);
  for (let i = 0; i < REALTIME_PCM_TAG.length; i++) {
    if (head[i] !== REALTIME_PCM_TAG[i]) return null;
  }
  return frame.slice(REALTIME_PCM_TAG.length);
}
