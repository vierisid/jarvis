// D32's required coverage is independent of what today's fixtures can render.
// An absent fixture is a blocked case, never a smaller denominator.
const select = (label, value) => ({ kind: "select", label, value });
const check = label => ({ kind: "check", label });
const examples = (label, ready, long, empty, error) => Object.fromEntries(
  Object.entries({ ready, long, empty, error }).map(([state, value]) =>
    [state, value === null ? null : [select(label, value)]]),
);
export const ROOMS = [
  { id: "today", specimen: "today", selector: ".brief-today-layout", states: {
    ready: [], long: [check("Long document")],
    empty: [select("Decision scenario", "empty"), select("Outcome scenario", "empty"), select("Recommendation scenario", "empty"), select("Opportunity scenario", "empty")],
    error: [select("Decision scenario", "unavailable"), select("Outcome scenario", "unavailable"), select("Recommendation scenario", "unavailable"), select("Opportunity scenario", "unavailable")],
  }, journey: "Approve a decision; verify its receipt and next document. Open a goal recommendation and preserve its source." },
  { id: "workflows", specimen: "ingredient-picker", selector: ".brief-workflow-creation", states: {
    ready: [], long: [check("Long rows")], empty: [select("Recent runs scenario", "empty")], error: [select("Recent runs scenario", "unavailable"), select("Composition scenario", "unavailable")],
  }, journey: "Write a request, choose an ingredient, submit once, reopen the returned draft ID. Required destination must render its actual body." },
  { id: "workflow", specimen: "workflow-canvas", selector: ".brief-workflow-canvas", states: { ready: [], long: [check("Branches, loops & disconnected nodes")], empty: null, error: null }, journey: "Select and edit a node; save and reopen the same version. Test Runs and Context destinations." },
  { id: "workflow-preview", blocked: "No room-local Body or complete preview fixture is registered.", journey: "Open a proposed workflow and return to its source with selection intact." },
  { id: "workflow-draft", blocked: "No room-local Body or complete draft fixture is registered.", journey: "Create, edit, save and activate a draft through the approved activation path." },
  { id: "workflow-runs", specimen: "workflow-runs", selector: ".brief-workflow-runs", states: examples("Run history example", "normal", null, "empty", "unavailable"), journey: "Select different run IDs, refresh, open recorded context and return to the selected run." },
  { id: "workflow-context", specimen: "workflow-context", selector: ".brief-workflow-context", states: examples("Workflow context example", "normal", "long", "empty", "unavailable"), journey: "Switch configured/recorded context and follow an available source; preserve run and version IDs." },
  { id: "all-workflows", specimen: "workflow-manage", selector: ".brief-management", states: examples("Workflow management example", "normal", "long list", "empty", "unavailable"), journey: "Filter, open a workflow, return, delete and undo; preserve the selected workflow identity." },
  { id: "opportunities", specimen: "opportunities", selector: ".brief-opportunities", states: examples("Opportunity example", "ready", "long content", "empty", "unavailable"), journey: "Open a finished brief, accept once, and reconcile the canonical result; refuse an expired proposal." },
  { id: "needs-you", specimen: "decisions", selector: ".brief-decisions", states: examples("Decision example", "ready", "long", "empty", "unavailable"), journey: "Read a long decision, approve/reject, verify its receipt and stable next selection; recover a failed response." },
  { id: "goals", specimen: "goals", selector: ".brief-goals-room", states: examples("Goal example", "ready", "long", "empty", "unavailable"), journey: "Select a goal, reorder/refresh its list, open its decision, then return to the same goal." },
  { id: "completed-goals", specimen: "goals", selector: ".brief-goals-room", enter: { role: "tab", name: "Completed" }, states: examples("Goal example", "mixed-status", null, "empty", "unavailable"), journey: "Open completed goals, select a completed goal and return to active goals without losing selection." },
  { id: "memory", specimen: "memory", selector: ".brief-memory-room", states: examples("Memory example", "ready", "long", "empty", "unavailable"), journey: "Search, combine filters, clear them, open a memory and return to the same filtered stream." },
  { id: "memory-detail", specimen: "memory-detail", selector: ".brief-memory-detail", enter: { selector: ".brief-memory-row" }, states: examples("Memory example", "ready", "long", null, "unavailable"), journey: "Open a fact, edit/save, return to its stream. Cancel forgetting and verify focus returns to its trigger." },
  { id: "connected-workspace", specimen: "connections", selector: ".brief-connections", states: examples("Connection example", "ready", "long", "empty", "unavailable"), journey: "Choose a service, start/cancel a fixture setup attempt and reconcile its status without fabricated connection success." },
  { id: "authority", specimen: "authority", selector: ".brief-authority", states: examples("Authority example", "ready", null, null, "error"), journey: "Change a draft level/category, cancel then confirm save; verify conflict handling and emergency control confirmation." },
  { id: "profile", specimen: "profile", selector: ".brief-profile", states: examples("Profile example", "ready", null, "empty", "error"), journey: "Edit a field, preserve its focus during polling, cancel discard, save and reconcile its canonical revision." },
  { id: "settings", specimen: "settings", selector: ".brief-settings", states: examples("Settings example", "local", null, null, "error"), journey: "Change appearance, save voice choice, confirm/cancel tutorial replay and verify a blocked destination." },
  { id: "billing", specimen: "billing", selector: ".brief-billing", states: examples("Billing example", "active", "long-history", "no-plan", "missing"), journey: "Expand invoice history, cancel plan-change confirmation, simulate a blocked external handoff and recover." },
];
export const WIDTHS = [1024, 1280, 1440, 1920, 800, 390];
export const THEMES = ["light", "dark"];
export const SIDEBARS = ["expanded", "rail"];
export const STATES = ["ready", "long", "empty", "error"];
export const MANUAL_KINDS = ["journey", "screen-reader", "reduced-motion", "zoom-200", "webview", "visual-reference"];

export function requiredCases() {
  const cases = [];
  for (const room of ROOMS) {
    for (const state of STATES) for (const theme of THEMES) for (const sidebar of SIDEBARS) for (const chat of [false, true]) {
      cases.push({ id: `${room.id}/layout/${state}/${theme}/${sidebar}/${chat ? "open" : "closed"}`, room: room.id, kind: "layout", state, theme, sidebar, chat, width: 1440 });
    }
    for (const state of ["ready", "long"]) for (const width of WIDTHS) cases.push({ id: `${room.id}/viewport/${state}/${width}`, room: room.id, kind: "viewport", state, width, theme: "light", sidebar: "expanded", chat: true });
    cases.push({ id: `${room.id}/repeat-20`, room: room.id, kind: "repeat-20", state: "ready", width: 1440, theme: "light", sidebar: "expanded", chat: false });
    cases.push({ id: `${room.id}/keyboard`, room: room.id, kind: "keyboard", state: "ready", width: 1440, theme: "light", sidebar: "expanded", chat: false });
    for (const kind of MANUAL_KINDS) cases.push({ id: `${room.id}/${kind}`, room: room.id, kind });
  }
  return cases;
}

export function fixtureBlock(test) {
  const room = ROOMS.find(room => room.id === test.room);
  if (!room) return "Unknown room.";
  if (room.blocked) return room.blocked;
  if (test.state && room.states[test.state] === null) return `No ${test.state} fixture for ${room.id}; required case retained.`;
  if (MANUAL_KINDS.includes(test.kind)) return "Requires explicit browser/host evidence; fixture geometry cannot certify this case.";
  return null;
}

export function newReport(head) {
  /** @type {Array<{id: string, status: string, reason?: string, evidence: string[]}>} */
  const cases = [];
  return { schema: "brief-craft-v1", head, source: "fixture", environment: "browser", capturedAt: new Date().toISOString(), cases, capabilities: [], notes: [] };
}
