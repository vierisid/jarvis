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
import {
  addStepToHead as treeAddStepToHead,
  addRouterBranch as treeAddRouterBranch,
  applySchemaDefaults,
  cloneTrigger,
  findStep,
  flattenSteps,
  insertStepAfter as treeInsertStepAfter,
  removeRouterBranch as treeRemoveRouterBranch,
  removeStep,
  reorderChain as treeReorderChain,
  setLoopItems as treeSetLoopItems,
  setRouterExecutionType as treeSetRouterExecutionType,
} from "./tree";

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
  | "datetime"
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
      const result = treeInsertStepAfter(prev, predecessorName);
      if (!result) return prev;
      createdName = result.newName;
      return result.tree;
    });
    if (createdName) setDirty(true);
    return createdName;
  }, []);

  /** Seed a new PIECE step at the head of a chain. Used when LOOP body or
   *  ROUTER branch is empty (no node to insert after). */
  const addStepToHead = useCallback((scope: ChainScope): string | null => {
    let createdName: string | null = null;
    setDraftTrigger((prev) => {
      if (!prev) return prev;
      const result = treeAddStepToHead(prev, scope);
      if (!result) return prev;
      createdName = result.newName;
      return result.tree;
    });
    if (createdName) setDirty(true);
    return createdName;
  }, []);

  /**
   * Re-link a chain (top-level, LOOP body, or ROUTER branch) so its action
   * steps appear in the order given by `orderedNames`. The chain's HEAD
   * pointer (trigger.nextAction / loop.firstLoopAction / router.children[i])
   * is updated; each step keeps its own subtree.
   *
   * The input must list every CURRENT step's name in that chain exactly
   * once. No-op on any mismatch so a stale UI invocation can't corrupt the
   * tree.
   */
  const reorderChain = useCallback((scope: ChainScope, orderedNames: string[]): void => {
    setDraftTrigger((prev) => (prev ? treeReorderChain(prev, scope, orderedNames) : prev));
    setDirty(true);
  }, []);

  const setLoopItems = useCallback((stepName: string, items: string): void => {
    setDraftTrigger((prev) => (prev ? treeSetLoopItems(prev, stepName, items) : prev));
    setDirty(true);
  }, []);

  const setRouterExecutionType = useCallback(
    (stepName: string, type: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH"): void => {
      setDraftTrigger((prev) => (prev ? treeSetRouterExecutionType(prev, stepName, type) : prev));
      setDirty(true);
    },
    [],
  );

  const addRouterBranch = useCallback((stepName: string, branchName: string): void => {
    setDraftTrigger((prev) => (prev ? treeAddRouterBranch(prev, stepName, branchName) : prev));
    setDirty(true);
  }, []);

  const removeRouterBranch = useCallback((stepName: string, branchIndex: number): void => {
    setDraftTrigger((prev) => (prev ? treeRemoveRouterBranch(prev, stepName, branchIndex) : prev));
    setDirty(true);
  }, []);

  /**
   * Remove a step from the tree by name. Works at any depth — top-level
   * chain, LOOP body, or ROUTER branch. The trigger cannot be deleted.
   * The deleted step's `nextAction` becomes its predecessor's `nextAction`,
   * or the parent's head pointer (firstLoopAction / children[i]) when the
   * deleted step was a sub-chain head.
   */
  const deleteStep = useCallback((stepName: string): void => {
    setDraftTrigger((prev) => (prev ? removeStep(prev, stepName) : prev));
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
    addStepToHead,
    deleteStep,
    reorderChain,
    setLoopItems,
    setRouterExecutionType,
    addRouterBranch,
    removeRouterBranch,
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
// Pure tree-manipulation helpers (cloneTrigger, findStep, flattenSteps,
// applySchemaDefaults, nextStepName, etc.) live in `./tree.ts` so they can
// be unit-tested without React. The hook delegates each mutator into that
// module via the imports at the top of this file.

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

/** Identifies which chain a reorder operation acts on. */
export type ChainScope =
  | { kind: "top" }
  | { kind: "loop"; parentName: string }
  | { kind: "branch"; parentName: string; branchName: string };

async function safeJson(res: Response): Promise<{ error?: string } | null> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return null;
  }
}
