/**
 * Manage Workflow Tool — chat-driven workflow CRUD + run management.
 *
 * Replaces the legacy `manage_workflow` tool that was deleted alongside the
 * old engine. This version drives the new activepieces-based runtime through
 * its repos / queue directly (in-process; no HTTP round-trip).
 *
 * Actions:
 *   list                   list all flows
 *   get                    detail view of a flow + its latest version
 *   run                    queue a flow run, optionally with a payload
 *   create                 create an empty flow with a manual trigger
 *   enable / disable       toggle flow status
 *   publish                lock the latest draft and set as published_version
 *   delete                 remove a flow
 *   list_runs              recent runs for a flow (or globally)
 *   get_run                run detail with step outputs
 *
 * Flow references accept either a display name (case-insensitive) or an id.
 * Runs are referenced strictly by id.
 */

import type { ToolDefinition } from "./registry.ts";
import type { TriggerManager } from "../../workflows/runner/triggers/manager.ts";
import type { PieceLlmClient, PieceToolRegistry } from "../../workflows/jarvis-pieces/types.ts";
import type { PieceLookup } from "../../workflows/runtime/piece-catalog.ts";
import {
  createFlow,
  deleteFlow,
  getFlow,
  listFlows,
  parseFlowMetadata,
  setPublishedVersion,
  updateFlowStatus,
  type FlowRow,
} from "../../workflows/db/repos/flow.ts";
import {
  createDraftVersion,
  getFlowVersion,
  getLatestDraft,
  lockVersion,
} from "../../workflows/db/repos/flow-version.ts";
import {
  createFlowRun,
  getFlowRun,
  listRuns,
  type FlowRun,
} from "../../workflows/db/repos/flow-run.ts";
import { enqueue } from "../../workflows/db/repos/job-queue.ts";
import { RUN_FLOW } from "../../workflows/runner/handler.ts";
import { composeFlow, type ComposedFlow } from "./workflow-composer.ts";

export interface ManageWorkflowDeps {
  /** When provided, a refresh is fired after status / publish / delete so cron+webhook+event subs reconcile. */
  triggerManager?: TriggerManager;
  /** Required for the `compose` action: lets the LLM build a draft flow from a description. */
  llm?: PieceLlmClient;
  /** Required for the `compose` action: catalog of pieces the LLM can pick from. */
  pieceRegistry?: PieceLookup;
  /**
   * Optional. When provided, the composer surfaces the names of registered
   * Jarvis tools so the LLM can wire `jarvis-tool { toolName: '...' }` correctly
   * for asks like "send a Gmail" or "search the vault".
   */
  toolRegistry?: PieceToolRegistry;
}

export function createManageWorkflowTool(deps: ManageWorkflowDeps = {}): ToolDefinition {
  return {
    name: "manage_workflow",
    description: [
      "Manage Jarvis workflows: list, inspect, create, run, enable/disable, publish, and delete.",
      "Use this to surface the user's automations, kick off runs from chat, or set up new flows.",
      "",
      "Most actions accept a 'flow' parameter that resolves either a display name (case-insensitive) or an id.",
      "Run history is referenced by run_id (returned by 'run' or 'list_runs').",
      "",
      "Actions:",
      "  list                                — return every workflow's id, name, status, last-updated",
      "  get { flow }                        — full detail (latest version, published id, recent metadata)",
      "  run { flow, payload? }              — queue a run; returns the run_id",
      "  create { name }                     — create an empty workflow with a manual trigger; returns id",
      "  enable / disable { flow }           — toggle status",
      "  publish { flow }                    — lock the latest draft and set as the published version",
      "  delete { flow }                     — permanently remove",
      "  list_runs { flow?, limit? }         — recent runs (per flow or across all)",
      "  get_run { run_id }                  — full run detail with step outputs",
      "  compose { name, description }       — build a draft flow from a plain-English description (uses the LLM)",
    ].join("\n"),
    category: "automation",
    parameters: {
      action: {
        type: "string",
        description:
          'Action: "list" | "get" | "run" | "create" | "enable" | "disable" | "publish" | "delete" | "list_runs" | "get_run"',
        required: true,
      },
      flow: {
        type: "string",
        description: "Workflow display name (case-insensitive) or id. Required for most actions.",
        required: false,
      },
      name: {
        type: "string",
        description: 'Display name for "create".',
        required: false,
      },
      payload: {
        type: "object",
        description: 'Optional JSON payload passed as the trigger.payload of the run (for "run").',
        required: false,
      },
      run_id: {
        type: "string",
        description: 'Run id (for "get_run").',
        required: false,
      },
      description: {
        type: "string",
        description: 'Plain-English description (for "compose").',
        required: false,
      },
      limit: {
        type: "number",
        description: 'Cap for "list_runs" (default 25).',
        required: false,
      },
    },
    execute: async (params) => {
      const action = String(params.action ?? "");
      switch (action) {
        case "list":
          return JSON.stringify(actList());
        case "get":
          return JSON.stringify(actGet(requireFlowParam(params)));
        case "run":
          return JSON.stringify(actRun(requireFlowParam(params), params.payload as Record<string, unknown> | undefined));
        case "create":
          return JSON.stringify(actCreate(requireString(params, "name")));
        case "enable":
          return JSON.stringify(actSetStatus(requireFlowParam(params), "ENABLED", deps));
        case "disable":
          return JSON.stringify(actSetStatus(requireFlowParam(params), "DISABLED", deps));
        case "publish":
          return JSON.stringify(actPublish(requireFlowParam(params), deps));
        case "delete":
          return JSON.stringify(actDelete(requireFlowParam(params), deps));
        case "list_runs":
          return JSON.stringify(actListRuns(params.flow as string | undefined, asLimit(params.limit)));
        case "get_run":
          return JSON.stringify(actGetRun(requireString(params, "run_id")));
        case "compose":
          return JSON.stringify(
            await actCompose(requireString(params, "name"), requireString(params, "description"), deps),
          );
        default:
          throw new Error(`unknown action "${action}"`);
      }
    },
  };
}

/* ------------------------------------------------------------ resolution */

function resolveFlow(ref: string): FlowRow {
  const direct = getFlow(ref);
  if (direct) return direct;
  const target = ref.trim().toLowerCase();
  // Match against the display name on the latest published or draft version.
  for (const flow of listFlows(undefined, { limit: 1000 })) {
    const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
    if (!versionId) continue;
    const version = getFlowVersion(versionId);
    if (version && version.displayName.toLowerCase() === target) return flow;
  }
  throw new Error(`workflow not found: ${ref}`);
}

function requireFlowParam(params: Record<string, unknown>): FlowRow {
  const ref = params.flow;
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("'flow' parameter is required (display name or id)");
  }
  return resolveFlow(ref);
}

function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`'${key}' parameter is required and must be a non-empty string`);
  }
  return v;
}

function asLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 25;
  return Math.floor(raw);
}

/* --------------------------------------------------------------- actions */

function summarizeFlow(flow: FlowRow): Record<string, unknown> {
  const draft = getLatestDraft(flow.id);
  const published = flow.published_version_id ? getFlowVersion(flow.published_version_id) : null;
  const displayName = draft?.displayName ?? published?.displayName ?? flow.id;
  return {
    id: flow.id,
    name: displayName,
    status: flow.status,
    publishedVersionId: flow.published_version_id,
    metadata: parseFlowMetadata(flow),
    updated: flow.updated,
  };
}

function actList(): Array<Record<string, unknown>> {
  return listFlows(undefined, { limit: 1000 }).map(summarizeFlow);
}

function actGet(flow: FlowRow): Record<string, unknown> {
  const summary = summarizeFlow(flow);
  const draft = getLatestDraft(flow.id);
  const published = flow.published_version_id ? getFlowVersion(flow.published_version_id) : null;
  return {
    ...summary,
    latestDraft: draft,
    published,
  };
}

function actRun(flow: FlowRow, payload?: Record<string, unknown>): Record<string, unknown> {
  const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
  if (!versionId) throw new Error("workflow has no draft or published version to run");
  const run = createFlowRun({
    flowId: flow.id,
    flowVersionId: versionId,
    triggeredBy: "assistant:manage_workflow",
    startTime: Date.now(),
  });
  enqueue({
    jobType: RUN_FLOW,
    payload: { runId: run.id, payload: payload ?? {} },
    flowRunId: run.id,
    flowId: flow.id,
    flowVersionId: versionId,
  });
  return { run_id: run.id, status: "QUEUED", flow_id: flow.id };
}

function actCreate(displayName: string): Record<string, unknown> {
  const flow = createFlow();
  createDraftVersion({
    flowId: flow.id,
    displayName,
    trigger: {
      name: "trigger",
      type: "EMPTY",
      displayName: "Manual",
      settings: {},
    },
  });
  return summarizeFlow(flow);
}

function actSetStatus(
  flow: FlowRow,
  status: "ENABLED" | "DISABLED",
  deps: ManageWorkflowDeps,
): Record<string, unknown> {
  updateFlowStatus(flow.id, status);
  deps.triggerManager?.refresh(flow.id);
  const updated = getFlow(flow.id);
  return updated ? summarizeFlow(updated) : { error: "flow vanished after update" };
}

function actPublish(flow: FlowRow, deps: ManageWorkflowDeps): Record<string, unknown> {
  let target = getLatestDraft(flow.id);
  if (!target) {
    if (flow.published_version_id) {
      // Already published, nothing to do.
      return summarizeFlow(flow);
    }
    throw new Error("no draft version to publish");
  }
  if (target.state !== "LOCKED") target = lockVersion(target.id);
  setPublishedVersion(flow.id, target.id);
  updateFlowStatus(flow.id, "ENABLED");
  deps.triggerManager?.refresh(flow.id);
  const updated = getFlow(flow.id);
  return updated ? summarizeFlow(updated) : { error: "flow vanished after publish" };
}

function actDelete(flow: FlowRow, deps: ManageWorkflowDeps): Record<string, unknown> {
  deleteFlow(flow.id);
  deps.triggerManager?.refresh(flow.id);
  return { id: flow.id, deleted: true };
}

const RAW_RESPONSE_CAP = 4096;

async function actCompose(
  name: string,
  description: string,
  deps: ManageWorkflowDeps,
): Promise<Record<string, unknown>> {
  if (!deps.llm) {
    throw new Error("compose: an LLM client is not configured for this build");
  }
  if (!deps.pieceRegistry) {
    throw new Error("compose: piece registry is not configured for this build");
  }

  // Reject up-front when a flow with the same display name already exists.
  // Auto-suffixing silently ("My Flow (2)") is more annoying than helpful;
  // the assistant can rename and call again.
  const collision = findFlowByDisplayName(name);
  if (collision) {
    return {
      ok: false,
      errors: [`a workflow named "${name}" already exists (id=${collision.id}); pick a different name`],
      rawResponse: null,
    };
  }

  const composeDeps: Parameters<typeof composeFlow>[0] = {
    llm: deps.llm,
    pieceRegistry: deps.pieceRegistry,
  };
  if (deps.toolRegistry) {
    composeDeps.toolNames = deps.toolRegistry.listNames();
  }
  const result = await composeFlow(composeDeps, { name, description });

  if (!result.ok) {
    return {
      ok: false,
      errors: result.errors,
      rawResponse: capRawResponse(result.rawResponse),
    };
  }

  // Persist as a fresh flow + draft version. The flow is created DISABLED;
  // the user must publish + enable explicitly.
  const flow = createFlow();
  const flowName = result.flow.displayName.trim() || name;
  const version = createDraftVersion({
    flowId: flow.id,
    displayName: flowName,
    trigger: result.flow.trigger,
  });
  return {
    ok: true,
    flow: summarizeFlow(getFlow(flow.id) ?? flow),
    versionId: version.id,
  };
}

function findFlowByDisplayName(name: string): FlowRow | null {
  const target = name.trim().toLowerCase();
  if (!target) return null;
  for (const flow of listFlows(undefined, { limit: 1000 })) {
    const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
    if (!versionId) continue;
    const version = getFlowVersion(versionId);
    if (version && version.displayName.toLowerCase() === target) return flow;
  }
  return null;
}

function capRawResponse(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw.length <= RAW_RESPONSE_CAP) return raw;
  return raw.slice(0, RAW_RESPONSE_CAP) + `\n... (truncated, ${raw.length - RAW_RESPONSE_CAP} more chars)`;
}

/** Re-export for tests so they can inspect the parser output without going through the LLM. */
export type { ComposedFlow };

function actListRuns(flowRef: string | undefined, limit: number): Array<Record<string, unknown>> {
  const flow = flowRef ? resolveFlow(flowRef) : null;
  const opts: Parameters<typeof listRuns>[0] = { limit };
  if (flow) opts.flowId = flow.id;
  return listRuns(opts).map((r) => summarizeRun(r));
}

function actGetRun(runId: string): Record<string, unknown> {
  const run = getFlowRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  return summarizeRun(run, true);
}

function summarizeRun(run: FlowRun, includeSteps = false): Record<string, unknown> {
  return {
    id: run.id,
    flow_id: run.flowId,
    status: run.status,
    environment: run.environment,
    triggeredBy: run.triggeredBy,
    startTime: run.startTime,
    finishTime: run.finishTime,
    durationMs: run.startTime && run.finishTime ? run.finishTime - run.startTime : null,
    stepsCount: run.stepsCount,
    failedStep: run.failedStep,
    ...(includeSteps ? { steps: run.steps } : {}),
  };
}
