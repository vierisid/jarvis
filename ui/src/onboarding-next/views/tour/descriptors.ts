/** Approved Figma room order. These IDs are view-local; B06 maps durable progress. */
export const TOUR_STEPS = [
  { id: "today", room: "Today", title: "Start with what matters.", body: "See what needs your attention, the work Jarvis has moved forward and the next step toward your goal.", node: "1097:16634" },
  { id: "workflows", room: "Workflows", title: "Describe the work. Review the steps.", body: "Start with a prompt, inspect the canvas and return to the workflows already working for you.", node: "1097:19145" },
  { id: "opportunities", room: "Opportunities", title: "A routine, ready to improve.", body: "Jarvis connects repeated work to your goal and asks before drafting a workflow. Review the draft, then approve and enable it.", node: "1097:21538" },
  { id: "needs-you", room: "Needs you", title: "Your judgment, at the right moment.", body: "When work needs your approval, review exactly what Jarvis wants to do here, then approve or deny it.", node: "1097:23684" },
  { id: "goals", room: "Goals", title: "Give the work a direction.", body: "Set what you want to achieve. Follow the path, see progress and ask Jarvis for the best next step.", node: "1097:25442" },
  { id: "memory", room: "Memory", title: "Useful context stays with you.", body: "Find the facts and preferences Jarvis remembers. Open a memory to review or correct it.", node: "1097:27524" },
  { id: "connected-workspace", room: "Connected workspace", title: "Bring your work together.", body: "See connected computers and services here. Add another service when a workflow needs it.", node: "1097:30152" },
  { id: "authority", room: "Authority", title: "You decide what needs approval.", body: "Choose the authority level and the actions that should ask first. These rules apply inside workflows too.", node: "1097:32089" },
  { id: "profile", room: "Profile", title: "A workspace that knows you.", body: "Open your name in the sidebar to reach Profile, Settings and Billing. Keep your profile up to date here.", node: "1097:34599" },
  { id: "settings", room: "Settings", title: "Make Jarvis feel right for you.", body: "Choose your appearance and everyday preferences. Your work stays in place when the look changes.", node: "1097:37315" },
  { id: "billing", room: "Billing", title: "Keep your plan in view.", body: "Find your plan, usage and billing details together. You can return here through the account menu.", node: "1097:39626" },
  { id: "pebble", room: "Pebble", title: "A conversation beside your work.", body: "Open the Pebble in the lower-right corner. Ask for help, refine a workflow or think through a decision.", node: "1097:42287" },
] as const;

export type TourStepId = typeof TOUR_STEPS[number]["id"];
export type TourDescriptor = typeof TOUR_STEPS[number];
export const getTourStep = (id: string) => TOUR_STEPS.find(step => step.id === id);
