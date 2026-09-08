/**
 * Microphone constraints for a browser-side wake-word listener.
 *
 * Kept even though the dashboard does not currently run one (see
 * selectActiveWakeEngine): if the engine is ever re-enabled it must not take
 * the output device with it.
 *
 * The engine opens the microphone with `getUserMedia({ audio: true })`, i.e.
 * Chromium's defaults, which turn on echo cancellation, noise suppression and
 * automatic gain control. Echo cancellation is the expensive one: to cancel
 * echo the browser has to know what is being played, so it attaches itself to
 * the output endpoint and Windows treats the capture stream as communications
 * activity. The observable result was that audio played by ANY process on that
 * endpoint degraded while a dashboard was open, including the sidecar's own
 * speech, which the dashboard is not otherwise involved in.
 *
 * A wake-word detector wants none of the three anyway: they all reshape the
 * audio the model was trained on.
 */

/**
 * Microphone constraints for the wake-word listener.
 *
 * A wake-word detector wants the rawest signal it can get: echo cancellation,
 * noise suppression and gain control all reshape the audio the model was
 * trained on, and echo cancellation is what pulls the browser onto the output
 * device. None of the three earns its place here.
 */
export const WAKE_MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};



/**
 * Applies WAKE_MIC_CONSTRAINTS to whatever `fn` opens, then restores the
 * original getUserMedia.
 *
 * This is a wrapper rather than a parameter because the upstream engine
 * hardcodes `audio: true` and its `start()` accepts only `deviceId` and `gain`,
 * so there is no seam to pass constraints through. The override is installed
 * for the duration of one `start()` call and removed in a finally.
 *
 * Caveat, deliberately accepted: a getUserMedia call made by something else
 * during that window would also get these constraints. The window is one
 * engine start, and the only other caller in the app is the recorder, which
 * cannot run while the wake engine is starting.
 */
export async function withWakeMicConstraints<T>(fn: () => Promise<T>): Promise<T> {
  const md = globalThis.navigator?.mediaDevices;
  if (!md?.getUserMedia) return fn();

  // Capture the property as-is and restore exactly that. Binding it first and
  // restoring the bound copy would leave the native method permanently replaced
  // and stack a new binding on every call.
  const original = md.getUserMedia;
  md.getUserMedia = function (constraints?: MediaStreamConstraints) {
    return original.call(md, mergeWakeMicConstraints(constraints));
  };
  try {
    return await fn();
  } finally {
    md.getUserMedia = original;
  }
}

/**
 * Folds WAKE_MIC_CONSTRAINTS into whatever the caller asked for, preserving any
 * device selection it made. Exported for testing.
 */
export function mergeWakeMicConstraints(
  constraints: MediaStreamConstraints | undefined,
): MediaStreamConstraints {
  const audio = constraints?.audio;
  if (audio === false) return { ...constraints, audio: false };
  if (audio && typeof audio === "object") {
    return { ...constraints, audio: { ...audio, ...WAKE_MIC_CONSTRAINTS } };
  }
  // `true`, or absent: the engine's own default.
  return { ...constraints, audio: { ...WAKE_MIC_CONSTRAINTS } };
}
