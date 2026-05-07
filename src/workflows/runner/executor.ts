/**
 * `JarvisPiecesFlowExecutor` -- walks a flow_version's trigger tree and
 * dispatches each PIECE step to the JarvisPieceRegistry.
 *
 * Activepieces flow shape (subset we honor):
 *
 *   {
 *     "name": "trigger",
 *     "type": "PIECE_TRIGGER" | "EMPTY",
 *     "settings": { ... },
 *     "nextAction": ChildNode
 *   }
 *
 * ChildNode types:
 *   - PIECE             -- piece action; resolved against the registry.
 *   - LOOP_ON_ITEMS     -- iterates `firstLoopAction` once per item in
 *                          `settings.items` (template).
 *   - ROUTER            -- evaluates `settings.branches`, executes the
 *                          subgraph at the matching child index.
 *
 * Every node may carry `nextAction` to continue the chain after itself.
 *
 * What we do NOT yet support:
 *   - CODE actions (would need an isolated runner; deliberately deferred).
 *   - Non-Jarvis pieces (gmail, slack, etc.) -- those need the engine
 *     subprocess. They surface as "unknown action" errors.
 *
 * Output map written to flow_run.steps:
 *   { [stepName]: { input: <resolved>, output: <result> } }
 *   For LOOP nodes, output is { iterations: [...], count }.
 *   For ROUTER nodes, output is { matched: [branchName] }.
 */

import {
  FlowExecutionError,
  type FlowExecutor,
  type FlowExecutorContext,
  type FlowExecutorResult,
} from "./handler";
import {
  JarvisActionInputError,
  type JarvisPieceRegistry,
  type JarvisPieceServices,
} from "../jarvis-pieces/types";
import { resolveTemplate, TemplateError, type StepOutputs } from "./templating";
import { evaluateConditionGroups, type BranchCondition, type BranchConditionGroups } from "./conditions";

interface FlowStepNode {
  name: string;
  displayName?: string;
  type: string;
  settings?: {
    pieceName?: string;
    actionName?: string;
    triggerName?: string;
    input?: Record<string, unknown>;
    /** LOOP_ON_ITEMS: template that resolves to an array. */
    items?: string;
    /** ROUTER: branches definition. */
    branches?: Array<RouterBranch>;
    /** ROUTER: which matched branches to run. */
    executionType?: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH";
  };
  nextAction?: FlowStepNode;
  /** LOOP_ON_ITEMS: head of the inner subgraph. */
  firstLoopAction?: FlowStepNode;
  /** ROUTER: per-branch subgraph head, indexed by branches[i]. May contain null for empty branches. */
  children?: Array<FlowStepNode | null>;
}

type RouterBranch =
  | { branchType: "CONDITION"; branchName: string; conditions: BranchConditionGroups }
  | { branchType: "FALLBACK"; branchName: string };

interface RunStepOutput {
  input: Record<string, unknown>;
  output: unknown;
}

interface WalkContext {
  outputs: StepOutputs;
  steps: Record<string, RunStepOutput>;
  counter: { count: number };
}

export interface JarvisPiecesFlowExecutorOptions {
  registry: JarvisPieceRegistry;
  services: JarvisPieceServices;
  /** Cap on actions per run, defense against runaway flows. Default 1000. */
  maxSteps?: number;
}

export class JarvisPiecesFlowExecutor implements FlowExecutor {
  private readonly registry: JarvisPieceRegistry;
  private readonly services: JarvisPieceServices;
  private readonly maxSteps: number;

  constructor(opts: JarvisPiecesFlowExecutorOptions) {
    this.registry = opts.registry;
    this.services = opts.services;
    this.maxSteps = opts.maxSteps ?? 1000;
  }

  async execute(ctx: FlowExecutorContext): Promise<FlowExecutorResult> {
    const trigger = ctx.version.trigger as unknown as FlowStepNode | null;
    if (!trigger || typeof trigger !== "object") {
      throw new FlowExecutionError("flow has no trigger", { name: "<trigger>", displayName: "Trigger" });
    }
    if (typeof trigger.name !== "string" || trigger.name.length === 0) {
      throw new FlowExecutionError("trigger is missing a name", { name: "<trigger>", displayName: "Trigger" });
    }

    const walkCtx: WalkContext = {
      // Trigger payload is exposed under the trigger's name so downstream
      // pieces can reference it via {{<triggerName>.field}}.
      outputs: { [trigger.name]: ctx.payload },
      steps: {},
      counter: { count: 0 },
    };

    await this.walk(trigger.nextAction, walkCtx);

    return {
      steps: walkCtx.steps as Record<string, unknown>,
      stepsCount: Object.keys(walkCtx.steps).length,
    };
  }

  /** Linearly walk a chain starting at `cursor`, dispatching by node type. */
  private async walk(cursor: FlowStepNode | undefined, ctx: WalkContext): Promise<void> {
    while (cursor) {
      if (++ctx.counter.count > this.maxSteps) {
        throw new FlowExecutionError(
          `flow exceeded maxSteps=${this.maxSteps}`,
          { name: cursor.name, displayName: cursor.displayName ?? cursor.name },
          ctx.steps,
        );
      }

      switch (cursor.type) {
        case "PIECE":
          await this.executePiece(cursor, ctx);
          break;
        case "LOOP_ON_ITEMS":
          await this.executeLoop(cursor, ctx);
          break;
        case "ROUTER":
          await this.executeRouter(cursor, ctx);
          break;
        default:
          throw new FlowExecutionError(
            `unsupported action type "${cursor.type}"`,
            { name: cursor.name, displayName: cursor.displayName ?? cursor.name },
            ctx.steps,
          );
      }

      cursor = cursor.nextAction;
    }
  }

  private async executePiece(node: FlowStepNode, ctx: WalkContext): Promise<void> {
    const stepLabel = { name: node.name, displayName: node.displayName ?? node.name };
    const settings = node.settings;
    if (!settings || typeof settings.pieceName !== "string" || typeof settings.actionName !== "string") {
      throw new FlowExecutionError(`step "${node.name}" missing pieceName/actionName`, stepLabel, ctx.steps);
    }
    const action = this.registry.resolveAction(`${settings.pieceName}:${settings.actionName}`);
    if (!action) {
      throw new FlowExecutionError(
        `step "${node.name}" references unknown action ${settings.pieceName}:${settings.actionName}`,
        stepLabel,
        ctx.steps,
      );
    }

    let resolvedInput: Record<string, unknown>;
    try {
      const raw = (settings.input ?? {}) as Record<string, unknown>;
      resolvedInput = resolveTemplate(raw, ctx.outputs) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof TemplateError) {
        throw new FlowExecutionError(`step "${node.name}" template error: ${e.message}`, stepLabel, ctx.steps);
      }
      throw e;
    }

    let parsed: unknown;
    try {
      parsed = action.parseInput(resolvedInput);
    } catch (e) {
      if (e instanceof JarvisActionInputError) {
        throw new FlowExecutionError(`step "${node.name}" input error: ${e.message}`, stepLabel, ctx.steps);
      }
      throw e;
    }

    let output: unknown;
    try {
      output = await action.execute(parsed, { services: this.services });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new FlowExecutionError(`step "${node.name}" execute error: ${msg}`, stepLabel, ctx.steps);
    }

    ctx.steps[node.name] = { input: resolvedInput, output };
    ctx.outputs[node.name] = output;
  }

  private async executeLoop(node: FlowStepNode, ctx: WalkContext): Promise<void> {
    const stepLabel = { name: node.name, displayName: node.displayName ?? node.name };
    const itemsExpr = node.settings?.items;
    if (typeof itemsExpr !== "string" || itemsExpr.length === 0) {
      throw new FlowExecutionError(`loop "${node.name}" missing settings.items`, stepLabel, ctx.steps);
    }

    let items: unknown;
    try {
      items = resolveTemplate(itemsExpr, ctx.outputs);
    } catch (e) {
      if (e instanceof TemplateError) {
        throw new FlowExecutionError(`loop "${node.name}" items template: ${e.message}`, stepLabel, ctx.steps);
      }
      throw e;
    }
    if (!Array.isArray(items)) {
      throw new FlowExecutionError(
        `loop "${node.name}" items resolved to ${typeof items}, expected array`,
        stepLabel,
        ctx.steps,
      );
    }

    const iterations: Array<Record<string, unknown>> = [];
    for (let i = 0; i < items.length; i++) {
      // Per-iteration loop context, accessible inside the body as
      // {{<loopName>.item}} / {{<loopName>.index}}.
      ctx.outputs[node.name] = { item: items[i], index: i + 1 };
      await this.walk(node.firstLoopAction, ctx);
      iterations.push({ item: items[i], index: i + 1 });
    }

    // Replace the per-iteration scratch value with a stable summary; flows
    // referencing {{<loopName>.iterations[k].item}} after the loop work.
    ctx.outputs[node.name] = { iterations, count: items.length };
    ctx.steps[node.name] = {
      input: { items: itemsExpr },
      output: { iterations, count: items.length },
    };
  }

  private async executeRouter(node: FlowStepNode, ctx: WalkContext): Promise<void> {
    const stepLabel = { name: node.name, displayName: node.displayName ?? node.name };
    const branches = node.settings?.branches ?? [];
    const children = node.children ?? [];
    const executionType = node.settings?.executionType ?? "EXECUTE_FIRST_MATCH";

    if (branches.length === 0) {
      // Empty router: skip but record so the run shows we visited.
      ctx.steps[node.name] = { input: { branches: [] }, output: { matched: [] } };
      ctx.outputs[node.name] = { matched: [] };
      return;
    }

    const matchedIndices: number[] = [];
    let fallbackIndex: number | null = null;
    for (let i = 0; i < branches.length; i++) {
      const branch = branches[i];
      if (!branch) continue;
      if (branch.branchType === "FALLBACK") {
        fallbackIndex = i;
        continue;
      }
      if (branch.branchType !== "CONDITION") continue; // unknown branch type: skip
      const ok = evaluateConditionGroups(branch.conditions, ctx.outputs);
      if (ok) {
        matchedIndices.push(i);
        if (executionType === "EXECUTE_FIRST_MATCH") break;
      }
    }
    if (matchedIndices.length === 0 && fallbackIndex !== null) {
      matchedIndices.push(fallbackIndex);
    }

    // Run each selected branch's subgraph.
    for (const idx of matchedIndices) {
      const subgraph = children[idx] ?? undefined;
      if (subgraph) await this.walk(subgraph, ctx);
    }

    const matchedNames = matchedIndices.map((i) => branches[i]?.branchName ?? `<branch_${i}>`);
    ctx.steps[node.name] = {
      input: { branches: branches.map((b) => b?.branchName ?? "<unnamed>") },
      output: { matched: matchedNames },
    };
    ctx.outputs[node.name] = { matched: matchedNames };

    // Helpful for downstream lints: if no branch matched and no fallback was
    // declared, we silently move on. That's correct behavior; downstream
    // conditions can detect via {{<routerName>.matched[0]}} being absent.
    void stepLabel;
  }
}

/** Re-exported for tests / external composers. */
export type { BranchCondition, BranchConditionGroups, RouterBranch };
