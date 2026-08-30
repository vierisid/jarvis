import type { ConnectionState } from "../shell/Header";
import type { VoiceState } from "../shell/VoiceRail";

export const JARVIS_CORE_STATES = [
  "SLEEPING",
  "AWAKENING",
  "IDLE",
  "LISTENING",
  "THINKING",
  "WORKING",
  "WAITING_APPROVAL",
  "SPEAKING",
  "ERROR",
] as const;

export type JarvisCoreState = (typeof JARVIS_CORE_STATES)[number];

export interface JarvisCoreSignals {
  connection: ConnectionState;
  voiceState: VoiceState;
  isBooting?: boolean;
  isSleeping?: boolean;
  hasActiveWork?: boolean;
  hasPendingApproval?: boolean;
  hasError?: boolean;
}

/**
 * One deterministic priority order for every CORE consumer. Keep this pure:
 * animation, copy, Activity and accessibility must never disagree about the
 * state Jarvis is in.
 */
export function deriveJarvisCoreState(signals: JarvisCoreSignals): JarvisCoreState {
  if (signals.hasError || signals.connection === "offline") return "ERROR";
  if (signals.isBooting || signals.connection === "degraded") return "AWAKENING";
  if (signals.isSleeping) return "SLEEPING";
  if (signals.hasPendingApproval || signals.voiceState === "awaiting-approval") {
    return "WAITING_APPROVAL";
  }

  switch (signals.voiceState) {
    case "speaking":
      return "SPEAKING";
    case "listening":
      return "LISTENING";
    case "thinking":
      return "THINKING";
    case "muted":
      return "SLEEPING";
    case "idle":
      return signals.hasActiveWork ? "WORKING" : "IDLE";
  }
}
