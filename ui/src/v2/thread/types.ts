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
  | "log";

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
    };

export type ThreadItemKind = ThreadItem["kind"];
