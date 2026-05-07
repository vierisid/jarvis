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

export interface FlowStepNode {
  name: string;
  type: "PIECE_TRIGGER" | "EMPTY" | "PIECE";
  displayName?: string;
  settings?: {
    pieceName?: string;
    triggerName?: string;
    actionName?: string;
    input?: Record<string, unknown>;
  };
  nextAction?: FlowStepNode;
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

export interface PieceCatalogEntry {
  name: string;
  displayName: string;
  description: string;
  actions: Array<{ name: string; displayName: string; description: string }>;
  triggers: Array<{ name: string; displayName: string; description: string }>;
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
   * EMPTY clears the trigger's settings but preserves nextAction.
   */
  const setTriggerType = useCallback((type: "EMPTY" | "PIECE_TRIGGER"): void => {
    setDraftTrigger((prev) => {
      if (!prev) return prev;
      const next = cloneTrigger(prev);
      next.type = type;
      if (type === "EMPTY") {
        next.settings = {};
      } else if (!next.settings || !next.settings.pieceName) {
        next.settings = { input: {} };
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
      if (target) {
        target.settings = {
          ...(target.settings ?? {}),
          pieceName,
          actionName,
          input: target.settings?.input ?? {},
        };
      }
      return next;
    });
    setDirty(true);
  }, []);

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

  const allSteps = useMemo(
    () => (draftTrigger ? walkSteps(draftTrigger) : []),
    [draftTrigger],
  );

  return {
    catalog,
    version,
    draftTrigger,
    allSteps,
    error,
    loading,
    dirty,
    reload,
    updateStep,
    updateStepInput,
    setStepPiece,
    setTriggerType,
    insertStepAfter,
    deleteStep,
    save,
    reset,
  };
}

/* ----------------------------------------------------------------- helpers */

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
 * Generate the lowest unused `step_<n>` name. Activepieces' step name regex
 * accepts identifier-style names; we keep the convention upstream uses for
 * generated steps.
 */
function nextStepName(used: Set<string>): string {
  for (let i = 1; i < 10000; i++) {
    const candidate = `step_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  // Fallback to a timestamp suffix if (somehow) we exhaust 10k slots.
  return `step_${Date.now()}`;
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

async function safeJson(res: Response): Promise<{ error?: string } | null> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return null;
  }
}
