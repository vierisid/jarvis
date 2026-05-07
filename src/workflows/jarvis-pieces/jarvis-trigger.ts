/**
 * `jarvis-trigger` piece -- bridges Jarvis events into workflows and exposes
 * one workflow as the input to another.
 *
 * Trigger: on_event
 *   eventType: string  (required -- e.g. "awareness.context_changed")
 *   filter?:   { ... } (optional -- forwarded to the bus implementation)
 *
 *   When the parent workflow is enabled, the trigger subscribes to the named
 *   event on Jarvis' event bus. Each matching event fires a run with the
 *   event payload as the trigger payload.
 *
 * Action: run_workflow
 *   flowId?:   string
 *   flowName?: string
 *   payload?:  object
 *
 *   Either `flowId` or `flowName` is required. Returns the started run id
 *   (fire-and-forget). For waiting on completion, use `jarvis-context` to
 *   poll, or compose with `jarvis-agent` for higher-level orchestration.
 */

import {
  JarvisActionInputError,
  type JarvisAction,
  type JarvisPiece,
  type JarvisPieceContext,
  type JarvisTrigger,
  type JarvisTriggerContext,
  type PieceWorkflowStartInput,
  type TriggerSubscription,
} from "./types";

// ------------------------------------------------------------ on_event

export interface OnEventInput {
  eventType: string;
  filter?: Record<string, unknown>;
}

export const onEventTrigger: JarvisTrigger<OnEventInput> = {
  name: "on_event",
  displayName: "On Jarvis event",
  description:
    "Fire the workflow when a Jarvis event of the given type is published. Use the daemon's event-type catalog (awareness.*, commitment.*, voice.*, tool.*) to pick a value.",

  inputSchema: {
    fields: [
      {
        name: "eventType",
        label: "Event type",
        type: "string",
        required: true,
        placeholder: "awareness.context_changed",
      },
      {
        name: "filter",
        label: "Filter",
        type: "json",
        required: false,
        description: "Optional. Shallow-equality filter; each field must match the event payload.",
      },
    ],
  },

  parseInput: (raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new JarvisActionInputError("input must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.eventType !== "string" || r.eventType.length === 0) {
      throw new JarvisActionInputError("eventType is required and must be a non-empty string");
    }
    const out: OnEventInput = { eventType: r.eventType };
    if (r.filter !== undefined) {
      if (typeof r.filter !== "object" || r.filter === null || Array.isArray(r.filter)) {
        throw new JarvisActionInputError("filter must be an object if provided");
      }
      out.filter = r.filter as Record<string, unknown>;
    }
    return out;
  },

  async subscribe(input, ctx: JarvisTriggerContext): Promise<TriggerSubscription> {
    const bus = ctx.services.eventBus;
    if (!bus) {
      throw new Error("jarvis-trigger.on_event: ctx.services.eventBus is not configured");
    }
    const matches = makeFilter(input.filter);
    const unsubscribe = bus.subscribe(input.eventType, (payload) => {
      if (!matches(payload)) return;
      // Fire-and-forget. The runtime turns onFire into a queued RUN_FLOW job.
      void ctx.onFire(payload).catch((e) => {
        if (ctx.log) ctx.log(`jarvis-trigger.on_event onFire error: ${(e as Error).message}`);
      });
    });
    return {
      async unsubscribe() {
        unsubscribe();
      },
    };
  },
};

/**
 * Build a shallow-equality filter: each `filter[key]` must be `===` to
 * `payload[key]` for the event to pass. `undefined`/missing filter accepts
 * everything. Pieces that need richer matching can preprocess in a downstream
 * action; we keep this layer simple.
 */
function makeFilter(filter?: Record<string, unknown>): (payload: Record<string, unknown>) => boolean {
  if (!filter) return () => true;
  const entries = Object.entries(filter);
  if (entries.length === 0) return () => true;
  return (payload) => {
    for (const [k, v] of entries) {
      if (payload[k] !== v) return false;
    }
    return true;
  };
}

// ---------------------------------------------------------- run_workflow

export interface RunWorkflowInput {
  flowId?: string;
  flowName?: string;
  payload?: Record<string, unknown>;
}

export interface RunWorkflowOutput {
  runId: string;
}

export const runWorkflowAction: JarvisAction<RunWorkflowInput, RunWorkflowOutput> = {
  name: "run_workflow",
  displayName: "Run another workflow",
  description:
    "Trigger a saved workflow by id or name. Returns the started run id. Fire-and-forget; the called workflow runs asynchronously.",

  inputSchema: {
    fields: [
      {
        name: "flowId",
        label: "Flow id",
        type: "string",
        required: false,
        description: "Provide either flowId or flowName.",
      },
      { name: "flowName", label: "Flow name", type: "string", required: false },
      {
        name: "payload",
        label: "Payload",
        type: "json",
        required: false,
        description: "Optional JSON object passed as the trigger payload of the called flow.",
      },
    ],
  },

  parseInput: (raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new JarvisActionInputError("input must be an object");
    }
    const r = raw as Record<string, unknown>;
    const out: RunWorkflowInput = {};
    if (r.flowId !== undefined) {
      if (typeof r.flowId !== "string" || r.flowId.length === 0) {
        throw new JarvisActionInputError("flowId must be a non-empty string if provided");
      }
      out.flowId = r.flowId;
    }
    if (r.flowName !== undefined) {
      if (typeof r.flowName !== "string" || r.flowName.length === 0) {
        throw new JarvisActionInputError("flowName must be a non-empty string if provided");
      }
      out.flowName = r.flowName;
    }
    if (!out.flowId && !out.flowName) {
      throw new JarvisActionInputError("run_workflow requires flowId or flowName");
    }
    if (r.payload !== undefined) {
      if (typeof r.payload !== "object" || r.payload === null || Array.isArray(r.payload)) {
        throw new JarvisActionInputError("payload must be an object if provided");
      }
      out.payload = r.payload as Record<string, unknown>;
    }
    return out;
  },

  async execute(input, ctx: JarvisPieceContext): Promise<RunWorkflowOutput> {
    const runner = ctx.services.workflowRunner;
    if (!runner) {
      throw new Error("jarvis-trigger.run_workflow: ctx.services.workflowRunner is not configured");
    }
    const startInput: PieceWorkflowStartInput = {};
    if (input.flowId !== undefined) startInput.flowId = input.flowId;
    if (input.flowName !== undefined) startInput.flowName = input.flowName;
    if (input.payload !== undefined) startInput.payload = input.payload;
    const { runId } = await runner.start(startInput);
    return { runId };
  },
};

export const jarvisTriggerPiece: JarvisPiece = {
  name: "jarvis-trigger",
  displayName: "Jarvis: Trigger",
  description:
    "Bridge Jarvis events into workflows (on_event trigger) and run saved workflows from inside other workflows (run_workflow action).",
  actions: {
    [runWorkflowAction.name]: runWorkflowAction as unknown as JarvisAction,
  },
  triggers: {
    [onEventTrigger.name]: onEventTrigger as unknown as JarvisTrigger,
  },
};
