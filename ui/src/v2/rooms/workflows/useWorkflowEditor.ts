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
import type { ConnectionMeta } from "./useConnections";
import {
  detectTriggerKind,
  makeEmptyStash,
  transitionTriggerKind,
  type TriggerKind,
  type TriggerKindStash,
} from "./trigger-kinds";
import {
  addStepToHead as treeAddStepToHead,
  allReachableNames,
  applySchemaDefaults,
  cloneTrigger,
  connectSteps as treeConnectSteps,
  disconnectEdge as treeDisconnectEdge,
  findStep,
  flattenSteps,
  insertStepAfter as treeInsertStepAfter,
  isSourceHandleConnected,
  parseSourceHandle,
  removeStep,
  reorderChain as treeReorderChain,
  type ConnectionHandle,
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
    /**
     * ROUTER: UI-only marker the engine ignores. Distinguishes a strict
     * "If" (exactly two branches "True"/"False", branch names locked) from
     * a free-form "Router" (N renameable branches). Absent means
     * "router" -- a step authored via the API / assistant doesn't carry
     * this flag, so the editor treats it as the more flexible Router.
     */
    routerKind?: "if" | "router";
    /**
     * PIECE / CODE: per-step error-handling toggles consumed by the engine
     * at `src/workflows/activepieces/.../helper/error-handling.ts`.
     *   - `continueOnFailure.value === true`: a FAILED step is treated as
     *     RUNNING for verdict purposes -- downstream steps execute, and
     *     this step's `output` stays undefined so a downstream Router can
     *     branch on `{{<step>}}` with DOES_NOT_EXIST.
     *   - `retryOnFailure.value === true`: the engine retries up to 4
     *     attempts with exponential backoff (engine-wide constants). Final
     *     failure still respects `continueOnFailure`.
     * Both fields nest in their own `{ value: boolean }` wrapper to match
     * the activepieces shared schema. Setting `value: false` (or omitting)
     * disables the feature.
     */
    errorHandlingOptions?: {
      continueOnFailure?: { value?: boolean };
      retryOnFailure?: { value?: boolean };
    };
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
  /**
   * Per-step sample outputs (`stepName -> output`) for the "test this step"
   * path. Editable per step via the properties panel. Null when never set.
   */
  sampleData: Record<string, unknown> | null;
  /**
   * Per-step sample INPUT overrides (`stepName -> input`) used only when
   * the user clicks "Test this step". Replaces that step's
   * `settings.input` for the test run; the persisted production input
   * is unaffected. Null when never set.
   */
  sampleInput: Record<string, unknown> | null;
  created: number;
  updated: number;
}

/**
 * Mirror of the daemon-side `PieceInputType` declared in
 * `src/workflows/runtime/piece-input.ts`. KEEP IN SYNC: the catalog
 * API returns whatever the daemon emits, and the editor falls through
 * to its default branch (a string-style input) for any unknown value.
 * Adding a new variant means editing BOTH files.
 */
export type PieceInputType =
  | "string"
  | "long_text"
  | "number"
  | "boolean"
  | "enum"
  | "multi_enum"
  | "datetime"
  | "json"
  | "flow_ref";

export interface PieceInputField {
  name: string;
  label: string;
  type: PieceInputType;
  required: boolean;
  description?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string; description?: string; group?: string }>;
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
  /**
   * Optional declared output for the action or trigger. Used by the
   * variable picker to surface field-level rows even before the step has
   * been run. Actions populate `outputSample` (Jarvis extension to AP);
   * triggers populate the upstream-native `sampleData`. The picker reads
   * either -- both carry the same kind of JSON shape.
   */
  outputSample?: unknown;
  sampleData?: unknown;
  /**
   * Output sample varies with a single input property. Used by triggers
   * whose envelope shape depends on a config value (jarvis-trigger
   * `on_event`: payload depends on `eventType`). Picker uses this when
   * present to resolve the right sample for the step's current settings.
   */
  dynamicSampleData?: {
    propName: string;
    samples: Record<string, unknown>;
  };
}

/**
 * Piece-level auth declaration. Present on integrations that need a
 * connection (gmail, slack, telegram-bot, github); absent on
 * connection-less pieces (jarvis-ask, schedule, code, webhook). The
 * editor renders a connection picker when this is set.
 */
export interface PieceCatalogAuth {
  type:
    | "OAUTH2"
    | "PLATFORM_OAUTH2"
    | "CLOUD_OAUTH2"
    | "SECRET_TEXT"
    | "BASIC_AUTH"
    | "CUSTOM_AUTH";
  displayName?: string;
  description?: string;
}

export interface PieceCatalogEntry {
  name: string;
  displayName: string;
  description: string;
  actions: PieceCatalogActionOrTrigger[];
  triggers: PieceCatalogActionOrTrigger[];
  auth?: PieceCatalogAuth;
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
  // Orphan steps live outside the trigger tree: head node + its (optional)
  // own `nextAction` chain. They appear on the canvas with a stored x/y so
  // the user can wire them in by dragging a handle. Persisted in the
  // `flow_version_ui_meta` sidecar so reloads preserve them.
  const [draftOrphans, setDraftOrphans] = useState<OrphanStep[]>([]);
  // Per-step x/y positions for nodes inside the connected tree. Empty means
  // "use the deterministic auto-layout". Populated lazily as the user drags
  // tree nodes; sent to the server as `uiMeta.positions` on save so the
  // editor reopens at the layout the user left.
  const [stepPositions, setStepPositions] = useState<Record<string, NodePosition>>({});
  // Connections cache. Mirrors `/api/workflows/connections` so the editor
  // can render a connection picker and auto-fill the first matching
  // connection when a piece is added. Refreshed on editor open and on
  // every catalog reload (which is also triggered by Library installs).
  // We don't subscribe to connection mutations from elsewhere -- the
  // connections panel uses its own hook -- so a user who creates a
  // connection in the dashboard needs the editor's catalog reload to
  // pick it up. Good enough for the common flow (open editor, see
  // existing connections); the reload button covers the edge case.
  const [connections, setConnections] = useState<ConnectionMeta[]>([]);
  const ignoreNextLoadRef = useRef(false);

  // Per-kind stash of prior trigger settings. Switching kinds snapshots the
  // outgoing kind's settings into this map; switching back to a kind whose
  // stash is populated restores it verbatim. Closes the silent-discard
  // hole the prior single-ref design had on direct kind-to-kind hops
  // (schedule -> webhook would lose the cron). See
  // `./trigger-kinds.ts:transitionTriggerKind` for the pure semantics.
  const triggerSettingsStashRef = useRef<TriggerKindStash>(makeEmptyStash());

  /**
   * Bounded undo stack. Snapshots `{trigger, orphans, positions}` before
   * each destructive op (delete, disconnect, drop-into-orphan, piece
   * replace). Cleared on reload + save -- undo is a within-session aid,
   * not durable history.
   *
   * Stack-based rather than single-slot so successive deletes still let
   * the user back out one at a time. Capped at 20 entries so a long
   * editing session doesn't grow memory unboundedly with full subtree
   * clones.
   */
  interface UndoSnapshot {
    label: string;
    trigger: FlowStepNode | null;
    orphans: OrphanStep[];
    positions: Record<string, NodePosition>;
  }
  const UNDO_CAP = 20;
  const [undoStack, setUndoStack] = useState<UndoSnapshot[]>([]);

  // Snapshot helper. Captures the live state by deep-cloning the tree +
  // orphan subtrees; positions are a flat object so a shallow copy is
  // enough. Call BEFORE applying a destructive mutation.
  const snapshotForUndo = useCallback(
    (label: string): void => {
      setUndoStack((prev) => {
        const next: UndoSnapshot = {
          label,
          trigger: draftTrigger ? cloneTrigger(draftTrigger) : null,
          orphans: draftOrphans.map((o) => ({ ...o, node: cloneTrigger(o.node) })),
          positions: { ...stepPositions },
        };
        const stack = [...prev, next];
        return stack.length > UNDO_CAP ? stack.slice(-UNDO_CAP) : stack;
      });
    },
    [draftTrigger, draftOrphans, stepPositions],
  );

  /** Pop the most recent snapshot and restore the editor to it. */
  const undo = useCallback((): boolean => {
    let restored = false;
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1]!;
      setDraftTrigger(last.trigger);
      setDraftOrphans(last.orphans);
      setStepPositions(last.positions);
      setDirty(true);
      restored = true;
      return prev.slice(0, -1);
    });
    return restored;
  }, []);

  /** Load (or reload) the catalog + version. */
  const reload = useCallback(async (): Promise<void> => {
    if (!flowId) return;
    setLoading(true);
    setError(null);
    try {
      const [catalogRes, detailRes, connRes] = await Promise.all([
        fetch("/api/workflows/pieces"),
        fetch(`/api/workflows/${flowId}`),
        // Fetch connections in parallel so the editor can render the
        // connection picker on first paint without a follow-up round
        // trip. Failure is non-fatal -- the picker just renders empty
        // and the user re-enters credentials, same as before this
        // wiring landed.
        fetch("/api/workflows/connections"),
      ]);
      if (!catalogRes.ok) throw new Error(`pieces -> ${catalogRes.status}`);
      if (!detailRes.ok) throw new Error(`flow detail -> ${detailRes.status}`);
      const catalogList = (await catalogRes.json()) as PieceCatalogEntry[];
      setCatalog(catalogList);
      if (connRes.ok) {
        const connBody = (await connRes.json()) as { connections: ConnectionMeta[] };
        setConnections(Array.isArray(connBody.connections) ? connBody.connections : []);
      } else {
        setConnections([]);
      }

      const detail = (await detailRes.json()) as {
        flow: { id: string };
        latestDraft: FlowVersion | null;
        published: FlowVersion | null;
        uiMeta: FlowVersionUiMeta | null;
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
      // Hydrate orphans + positions from the editor sidecar. Both default to
      // empty so a flow that's never been visually edited renders with the
      // deterministic auto-layout.
      const meta = detail.uiMeta;
      setDraftOrphans(
        Array.isArray(meta?.orphans)
          ? meta!.orphans.map((o) => orphanFromMeta(o)).filter((o): o is OrphanStep => !!o)
          : [],
      );
      setStepPositions(meta?.positions && typeof meta.positions === "object" ? { ...meta.positions } : {});
      setDirty(false);
      // Reload replaces the entire edit buffer with server state; any
      // in-flight undo history would be against a tree that no longer
      // exists. Drop it.
      setUndoStack([]);
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

  /**
   * Apply an in-place mutation to a step wherever it lives -- inside the
   * connected trigger tree OR in the orphan pool. Centralising the routing
   * here means every "edit step" mutator below works the same way for
   * orphan steps (settings popover, input fields, piece swap, ...) without
   * each call site needing to know which collection the selected step is
   * currently in.
   *
   * The mutator is called with a freshly cloned node; mutate in place. We
   * splice the resulting node back into the right state slot.
   */
  const mutateAnyStep = useCallback(
    (stepName: string, mutate: (step: FlowStepNode) => void): void => {
      // Tree path: locate via findStep on the current draft. Reading the
      // current `draftTrigger` from the closure (rather than inside the
      // setter) is safe because every mutator that calls us is itself
      // recreated when `draftTrigger` changes.
      if (draftTrigger && findStep(draftTrigger, stepName)) {
        setDraftTrigger((prev) => {
          if (!prev) return prev;
          const next = cloneTrigger(prev);
          const target = findStep(next, stepName);
          if (target) mutate(target);
          return next;
        });
        setDirty(true);
        return;
      }
      // Orphan path: rebuild the matching entry with a freshly cloned
      // node so identity changes and React re-renders.
      if (!draftOrphans.some((o) => o.node.name === stepName)) return;
      setDraftOrphans((prev) =>
        prev.map((o) => {
          if (o.node.name !== stepName) return o;
          const cloned = cloneTrigger(o.node);
          mutate(cloned);
          return { ...o, node: cloned };
        }),
      );
      setDirty(true);
    },
    [draftTrigger, draftOrphans],
  );

  /**
   * Rename the version's `displayName` -- the visible workflow name in the
   * editor's header and the room list. Empty values are rejected at the
   * setter (the caller normalises whitespace); the actual persist happens
   * on the next `save()` so users can revert before committing.
   */
  const setVersionDisplayName = useCallback((displayName: string): void => {
    const trimmed = displayName.trim();
    if (!trimmed) return;
    setVersion((prev) => {
      if (!prev) return prev;
      if (prev.displayName === trimmed) return prev;
      return { ...prev, displayName: trimmed };
    });
    setDirty(true);
  }, []);

  /** Update a single step in-place by name. Works for both tree and orphan steps. */
  const updateStep = useCallback(
    (stepName: string, patch: Partial<FlowStepNode>): void => {
      mutateAnyStep(stepName, (target) => {
        Object.assign(target, patch);
        // Preserve nested objects we didn't touch.
        if (patch.settings) {
          target.settings = { ...target.settings, ...patch.settings };
        }
      });
    },
    [mutateAnyStep],
  );

  /** Update a single input key on a step. Convenience for the properties panel. */
  const updateStepInput = useCallback(
    (stepName: string, key: string, value: unknown): void => {
      mutateAnyStep(stepName, (target) => {
        const settings = target.settings ? { ...target.settings } : {};
        settings.input = { ...(settings.input ?? {}), [key]: value };
        target.settings = settings;
      });
    },
    [mutateAnyStep],
  );

  /**
   * Insert a new PIECE step immediately after `predecessorName`. The new step
   * starts unconfigured (no piece picked); the user picks one in the panel.
   * Returns the new step's name so the caller can select it.
   */
  const insertStepAfter = useCallback((predecessorName: string): string | null => {
    // Compute synchronously (see disconnectEdgeByHandle): reading `newName` out
    // of the deferred setDraftTrigger updater is unreliable -- React may run
    // the updater later, leaving the return null so the caller can't select
    // the new step and `setDirty` is skipped. treeInsertStepAfter is pure.
    if (!draftTrigger) return null;
    const result = treeInsertStepAfter(draftTrigger, predecessorName);
    if (!result) return null;
    setDraftTrigger(result.tree);
    setDirty(true);
    return result.newName;
  }, [draftTrigger]);

  /** Seed a new PIECE step at the head of a chain. Used when LOOP body or
   *  ROUTER branch is empty (no node to insert after). */
  const addStepToHead = useCallback((scope: ChainScope): string | null => {
    if (!draftTrigger) return null;
    const result = treeAddStepToHead(draftTrigger, scope);
    if (!result) return null;
    setDraftTrigger(result.tree);
    setDirty(true);
    return result.newName;
  }, [draftTrigger]);

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

  const setLoopItems = useCallback(
    (stepName: string, items: string): void => {
      mutateAnyStep(stepName, (target) => {
        if (target.type !== "LOOP_ON_ITEMS") return;
        target.settings = { ...(target.settings ?? {}), items };
      });
    },
    [mutateAnyStep],
  );

  const setRouterExecutionType = useCallback(
    (stepName: string, type: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH"): void => {
      mutateAnyStep(stepName, (target) => {
        if (target.type !== "ROUTER") return;
        target.settings = { ...(target.settings ?? {}), executionType: type };
      });
    },
    [mutateAnyStep],
  );

  const addRouterBranch = useCallback(
    (stepName: string, branchName: string): void => {
      mutateAnyStep(stepName, (target) => {
        if (target.type !== "ROUTER") return;
        const branches = [...(target.settings?.branches ?? [])];
        const children = [...(target.children ?? [])];
        // Insert before any FALLBACK so the catch-all stays last (mirrors
        // the same convention as the tree-only `addRouterBranch` helper).
        let insertAt = branches.length;
        for (let i = 0; i < branches.length; i++) {
          if (branches[i]?.branchType === "FALLBACK") {
            insertAt = i;
            break;
          }
        }
        // Seed with one empty condition so the condition editor opens
        // pre-populated when the user expands the new branch.
        branches.splice(insertAt, 0, {
          branchName,
          branchType: "CONDITION",
          conditions: [
            [{ firstValue: "", operator: "TEXT_EXACTLY_MATCHES", secondValue: "" }],
          ],
        });
        children.splice(insertAt, 0, null);
        target.settings = { ...(target.settings ?? {}), branches };
        target.children = children;
      });
    },
    [mutateAnyStep],
  );

  const removeRouterBranch = useCallback(
    (stepName: string, branchIndex: number): void => {
      mutateAnyStep(stepName, (target) => {
        if (target.type !== "ROUTER") return;
        const branches = [...(target.settings?.branches ?? [])];
        const children = [...(target.children ?? [])];
        if (branchIndex < 0 || branchIndex >= branches.length) return;
        branches.splice(branchIndex, 1);
        children.splice(branchIndex, 1);
        target.settings = { ...(target.settings ?? {}), branches };
        target.children = children;
      });
    },
    [mutateAnyStep],
  );

  /**
   * Replace a CONDITION branch's `conditions` array. The shape is
   * OR-of-ANDs: `Array<Array<Condition>>`. FALLBACK branches don't carry
   * conditions, so the mutator silently skips them. No-op when the step
   * isn't a ROUTER or the index is out of range so a stale UI call can't
   * corrupt the tree.
   */
  const setBranchConditions = useCallback(
    (
      stepName: string,
      branchIndex: number,
      conditions: Array<
        Array<{
          firstValue: string;
          operator: string;
          secondValue?: string;
          caseSensitive?: boolean;
        }>
      >,
    ): void => {
      mutateAnyStep(stepName, (target) => {
        if (target.type !== "ROUTER") return;
        const branches = [...(target.settings?.branches ?? [])];
        if (branchIndex < 0 || branchIndex >= branches.length) return;
        const branch = branches[branchIndex];
        if (!branch || branch.branchType !== "CONDITION") return;
        branches[branchIndex] = { ...branch, conditions };
        target.settings = { ...(target.settings ?? {}), branches };
      });
    },
    [mutateAnyStep],
  );

  /**
   * Remove a step from the tree by name. Works at any depth — top-level
   * chain, LOOP body, or ROUTER branch. The trigger cannot be deleted.
   * The deleted step's `nextAction` becomes its predecessor's `nextAction`,
   * or the parent's head pointer (firstLoopAction / children[i]) when the
   * deleted step was a sub-chain head.
   */
  const deleteStep = useCallback((stepName: string): void => {
    snapshotForUndo(`delete ${stepName}`);
    setDraftTrigger((prev) => (prev ? removeStep(prev, stepName) : prev));
    // Also drop any matching orphan -- step names are unique across the tree
    // + orphans, so the same name shouldn't appear in both, but defensive.
    setDraftOrphans((prev) => prev.filter((o) => !containsName(o.node, stepName)));
    setDirty(true);
  }, [snapshotForUndo]);

  /**
   * Wire `sourceName`'s `sourceHandle` to an orphan HEAD `targetName`,
   * removing that orphan entry from the pool. Works whether `sourceName`
   * lives in the tree or inside another orphan's subtree -- needed so the
   * user can re-join a detached chain into another detached chain without
   * first re-wiring it into the tree.
   */
  const connectByHandles = useCallback(
    (sourceName: string, sourceHandleId: string, targetName: string): boolean => {
      const handle = parseSourceHandle(sourceHandleId);
      if (!handle) return false;
      const targetIdx = draftOrphans.findIndex((o) => o.node.name === targetName);
      if (targetIdx < 0) return false;
      const targetOrphan = draftOrphans[targetIdx]!;

      // Tree path: source lives in the connected trigger tree. Compute
      // synchronously (see disconnectEdgeByHandle): capturing `connected` from
      // the deferred setDraftTrigger updater was unreliable -- if it stayed
      // false the orphan was never removed even though the tree absorbed a
      // clone of it, leaving the node duplicated (tree + orphan). treeConnectSteps
      // is pure and refuses an occupied handle by returning null.
      if (draftTrigger && findStep(draftTrigger, sourceName)) {
        const next = treeConnectSteps(draftTrigger, sourceName, handle, targetOrphan.node);
        if (!next) return false;
        setDraftTrigger(next);
        setDraftOrphans((prev) => prev.filter((_, i) => i !== targetIdx));
        setDirty(true);
        return true;
      }

      // Orphan path: source lives inside one of the OTHER orphan
      // subtrees (not the target's own subtree -- that'd be a cycle and
      // findStep wouldn't find a separate source there anyway). We mutate
      // that orphan's subtree in place and absorb the target subtree.
      const sourceIdx = draftOrphans.findIndex(
        (o, i) => i !== targetIdx && !!findStep(o.node, sourceName),
      );
      if (sourceIdx < 0) return false;
      const sourceOrphan = draftOrphans[sourceIdx]!;
      const newSourceSubtree = treeConnectSteps(
        sourceOrphan.node,
        sourceName,
        handle,
        targetOrphan.node,
      );
      if (!newSourceSubtree) return false;
      setDraftOrphans((prev) => {
        const next: OrphanStep[] = [];
        for (let i = 0; i < prev.length; i++) {
          if (i === targetIdx) continue;
          if (i === sourceIdx) {
            next.push({ ...sourceOrphan, node: newSourceSubtree });
          } else {
            next.push(prev[i]!);
          }
        }
        return next;
      });
      setDirty(true);
      return true;
    },
    [draftTrigger, draftOrphans],
  );

  /**
   * Sever the outgoing edge at `sourceName`'s `sourceHandle`. The
   * detached subtree's head becomes a new orphan placed at the given
   * canvas coordinates so the user can re-wire it without losing work.
   * Works whether the source lives in the trigger tree OR inside an
   * orphan's subtree (so right-click-disconnect inside a detached chain
   * just splits it into two smaller orphans).
   */
  const disconnectEdgeByHandle = useCallback(
    (sourceName: string, sourceHandleId: string, dropAt: { x: number; y: number }): boolean => {
      const handle = parseSourceHandle(sourceHandleId);
      if (!handle) return false;

      // Snapshot before either path mutates. We do it unconditionally
      // (even if the disconnect ultimately fails on a bad handle) only
      // when we've passed the parseSourceHandle gate, so a noop call
      // with a malformed handle id doesn't pollute the undo stack.
      snapshotForUndo(`disconnect ${sourceName}`);

      // Tree path: source is reachable from the trigger. Compute the split
      // SYNCHRONOUSLY (not inside the setState updater) so the detached head is
      // available to push into orphans in the same tick. Previously `detached`
      // was assigned inside the `setDraftTrigger` updater and read right after
      // the call -- but React defers the updater, so `detached` stayed null,
      // the orphan was never added, and the whole downstream subtree silently
      // vanished when you removed an edge. `treeDisconnectEdge` is pure (it
      // clones), so calling it on the closure's `draftTrigger` is safe.
      if (draftTrigger && findStep(draftTrigger, sourceName)) {
        const result = treeDisconnectEdge(draftTrigger, sourceName, handle);
        if (!result) return false;
        setDraftTrigger(result.tree);
        setDraftOrphans((prev) => [...prev, { node: result.detached, x: dropAt.x, y: dropAt.y }]);
        setDirty(true);
        return true;
      }

      // Orphan path: source is inside an orphan subtree. Disconnect there
      // and split: the surviving head shrinks; the detached subtree
      // becomes its own new orphan at the cursor.
      const orphanIdx = draftOrphans.findIndex((o) => !!findStep(o.node, sourceName));
      if (orphanIdx < 0) return false;
      const orphan = draftOrphans[orphanIdx]!;
      const result = treeDisconnectEdge(orphan.node, sourceName, handle);
      if (!result) return false;
      setDraftOrphans((prev) => {
        const next = [...prev];
        next[orphanIdx] = { ...orphan, node: result.tree };
        next.push({ node: result.detached, x: dropAt.x, y: dropAt.y });
        return next;
      });
      setDirty(true);
      return true;
    },
    [draftTrigger, draftOrphans, snapshotForUndo],
  );

  /** Update an orphan's stored canvas position. Called on drag-stop so the
   *  orphan stays where the user left it across re-renders. */
  const setOrphanPosition = useCallback(
    (stepName: string, x: number, y: number): void => {
      setDraftOrphans((prev) =>
        prev.map((o) => (o.node.name === stepName ? { ...o, x, y } : o)),
      );
      setDirty(true);
    },
    [],
  );

  /**
   * Record the canvas position of a *connected* (tree) step. Used by the
   * canvas drag handler in addition to the existing chain-reorder logic --
   * order changes by Y, but X is now also persisted so the editor reopens
   * with the same layout the user left. Steps without an entry fall back
   * to the deterministic auto-layout.
   */
  const setStepPosition = useCallback(
    (stepName: string, x: number, y: number): void => {
      setStepPositions((prev) => {
        const cur = prev[stepName];
        if (cur && cur.x === x && cur.y === y) return prev;
        return { ...prev, [stepName]: { x, y } };
      });
      setDirty(true);
    },
    [],
  );

  /**
   * Drop all saved tree-node positions so the next render falls through
   * to the deterministic auto-layout (`buildGraph` computes a left-to-
   * right grid from the chain's flatten order when a step has no saved
   * coords). Used by the editor's "Auto-arrange" button. Orphans aren't
   * touched -- they live outside the chain and have no auto position to
   * fall back to.
   */
  const clearStepPositions = useCallback((): void => {
    setStepPositions((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      return {};
    });
    setDirty(true);
  }, []);

  /**
   * Spawn an orphan PIECE step pre-configured with the chosen piece +
   * action, positioned at the given canvas (flow) coordinates. The user
   * wires it into the chain by dragging from a source handle into this
   * step's target handle. Returns the new step's name.
   *
   * Used by the library popover opened from the canvas right-click menu
   * (Task 7). Names are unique across the tree AND the existing orphan
   * pool so step references can't collide.
   */
  const createOrphanStep = useCallback(
    (flowPos: { x: number; y: number }, pieceName: string, actionName: string): string | null => {
      const piece = catalog.find((p) => p.name === pieceName);
      const action = piece?.actions.find((a) => a.name === actionName);
      if (!piece || !action) return null;
      const seed = applySchemaDefaults({}, action.inputSchema ?? null);

      // Generate a unique step_<n> by scanning tree + orphans.
      const taken = new Set<string>();
      if (draftTrigger) {
        for (const fs of flattenSteps(draftTrigger)) taken.add(fs.step.name);
      }
      for (const o of draftOrphans) taken.add(o.node.name);
      let n = 1;
      while (taken.has(`step_${n}`)) n++;
      const newName = `step_${n}`;

      const newStep: FlowStepNode = {
        name: newName,
        type: "PIECE",
        displayName: action.displayName,
        settings: { pieceName, actionName, input: seed },
      };
      setDraftOrphans((prev) => [...prev, { node: newStep, x: flowPos.x, y: flowPos.y }]);
      setDirty(true);
      return newName;
    },
    [catalog, draftTrigger, draftOrphans],
  );

  /**
   * Spawn a control-flow orphan (LOOP_ON_ITEMS / IF / ROUTER) at the given
   * canvas coordinates. IF and ROUTER both produce a `ROUTER` step at the
   * engine level -- they differ only in the UI marker `settings.routerKind`
   * which gates the rename/add-branch UI:
   *
   *   - IF: two locked branches named "True" (CONDITION) and "False"
   *     (FALLBACK). The user can't rename them or add more -- it's a
   *     strict two-way split.
   *   - ROUTER: same two branches (renamed "Branch 1" / "Else") that the
   *     user is free to rename, plus an "Add branch" affordance.
   *   - LOOP_ON_ITEMS: empty `items` template; body wired in later via
   *     the loop-body handle.
   */
  const createOrphanControlFlowStep = useCallback(
    (
      flowPos: { x: number; y: number },
      kind: "LOOP_ON_ITEMS" | "IF" | "ROUTER",
    ): string | null => {
      const taken = new Set<string>();
      if (draftTrigger) {
        for (const fs of flattenSteps(draftTrigger)) taken.add(fs.step.name);
      }
      for (const o of draftOrphans) taken.add(o.node.name);
      let n = 1;
      while (taken.has(`step_${n}`)) n++;
      const newName = `step_${n}`;

      let newStep: FlowStepNode;
      if (kind === "LOOP_ON_ITEMS") {
        newStep = {
          name: newName,
          type: "LOOP_ON_ITEMS",
          displayName: "Loop on items",
          settings: { items: "" },
        };
      } else if (kind === "IF") {
        newStep = {
          name: newName,
          type: "ROUTER",
          displayName: "If",
          settings: {
            executionType: "EXECUTE_FIRST_MATCH",
            routerKind: "if",
            branches: [
              {
                branchName: "True",
                branchType: "CONDITION",
                // Seed one empty condition so the panel opens with a
                // ready-to-fill row rather than an "Add condition"
                // button. Default operator is TEXT_EXACTLY_MATCHES
                // since that's the most-common IF use case ("if
                // {{step.field}} equals X").
                conditions: [
                  [{ firstValue: "", operator: "TEXT_EXACTLY_MATCHES", secondValue: "" }],
                ],
              },
              { branchName: "False", branchType: "FALLBACK" },
            ],
          },
          children: [null, null],
        };
      } else {
        newStep = {
          name: newName,
          type: "ROUTER",
          displayName: "Router",
          settings: {
            executionType: "EXECUTE_FIRST_MATCH",
            routerKind: "router",
            branches: [
              {
                branchName: "Branch 1",
                branchType: "CONDITION",
                conditions: [
                  [{ firstValue: "", operator: "TEXT_EXACTLY_MATCHES", secondValue: "" }],
                ],
              },
              { branchName: "Else", branchType: "FALLBACK" },
            ],
          },
          children: [null, null],
        };
      }
      setDraftOrphans((prev) => [...prev, { node: newStep, x: flowPos.x, y: flowPos.y }]);
      setDirty(true);
      return newName;
    },
    [draftTrigger, draftOrphans],
  );

  /**
   * Four-way trigger kind selector. Each kind maps to a canonical
   * (pieceName, triggerName) pair via `TRIGGER_KINDS`; the transition
   * itself (including the per-kind stash that lets the user round-trip
   * without losing config) lives in `./trigger-kinds.ts`.
   *
   *   manual   -> EMPTY trigger (POST /run only)
   *   schedule -> built-in cron primitive
   *   webhook  -> built-in HTTP primitive
   *   event    -> @jarvispieces/piece-jarvis-trigger:on_event
   *
   * If the current trigger is a non-canonical PIECE_TRIGGER
   * (community piece, imported flow, etc.), the picker still routes
   * through `transitionTriggerKind` -- the OUTGOING kind is detected
   * as `"other"` and its settings aren't stashed (we have no kind to
   * key them under). The user explicitly clicked a button to switch,
   * so this is opt-in clobbering, not a silent overwrite.
   */
  const setTriggerKind = useCallback((kind: TriggerKind): void => {
    setDraftTrigger((prev) => {
      if (!prev) return prev;
      const next = cloneTrigger(prev);
      const currentKind = detectTriggerKind(prev);
      const { type, settings, nextStash } = transitionTriggerKind(
        currentKind,
        prev.settings,
        kind,
        triggerSettingsStashRef.current,
      );
      triggerSettingsStashRef.current = nextStash;
      next.type = type;
      next.settings = settings;
      return next;
    });
    setDirty(true);
  }, []);

  const setStepPiece = useCallback(
    (stepName: string, pieceName: string, actionName: string): void => {
      // Replacing a step's piece overwrites inputs with the new sub-action's
      // defaults. Snapshot so the user can back out if they picked the
      // wrong piece (especially common when clicking an empty piece slot
      // and choosing from the library picker by mistake).
      snapshotForUndo(`replace ${stepName} with ${pieceName}.${actionName}`);
      mutateAnyStep(stepName, (target) => {
        const isTrigger = target.type === "PIECE_TRIGGER" || target.type === "EMPTY";
        // Look up the chosen sub-action's schema to seed defaults.
        const piece = catalog.find((p) => p.name === pieceName);
        const sub = isTrigger
          ? piece?.triggers.find((t) => t.name === actionName)
          : piece?.actions.find((a) => a.name === actionName);
        const seed = applySchemaDefaults(target.settings?.input ?? {}, sub?.inputSchema ?? null);
        // Auto-fill the first available connection for pieces that
        // require auth. The user can override via the connection
        // picker; this just spares them the "I added a piece and now
        // it has no connection set" friction. Activepieces references
        // the chosen connection from `settings.input.auth` as a
        // `{{connections.<externalId>}}` template -- the engine
        // resolves it at run time. Matching is by pieceName; if no
        // connection exists yet the field stays empty and the picker
        // shows "(no connection set)".
        if (piece?.auth) {
          const match = connections.find(
            (c) => c.pieceName === pieceName && c.status === "ACTIVE",
          );
          if (match && seed["auth"] === undefined) {
            seed["auth"] = `{{connections.${match.externalId}}}`;
          }
        }

        const settings: NonNullable<FlowStepNode["settings"]> = {
          ...(target.settings ?? {}),
          pieceName,
          input: seed,
        };
        if (isTrigger) settings.triggerName = actionName;
        else settings.actionName = actionName;
        target.settings = settings;
      });
    },
    [catalog, connections, mutateAnyStep, snapshotForUndo],
  );

  /**
   * Toggle one of the two per-step error-handling flags. Works on PIECE +
   * CODE steps (the only types the engine consults for these options) --
   * other types are silently no-op'd so an accidental call from a shared
   * UI surface can't corrupt their settings.
   */
  const setStepErrorHandling = useCallback(
    (
      stepName: string,
      patch: { continueOnFailure?: boolean; retryOnFailure?: boolean },
    ): void => {
      mutateAnyStep(stepName, (target) => {
        // The engine consults `errorHandlingOptions` for PIECE (and CODE,
        // which the editor doesn't model). Other types ignore them, so we
        // short-circuit rather than writing dead settings.
        if (target.type !== "PIECE") return;
        const prev = target.settings?.errorHandlingOptions ?? {};
        const next: NonNullable<NonNullable<FlowStepNode["settings"]>["errorHandlingOptions"]> = {
          ...prev,
        };
        if (patch.continueOnFailure !== undefined) {
          next.continueOnFailure = { value: patch.continueOnFailure };
        }
        if (patch.retryOnFailure !== undefined) {
          next.retryOnFailure = { value: patch.retryOnFailure };
        }
        target.settings = { ...(target.settings ?? {}), errorHandlingOptions: next };
      });
    },
    [mutateAnyStep],
  );

  /**
   * "Add error handling" template. Composition (per the spec):
   *   1. Force `continueOnFailure = true` on the target piece, regardless
   *      of prior state -- without this the engine fails the whole flow on
   *      step failure and the router never runs.
   *   2. Build a ROUTER whose CONDITION branch matches when the piece's
   *      `output` is undefined (engine-native "failed" signal: a FAILED
   *      step never has `setOutput` called, so `{{<piece>}}` resolves to
   *      undefined and `DOES_NOT_EXIST` returns true). The FALLBACK
   *      branch is the success path.
   *   3. Splice the router between the piece and its existing successor:
   *      - No successor (Case A): router becomes piece.nextAction with
   *        both children null.
   *      - Has successor X (Case B): router becomes piece.nextAction;
   *        the FALLBACK branch's child slot points at X (continuing the
   *        success path); the CONDITION branch's child slot is null for
   *        the user to fill in.
   * Returns the new router's name so the caller can select it.
   */
  const addErrorHandling = useCallback(
    (stepName: string): string | null => {
      // Build the router shell up front so we can pick a unique step name
      // that considers BOTH the tree and the orphan pool at the same time
      // -- once we mutate the target, the next call to `nextStepName`
      // would also see this new router and skip past its number.
      const taken = new Set<string>();
      if (draftTrigger) for (const fs of flattenSteps(draftTrigger)) taken.add(fs.step.name);
      for (const o of draftOrphans) taken.add(o.node.name);
      let n = 1;
      while (taken.has(`step_${n}`)) n++;
      const routerName = `step_${n}`;

      // We need the target's identity (displayName, existing successor)
      // BEFORE we mutate so we can pre-construct the router. Look it up
      // in both places.
      const findTarget = (): FlowStepNode | null => {
        if (draftTrigger) {
          const inTree = findStep(draftTrigger, stepName);
          if (inTree) return inTree;
        }
        const orphan = draftOrphans.find((o) => o.node.name === stepName);
        return orphan?.node ?? null;
      };
      const target = findTarget();
      if (!target) return null;
      if (target.type !== "PIECE") return null;

      const pieceLabel = target.displayName ?? target.name;
      const router: FlowStepNode = {
        name: routerName,
        type: "ROUTER",
        displayName: `${pieceLabel} error catch`,
        settings: {
          executionType: "EXECUTE_FIRST_MATCH",
          // Renameable: error-catch branches start with descriptive
          // labels but the user can rephrase them ("Retry path",
          // "Notify ops", ...) so this lives in the renameable Router
          // family, not the strict IF.
          routerKind: "router",
          branches: [
            {
              branchType: "CONDITION",
              branchName: "On error",
              // Engine resolves `{{<stepName>}}` to `step.output`. A failed
              // step never has setOutput() called, so the resolved value
              // is undefined and DOES_NOT_EXIST fires. The router-executor
              // checks: `firstValue === undefined || null || ""`.
              conditions: [
                [
                  {
                    firstValue: `{{${target.name}}}`,
                    operator: "DOES_NOT_EXIST",
                  },
                ],
              ],
            },
            { branchType: "FALLBACK", branchName: "On success" },
          ],
        },
        // children parallel to branches: [CONDITION, FALLBACK].
        // Case A (no successor): both null. Case B: FALLBACK takes the
        // previous successor; the user populates the CONDITION branch.
        children: [null, target.nextAction ?? null],
      };

      mutateAnyStep(stepName, (live) => {
        // 1. Force continueOnFailure=true. The user can still opt out via
        //    the settings popover after the fact.
        const prevErr = live.settings?.errorHandlingOptions ?? {};
        live.settings = {
          ...(live.settings ?? {}),
          errorHandlingOptions: {
            ...prevErr,
            continueOnFailure: { value: true },
          },
        };
        // 2. Insert the router between the piece and its existing
        //    successor. The successor (if any) already lives on
        //    `router.children[1]` per the construction above.
        live.nextAction = router;
      });
      return routerName;
    },
    [draftTrigger, draftOrphans, mutateAnyStep],
  );

  /** Save the draft trigger back to the server. Returns the new version on success. */
  const save = useCallback(async (): Promise<ActionResult> => {
    if (!flowId || !version || !draftTrigger) {
      return { ok: false, message: "nothing to save" };
    }
    try {
      // Build the sidecar payload. Positions are scrubbed of stale entries
      // (deleted steps) so we don't accumulate dead keys forever. Orphans
      // serialize to plain step nodes; their x/y is carried inside the
      // orphan record so the editor can rehydrate them at the same spot.
      const liveNames = new Set<string>();
      const collect = (n: FlowStepNode): void => {
        liveNames.add(n.name);
        if (n.nextAction) collect(n.nextAction);
        if (n.firstLoopAction) collect(n.firstLoopAction);
        if (Array.isArray(n.children)) for (const c of n.children) if (c) collect(c);
      };
      collect(draftTrigger);
      for (const o of draftOrphans) liveNames.add(o.node.name);
      const positionsScrubbed: Record<string, NodePosition> = {};
      for (const [name, pos] of Object.entries(stepPositions)) {
        if (liveNames.has(name)) positionsScrubbed[name] = pos;
      }
      const uiMeta: FlowVersionUiMeta = {
        schema: UI_META_SCHEMA_VERSION,
        positions: positionsScrubbed,
        orphans: draftOrphans.map(orphanToMeta),
      };

      // If editing a published version (LOCKED clone), we need to create a
      // new draft via POST /api/workflows/:id/versions. Otherwise PATCH.
      let res: Response;
      if (version.state === "LOCKED") {
        res = await fetch(`/api/workflows/${flowId}/versions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: version.displayName, trigger: draftTrigger, uiMeta }),
        });
      } else {
        // Send the current `displayName` alongside the trigger so renames
        // from the editor's header reach the server in the same round-trip.
        // The API treats `displayName` as a partial update -- omitting it
        // would leave the server value untouched, but always sending it is
        // simpler and lets the API echo a consistent record back.
        res = await fetch(`/api/workflows/${flowId}/versions/${version.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: version.displayName,
            trigger: draftTrigger,
            uiMeta,
          }),
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
      setStepPositions(positionsScrubbed);
      // Orphans persist across save -- they're part of the user's editing
      // state and the server now stores them too.
      setDirty(false);
      // The undo stack is a within-session aid; once the user commits a
      // save the prior states no longer round-trip cleanly with the
      // server (versionId may roll, sample data may have diverged).
      // Drop the stack so undo can't accidentally restore a state the
      // user already deliberately overwrote.
      setUndoStack([]);
      return { ok: true, message: "Saved" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }, [flowId, version, draftTrigger, draftOrphans, stepPositions]);

  const reset = useCallback((): void => {
    if (version) {
      setDraftTrigger(cloneTrigger(version.trigger));
      // Reset clears in-memory edits including orphans + positions. The
      // last server-known state is recovered by the next reload() if the
      // user wants those back.
      setDraftOrphans([]);
      setStepPositions({});
      setDirty(false);
      setUndoStack([]);
    }
  }, [version]);

  /**
   * Per-step sample data update. Saves through to the server immediately
   * (independent of `dirty`) so test-from-here always sees the latest
   * inputs without requiring a separate "Save" click. Pass `null` to clear.
   * The version's `sampleData` map is replaced with the API response so the
   * local view stays consistent.
   */
  const setStepSampleData = useCallback(
    async (stepName: string, output: unknown | null): Promise<ActionResult> => {
      if (!flowId || !version) return { ok: false, message: "no version loaded" };
      if (version.state === "LOCKED") {
        return { ok: false, message: "version is published; create a new draft to edit sample data" };
      }
      try {
        const res = await fetch(
          `/api/workflows/${flowId}/versions/${version.id}/sample-data/${encodeURIComponent(stepName)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ output }),
          },
        );
        if (!res.ok) {
          const body = await safeJson(res);
          return { ok: false, message: body?.error ?? `HTTP ${res.status}` };
        }
        const body = (await res.json()) as { sampleData: Record<string, unknown> | null };
        setVersion((prev) => (prev ? { ...prev, sampleData: body.sampleData } : prev));
        return { ok: true, message: "Sample data saved" };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    [flowId, version],
  );

  /**
   * Per-step sample INPUT update. Mirrors `setStepSampleData` but
   * targets the `sample_input` column. Pass `null` to clear. The
   * server enforces that non-null inputs are plain objects (they
   * replace `settings.input` shape at test time).
   */
  const setStepSampleInput = useCallback(
    async (stepName: string, input: Record<string, unknown> | null): Promise<ActionResult> => {
      if (!flowId || !version) return { ok: false, message: "no version loaded" };
      if (version.state === "LOCKED") {
        return { ok: false, message: "version is published; create a new draft to edit sample input" };
      }
      try {
        const res = await fetch(
          `/api/workflows/${flowId}/versions/${version.id}/sample-input/${encodeURIComponent(stepName)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input }),
          },
        );
        if (!res.ok) {
          const body = await safeJson(res);
          return { ok: false, message: body?.error ?? `HTTP ${res.status}` };
        }
        const body = (await res.json()) as { sampleInput: Record<string, unknown> | null };
        setVersion((prev) => (prev ? { ...prev, sampleInput: body.sampleInput } : prev));
        return { ok: true, message: "Sample input saved" };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    [flowId, version],
  );

  /**
   * Kick off a "test from here" run: enqueues a flow run with
   * `stepNameToTest` set. The engine executes only that step, feeding it
   * preceding-step outputs from the version's persisted sample data. The
   * resulting flow_run row shows up in the run-history panel.
   */
  const testStepFromHere = useCallback(
    async (stepName: string): Promise<ActionResult> => {
      if (!flowId) return { ok: false, message: "no flow loaded" };
      try {
        const res = await fetch(`/api/workflows/${flowId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            triggeredBy: "dashboard:test-from-here",
            stepNameToTest: stepName,
            environment: "TESTING",
          }),
        });
        if (!res.ok) {
          const body = await safeJson(res);
          return { ok: false, message: body?.error ?? `run failed: ${res.status}` };
        }
        return { ok: true, message: `Test run queued for "${stepName}"` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    [flowId],
  );

  /** Depth-recursive flatten that includes LOOP body + ROUTER branch children.
   *  Top-level entries have depth=0; sub-graph entries carry their parent's
   *  step name + (for routers) the branch label. */
  const allSteps = useMemo(
    () => (draftTrigger ? flattenSteps(draftTrigger) : []),
    [draftTrigger],
  );

  /** Names already reachable from the trigger -- their target handle is
   *  taken (every connected step has exactly one parent). Used by the
   *  canvas to disable target-side dragging on already-wired nodes. */
  const treeNames = useMemo(
    () => (draftTrigger ? allReachableNames(draftTrigger) : new Set<string>()),
    [draftTrigger],
  );

  /** Predicate the canvas passes to each Handle so already-connected source
   *  handles refuse to start a new drag. Looks in BOTH the tree and the
   *  orphan subtrees -- orphan-internal nodes (like the middle of a
   *  detached C-D-E chain) have their source handles wired to the next
   *  step in the chain, so they must refuse new drags too. */
  const isHandleAvailable = useCallback(
    (stepName: string, handleId: string): boolean => {
      const handle = parseSourceHandle(handleId);
      if (!handle) return false;
      let step: FlowStepNode | null = null;
      if (draftTrigger) step = findStep(draftTrigger, stepName);
      if (!step) {
        for (const o of draftOrphans) {
          const found = findStep(o.node, stepName);
          if (found) {
            step = found;
            break;
          }
        }
      }
      if (!step) return false;
      return !isSourceHandleConnected(step, handle);
    },
    [draftTrigger, draftOrphans],
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
    /** Connections cached at editor load. Used to populate the connection picker + auto-fill new steps. */
    connections,
    version,
    draftTrigger,
    draftOrphans,
    allSteps,
    treeNames,
    isHandleAvailable,
    error,
    loading,
    dirty,
    validationGaps,
    reload,
    setVersionDisplayName,
    updateStep,
    updateStepInput,
    setStepPiece,
    setStepErrorHandling,
    addErrorHandling,
    setTriggerKind,
    insertStepAfter,
    addStepToHead,
    deleteStep,
    reorderChain,
    setLoopItems,
    setRouterExecutionType,
    addRouterBranch,
    removeRouterBranch,
    setBranchConditions,
    connectByHandles,
    disconnectEdgeByHandle,
    setOrphanPosition,
    setStepPosition,
    clearStepPositions,
    stepPositions,
    createOrphanStep,
    createOrphanControlFlowStep,
    save,
    reset,
    setStepSampleData,
    setStepSampleInput,
    testStepFromHere,
    /** Restore the editor to the state immediately before the last destructive op (delete / disconnect / piece replace). Returns true if anything was restored. */
    undo,
    /** True when the undo stack has at least one snapshot. Use to gate the undo button / shortcut. */
    canUndo: undoStack.length > 0,
    /** Top-of-stack label for tooltip / aria-label purposes. */
    undoLabel: undoStack.length > 0 ? undoStack[undoStack.length - 1]!.label : null,
  };
}

/**
 * An orphan step: head node of a disconnected subgraph that lives on the
 * canvas at a stored x/y. Created by right-click disconnect (the detached
 * subtree's head) and by the library picker (Task 7).
 */
export interface OrphanStep {
  node: FlowStepNode;
  x: number;
  y: number;
}

/** Sidecar wire shape -- mirrors `FlowVersionUiMeta` on the server. Kept
 *  inline so the hook doesn't reach into a server-side module. */
export const UI_META_SCHEMA_VERSION = 1;

export interface NodePosition {
  x: number;
  y: number;
}

export interface FlowVersionUiMeta {
  schema: number;
  positions: Record<string, NodePosition>;
  orphans: OrphanMeta[];
}

/** On-wire orphan record. `node` is the FlowStepNode head; x/y are stored
 *  alongside so the sidecar contains everything the editor needs to repaint
 *  this orphan at the same canvas spot on reload. */
export interface OrphanMeta {
  node: FlowStepNode;
  x: number;
  y: number;
}

function orphanToMeta(o: OrphanStep): OrphanMeta {
  return { node: o.node, x: o.x, y: o.y };
}

function orphanFromMeta(raw: unknown): OrphanStep | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<OrphanMeta>;
  if (!o.node || typeof o.node !== "object" || typeof (o.node as FlowStepNode).name !== "string") return null;
  return {
    node: o.node as FlowStepNode,
    x: typeof o.x === "number" ? o.x : 0,
    y: typeof o.y === "number" ? o.y : 0,
  };
}

/** Re-export the ConnectionHandle shape so the canvas component can type
 *  the handle ids without re-importing from `./tree`. */
export type { ConnectionHandle } from "./tree";

/** Recursive name-check across a step and every successor (`nextAction`,
 *  `firstLoopAction`, `children[]`). Used to scrub deletions out of the
 *  orphan list. */
function containsName(node: FlowStepNode, name: string): boolean {
  if (node.name === name) return true;
  if (node.nextAction && containsName(node.nextAction, name)) return true;
  if (node.firstLoopAction && containsName(node.firstLoopAction, name)) return true;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child && containsName(child, name)) return true;
    }
  }
  return false;
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
