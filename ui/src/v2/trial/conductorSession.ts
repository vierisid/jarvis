/**
 * The browser half of the trial's opening.
 *
 * Owns a WebSocket dedicated to the conductor and a `RealtimeVoiceController`
 * bound to it. Deliberately its OWN socket rather than the shell's: the daemon
 * keys realtime sessions by socket, so a dedicated one keeps the conversation
 * entirely separate from the dashboard's chat, room actions and TTS, and the
 * room beats can later drive the shell over its own connection without ever
 * touching this one.
 *
 * Every server event that matters to the opening arrives here and is handed
 * upward as a plain callback, so the React layer holds no protocol knowledge.
 */

import { RealtimeVoiceController } from "../../lib/RealtimeVoiceController";
import type { TrialStatus } from "./trialGate";

/** One entity as the daemon reports it landing. Mirrors `LandedEntity`. */
export interface LandedEntity {
  id: string;
  name: string;
  type: string;
  role?: string;
  isNew: boolean;
  factCount: number;
}

export interface CapturedFuel {
  area: string;
  summary: string;
  quote?: string;
  at: number;
}

export type ConductorPhase = "connecting" | "speaking" | "listening" | "closed" | "error";

/* ── the seven room beats (D16), as they arrive on the wire ── */

export type RoomBeat = "goals" | "tasks" | "calendar" | "workflows" | "authority" | "agents";

export interface GoalProposal {
  beat: "goals";
  objective: string;
  measure?: string;
  keyResults: { title: string; measure?: string }[];
}

export interface TaskProposal {
  beat: "tasks";
  tasks: {
    what: string;
    due: number | null;
    dueLabel: string | null;
    priority: "low" | "normal" | "high" | "critical";
    late: boolean;
  }[];
}

export interface CalendarProposal {
  beat: "calendar";
  hour: number;
  minute: number;
  because?: string;
}

export interface WorkflowProposal {
  beat: "workflows";
  name: string;
  runsWhen: string;
  steps: string[];
  never?: string;
  building?: boolean;
}

export interface AuthorityProposal {
  beat: "authority";
  level: number;
}

export type BeatProposal =
  | GoalProposal
  | TaskProposal
  | CalendarProposal
  | WorkflowProposal
  | AuthorityProposal;

/** What just became real, for the card's last frame before it dissolves. */
export interface ProposalLanded {
  beat: RoomBeat;
  summary: string;
}

/** D21: fly the pebble somewhere and hold a label there. */
export interface PebblePoint {
  target: string;
  label: string;
  /**
   * The room this gesture is leading them INTO, when it is leading them
   * anywhere. The trial opens it as the surface itself rather than letting the
   * shell open it as an inline window inside the hidden Talk panel.
   */
  room?: string;
  /** Bumped per event so the same target twice still moves it. */
  ts: number;
}

export interface OnboardingComplete {
  beats: RoomBeat[];
  workflows: string[];
  authorityLevel: number | null;
  briefAt: { hour: number; minute: number } | null;
  agent: { agentId: string; agentName: string; question: string } | null;
}

export interface ConductorCallbacks {
  onPhase: (phase: ConductorPhase, detail?: string) => void;
  /** Assistant / founder captions, streamed. */
  onTranscript: (role: "user" | "assistant", text: string, final: boolean) => void;
  /** D22: fires while the founder is still talking. */
  onEntitiesLanded: (landed: LandedEntity[]) => void;
  onFuelCaptured: (fuel: CapturedFuel) => void;
  /** The clock started, or any other entitlement change. */
  onTrialStatus: (status: TrialStatus) => void;
  /** The seam. The conversation is still live when this fires (D17). */
  onOpeningComplete: (understanding: string) => void;
  /** The one thing currently waiting on their spoken yes, or null. */
  onProposal: (proposal: BeatProposal | null, landed?: ProposalLanded) => void;
  /** One of the six stops just finished. */
  onBeatComplete: (beat: RoomBeat, done: RoomBeat[]) => void;
  /** D21: lead their eye somewhere before the room opens. */
  onPoint: (point: PebblePoint) => void;
  /** The finale's agent is running. Onboarding is over, the talking is not. */
  onOnboardingComplete: (summary: OnboardingComplete) => void;
}

export class ConductorSession {
  private cb: ConductorCallbacks;
  private ws: WebSocket | null = null;
  private ctrl: RealtimeVoiceController | null = null;
  private disposed = false;

  constructor(cb: ConductorCallbacks) {
    this.cb = cb;
  }

  /**
   * Connect, claim the conductor role, and open the microphone.
   *
   * The order matters: `trial_conductor_start` has to reach the daemon BEFORE
   * the controller's `voice_start`, or the realtime starter builds an ordinary
   * assistant session, the founder would be greeted by a helpful assistant
   * rather than their co-founder, and only a page reload would fix it. Both
   * travel on the same socket, so send-order is delivery-order.
   */
  async start(): Promise<void> {
    if (this.disposed) return;
    this.cb.onPhase("connecting");

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onmessage = (e) => this.onMessage(e);
    ws.onerror = () => this.cb.onPhase("error", "The connection to Jarvis failed.");
    ws.onclose = () => {
      if (!this.disposed) this.cb.onPhase("closed");
    };

    await new Promise<void>((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) return resolve();
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
    });
    if (this.disposed) return;

    ws.send(JSON.stringify({ type: "trial_conductor_start", payload: {}, timestamp: Date.now() }));

    this.ctrl = new RealtimeVoiceController({
      ws,
      getCurrentRoom: () => "home",
      onError: (msg) => this.cb.onPhase("error", msg),
    });
    await this.ctrl.startStreaming();
  }

  private onMessage(e: MessageEvent): void {
    // Binary = the model's voice. Straight to the speaker.
    if (e.data instanceof ArrayBuffer) {
      this.ctrl?.enqueuePlayback(e.data);
      return;
    }
    let msg: { type?: string; payload?: unknown };
    try {
      msg = JSON.parse(e.data as string);
    } catch {
      return;
    }

    switch (msg.type) {
      case "realtime_status": {
        const p = (msg.payload ?? {}) as { state?: string; message?: string };
        if (p.state === "live") this.cb.onPhase("speaking");
        else if (p.state === "error") this.cb.onPhase("error", p.message);
        else if (p.state === "closed") this.cb.onPhase("closed", p.message);
        return;
      }
      case "realtime_transcript": {
        const p = (msg.payload ?? {}) as { role?: "user" | "assistant"; text?: string; final?: boolean };
        if (!p.role || typeof p.text !== "string") return;
        this.cb.onTranscript(p.role, p.text, Boolean(p.final));
        return;
      }
      case "tts_end": {
        // Barge-in: the founder started talking over Jarvis. Drop the audio
        // still queued locally so their voice is not fighting a speaker.
        const p = (msg.payload ?? {}) as { bargeIn?: boolean };
        if (p.bargeIn) {
          this.ctrl?.flushPlayback();
          this.cb.onPhase("listening");
        }
        return;
      }
      case "trial_memory": {
        const p = (msg.payload ?? {}) as { landed?: LandedEntity[] };
        if (Array.isArray(p.landed) && p.landed.length > 0) this.cb.onEntitiesLanded(p.landed);
        return;
      }
      case "trial_fuel":
        this.cb.onFuelCaptured(msg.payload as CapturedFuel);
        return;
      case "trial_status":
        this.cb.onTrialStatus(msg.payload as TrialStatus);
        return;
      case "trial_opening_complete": {
        const p = (msg.payload ?? {}) as { understanding?: string };
        this.cb.onOpeningComplete(p.understanding ?? "");
        return;
      }
      case "trial_proposal": {
        const p = (msg.payload ?? {}) as { proposal?: BeatProposal | null; landed?: ProposalLanded };
        this.cb.onProposal(p.proposal ?? null, p.landed);
        return;
      }
      case "trial_beat": {
        const p = (msg.payload ?? {}) as { beat?: RoomBeat; done?: RoomBeat[] };
        if (p.beat) this.cb.onBeatComplete(p.beat, p.done ?? []);
        return;
      }
      case "trial_point": {
        const p = (msg.payload ?? {}) as { target?: string; label?: string; room?: string };
        if (p.target) {
          this.cb.onPoint({ target: p.target, label: p.label ?? "", room: p.room, ts: Date.now() });
        }
        return;
      }
      case "trial_onboarding_complete": {
        this.cb.onOnboardingComplete((msg.payload ?? {}) as OnboardingComplete);
        return;
      }
      case "error": {
        const p = (msg.payload ?? {}) as { code?: string; message?: string };
        // The only error worth surfacing here is the refusal to open the
        // conductor at all; the rest belong to the shell's own socket.
        if (p.code === "no_trial") this.cb.onPhase("error", p.message);
        return;
      }
      default:
        return;
    }
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.ctrl?.dispose();
    } catch {
      /* audio graph already gone */
    }
    this.ctrl = null;
    try {
      this.ws?.close();
    } catch {
      /* socket already gone */
    }
    this.ws = null;
  }
}

/**
 * Ask for the microphone (D10: voice is mandatory; if it is not granted, a
 * prompt asks for it).
 *
 * Returns the browser's verdict rather than throwing, because "they said no"
 * is a designed state here, not an exception: the screen stays and asks again.
 * The stream is released immediately, the realtime controller opens its own,
 * and holding a second one keeps the OS recording indicator lit for no reason.
 */
export async function requestMicrophone(): Promise<"granted" | "denied" | "unavailable"> {
  if (!navigator.mediaDevices?.getUserMedia) return "unavailable";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return "granted";
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable";
  }
}

/** Has the microphone already been granted in a previous session? */
export async function microphoneAlreadyGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    return status?.state === "granted";
  } catch {
    // Firefox and Safari do not expose the microphone permission here. Fall
    // back to asking, which is a no-op prompt when it is already granted.
    return false;
  }
}
