/**
 * The pebble's short spoken confirmation for a fast-path turn (#964).
 *
 * One copy, used by every fast path in src/daemon/index.ts. A turn can be
 * cancelled at any await before or during the confirmation (the user presses
 * the summon key again, the mic is blocked, the sidecar goes away). Whoever
 * cancels it puts the pebble in its next state themselves (`idle`, `muted`),
 * so a cancelled confirmation must not touch the pebble at all:
 *
 * - cancelled before it starts: no bubble, no heartbeat, no audio. It used to
 *   set `speaking` with the text first and only then look at the flag, and
 *   return without going back to idle, so the pebble was left in `speaking`
 *   with a reply to a turn the user had already dismissed.
 * - cancelled while the speech was being synthesized: the clip is not played.
 *   The canceller has already stopped audio; playing it after that spoke over
 *   the dismissal.
 * - cancelled during the hold: the canceller's state stands, so no `idle`.
 *
 * NO IMPORTS: everything live is passed in, so this is testable without the
 * daemon.
 */

export type ConfirmationCtrl = { readonly cancelled: boolean };

export interface SpeakConfirmationDeps {
  setState: (sidecarId: string, state: string, text?: string) => Promise<void>;
  /** Mirror the text to the dashboard, and only there (#1026). Errors are swallowed. */
  heartbeat: (text: string) => void;
  /** The current TTS synthesizer, or null when TTS is off. Read per call: settings can swap it. */
  synthesizer: () => ((text: string) => Promise<Buffer>) | null;
  /** Start non-blocking playback of a synthesized clip on the pebble. */
  play: (sidecarId: string, audio: Buffer) => Promise<void>;
  /** Wait roughly as long as the clip takes to play. */
  hold: (ms: number) => Promise<void>;
  warn?: (message: string, err: unknown) => void;
}

export type SpeakConfirmation = (
  sidecarId: string,
  text: string,
  ctrl: ConfirmationCtrl,
  opts?: { heartbeat?: boolean },
) => Promise<void>;

/** How long the bubble stays up for a confirmation of this length. */
export function confirmationHoldMs(text: string): number {
  return Math.max(800, text.length * 60);
}

export function makeSpeakConfirmation(deps: SpeakConfirmationDeps): SpeakConfirmation {
  return async (sidecarId, text, ctrl, opts) => {
    // Checked before anything reaches the pebble: see the header.
    if (ctrl.cancelled) return;
    await deps.setState(sidecarId, 'speaking', text);
    if (opts?.heartbeat !== false && !ctrl.cancelled) {
      try { deps.heartbeat(text); } catch { /* ignore */ }
    }
    const synthesize = deps.synthesizer();
    if (synthesize && !ctrl.cancelled) {
      try {
        const audio = await synthesize(text);
        // A cancel that lands while this play RPC is in flight can still start
        // the clip after the canceller's stop_audio; that window is one RPC.
        if (!ctrl.cancelled) await deps.play(sidecarId, audio);
      } catch (err) {
        deps.warn?.('[ambient-ui] confirmation TTS failed:', err);
      }
    }
    if (ctrl.cancelled) return;
    await deps.hold(confirmationHoldMs(text));
    if (!ctrl.cancelled) await deps.setState(sidecarId, 'idle', '');
  };
}
