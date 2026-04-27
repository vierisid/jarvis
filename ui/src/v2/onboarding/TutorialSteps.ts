import type { TutorialEventName } from "./TutorialEventContext";

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
      "When I open a room fullscreen, it covers the dashboard so you can focus. Press Escape to return to the thread.",
    tryHint: "Try opening a room from the palette, then press Escape.",
    autoAdvanceOn: "room_opened",
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
  },
];
