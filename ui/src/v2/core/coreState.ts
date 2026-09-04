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

export interface JarvisAgentActivitySignal {
  agentName: string;
  eventType: string;
  timestamp: number;
}

/**
 * Agent activity is an append-only event stream. Only the newest event for
 * each agent is authoritative; an older tool_call must not keep CORE in
 * WORKING after that agent has emitted done.
 */
export function hasActiveAgentWork(events: JarvisAgentActivitySignal[]): boolean {
  const latestByAgent = new Map<string, JarvisAgentActivitySignal>();
  for (const event of events) {
    const current = latestByAgent.get(event.agentName);
    if (!current || event.timestamp > current.timestamp) {
      latestByAgent.set(event.agentName, event);
    }
  }
  return [...latestByAgent.values()].some((event) => event.eventType !== "done");
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
