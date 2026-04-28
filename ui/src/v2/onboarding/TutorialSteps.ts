import type { TutorialEventName } from "./TutorialEventContext";
import type { RoomKey } from "../router";

/**
 * Phase C — the 12-step spotlight walkthrough script.
 *
 * Each step has:
 *   - `id`             stable string for resume-from-step support
 *   - `target`         CSS selector to spotlight, or "viewport" for
 *                       a centered card with no cut-out
 *   - `narration`      what Jarvis speaks AND the bubble shows
 *   - `tryHint`        optional one-line "try it yourself" hint
 *   - `autoAdvanceOn`  optional event name; when fired by the AppShell,
 *                       the tour moves to the next step
 *   - `prefer`         optional bubble-anchor preference
 *   - `requireSampleCard`/`requireSampleRoomWindow`/`requireSampleApproval`
 *                       set on steps that need synthetic items injected
 *                       into the thread to have something to spotlight
 *   - `injectSampleApproval` similar — but for the approval card
 *
 * Sequenced top-to-bottom of the screen so the user's eye flow stays
 * natural. Verified selectors against the actual JSX/CSS during the
 * Phase C audit.
 */

export type SpotlightAnchor = "top" | "bottom" | "left" | "right";

export interface TutorialStep {
  id: string;
  target: string;
  narration: string;
  tryHint?: string;
  autoAdvanceOn?: TutorialEventName;
  prefer?: SpotlightAnchor;
  /** True for steps that need a synthetic InlineCard in the thread. */
  requireSampleCard?: boolean;
  /** True for steps that need a synthetic RoomWindow in the thread. */
  requireSampleRoomWindow?: boolean;
  /** True for steps that need a synthetic ApprovalCard in the thread. */
  requireSampleApproval?: boolean;
  /** Open this Room fullscreen before the step renders. The TutorialRoom
   *  dispatches a `v2-tutorial:open-room` window event with the key;
   *  AppShell handles it by calling `openRoom(key)`. Used for the
   *  per-room walkthrough block so the user sees each Room behind the
   *  spotlight while Jarvis explains it. */
  openRoomBefore?: RoomKey;
  /** Close any open Room before the step renders. Pairs with
   *  `openRoomBefore` on the step that exits the room block (the outro). */
  closeRoomBefore?: boolean;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: "intro-welcome",
    target: "viewport",
    narration:
      "Welcome to Jarvis. I'll take you through the dashboard in about ten minutes. You can press Next, say 'next', or just try the highlighted feature yourself to advance.",
  },
  {
    id: "thread",
    target: ".v2-thread",
    narration:
      "This is the thread, your conversation with me. Everything we say lives here, persistent across sessions. New replies, suggestions, and approvals appear here in real time.",
    prefer: "right",
  },
  {
    id: "composer",
    target: ".v2-composer",
    narration:
      "Type to me here. Press slash to summon a tool, press Cmd-K for the palette, or just hit Enter to send.",
    tryHint: "Type something and hit Enter.",
    prefer: "top",
  },
  {
    id: "voice-rail",
    target: ".v2-rail",
    narration:
      "I'm always listening for the wake word. Say 'Jarvis' to interrupt me at any time, or hold the spacebar to push-to-talk. The orb shows my voice state — idle, listening, thinking, speaking.",
    prefer: "left",
  },
  {
    id: "inline-card",
    target: ".v2-card",
    narration:
      "When I bring up an object — a workflow, a memory, a task — it shows as a card right in the thread. Click Focus to open it as a room.",
    requireSampleCard: true,
    prefer: "right",
  },
  {
    id: "inline-roomwindow",
    target: ".v2-roomwin",
    narration:
      "Rooms can also live inline as draggable windows. Drag the title bar to detach into a floating panel. Click the close, minimize, or expand circles in the corner to control them.",
    requireSampleRoomWindow: true,
    prefer: "right",
  },
  {
    id: "palette",
    target: ".v2-header__palette",
    narration:
      "Press Command-K, or click here, to open the palette. It's your fastest way to jump anywhere or search across everything I know.",
    tryHint: "Press ⌘K to open the palette.",
    autoAdvanceOn: "palette_opened",
    prefer: "bottom",
  },
  {
    id: "rooms-fullscreen",
    target: ".v2-room-overlay",
    narration:
      "When I open a room fullscreen, it covers the dashboard so you can focus. Press Escape to return to the thread. Now let me give you the quick tour of every room.",
    tryHint: "Try opening a room from the palette, then press Escape.",
    autoAdvanceOn: "room_opened",
  },

  // ── Per-room mini-tour ────────────────────────────────────────────
  // One short step per Room, opened automatically as we advance. The
  // user sees each surface behind the spotlight while Jarvis explains
  // what it's for. Single sentence each — this is "what does this do",
  // not "how to use it". Sequenced roughly by how often a typical user
  // touches each room.

  {
    id: "room-workflows",
    target: ".v2-room-overlay",
    narration:
      "Workflows are visual automations. Build them by dragging nodes — triggers, conditions, actions — or just describe what you want and I'll wire them up. Cron, webhooks, file changes, calendar events, you name it.",
    openRoomBefore: "workflows",
  },
  {
    id: "room-memory",
    target: ".v2-room-overlay",
    narration:
      "Memory is everything I remember about you and your world — facts, projects, relationships, conversations. Search it, browse by source, or watch it grow as we talk.",
    openRoomBefore: "memory",
  },
  {
    id: "room-tasks",
    target: ".v2-room-overlay",
    narration:
      "Tasks are the to-do side. Anything you mention, I capture here automatically — by deadline, by project, by priority. I'll also add tasks I want to do for you and ask before running them.",
    openRoomBefore: "tasks",
  },
  {
    id: "room-goals",
    target: ".v2-room-overlay",
    narration:
      "Goals are your OKRs — north-star outcomes broken into measurable key results. I check in each morning to plan, each evening to review, and nudge you if you're falling behind.",
    openRoomBefore: "goals",
  },
  {
    id: "room-calendar",
    target: ".v2-room-overlay",
    narration:
      "Calendar shows your schedule across every connected source — Google Calendar, holds you've asked me to make, focus blocks. I use this to time suggestions and avoid pinging you mid-meeting.",
    openRoomBefore: "calendar",
  },
  {
    id: "room-content",
    target: ".v2-room-overlay",
    narration:
      "Content is the inbox for things I've made for you — research summaries, drafts, briefs, code snippets. Each one shows what I read to make it, so you can verify before using.",
    openRoomBefore: "content",
  },
  {
    id: "room-agents",
    target: ".v2-room-overlay",
    narration:
      "Agents are the specialist roles I delegate to — researcher, builder, planner, and so on. Each has its own tools and authority band. You can spawn them by name or let me pick.",
    openRoomBefore: "agents",
  },
  {
    id: "room-tools",
    target: ".v2-room-overlay",
    narration:
      "Tools is every capability I have — built-in actions, sidecar handlers, browser controls, terminal access. Browse them, see permissions, or run one ad-hoc to test it.",
    openRoomBefore: "tools",
  },
  {
    id: "room-authority",
    target: ".v2-room-overlay",
    narration:
      "Authority is your control panel for what I'm allowed to do unsupervised. Set bands per tool — auto-run, ask first, never. There's also a kill-switch for emergencies.",
    openRoomBefore: "authority",
  },
  {
    id: "room-logs",
    target: ".v2-room-overlay",
    narration:
      "Logs is the full audit trail — every tool call, every LLM exchange, every approval decision. Filter by time, agent, or tool. This is how you keep me honest.",
    openRoomBefore: "logs",
  },
  {
    id: "room-workspaces",
    target: ".v2-room-overlay",
    narration:
      "Workspaces are saved windows of work — a layout of rooms, a project context, a set of pinned cards. Switch between projects and your dashboard reshapes around what you're doing.",
    openRoomBefore: "workspaces",
  },
  {
    id: "room-settings",
    target: ".v2-room-overlay",
    narration:
      "Settings is where you tune everything — LLM provider, voice, channels, personality, integrations, and your profile. You can also replay any onboarding phase from here.",
    openRoomBefore: "settings",
  },

  {
    id: "voice-room-actions",
    target: ".v2-rail__orb-wrap",
    narration:
      "You can drive entire rooms by voice. Try saying 'go to settings and disable TTS' — I'll do both in one breath. Voice commands work everywhere.",
    prefer: "left",
  },
  {
    id: "approvals",
    target: ".v2-approval",
    narration:
      "When I want to do something with real-world impact — sending a message, spending money, deleting things — I'll ask first. Approve or deny by click or by saying 'yes' or 'cancel'.",
    requireSampleApproval: true,
    prefer: "right",
  },
  {
    id: "notifications",
    target: "[data-notif-toggle]",
    narration:
      "The bell catches anything you missed — approvals you didn't see, suggestions, sidecar disconnects. Press Alt-N to peek at any time.",
    autoAdvanceOn: "notif_opened",
    prefer: "bottom",
  },
  {
    id: "outro",
    target: "viewport",
    narration:
      "That's it. I've saved everything I learned about you in the Memory room — go take a look. Anything you want me to redo, just say 'replay onboarding'. Welcome aboard.",
    closeRoomBefore: true,
  },
];
