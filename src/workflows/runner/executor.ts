/**
 * `JarvisPiecesFlowExecutor` -- walks a flow_version's trigger->nextAction
 * chain and dispatches each PIECE step to the JarvisPieceRegistry.
 *
 * Activepieces flow shape (subset we honor; see
 * src/workflows/activepieces/packages/shared/src/lib/automation/flows/):
 *
 *   {
 *     "name": "trigger",
 *     "type": "PIECE_TRIGGER" | "EMPTY",
 *     "settings": { "pieceName": "...", "triggerName": "...", "input": {...} },
 *     "nextAction": { ...action, "nextAction": { ... } }
 *   }
 *
 * We currently support:
 *   - Linear chains (trigger -> action -> action -> ...).
 *   - PIECE actions whose `pieceName` is registered in our JarvisPieceRegistry.
 *
 * We do NOT yet support:
 *   - LOOP_ON_ITEMS, ROUTER, CODE actions.
 *   - Pieces outside the Jarvis registry (gmail, slack, etc.) -- those need
 *     the engine subprocess.
 *   - The trigger's runtime semantics. We treat the trigger purely as an
 *     anchor for `nextAction` and pass the run's external payload as the
 *     trigger's "output" under the trigger's step name.
 *
 * For each PIECE action: resolve `input` templates against the step-output
 * map, call the action's `parseInput`, then `execute`. Store the result.
 * If the action throws, surface as `FlowExecutionError` with the named step.
 *
 * Steps map serialized to flow_run.steps:
 *   { [stepName]: { input: <resolved>, output: <result> } }
 *
 * Output of the executor: the run's terminal `steps` map and `stepsCount`.
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

interface FlowStepNode {
  name: string;
  displayName?: string;
  type: string;
  settings?: {
    pieceName?: string;
    actionName?: string;
    triggerName?: string;
    input?: Record<string, unknown>;
  };
  nextAction?: FlowStepNode;
  // LOOP_ON_ITEMS / ROUTER nodes have additional shapes; ignored for now.
}

interface RunStepOutput {
  input: Record<string, unknown>;
  output: unknown;
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
      throw new FlowExecutionError(
        "flow has no trigger",
        { name: "<trigger>", displayName: "Trigger" },
      );
    }
    if (typeof trigger.name !== "string" || trigger.name.length === 0) {
      throw new FlowExecutionError(
        "trigger is missing a name",
        { name: "<trigger>", displayName: "Trigger" },
      );
    }

    // The trigger's "output" is the run's external payload. Pieces downstream
    // can reference it via {{<triggerName>.foo}}.
    const stepOutputs: StepOutputs = { [trigger.name]: ctx.payload };
    const steps: Record<string, RunStepOutput> = {};

    let cursor: FlowStepNode | undefined = trigger.nextAction;
    let count = 0;
    while (cursor) {
      if (++count > this.maxSteps) {
        throw new FlowExecutionError(
          `flow exceeded maxSteps=${this.maxSteps}`,
          { name: cursor.name, displayName: cursor.displayName ?? cursor.name },
          steps,
        );
      }

      const stepLabel = {
        name: cursor.name,
        displayName: cursor.displayName ?? cursor.name,
      };

      if (cursor.type !== "PIECE") {
        throw new FlowExecutionError(
          `unsupported action type "${cursor.type}" -- this executor only handles PIECE actions in linear chains`,
          stepLabel,
          steps,
        );
      }
      const settings = cursor.settings;
      if (
        !settings ||
        typeof settings.pieceName !== "string" ||
        typeof settings.actionName !== "string"
      ) {
        throw new FlowExecutionError(
          `step "${cursor.name}" missing pieceName/actionName`,
          stepLabel,
          steps,
        );
      }

      const action = this.registry.resolveAction(`${settings.pieceName}:${settings.actionName}`);
      if (!action) {
        throw new FlowExecutionError(
          `step "${cursor.name}" references unknown action ${settings.pieceName}:${settings.actionName}`,
          stepLabel,
          steps,
        );
      }

      let resolvedInput: Record<string, unknown>;
      try {
        const raw = (settings.input ?? {}) as Record<string, unknown>;
        resolvedInput = resolveTemplate(raw, stepOutputs) as Record<string, unknown>;
      } catch (e) {
        if (e instanceof TemplateError) {
          throw new FlowExecutionError(
            `step "${cursor.name}" template error: ${e.message}`,
            stepLabel,
            steps,
          );
        }
        throw e;
      }

      let parsed: unknown;
      try {
        parsed = action.parseInput(resolvedInput);
      } catch (e) {
        if (e instanceof JarvisActionInputError) {
          throw new FlowExecutionError(
            `step "${cursor.name}" input error: ${e.message}`,
            stepLabel,
            steps,
          );
        }
        throw e;
      }

      let output: unknown;
      try {
        output = await action.execute(parsed, { services: this.services });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new FlowExecutionError(
          `step "${cursor.name}" execute error: ${msg}`,
          stepLabel,
          steps,
        );
      }

      steps[cursor.name] = { input: resolvedInput, output };
      stepOutputs[cursor.name] = output;
      cursor = cursor.nextAction;
    }

    return { steps: steps as Record<string, unknown>, stepsCount: Object.keys(steps).length };
  }
}
