import type { BriefRoute } from '../contracts';

/** Stable integration IDs, shared by the static tutorial and the assembled controls.
 * A target is a navigation/focus destination, never a command or permission grant. */
export const ONBOARDING_TARGETS = {
  workflows: { id: 'brief-workflow-prompt', route: { room: 'workflows', selection: {} } },
  talk: { id: 'brief-chat-composer', route: { room: 'today', selection: {} } },
  context: { id: 'brief-memory-navigation', route: { room: 'memory', selection: {} } },
  apps: { id: 'brief-connected-workspace-navigation', route: { room: 'connected-workspace', selection: {} } },
  authority: { id: 'brief-authority-navigation', route: { room: 'authority', selection: {} } },
} as const satisfies Record<string, { id: string; route: BriefRoute }>;
export type TutorialStep = keyof typeof ONBOARDING_TARGETS;
export const TUTORIAL_STEPS = Object.keys(ONBOARDING_TARGETS) as TutorialStep[];
export const tutorialStepId = (step: TutorialStep) => `brief:v1:${step}`;
export function tutorialIndex(saved: string | null | undefined) {
  // Unknown/older tutorial IDs start at the first step, never claim completion.
  const index = TUTORIAL_STEPS.findIndex(step => tutorialStepId(step) === saved);
  return Math.max(0, index);
}
export const BRIEF_TOUR = [
  { title: 'Give the repetition a workflow', sm: 'Describe the work you want to automate in Workflows. Jarvis prepares a draft with steps you can inspect and steer.', t: 'Create your workflow starts with your prompt. Preparing a draft does not enable or run it.', focus: 'workflows', pos: { left: 'calc(var(--mrail-w) + 12px)', top: 58 } },
  { title: 'Build it together', sm: 'Open the Pebble to talk with Jarvis while keeping your workspace in view. Your conversation stays beside your work.', t: 'Sending a message is a separate, explicit action.', focus: 'talk', pos: { right: 18, bottom: 50 } },
  { title: 'A cofounder with context', sm: 'Memory and Goals give your work context. Today brings together outcomes, opportunities and decisions that need you.', t: 'Open Memory to inspect the context Jarvis has recorded.', focus: 'context', pos: { left: 'calc(var(--mrail-w) + 12px)', top: 104 } },
  { title: 'Work across your apps', sm: 'Connected workspace shows your services and computers. Computer actions need that paired computer awake, connected and permitted.', t: 'Connecting a service still requires its existing setup and consent.', focus: 'apps', pos: { right: 18, bottom: 50 } },
  { title: 'Decide where approval belongs', sm: 'Open Authority & settings to inspect action permissions and approval rules. Review a workflow before deliberately enabling or running it.', t: 'Your written interview provides context. It does not grant authority.', focus: 'authority', pos: { left: 'calc(var(--mrail-w) + 12px)', top: 150 } },
] as const;
