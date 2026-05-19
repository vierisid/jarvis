/**
 * Variable-picker resolution: turn a predecessor chain into the rows shown
 * in the floating "Insert variable" panel.
 *
 * Per-step resolution order:
 *   1. persisted sampleData[step.name] -- user-pinned or run-captured
 *      (the most authoritative source: the user either typed it or a
 *      successful run wrote it through `mergeRunOutputsIntoSampleData`).
 *   2. declared output from the piece catalog -- `action.outputSample`
 *      (Jarvis extension to AP) or `trigger.sampleData` (upstream-native).
 *   3. fallback to a single `(output)` row that inserts the bare
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
): VariableRow[] {
  const rows: VariableRow[] = [];
  // Most-recent first: the chain comes out trigger-first from
  // pathToStep, but the user wants the closest predecessor on top.
  const ordered = [...predecessors].reverse();
  for (const step of ordered) {
    const captured = sampleData[step.name];
    const declared = lookupDeclaredOutput(step, catalog);
    const usable = pickUsableSample(captured, declared);
    if (usable) {
      for (const key of Object.keys(usable)) {
        rows.push({
          step,
          field: key,
          label: key,
          template: `{{${step.name}.${key}}}`,
        });
      }
    } else {
      // No usable shape -- offer the whole-step template; the user can
      // drill in with `.field` manually.
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
 * Pick the first source that's an object with at least one top-level key.
 * Anything else (primitive, array, empty object, undefined) is treated as
 * "no usable shape" so the caller falls through to the `(output)` row.
 */
export function pickUsableSample(
  captured: unknown,
  declared: unknown,
): Record<string, unknown> | null {
  for (const candidate of [captured, declared]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const obj = candidate as Record<string, unknown>;
      if (Object.keys(obj).length > 0) return obj;
    }
  }
  return null;
}
