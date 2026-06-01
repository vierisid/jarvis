/**
 * Thread domain types. Mirrors the handoff COMPONENTS.md + VOICE_SCHEMA.md contracts.
 * The thread is the single surface for all conversational content; items flow
 * through this union regardless of source (voice STT, text composer, daemon reply).
 */

export type Impact = "read" | "write" | "destructive" | "external";

export type ObjectType =
  | "workflow"
  | "memory"
  | "tool"
  | "agent"
  | "authority"
  | "log"
  | "calendar"
  | "goals"
  | "tasks"
  | "content"
  | "workspaces"
  | "usage"
  | "settings";

export type JarvisSpeechStatus = "speaking" | "done";

export type ThreadItem =
  | {
      kind: "user-voice";
      id: string;
      text: string;
      t: string;
    }
  | {
      kind: "user-text";
      id: string;
      text: string;
      t: string;
    }
  | {
      kind: "jarvis-speech";
      id: string;
      text: string;
      t: string;
      status: JarvisSpeechStatus;
    }
  | {
      kind: "jarvis-thought";
      id: string;
      text: string;
      t: string;
    }
  | {
      kind: "approval";
      id: string;
      /** Short imperative sentence, e.g. "Delete 14 files in ~/Downloads". */
      intent: string;
      /** Soft-gate category, e.g. "authority.approve", "send_email". */
      category: string;
      impact: Impact;
      /** Highlight spans inside the intent sentence (accent color). */
      highlights?: string[];
      t: string;
    }
  | {
      kind: "card";
      id: string;
      objectType: ObjectType;
      /** Object id or lookup reference. */
      ref: string;
      title: string;
      summary?: string;
      /** Ambient metadata rendered as mono meta-line (e.g. "v7 · 1,241 runs"). */
      meta?: string;
      /** Short status ("Running", "Active", "Idle") — rendered as a Chip. */
      status?: { label: string; tone: "ok" | "warn" | "neutral" | "accent" };
      t: string;
    }
  | {
      kind: "result";
      id: string;
      summary: string;
      detail?: string;
      t: string;
    }
  | {
      kind: "clarifier";
      id: string;
      transcript: string;
      /** Daemon's best guess; see VoiceIntentLite. */
      primary: VoiceIntentLite;
      /** Optional alternatives shown alongside the primary. */
      alternatives: VoiceIntentLite[];
      confidence: number;
      t: string;
    }
  | {
      kind: "repeat-back";
      id: string;
      transcript: string;
      confidence: number;
      t: string;
    }
  | {
      /**
       * Phase 6.1.5 / 6.1.6 — a Room rendered as a browser-window-style card.
       * `state`  controls header-only vs full body:
       *   "inline"     → header + body shown
       *   "minimized"  → header strip only (body collapsed)
       * `layout` controls placement on screen (Phase 6.1.6):
       *   {mode:"inline"}                  → renders in the thread flow
       *   {mode:"floating", rect:{x,y,w,h}} → renders absolutely positioned
       *                                       in the floating layer over the
       *                                       thread (per-room persisted)
       * Expanding (□ traffic light) opens the fullscreen RoomShell overlay;
       * closing the overlay returns to this state.
       */
      kind: "room-window";
      id: string;
      roomKey:
        | "workflows"
        | "memory"
        | "tools"
        | "agents"
        | "authority"
        | "logs"
        | "calendar"
        | "goals"
        | "tasks"
        | "content"
        | "workspaces"
        | "usage"
        | "settings";
      state: "inline" | "minimized";
      layout: { mode: "inline" } | {
        mode: "floating";
        rect: { x: number; y: number; w: number; h: number };
      };
      t: string;
    };

/**
 * Lite version of the daemon-side `Intent` that the UI actually renders.
 * Only the fields the cards need — the full `args` and `object.id` aren't
 * surfaced in v1 of the clarifier card.
 */
export type VoiceIntentLite = {
  /** Human-readable label, e.g. "Send the email now". */
  label: string;
  verb: string;
  impact: Impact;
};

export type ThreadItemKind = ThreadItem["kind"];
