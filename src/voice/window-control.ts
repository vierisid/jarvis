/**
 * Window-control voice matcher (Phase 6.1.5 follow-up).
 *
 * Recognizes short imperative utterances that target the dashboard's
 * inline RoomWindow chrome (close × / minimize – / expand □) and avoids
 * sending them through the LLM classifier path. Regex-based — actions
 * are a small finite set and the latency win matters.
 *
 * Examples that match:
 *   "close"                      → { action: "close", target: "most_recent" }
 *   "shut the tools room"        → { action: "close", target: "tools" }
 *   "minimize"                   → { action: "minimize", target: "most_recent" }
 *   "minimize the workflows"     → { action: "minimize", target: "workflows" }
 *   "expand"                     → { action: "expand", target: "most_recent" }
 *   "maximize tools please"      → { action: "expand", target: "tools" }
 *   "restore the memory window"  → { action: "restore", target: "memory" }
 *
 * Examples that DO NOT match (fall through to classifier):
 *   "open the tools room"        — handled by intentToRoomKey path
 *   "back to the thread"         — handled by intentIsBackToThread path
 *   "I want to close the email and reply"  — verb not in first words
 */

import type { RoomKey } from "./intent.ts";

export type WindowAction = "close" | "minimize" | "expand" | "restore" | "reorder";

export type WindowControl = {
  action: WindowAction;
  /** A specific Room or `most_recent` if the user didn't name one.
   *  For `reorder` (which is global), this is always `most_recent`
   *  and the UI ignores it. */
  target: RoomKey | "most_recent";
};

/**
 * Maps user-spoken room names (singular or plural) to canonical RoomKey
 * values. Update alongside `RoomKey` if new keys are added.
 */
const ROOM_ALIASES: Record<string, RoomKey> = {
  tool: "tools",
  tools: "tools",
  workflow: "workflows",
  workflows: "workflows",
  log: "logs",
  logs: "logs",
  agent: "agents",
  agents: "agents",
  memory: "memory",
  authority: "authority",
  calendar: "calendar",
  goal: "goals",
  goals: "goals",
  content: "content",
  contents: "content",
  workspace: "workspaces",
  workspaces: "workspaces",
  project: "workspaces",
  projects: "workspaces",
  setting: "settings",
  settings: "settings",
};

// Action verbs grouped by canonical action. Multi-word phrases (e.g.
// "full screen") are matched after token normalization collapses spaces.
const ACTION_VERBS: Record<WindowAction, RegExp> = {
  // Allow up to ~3 polite leading tokens so "please close it" / "can you
  // close" still match. Keep the verb close to the start so longer
  // sentences fall through to the classifier instead.
  close: /^(please\s+|could you\s+|can you\s+|kindly\s+)*(close|shut|dismiss|hide)\b/,
  minimize:
    /^(please\s+|could you\s+|can you\s+|kindly\s+)*(minimi[sz]e|shrink|collapse)\b/,
  expand:
    /^(please\s+|could you\s+|can you\s+|kindly\s+)*(expand|maximi[sz]e|fullscreen|full[\s-]screen)\b/,
  restore:
    /^(please\s+|could you\s+|can you\s+|kindly\s+)*(restore|unminimi[sz]e|reopen|bring back)\b/,
  // "reorder" / "tidy [up]" / "reset layout" — bring all floating windows
  // back to inline placement. Global; no target. Phase 6.1.6.
  reorder:
    /^(please\s+|could you\s+|can you\s+|kindly\s+)*(reorder|tidy(\s+up)?|reset\s+(the\s+)?layout|inline\s+(all|everything)|bring\s+(all|everything)\s+back)\b/,
};

export function matchWindowControl(transcript: string): WindowControl | null {
  const normalized = transcript
    .toLowerCase()
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;

  // Cap utterance length at 8 words — anything longer almost certainly
  // isn't a bare window-control command.
  const words = normalized.split(" ");
  if (words.length > 8) return null;

  let action: WindowAction | null = null;
  for (const [act, rx] of Object.entries(ACTION_VERBS) as [WindowAction, RegExp][]) {
    if (rx.test(normalized)) {
      action = act;
      break;
    }
  }
  if (!action) return null;

  let target: RoomKey | "most_recent" = "most_recent";
  for (const [alias, key] of Object.entries(ROOM_ALIASES)) {
    // Word-boundary so "tool" doesn't match "toolkit"; checked across the
    // full normalized utterance so "close the tools" finds "tools" after
    // the action verb.
    if (new RegExp(`\\b${alias}\\b`).test(normalized)) {
      target = key;
      break;
    }
  }

  return { action, target };
}
