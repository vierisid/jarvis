/**
 * Variable-picker resolution: turn a predecessor chain into the rows shown
 * in the floating "Insert variable" panel.
 *
 * Per-step resolution order:
 *   1. persisted sampleData[step.name] -- user-pinned or run-captured for
 *      THIS specific step (the most authoritative source).
 *   2. declared output from the piece catalog -- `action.outputSample`
 *      (Jarvis extension to AP) or `trigger.sampleData` (upstream-native).
 *      Acts as the author's "this is what my action returns" contract.
 *   3. persisted sampleData from a SIBLING step that shares the same
 *      (pieceName, actionName) / (pieceName, triggerName). Lets a second
 *      "Send email" step inherit the shape captured from the first one
 *      without having to be re-run -- the output shape of a given action
 *      is usually identical across instances.
 *   4. fallback to a single `(output)` row that inserts the bare
 *      `{{step.name}}` template; the user can drill in by hand.
 *
 * Lives in its own module so the picker logic is testable without
 * mounting the editor's React tree.
 */

import type { FlowStepNode, PieceCatalogEntry } from "./useWorkflowEditor";

export interface VariableRow {
  /** The step that produces this output. */
  step: FlowStepNode;
  /** Field key (`"name"`) -- empty for whole-output rows. */
  field: string;
  /** Display label shown in the picker; matches `field` or "(output)". */
  label: string;
  /** Full template inserted into the input: `{{stepName.field}}` or `{{stepName}}`. */
  template: string;
}

export function buildVariableRows(
  predecessors: FlowStepNode[],
  sampleData: Record<string, unknown>,
  catalog: PieceCatalogEntry[],
  /**
   * Every step in the current version (in any order). Used for the
   * sibling-shape fallback: a second instance of the same action
   * inherits the shape captured from the first. Pass an empty array to
   * disable the sibling tier (e.g. tests that don't need it).
   */
  allSteps: FlowStepNode[] = [],
): VariableRow[] {
  const rows: VariableRow[] = [];
  // Most-recent first: the chain comes out trigger-first from
  // pathToStep, but the user wants the closest predecessor on top.
  const ordered = [...predecessors].reverse();
  for (const step of ordered) {
    const captured = sampleData[step.name];
    const declared = lookupDeclaredOutput(step, catalog);
    const sibling = pickUsableSample(captured, declared)
      ? undefined
      : lookupSiblingShape(step, allSteps, sampleData);
    const usable = pickUsableSample(captured, declared) ?? pickUsableSample(sibling, undefined);
    if (usable?.kind === "object") {
      for (const key of Object.keys(usable.value)) {
        rows.push({
          step,
          field: key,
          label: key,
          template: `{{${step.name}.${key}}}`,
        });
      }
    } else if (usable?.kind === "array") {
      // Array output: first emit the iterate-all row (the whole step,
      // for LOOP_ON_ITEMS sources), then drill one level into the
      // first element's top-level keys so users wiring a fixed index
      // ({{step[0].field}}) see real labels. The drill rows are
      // typographically distinct so the user can tell "first item" from
      // "iterate".
      const len = usable.value.length;
      const iterateLabel = `(${len} item${len === 1 ? "" : "s"})`;
      rows.push({ step, field: "", label: iterateLabel, template: `{{${step.name}}}` });
      const first = usable.value[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        for (const key of Object.keys(first as Record<string, unknown>)) {
          rows.push({
            step,
            field: key,
            // Prefix with "[0]." so the user reads the label as a
            // first-element field, not a wholesale step output key.
            label: `[0].${key}`,
            template: `{{${step.name}[0].${key}}}`,
          });
        }
      }
    } else {
      // No usable shape anywhere -- offer the whole-step template; the
      // user can drill in with `.field` manually.
      rows.push({ step, field: "", label: "(output)", template: `{{${step.name}}}` });
    }
  }
  return rows;
}

/**
 * Walk the catalog to find the action / trigger that backs this step and
 * return its declared output sample (if any). Returns undefined for steps
 * that aren't piece-backed (LOOP, ROUTER, EMPTY trigger) or when the piece
 * / sub-action isn't in the catalog.
 */
export function lookupDeclaredOutput(
  step: FlowStepNode,
  catalog: PieceCatalogEntry[],
): unknown {
  const settings = step.settings as
    | { pieceName?: unknown; actionName?: unknown; triggerName?: unknown }
    | undefined;
  const pieceName = typeof settings?.pieceName === "string" ? settings.pieceName : null;
  if (!pieceName) return undefined;
  const piece = catalog.find((p) => p.name === pieceName);
  if (!piece) return undefined;
  if (step.type === "PIECE_TRIGGER") {
    const triggerName = typeof settings?.triggerName === "string" ? settings.triggerName : null;
    if (!triggerName) return undefined;
    const trigger = piece.triggers.find((t) => t.name === triggerName);
    // Triggers carry the upstream `sampleData`. Some pieces also set
    // `outputSample` as a hint for symmetry; either works.
    return trigger?.sampleData ?? trigger?.outputSample;
  }
  if (step.type === "PIECE") {
    const actionName = typeof settings?.actionName === "string" ? settings.actionName : null;
    if (!actionName) return undefined;
    const action = piece.actions.find((a) => a.name === actionName);
    return action?.outputSample;
  }
  return undefined;
}

/**
 * Find another step in the flow that shares the same piece + sub-action
 * with `step` and has a usable sampleData entry; return that entry. The
 * output shape of a given action is usually identical across instances,
 * so capturing on step_1 (gmail.send_email) is enough to make step_2
 * (also gmail.send_email) show field-level rows.
 *
 * Skips:
 *   - the step itself (sampleData[step.name] is the direct-match tier
 *     and was already checked by the caller)
 *   - steps with a different piece or sub-action
 *   - LOOP / ROUTER / EMPTY (no piece identity to match on)
 *   - siblings whose own sampleData is missing or non-object
 *
 * Returns the first match in iteration order; with the usual auto-capture
 * pattern (most-recently-run steps are most likely to have data), this is
 * good enough -- we don't try to pick a "best" sibling.
 */
export function lookupSiblingShape(
  step: FlowStepNode,
  allSteps: FlowStepNode[],
  sampleData: Record<string, unknown>,
): unknown {
  const id = stepActionId(step);
  if (!id) return undefined;
  for (const other of allSteps) {
    if (other.name === step.name) continue;
    const otherId = stepActionId(other);
    if (!otherId || otherId.piece !== id.piece || otherId.sub !== id.sub || otherId.kind !== id.kind) continue;
    const sample = sampleData[other.name];
    // Accept the same shapes the picker can render: a non-empty
    // plain object OR a non-empty array. Other shapes (primitives,
    // null, empty containers) give the picker nothing to display.
    if (sample && typeof sample === "object") {
      if (Array.isArray(sample) && sample.length > 0) return sample;
      if (!Array.isArray(sample) && Object.keys(sample).length > 0) return sample;
    }
  }
  return undefined;
}

/**
 * Identity of an action / trigger for sibling matching. Two steps are
 * "the same action" when their `{ kind, piece, sub }` triples match.
 */
function stepActionId(step: FlowStepNode): { kind: "PIECE" | "PIECE_TRIGGER"; piece: string; sub: string } | null {
  const settings = step.settings as
    | { pieceName?: unknown; actionName?: unknown; triggerName?: unknown }
    | undefined;
  const piece = typeof settings?.pieceName === "string" ? settings.pieceName : null;
  if (!piece) return null;
  if (step.type === "PIECE_TRIGGER") {
    const sub = typeof settings?.triggerName === "string" ? settings.triggerName : null;
    return sub ? { kind: "PIECE_TRIGGER", piece, sub } : null;
  }
  if (step.type === "PIECE") {
    const sub = typeof settings?.actionName === "string" ? settings.actionName : null;
    return sub ? { kind: "PIECE", piece, sub } : null;
  }
  return null;
}

/**
 * Discriminated picker result. The variable-row builder produces
 * different shapes for objects (one row per key) vs arrays (a single
 * iterate-able row), so the picker discriminates here rather than
 * forcing the caller to re-detect.
 */
export type UsableSample =
  | { kind: "object"; value: Record<string, unknown> }
  | { kind: "array"; value: unknown[] };

/**
 * Pick the first source the picker can render: a non-empty plain
 * object or a non-empty array. Anything else (primitive, null, empty
 * container, undefined) returns null so the caller falls through to
 * the `(output)` row.
 *
 * Precedence is by candidate order, not by kind: captured wins over
 * declared regardless of whether either is an object or an array. A
 * step whose declared shape is an object but whose captured run output
 * is an array shows up as an iterable -- the runtime truth beats the
 * author's intent because the user has a concrete value to wire.
 */
export function pickUsableSample(
  captured: unknown,
  declared: unknown,
): UsableSample | null {
  for (const candidate of [captured, declared]) {
    if (!candidate || typeof candidate !== "object") continue;
    if (Array.isArray(candidate)) {
      if (candidate.length > 0) return { kind: "array", value: candidate };
      continue;
    }
    const obj = candidate as Record<string, unknown>;
    if (Object.keys(obj).length > 0) return { kind: "object", value: obj };
  }
  return null;
}
