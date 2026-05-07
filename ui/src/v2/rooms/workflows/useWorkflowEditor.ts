/**
 * Hook for the workflow visual editor.
 *
 * Loads:
 *   - The piece catalog from `/api/workflows/pieces` (cached for the editor's lifetime).
 *   - The flow's full detail from `/api/workflows/:id`.
 *   - The flow's editable version: prefer the latest DRAFT, fall back to a
 *     DRAFT clone of the published version when only LOCKED versions exist.
 *
 * Edits are local until `save()` PATCHes the draft. Save returns the
 * server-confirmed version so the editor can re-render from the new
 * `updated` timestamp.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type FlowVersionState = "DRAFT" | "LOCKED";

export type FlowRouterBranch =
  | {
      branchType: "CONDITION";
      branchName: string;
      conditions: Array<Array<{ firstValue: string; operator: string; secondValue?: string; caseSensitive?: boolean }>>;
    }
  | { branchType: "FALLBACK"; branchName: string };

export interface FlowStepNode {
  name: string;
  type: "PIECE_TRIGGER" | "EMPTY" | "PIECE" | "LOOP_ON_ITEMS" | "ROUTER";
  displayName?: string;
  settings?: {
    pieceName?: string;
    triggerName?: string;
    actionName?: string;
    input?: Record<string, unknown>;
    /** LOOP_ON_ITEMS: template that resolves to an array. */
    items?: string;
    /** ROUTER: branches definition. */
    branches?: FlowRouterBranch[];
    /** ROUTER: which matched branches to run. */
    executionType?: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH";
  };
  nextAction?: FlowStepNode;
  /** LOOP_ON_ITEMS: head of the inner subgraph executed once per iteration. */
  firstLoopAction?: FlowStepNode;
  /** ROUTER: per-branch subgraph head. May contain null for empty branches. */
  children?: Array<FlowStepNode | null>;
}

export interface FlowVersion {
  id: string;
  flowId: string;
  displayName: string;
  trigger: FlowStepNode;
  state: FlowVersionState;
  valid: boolean;
  schemaVersion: string | null;
  agentIds: string[];
  connectionIds: string[];
  notes: unknown[];
  backupFiles: Record<string, string> | null;
  created: number;
  updated: number;
}

export type PieceInputType =
  | "string"
  | "long_text"
  | "number"
  | "boolean"
  | "enum"
  | "multi_enum"
  | "json";

export interface PieceInputField {
  name: string;
  label: string;
  type: PieceInputType;
  required: boolean;
  description?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string; description?: string }>;
  default?: unknown;
}

export interface PieceInputSchema {
  fields: PieceInputField[];
}

export interface PieceCatalogActionOrTrigger {
  name: string;
  displayName: string;
  description: string;
  inputSchema: PieceInputSchema | null;
}

export interface PieceCatalogEntry {
  name: string;
  displayName: string;
  description: string;
  actions: PieceCatalogActionOrTrigger[];
  triggers: PieceCatalogActionOrTrigger[];
}

interface ActionResult {
  ok: boolean;
  message: string;
}

export function useWorkflowEditor(flowId: string | null) {
  const [catalog, setCatalog] = useState<PieceCatalogEntry[]>([]);
  const [version, setVersion] = useState<FlowVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);

  // Local edit buffer: a copy of `version.trigger` the editor mutates until save.
  const [draftTrigger, setDraftTrigger] = useState<FlowStepNode | null>(null);
  const ignoreNextLoadRef = useRef(false);

  // Stash for trigger settings while the user is in EMPTY (manual) mode.
  // Switching back to PIECE_TRIGGER restores the prior piece + input so a
  // morph round-trip doesn't lose work.
  const triggerSettingsStashRef = useRef<FlowStepNode["settings"] | null>(null);

  /** Load (or reload) the catalog + version. */
  const reload = useCallback(async (): Promise<void> => {
    if (!flowId) return;
    setLoading(true);
    setError(null);
    try {
      const [catalogRes, detailRes] = await Promise.all([
        fetch("/api/workflows/pieces"),
        fetch(`/api/workflows/${flowId}`),
      ]);
      if (!catalogRes.ok) throw new Error(`pieces -> ${catalogRes.status}`);
      if (!detailRes.ok) throw new Error(`flow detail -> ${detailRes.status}`);
      const catalogList = (await catalogRes.json()) as PieceCatalogEntry[];
      setCatalog(catalogList);

      const detail = (await detailRes.json()) as {
        flow: { id: string };
        latestDraft: FlowVersion | null;
        published: FlowVersion | null;
      };
      let editable: FlowVersion | null = detail.latestDraft;
      if (!editable && detail.published) {
        // Clone the published version as a new draft so the editor has
        // something writable. The clone is created lazily on first save;
        // until then we surface the published version's contents in the UI.
        editable = { ...detail.published, state: "DRAFT" };
      }
      setVersion(editable);
      setDraftTrigger(editable ? cloneTrigger(editable.trigger) : null);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [flowId]);

  useEffect(() => {
    if (ignoreNextLoadRef.current) {
      ignoreNextLoadRef.current = false;
      return;
    }
    void reload();
  }, [reload]);

  /** Update a single step in-place by name. The mutated tree replaces draftTrigger. */
  const updateStep = useCallback((stepName: string, patch: Partial<FlowStepNode>): void => {
    setDraftTrigger((prev) => {
      if (!prev) return prev;
      const next = cloneTrigger(prev);
      const target = findStep(next, stepName);
      if (target) {
        Object.assign(target, patch);
        // Preserve nested objects we didn't touch
        if (patch.settings) {
          target.settings = { ...target.settings, ...patch.settings };
        }
      }
      return next;
    });
    setDirty(true);
  }, []);

  /** Update a single input key on a step. Convenience for the properties panel. */
  const updateStepInput = useCallback((stepName: string, key: string, value: unknown): void => {
    setDraftTrigger((prev) => {
      if (!prev) return prev;
      const next = cloneTrigger(prev);
      const target = findStep(next, stepName);
      if (target) {
        const settings = target.settings ? { ...target.settings } : {};
        settings.input = { ...(settings.input ?? {}), [key]: value };
        target.settings = settings;
      }
      return next;
    });
    setDirty(true);
  }, []);

  /**
   * Insert a new PIECE step immediately after `predecessorName`. The new step
   * starts unconfigured (no piece picked); the user picks one in the panel.
   * Returns the new step's name so the caller can select it.
   */
  const insertStepAfter = useCallback((predecessorName: string): string | null => {
    let createdName: string | null = null;
    setDraftTrigger((prev) => {
      if (!prev) return prev;
      const next = cloneTrigger(prev);
      const predecessor = findStep(next, predecessorName);
      if (!predecessor) return prev;
      const usedNames = new Set(walkSteps(next).map((s) => s.name));
      const newName = nextStepName(usedNames);
      createdName = newName;
      const newStep: FlowStepNode = {
        name: newName,
        type: "PIECE",
        displayName: "New step",
        settings: { input: {} },
        nextAction: predecessor.nextAction,
      };
      predecessor.nextAction = newStep;
      return next;
    });
    if (createdName) setDirty(true);
    return createdName;
  }, []);

  /**
   * Re-link the top-level chain so that action steps appear in the order
   * given by `orderedNames`. The trigger always stays at the head; the input
   * must list every CURRENT action step's name exactly once (no additions,
   * no removals — those have their own methods). Out-of-band names are
   * ignored, missing names cause the call to no-op so a stale UI invocation
   * can't corrupt the chain.
   *
   * Scope: top-level chain only. Reordering inside a LOOP_ON_ITEMS body or
   * ROUTER branch requires a different operation (sub-chains aren't drawn
   * on the canvas yet).
   */
  const reorderActionNodes = useCallback((orderedNames: string[]): void => {
    setDraftTrigger((prev) => {
      if (!prev) return prev;
      const next = cloneTrigger(prev);
      // Walk current top-level action steps (everything below the trigger).
      const currentSteps: FlowStepNode[] = [];
      let cursor: FlowStepNode | undefined = next.nextAction;
      while (cursor) {
        currentSteps.push(cursor);
        cursor = cursor.nextAction;
      }
      const currentNames = new Set(currentSteps.map((s) => s.name));
      // Validate inputs: identical name set, no duplicates.
      if (orderedNames.length !== currentSteps.length) return prev;
      const seen = new Set<string>();
      for (const name of orderedNames) {
        if (seen.has(name) || !currentNames.has(name)) return prev;
        seen.add(name);
      }
      // No-op if order is unchanged.
      const same = currentSteps.every((s, i) => s.name === orderedNames[i]);
      if (same) return prev;

      // Re-link. Each step keeps its own subtree (firstLoopAction, children,
      // settings) -- we only swap nextAction pointers.
      const byName = new Map(currentSteps.map((s) => [s.name, s]));
      const ordered = orderedNames.map((n) => byName.get(n)!).filter((s): s is FlowStepNode => !!s);
      next.nextAction = ordered[0];
      for (let i = 0; i < ordered.length; i++) {
        const step = ordered[i];
        if (!step) continue;
        step.nextAction = ordered[i + 1];
      }
      return next;
    });
    setDirty(true);
  }, []);

  /**
   * Remove a step from the chain by name. The trigger cannot be deleted.
   * The deleted step's `nextAction` becomes its predecessor's `nextAction`.
   */
  const deleteStep = useCallback((stepName: string): void => {
    setDraftTrigger((prev) => {
      if (!prev) return prev;
      if (prev.name === stepName) return prev; // trigger is undeletable
      const next = cloneTrigger(prev);
      let cursor: FlowStepNode = next;
      while (cursor.nextAction) {
        if (cursor.nextAction.name === stepName) {
          cursor.nextAction = cursor.nextAction.nextAction;
          return next;
        }
        cursor = cursor.nextAction;
      }
      return prev;
    });
    setDirty(true);
  }, []);

  /**
   * Morph the trigger between EMPTY (manual) and PIECE_TRIGGER. Switching to
   * EMPTY stashes the prior settings; switching back restores them so the
   * round-trip doesn't discard the user's piece + input.
   */
  const setTriggerType = useCallback((type: "EMPTY" | "PIECE_TRIGGER"): void => {
    setDraftTrigger((prev) => {
      if (!prev) return prev;
      const next = cloneTrigger(prev);
      if (type === "EMPTY") {
        // Stash anything non-trivial so we can restore on the way back.
        if (next.settings && (next.settings.pieceName || Object.keys(next.settings.input ?? {}).length > 0)) {
          triggerSettingsStashRef.current = JSON.parse(JSON.stringify(next.settings));
        }
        next.type = "EMPTY";
        next.settings = {};
      } else {
        next.type = "PIECE_TRIGGER";
        if (triggerSettingsStashRef.current) {
          next.settings = JSON.parse(JSON.stringify(triggerSettingsStashRef.current));
          triggerSettingsStashRef.current = null;
        } else if (!next.settings || !next.settings.pieceName) {
          next.settings = { input: {} };
        }
      }
      return next;
    });
    setDirty(true);
  }, []);

  const setStepPiece = useCallback((stepName: string, pieceName: string, actionName: string): void => {
    setDraftTrigger((prev) => {
      if (!prev) return prev;
      const next = cloneTrigger(prev);
      const target = findStep(next, stepName);
      if (!target) return next;

      const isTrigger = target.type === "PIECE_TRIGGER" || target.type === "EMPTY";
      // Look up the chosen sub-action's schema to seed defaults.
      const piece = catalog.find((p) => p.name === pieceName);
      const sub = isTrigger
        ? piece?.triggers.find((t) => t.name === actionName)
        : piece?.actions.find((a) => a.name === actionName);
      const seed = applySchemaDefaults(target.settings?.input ?? {}, sub?.inputSchema ?? null);

      const settings: NonNullable<FlowStepNode["settings"]> = {
        ...(target.settings ?? {}),
        pieceName,
        input: seed,
      };
      if (isTrigger) settings.triggerName = actionName;
      else settings.actionName = actionName;
      target.settings = settings;
      return next;
    });
    setDirty(true);
  }, [catalog]);

  /** Save the draft trigger back to the server. Returns the new version on success. */
  const save = useCallback(async (): Promise<ActionResult> => {
    if (!flowId || !version || !draftTrigger) {
      return { ok: false, message: "nothing to save" };
    }
    try {
      // If editing a published version (LOCKED clone), we need to create a
      // new draft via POST /api/workflows/:id/versions. Otherwise PATCH.
      let res: Response;
      if (version.state === "LOCKED") {
        res = await fetch(`/api/workflows/${flowId}/versions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: version.displayName, trigger: draftTrigger }),
        });
      } else {
        res = await fetch(`/api/workflows/${flowId}/versions/${version.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trigger: draftTrigger }),
        });
      }
      if (!res.ok) {
        const body = await safeJson(res);
        return { ok: false, message: body?.error ?? `save failed: ${res.status}` };
      }
      const updated = (await res.json()) as FlowVersion;
      ignoreNextLoadRef.current = true;
      setVersion(updated);
      setDraftTrigger(cloneTrigger(updated.trigger));
      setDirty(false);
      return { ok: true, message: "Saved" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }, [flowId, version, draftTrigger]);

  const reset = useCallback((): void => {
    if (version) {
      setDraftTrigger(cloneTrigger(version.trigger));
      setDirty(false);
    }
  }, [version]);

  /** Depth-recursive flatten that includes LOOP body + ROUTER branch children.
   *  Top-level entries have depth=0; sub-graph entries carry their parent's
   *  step name + (for routers) the branch label. */
  const allSteps = useMemo(
    () => (draftTrigger ? flattenSteps(draftTrigger) : []),
    [draftTrigger],
  );

  /**
   * Walk every step and collect required-but-empty inputs (according to the
   * piece's declared schema). The dashboard uses this for a save-time
   * confirm; the executor's `parseInput` is the real gate.
   */
  const validationGaps = useMemo<EditorValidationGap[]>(
    () => collectValidationGaps(allSteps, catalog),
    [allSteps, catalog],
  );

  return {
    catalog,
    version,
    draftTrigger,
    allSteps,
    error,
    loading,
    dirty,
    validationGaps,
    reload,
    updateStep,
    updateStepInput,
    setStepPiece,
    setTriggerType,
    insertStepAfter,
    deleteStep,
    reorderActionNodes,
    save,
    reset,
  };
}

export interface EditorValidationGap {
  stepName: string;
  stepDisplayName: string;
  fieldName: string;
  fieldLabel: string;
}

function collectValidationGaps(steps: FlatStep[], catalog: PieceCatalogEntry[]): EditorValidationGap[] {
  const gaps: EditorValidationGap[] = [];
  for (const entry of steps) {
    const step = entry.step;
    const isTrigger = step.type === "PIECE_TRIGGER" || step.type === "EMPTY";
    if (step.type === "EMPTY") continue; // manual triggers carry no inputs
    const subName = isTrigger ? step.settings?.triggerName : step.settings?.actionName;
    if (!step.settings?.pieceName || !subName) {
      gaps.push({
        stepName: step.name,
        stepDisplayName: step.displayName ?? step.name,
        fieldName: "<piece>",
        fieldLabel: isTrigger ? "Trigger / action not selected" : "Action not selected",
      });
      continue;
    }
    const piece = catalog.find((p) => p.name === step.settings?.pieceName);
    const sub = isTrigger
      ? piece?.triggers.find((t) => t.name === subName)
      : piece?.actions.find((a) => a.name === subName);
    const schema = sub?.inputSchema;
    if (!schema) continue;
    const input = (step.settings.input ?? {}) as Record<string, unknown>;
    for (const field of schema.fields) {
      if (!field.required) continue;
      const v = input[field.name];
      const empty =
        v === undefined ||
        v === null ||
        v === "" ||
        (Array.isArray(v) && v.length === 0);
      if (empty) {
        gaps.push({
          stepName: step.name,
          stepDisplayName: step.displayName ?? step.name,
          fieldName: field.name,
          fieldLabel: field.label,
        });
      }
    }
  }
  return gaps;
}

/* ----------------------------------------------------------------- helpers */

/**
 * Deep clone a trigger tree. Uses JSON round-trip because the trigger shape is
 * deliberately JSON-serializable (it's persisted as TEXT in SQLite). Drops
 * Dates / Maps / Sets / `undefined` fields — none of which the trigger format
 * permits — so the loss is intentional.
 */
function cloneTrigger(node: FlowStepNode): FlowStepNode {
  return JSON.parse(JSON.stringify(node)) as FlowStepNode;
}

function findStep(root: FlowStepNode, name: string): FlowStepNode | null {
  let cursor: FlowStepNode | undefined = root;
  while (cursor) {
    if (cursor.name === name) return cursor;
    cursor = cursor.nextAction;
  }
  return null;
}

/**
 * Seed the step's input from a schema's declared defaults. Existing keys win
 * (user-set values are never overwritten); missing keys with a `default` get
 * filled in. Returns a fresh object suitable for assignment.
 */
function applySchemaDefaults(
  current: Record<string, unknown>,
  schema: PieceInputSchema | null,
): Record<string, unknown> {
  if (!schema) return { ...current };
  const next: Record<string, unknown> = { ...current };
  for (const field of schema.fields) {
    if (field.default === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(next, field.name)) continue;
    // Clone the default if it's an object/array so successive applies stay independent.
    next[field.name] =
      typeof field.default === "object" && field.default !== null
        ? JSON.parse(JSON.stringify(field.default))
        : field.default;
  }
  return next;
}

/**
 * Generate the next `step_<n>` name. Always picks `max(existing-numeric-suffix) + 1`,
 * never reuses a freed slot. Reusing names within the same flow risks template
 * references like `{{step_2.foo}}` silently re-binding to a fresh node, so we
 * burn through the namespace monotonically instead.
 */
function nextStepName(used: Set<string>): string {
  let max = 0;
  for (const name of used) {
    const m = /^step_(\d+)$/.exec(name);
    if (m && typeof m[1] === "string") {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `step_${max + 1}`;
}

function walkSteps(root: FlowStepNode): FlowStepNode[] {
  const list: FlowStepNode[] = [];
  let cursor: FlowStepNode | undefined = root;
  while (cursor) {
    list.push(cursor);
    cursor = cursor.nextAction;
  }
  return list;
}

/**
 * Depth-recursive flatten. Visits the top-level chain, then for each
 * LOOP_ON_ITEMS recurses into its `firstLoopAction` chain at depth+1, and
 * for each ROUTER recurses into each non-null `children[i]` chain at
 * depth+1 (carrying the branch's name as a label).
 *
 * Order is depth-first preorder: a parent is visited before its sub-graphs,
 * sub-graphs are visited in order, then the parent's `nextAction` is
 * visited. This matches the visual top-to-bottom indentation users expect.
 */
export function flattenSteps(root: FlowStepNode): FlatStep[] {
  const out: FlatStep[] = [];

  const walk = (
    start: FlowStepNode | undefined,
    depth: number,
    parentName: string | undefined,
    branchName: string | undefined,
    containerKind: "loop" | "router" | undefined,
  ): void => {
    let cursor: FlowStepNode | undefined = start;
    while (cursor) {
      const entry: FlatStep = { step: cursor, depth };
      if (parentName !== undefined) entry.parentName = parentName;
      if (branchName !== undefined) entry.branchName = branchName;
      if (containerKind !== undefined) entry.containerKind = containerKind;
      out.push(entry);

      if (cursor.type === "LOOP_ON_ITEMS" && cursor.firstLoopAction) {
        walk(cursor.firstLoopAction, depth + 1, cursor.name, undefined, "loop");
      } else if (cursor.type === "ROUTER" && Array.isArray(cursor.children)) {
        const branches = cursor.settings?.branches ?? [];
        for (let i = 0; i < cursor.children.length; i++) {
          const child = cursor.children[i];
          if (!child) continue;
          const bName = branches[i]?.branchName ?? `branch_${i}`;
          walk(child, depth + 1, cursor.name, bName, "router");
        }
      }

      cursor = cursor.nextAction;
    }
  };

  walk(root, 0, undefined, undefined, undefined);
  return out;
}

/** A single entry in `allSteps`. `step` is the live node; `depth` is the
 *  rendering indent level (0 = top). `parentName` / `branchName` are present
 *  for nodes that live inside a LOOP body (parent only) or ROUTER branch. */
export interface FlatStep {
  step: FlowStepNode;
  depth: number;
  parentName?: string;
  branchName?: string;
  containerKind?: "loop" | "router";
}

async function safeJson(res: Response): Promise<{ error?: string } | null> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return null;
  }
}
