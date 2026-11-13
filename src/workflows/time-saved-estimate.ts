/**
 * Default estimate of the minutes one successful run of a workflow saves.
 *
 * Used by Today's "Time saved" only when the owner has not set minutes per run
 * (`flow.time_saved_per_run`). It reads the run's own flow version graph and is
 * deterministic: the same graph always gives the same number. It is an
 * estimate of the manual work the steps replace, never a measurement.
 *
 * Minutes per step, by what the step does:
 * - owner-facing notify: 1
 * - third-party connector action (Gmail, Slack, Sheets and so on): 2
 * - HTTP or GraphQL request, other Jarvis tool calls, sub-workflows, CODE: 2
 * - AI ask, agent or model step: 5
 * - Jarvis domain services (report, sales, refund, onboarding, import, batch,
 *   meeting context): 10
 * - pure data helpers (JSON, text, math, date, store, validate, regex, delay): 0.5
 * - human input and approval steps, triggers, routers and loops: 0
 *
 * The total is rounded to whole minutes, with a floor of 1 minute per run and a
 * cap of 60. The cap keeps a large graph from claiming an unreasonable hour
 * count per run; an owner who knows better sets the number themselves.
 */
import type { FlowTriggerNode } from "./db/repos/flow-version";
import { walkFlowNodes } from "./db/flow-graph";

export const MIN_ESTIMATED_MINUTES_PER_RUN = 1;
export const MAX_ESTIMATED_MINUTES_PER_RUN = 60;
/**
 * Trust guard: the most one workflow may add to Today's time saved in one local
 * day when its minutes come from the default estimate. Without it, a schedule
 * that fires every minute would claim a full day of saved work from a guess.
 * It never applies to minutes the owner set themselves.
 */
export const MAX_ESTIMATED_MINUTES_PER_WORKFLOW_PER_DAY = 60;
/** Largest value an owner may set: one day. */
export const MAX_TIME_SAVED_PER_RUN = 1440;

const NOTIFY = new Set(["jarvis-notify"]);
const AI = new Set(["jarvis-ask", "jarvis-agent", "claude", "openai", "google-gemini", "anthropic", "ai", "text-ai"]);
const DOMAIN = new Set(["jarvis-report", "jarvis-sales", "jarvis-refund", "jarvis-onboarding", "jarvis-import", "jarvis-batch", "jarvis-context"]);
const DATA_HELPERS = new Set(["json", "text-helper", "math-helper", "date-helper", "store", "delay", "jarvis-validate", "jarvis-regex", "data-mapper", "csv"]);
const NO_EFFORT = new Set(["jarvis-input", "approval", "jarvis-trigger", "jarvis-test", "schedule", "webhook", "manual"]);

/** `@scope/piece-gmail` and `gmail` are the same piece. */
const shortName = (pieceName: string) => pieceName.replace(/^@[^/]+\/piece-/, "");

function stepMinutes(node: FlowTriggerNode): number {
  if (node.type === "PIECE_TRIGGER" || node.type === "EMPTY" || node.type === "ROUTER" || node.type === "LOOP_ON_ITEMS") return 0;
  if (node.type === "CODE") return 2;
  const piece = typeof node.settings?.pieceName === "string" ? shortName(node.settings.pieceName) : "";
  if (NO_EFFORT.has(piece)) return 0;
  if (NOTIFY.has(piece)) return 1;
  if (AI.has(piece)) return 5;
  if (DOMAIN.has(piece)) return 10;
  if (DATA_HELPERS.has(piece)) return 0.5;
  return 2;
}

export function estimateMinutesPerRun(trigger: FlowTriggerNode | null | undefined): number {
  const total = walkFlowNodes(trigger).reduce((sum, node) => sum + stepMinutes(node), 0);
  return Math.min(MAX_ESTIMATED_MINUTES_PER_RUN, Math.max(MIN_ESTIMATED_MINUTES_PER_RUN, Math.round(total)));
}

/** The minutes a stored `flow_version.trigger` JSON column implies; unreadable JSON gets the minimum. */
export function estimateMinutesFromJson(trigger: string | null | undefined): number {
  try { return estimateMinutesPerRun(trigger ? JSON.parse(trigger) : null); }
  catch { return MIN_ESTIMATED_MINUTES_PER_RUN; }
}
