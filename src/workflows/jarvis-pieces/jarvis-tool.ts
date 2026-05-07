/**
 * `jarvis-tool` piece -- invoke a registered Jarvis tool by name. Cheap,
 * deterministic, no LLM round-trip. Use this in a workflow when you know
 * exactly which tool to call (vs. `jarvis-agent`, where the LLM picks).
 *
 * Action: invoke
 *   toolName: string                   (required)
 *   params:   Record<string, unknown>  (default {})
 *
 * The action validates `toolName` exists in the registry and lets the
 * registry's own validation handle parameter shape -- we deliberately do not
 * duplicate parameter validation here, because tools evolve and the registry
 * is the source of truth.
 */

import {
  JarvisActionInputError,
  type JarvisAction,
  type JarvisPiece,
  type JarvisPieceContext,
} from "./types";

export interface InvokeInput {
  toolName: string;
  params: Record<string, unknown>;
}

export interface InvokeOutput {
  /** Whatever the tool returned. Pieces do not interpret this. */
  result: unknown;
  /** The name of the tool that ran (echoed for downstream nodes). */
  toolName: string;
}

export const invokeAction: JarvisAction<InvokeInput, InvokeOutput> = {
  name: "invoke",
  displayName: "Invoke a Jarvis tool",
  description:
    "Call a registered Jarvis tool by name with the given parameters. Returns the tool's raw result. For tasks where the LLM should pick a tool, use jarvis-agent instead.",

  inputSchema: {
    fields: [
      {
        name: "toolName",
        label: "Tool name",
        type: "string",
        required: true,
        description: "Exact id of the registered Jarvis tool (e.g. run_command, vault_search).",
      },
      {
        name: "params",
        label: "Parameters",
        type: "json",
        required: false,
        default: {},
        description: "JSON object passed verbatim to the tool's execute() function.",
      },
    ],
  },

  parseInput: (raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new JarvisActionInputError("input must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.toolName !== "string" || r.toolName.length === 0) {
      throw new JarvisActionInputError("toolName is required and must be a non-empty string");
    }
    let params: Record<string, unknown> = {};
    if (r.params !== undefined) {
      if (typeof r.params !== "object" || r.params === null || Array.isArray(r.params)) {
        throw new JarvisActionInputError("params must be an object if provided");
      }
      params = r.params as Record<string, unknown>;
    }
    return { toolName: r.toolName, params };
  },

  async execute(input, ctx: JarvisPieceContext): Promise<InvokeOutput> {
    const registry = ctx.services.toolRegistry;
    if (!registry) {
      throw new Error("jarvis-tool: ctx.services.toolRegistry is not configured");
    }
    if (!registry.has(input.toolName)) {
      throw new Error(`jarvis-tool: tool not found: ${input.toolName}`);
    }
    const result = await registry.execute(input.toolName, input.params);
    return { result, toolName: input.toolName };
  },
};

export const jarvisToolPiece: JarvisPiece = {
  name: "jarvis-tool",
  displayName: "Jarvis: Tool",
  description:
    "Call any tool registered with the Jarvis daemon (vault search, browser, desktop, etc.) directly from a workflow. Use when you know exactly which tool you want.",
  actions: {
    [invokeAction.name]: invokeAction as unknown as JarvisAction,
  },
};
