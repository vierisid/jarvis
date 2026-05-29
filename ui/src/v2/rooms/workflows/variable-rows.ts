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

/**
 * How many nested object levels the picker drills into. Most workflow event
 * payloads are 1-2 levels deep; capping prevents a pathological output (or a
 * sample with a recursive structure) from drowning the picker. Empirically
 * 3 covers every Jarvis event taxonomy and the upstream piece samples we
 * ship.
 */
const MAX_PICKER_DEPTH = 3;

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
      emitObjectRows(usable.value, step, "", rows, 0);
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
 * Recursively emit picker rows for every key in `obj`, dot-pathed against
 * `pathPrefix`. The parent row is always emitted (so the user can wire the
 * whole sub-object as `{{step.payload}}` when that is what they want); plain
 * non-empty object values trigger a recursive walk so nested leaves like
 * `payload.content` become first-class clickable rows.
 *
 * Why not flatten only -- the existing picker emitted a row for the parent
 * key (e.g. `payload`) and many flows rely on wiring the whole object into
 * a downstream JSON.stringify / jarvis-tool input. Keeping the parent row
 * preserves that contract; the nested rows are additive.
 *
 * Array values are emitted as a single leaf at their path; we deliberately
 * do not drill into array elements here (the top-level array case in
 * `buildVariableRows` handles iterate + first-element drill for whole-step
 * arrays).
 */
function emitObjectRows(
  obj: Record<string, unknown>,
  step: FlowStepNode,
  pathPrefix: string,
  rows: VariableRow[],
  depth: number,
): void {
  for (const key of Object.keys(obj)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    rows.push({
      step,
      field: path,
      label: path,
      template: `{{${step.name}.${path}}}`,
    });
    const value = obj[key];
    const isPlainNonEmptyObject =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length > 0;
    if (isPlainNonEmptyObject && depth + 1 < MAX_PICKER_DEPTH) {
      emitObjectRows(
        value as Record<string, unknown>,
        step,
        path,
        rows,
        depth + 1,
      );
    }
  }
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
    if (!trigger) return undefined;
    // Dynamic-output triggers: the envelope shape depends on a config
    // value (jarvis-trigger:on_event payload depends on `eventType`).
    // Resolve the configured prop value, look up the matching sample;
    // fall back to the static sample when the prop isn't set yet or
    // its value isn't in the map.
    const dyn = (trigger as { dynamicSampleData?: { propName: string; samples: Record<string, unknown> } }).dynamicSampleData;
    if (dyn) {
      const input = (settings as { input?: Record<string, unknown> })?.input;
      const propValue = input && typeof input === "object" ? input[dyn.propName] : undefined;
      if (typeof propValue === "string") {
        const dynSample = dyn.samples[propValue];
        if (dynSample !== undefined) return dynSample;
      }
    }
    // Triggers carry the upstream `sampleData`. Some pieces also set
    // `outputSample` as a hint for symmetry; either works.
    return trigger.sampleData ?? trigger.outputSample;
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
