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
import type { PieceLookup } from "../../workflows/runtime/piece-catalog.ts";
import type { ComposerLlmClient } from "./workflow-composer.ts";

/**
 * Minimal tool-registry shape the composer surfaces in its planner prompt.
 * Lists names + tool descriptions; doesn't drive execution. Kept inline
 * instead of importing the deleted legacy `PieceToolRegistry` type.
 */
export interface ComposerToolRegistry {
  listNames(category?: string): string[];
  /**
   * Optional richer listing: each tool with its parameter schema. When present
   * the composer surfaces required params to the LLM and validates them, so a
   * `jarvis-tool:invoke` step can't omit a tool's required param (e.g. `action`)
   * and 500 at runtime. Falls back to `listNames` when not provided.
   */
  listDetailed?(category?: string): ComposerToolSpec[];
}
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
import { composeFlow, type ComposedFlow, type ComposerSpecialistRole, type ComposerToolSpec } from "./workflow-composer.ts";

export interface ManageWorkflowDeps {
  /** When provided, a refresh is fired after status / publish / delete so cron+webhook+event subs reconcile. */
  triggerManager?: TriggerManager;
  /** Required for the `compose` action: lets the LLM build a draft flow from a description. */
  llm?: ComposerLlmClient;
  /** Required for the `compose` action: catalog of pieces the LLM can pick from. */
  pieceRegistry?: PieceLookup;
  /**
   * Optional. When provided, the composer surfaces the names of registered
   * Jarvis tools so the LLM can wire `jarvis-tool { toolName: '...' }` correctly
   * for asks like "send a Gmail" or "search the vault".
   */
  toolRegistry?: ComposerToolRegistry;
  /**
   * Optional. When provided, the composer lists the valid specialist sub-agent
   * roles in its prompt and rejects a `jarvis-agent:delegate` step whose `role`
   * isn't one of them. A thunk (not a snapshot) so it reflects specialists
   * discovered after this tool is constructed. See ComposeDeps.specialistRoles.
   */
  specialistRoles?: () => ComposerSpecialistRole[];
}

export function createManageWorkflowTool(deps: ManageWorkflowDeps = {}): ToolDefinition {
  return {
    name: "manage_workflow",
    description: [
      "Create, run, and manage the user's Jarvis workflows (automations).",
      "For \"make/automate/set up a workflow that ...\" requests, call `compose` with a proposed `name` and a `description` quoting the request — it builds a draft flow (LLM-backed). On {ok:false,errors}, refine the description with the piece/tool names in the errors and call again. Composed flows start DISABLED; `publish` after the user confirms, then `run` to test.",
      "`run { flow, payload? }` triggers an existing flow by name/id. Introspect with `list` / `get` / `list_runs` / `get_run`; lifecycle via `enable` / `disable` / `publish` / `delete`.",
      "`create` makes an EMPTY flow (manual trigger, no steps) and requires `empty: true` — use ONLY for an explicit blank canvas; if the user described behavior, use `compose` instead.",
    ].join("\n"),
    category: "automation",
    parameters: {
      action: {
        type: "string",
        description: 'compose | create | list | get | run | enable | disable | publish | delete | list_runs | get_run.',
        required: true,
      },
      flow: {
        type: "string",
        description: "Workflow name (case-insensitive) or id. Required for get/run/enable/disable/publish/delete; optional for list_runs.",
        required: false,
      },
      name: {
        type: "string",
        description: 'Short display name for the new workflow (compose/create).',
        required: false,
      },
      payload: {
        type: "object",
        description: 'Optional trigger payload object for run.',
        required: false,
      },
      run_id: {
        type: "string",
        description: 'Run id for get_run (returned by run/list_runs).',
        required: false,
      },
      description: {
        type: "string",
        description:
          'What the workflow should do (compose). Quote the user; include the trigger (schedule/webhook/manual) and concrete services/actions (e.g. "send a Gmail to ...").',
        required: false,
      },
      limit: {
        type: "number",
        description: 'Cap for list_runs (default 25).',
        required: false,
      },
      empty: {
        type: "boolean",
        description: 'Set true to create a blank flow with no steps (create only). Defaults to false.',
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
        case "create": {
          // Two-step gate to keep small / local LLMs honest:
          //   - If `description` is passed, reroute to `compose` so the
          //     workflow gets built out with steps. The verb "create" in
          //     the user's message lexically matches this action name,
          //     so weak models pick it even when the user described what
          //     the flow should do.
          //   - Otherwise require an explicit `empty: true` flag. Forces
          //     the caller to confirm "I really want a blank canvas" and
          //     short-circuits the silent-empty-flow failure mode the
          //     user reported. The error message walks the agent toward
          //     the right next call.
          const name = requireString(params, "name");
          const description = typeof params["description"] === "string" ? params["description"].trim() : "";
          if (description.length > 0) {
            const composed = await actCompose(name, description, deps);
            return JSON.stringify({
              ...composed,
              routedFrom: "create",
              note: "Rerouted to `compose` because a description was provided. Future calls: use `compose` directly when the user describes what the workflow should do.",
            });
          }
          const empty = params["empty"] === true;
          if (!empty) {
            throw new Error(
              "create: refusing to make an empty workflow without confirmation. " +
                "If the user described what the workflow should DO, call `compose` with that description. " +
                'If the user really wants a blank canvas to edit in the UI, retry with empty: true.',
            );
          }
          return JSON.stringify(actCreate(name));
        }
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
  void deps.triggerManager?.refresh(flow.id).catch(e => console.warn(`[manage-workflow] triggerManager.refresh failed: ${(e as Error).message}`));
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
  void deps.triggerManager?.refresh(flow.id).catch(e => console.warn(`[manage-workflow] triggerManager.refresh failed: ${(e as Error).message}`));
  const updated = getFlow(flow.id);
  return updated ? summarizeFlow(updated) : { error: "flow vanished after publish" };
}

function actDelete(flow: FlowRow, deps: ManageWorkflowDeps): Record<string, unknown> {
  deleteFlow(flow.id);
  void deps.triggerManager?.refresh(flow.id).catch(e => console.warn(`[manage-workflow] triggerManager.refresh failed: ${(e as Error).message}`));
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
    // Prefer the richer schema listing so the composer can validate invoke
    // params; fall back to bare names when the registry doesn't supply it.
    const detailed = deps.toolRegistry.listDetailed?.();
    if (detailed && detailed.length > 0) {
      composeDeps.tools = detailed;
    } else {
      composeDeps.toolNames = deps.toolRegistry.listNames();
    }
  }
  if (deps.specialistRoles) {
    const roles = deps.specialistRoles();
    if (roles.length > 0) composeDeps.specialistRoles = roles;
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
