import type { VoiceState as HookVoiceState } from "../../hooks/useVoice";
import type { VoiceState as UIVoiceState } from "../shell/VoiceRail";

/**
 * Translate the `useVoice` hook's state machine into the v2 UI's state union.
 *
 * Hook states (from `ui/src/hooks/useVoice.ts:35-41`):
 *   idle | wake_detected | recording | processing | speaking | error
 *
 * v2 UI states (from `ui/src/v2/shell/VoiceRail.tsx`):
 *   idle | listening | thinking | speaking | awaiting-approval | muted
 *
 * Three cross-cutting concerns short-circuit the mapping (in priority order):
 *   - `muted=true` always wins (overrides everything; the orb shows muted)
 *   - `awaitingApproval=true` shows the warn ring, even mid-speech
 *   - `daemonThinking=true` (Phase 4B) keeps the orb in thinking-state during
 *     the gap between STT-final and the first TTS chunk, where `useVoice`
 *     would otherwise have already returned to idle
 *
 * `error` collapses to `idle` because the hook auto-recovers in 3s. We
 * could surface a transient error chip later; for Phase 4A this is fine.
 */
export function mapVoiceState(
  hookState: HookVoiceState,
  opts: { muted: boolean; awaitingApproval: boolean; daemonThinking?: boolean },
): UIVoiceState {
  if (opts.muted) return "muted";
  if (opts.awaitingApproval) return "awaiting-approval";

  switch (hookState) {
    case "idle":
      // Honor the daemon's thinking flag during the post-STT / pre-TTS gap.
      return opts.daemonThinking ? "thinking" : "idle";
    case "wake_detected":
    case "recording":
      return "listening";
    case "processing":
      return "thinking";
    case "speaking":
      return "speaking";
    case "error":
      return "idle";
    default:
      return "idle";
  }
}
