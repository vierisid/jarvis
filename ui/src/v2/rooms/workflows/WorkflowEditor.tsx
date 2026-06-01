/**
 * WorkflowEditor (Phase 4 stage 2).
 *
 * Full-screen overlay with a visual graph + properties panel. Reads the
 * latest draft of a flow, lets the user pick a piece + action for each
 * configurable step, and edit the step's input fields. Save writes back via
 * `PATCH /api/workflows/:id/versions/:vid`.
 *
 * Out of scope for stage 2 (intentional):
 *   - Adding or removing nodes (chain shape stays as the user authored it).
 *   - Schema-aware property forms (every input is rendered as a text field).
 *   - Drag-rearranging nodes (linear chain only).
 *
 * Stage 3 lights all of those up.
 */

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { LayoutGrid, Save, RotateCcw, ShieldAlert, X, Plus, Trash2, Play, History, CheckCircle2, XCircle, Clock, AlertTriangle, Pause, Undo2 } from "lucide-react";
import { Button, Chip, Icon } from "../../ui";
import {
  useWorkflowEditor,
  type FlatStep,
  type FlowStepNode,
  type OrphanStep,
  type PieceCatalogActionOrTrigger,
  type PieceCatalogAuth,
  type PieceCatalogEntry,
  type PieceInputField,
} from "./useWorkflowEditor";
import { flattenSteps, pathToStep } from "./tree";
import { buildVariableRows, type VariableRow } from "./variable-rows";
import { TRIGGER_KINDS, detectTriggerKind } from "./trigger-kinds";
import { fetchFlowsForPicker, type FlowPickerEntry } from "./flow-picker-data";
import { useListNav } from "./use-list-nav";
import { useLibrary, type LibraryEntry as InstallableLibraryEntry } from "./useLibrary";
import type { ConnectionMeta } from "./useConnections";
import { useFlowRuns } from "./useFlowRuns";
import type { FlowRun, FlowRunStatus } from "./useWorkflowsData";
import "./WorkflowEditor.css";

// Horizontal flow layout. Each step in the flattened chain advances the
// cursor rightward by NODE_X_STEP; nested branches (loop body / router
// children) stack downward by NODE_Y_BRANCH * depth so a parent and its
// branch head are visually adjacent. Y baseline starts at NODE_Y_BASE so
// the trigger doesn't sit flush against the top of the canvas.
const NODE_Y_BASE = 40;
const NODE_X_STEP = 280;
const NODE_Y_BRANCH = 140;

interface WorkflowEditorProps {
  flowId: string;
  onClose: () => void;
}

interface StepNodeData extends Record<string, unknown> {
  step: FlowStepNode;
  selected: boolean;
  catalog: PieceCatalogEntry[];
  depth: number;
  branchName?: string;
  /** True when this node belongs to an orphan subgraph (head OR internal).
   *  Drives the dashed warn-tinted card styling so the user sees the whole
   *  disconnected chain at a glance, not just its head. */
  isOrphan: boolean;
  /** True when this node has no incoming connection -- the target handle
   *  is OPEN and accepts new drops. This is the orphan HEAD case (no
   *  predecessor) and only that case: tree-resident nodes always have a
   *  parent, orphan-internal nodes are wired to the preceding orphan step. */
  targetIsFree: boolean;
  /** Per-handle "already wired" state -- the rendered Handle uses these to
   *  block a drag from starting on a handle that's currently in use. */
  outConnected: boolean;
  loopBodyConnected: boolean;
  /** Keyed by branch name. */
  branchConnected: Record<string, boolean>;
  /**
   * Per-step status from the currently-overlaid run, or null when no run
   * is overlaid. Drives the colored border + status pip on the node card.
   */
  runStatus: CanvasRunStatus | null;
  /** Pre-stringified error text for the failed-step tooltip. */
  runError: string | null;
  /** ms duration for the step from the overlaid run, if recorded. */
  runDuration: number | null;
}

export function WorkflowEditor({ flowId, onClose }: WorkflowEditorProps): React.ReactElement {
  const editor = useWorkflowEditor(flowId);
  // Library catalog: pieces from npm that the user may or may not have
  // installed yet. The piece-library popover surfaces non-installed pieces
  // alongside installed ones so a user typing "telegram" can find it even
  // before they've installed it; picking an uninstalled row triggers the
  // install via this hook.
  const library = useLibrary();
  // Scoped runs for this flow: powers the header Run button and the
  // right-side Runs panel. Polls adaptively (2s while active, 8s idle).
  const runs = useFlowRuns(flowId);
  // Visibility of the Runs side panel. Defaults closed so the canvas has
  // the full width; the header button shows a count badge so the user
  // notices new runs even when it's hidden.
  const [runsPanelOpen, setRunsPanelOpen] = useState<boolean>(false);
  // When set, the canvas paints per-node status pips derived from this
  // run's `steps` map -- the user can see which steps succeeded / failed
  // / didn't get reached. Clicking a row in the panel toggles this; the
  // banner at the top of the canvas lets the user exit overlay mode.
  const [overlayRunId, setOverlayRunId] = useState<string | null>(null);
  // While in overlay mode, clicking a node opens this popover with the
  // step's input/output/error/duration instead of the settings panel.
  // Cleared automatically when overlay mode is exited or the node goes
  // missing from the graph.
  const [runDetail, setRunDetail] = useState<{
    stepName: string;
    anchor: { x: number; y: number };
  } | null>(null);
  const closeRunDetail = useCallback((): void => setRunDetail(null), []);
  const [selectedStepName, setSelectedStepName] = useState<string | null>(null);
  // Anchor for the floating settings popover. Captured at click-time from
  // the originating MouseEvent so the popover opens near the cursor rather
  // than at a fixed location. Null when the popover is closed.
  const [popoverAnchor, setPopoverAnchor] = useState<{ x: number; y: number } | null>(null);
  // Anchor for the canvas right-click context menu. Stores both screen
  // coordinates (where to paint the menu) and the corresponding flow
  // coordinates (where any newly-added piece should land in the graph).
  const [canvasMenu, setCanvasMenu] = useState<
    | { screen: { x: number; y: number }; flow: { x: number; y: number } }
    | null
  >(null);
  const closeCanvasMenu = useCallback((): void => setCanvasMenu(null), []);
  // Library picker (Task 7). When set, renders the floating piece library
  // at the recorded screen coords; picking a piece spawns an orphan step
  // at the matching flow coords for the user to wire in via a handle drag.
  const [libraryPicker, setLibraryPicker] = useState<
    | {
        screen: { x: number; y: number };
        flow: { x: number; y: number };
        /**
         * When set, the picker is in "replace mode": the chosen piece
         * configures the named step in place (preserving its position
         * and chain connections) instead of spawning a fresh orphan.
         * Used when the user clicks an unconfigured (empty) PIECE step.
         */
        replaceStepName?: string;
      }
    | null
  >(null);
  const closeLibraryPicker = useCallback((): void => setLibraryPicker(null), []);
  // Pending install fired from the picker. When non-null, the popover
  // renders that row as a spinner + blocks all other picks until the
  // install completes (or fails). On success we auto-place the new piece's
  // first action at the captured flow coords and close the popover so the
  // round-trip feels atomic to the user: click -> wait -> node appears.
  const [pendingInstall, setPendingInstall] = useState<{
    id: string;
    npmPackage: string;
    displayName: string;
  } | null>(null);
  // Per-node right-click menu (Delete / Add error handling).
  // Carrying the step type here avoids a lookup against tree+orphans
  // every time the menu re-renders to decide which entries to show.
  const [nodeContextMenu, setNodeContextMenu] = useState<
    | {
        screen: { x: number; y: number };
        nodeId: string;
        isTrigger: boolean;
        stepType: FlowStepNode["type"];
      }
    | null
  >(null);
  const closeNodeContextMenu = useCallback((): void => setNodeContextMenu(null), []);
  const [actionMessage, setActionMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const closePopover = useCallback((): void => {
    setSelectedStepName(null);
    setPopoverAnchor(null);
  }, []);

  // Auto-close the run-detail popover when overlay mode is exited or the
  // node it references is no longer in the graph. Keeps the popover from
  // floating against a stale anchor after the user clicks Exit on the
  // overlay banner.
  useEffect(() => {
    if (!runDetail) return;
    if (!overlayRunId) {
      setRunDetail(null);
      return;
    }
    const stillExists = editor.allSteps.some((fs) => fs.step.name === runDetail.stepName);
    if (!stillExists) setRunDetail(null);
  }, [runDetail, overlayRunId, editor.allSteps]);

  // Keep selection valid: when steps shift, drop the selection if it
  // doesn't exist. We have to check BOTH the connected tree AND the
  // orphan pool — clicking an orphan is a valid selection that should
  // open its settings popover.
  useEffect(() => {
    if (!selectedStepName) return;
    const inTree = editor.allSteps.some((fs) => fs.step.name === selectedStepName);
    const inOrphans = editor.draftOrphans.some((o) => o.node.name === selectedStepName);
    if (!inTree && !inOrphans) setSelectedStepName(null);
  }, [editor.allSteps, editor.draftOrphans, selectedStepName]);

  // Esc closes the editor. If there are unsaved changes, confirm first so a
  // stray keystroke doesn't lose work.
  const editorDirty = editor.dirty;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Don't hijack Esc when the user is typing in an input/textarea/select
      // -- React Flow listens too, and form fields commonly use Esc to revert.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (editorDirty && !window.confirm("Discard unsaved changes?")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorDirty, onClose]);

  // Ctrl/Cmd+Z undoes the most recent destructive op (delete, disconnect,
  // piece replace). Scoped tight: ignore when the user is typing in a
  // form field, ignore the redo combo (Shift+Z) because we don't ship
  // redo, ignore when no snapshot is available.
  const editorUndo = editor.undo;
  const editorCanUndo = editor.canUndo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== "z") return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!editorCanUndo) return;
      e.preventDefault();
      editorUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorUndo, editorCanUndo]);

  const onSave = async (): Promise<void> => {
    if (editor.validationGaps.length > 0) {
      const summary = editor.validationGaps
        .slice(0, 6)
        .map((g) => `  - ${g.stepDisplayName}: ${g.fieldLabel}`)
        .join("\n");
      const more = editor.validationGaps.length > 6 ? `\n  ...and ${editor.validationGaps.length - 6} more` : "";
      const proceed = window.confirm(
        `${editor.validationGaps.length} required field${editor.validationGaps.length === 1 ? "" : "s"} empty:\n\n${summary}${more}\n\nSave anyway? Runs will fail at the missing step.`,
      );
      if (!proceed) return;
    }
    const result = await editor.save();
    setActionMessage({ tone: result.ok ? "ok" : "warn", text: result.message });
    window.setTimeout(() => setActionMessage(null), 2500);
  };

  const onDiscard = (): void => {
    editor.reset();
    setActionMessage({ tone: "ok", text: "Reverted to saved version" });
    window.setTimeout(() => setActionMessage(null), 2000);
  };

  // Single lookup for the selected step. We check the connected tree first
  // (FlatStep carries depth / containerKind for the properties panel); on
  // miss, fall back to the orphan pool. Orphans live at depth 0 with no
  // container, so the synthesised FlatStep mirrors that.
  const selectedFlat = useMemo<FlatStep | null>(() => {
    if (!selectedStepName) return null;
    const inTree = editor.allSteps.find((fs) => fs.step.name === selectedStepName);
    if (inTree) return inTree;
    const orphan = editor.draftOrphans.find((o) => o.node.name === selectedStepName);
    if (orphan) return { step: orphan.node, depth: 0 };
    return null;
  }, [editor.allSteps, editor.draftOrphans, selectedStepName]);
  const selectedStep = selectedFlat?.step ?? null;
  const selectedDepth = selectedFlat?.depth ?? 0;

  // Per-step status snapshots for the run currently being overlaid on the
  // canvas (set via the Runs panel's "Show on canvas" button). Empty when
  // no run is overlaid -- in that case buildGraph just renders nodes in
  // their normal idle state. Declared up here so the buildGraph memo can
  // depend on it; the actual overlayRun object is resolved later for the
  // banner.
  const overlaySnapshots = useMemo(() => {
    if (!overlayRunId) return {};
    const run = runs.runs.find((r) => r.id === overlayRunId);
    if (!run) return {};
    const names = editor.allSteps.map((s) => s.step.name);
    return buildRunOverlay(run, names);
  }, [overlayRunId, runs.runs, editor.allSteps]);

  // Build the canonical graph from the chain. `baseNodes` reflects the
  // chain's authoritative order; React Flow needs an internal mutable copy
  // so dragged positions update visually without losing reactivity.
  const { nodes: baseNodes, edges } = useMemo(
    () => buildGraph(editor.draftTrigger, editor.allSteps, editor.draftOrphans, selectedStepName, editor.catalog, editor.stepPositions, overlaySnapshots),
    [editor.draftTrigger, editor.allSteps, editor.draftOrphans, selectedStepName, editor.catalog, editor.stepPositions, overlaySnapshots],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StepNodeData>>(baseNodes);
  // Sync incoming chain order changes back into React Flow's internal state.
  // Comparing by id+position keeps drag-induced renders from clobbering the
  // user's in-flight dragged position.
  useEffect(() => {
    setNodes(baseNodes);
  }, [baseNodes, setNodes]);

  // Capture the ReactFlowInstance so right-click handlers can translate
  // the cursor's screen coordinates into the canvas's flow coordinates
  // for orphan placement.
  const rfInstanceRef = useRef<ReactFlowInstance<Node<StepNodeData>, Edge> | null>(null);

  // Drag-stop: persist the new (x, y) for both tree-resident and orphan
  // nodes. We deliberately DO NOT touch the chain wiring on drag --
  // moving C between A and B used to reorder the chain into A -> C -> B,
  // which silently changed the workflow behind the user's back. Edges
  // are only ever changed by explicit handle drags / right-click delete;
  // position is purely visual.
  const onNodeDragStop = useCallback(
    (_e: React.MouseEvent | TouchEvent | MouseEvent, draggedNode: Node<StepNodeData>) => {
      if (draggedNode.data?.isOrphan) {
        editor.setOrphanPosition(draggedNode.id, draggedNode.position.x, draggedNode.position.y);
        return;
      }
      // Tree node: just save the layout. No chain mutation.
      editor.setStepPosition(draggedNode.id, draggedNode.position.x, draggedNode.position.y);
    },
    [editor],
  );

  /**
   * Drop-time validation: enforce the one-parent invariant and reject
   * self-loops. xyflow runs this on every potential drop target so it can
   * decorate invalid connection lines in red. Already-wired source handles
   * are also blocked at drag-start via `isConnectableStart` on the Handle
   * itself (see `StepNode`), so this is the second line of defence.
   */
  const isValidConnection = useCallback(
    (conn: Connection | Edge): boolean => {
      const { source, target, sourceHandle } = conn;
      if (!source || !target) return false;
      if (source === target) return false;
      // The target must be a free orphan; targets already in the tree have
      // a parent and the one-parent rule forbids re-attaching them.
      const targetIsOrphan = editor.draftOrphans.some((o) => o.node.name === target);
      if (!targetIsOrphan) return false;
      // The source handle must be free.
      if (sourceHandle && !editor.isHandleAvailable(source, sourceHandle)) return false;
      return true;
    },
    [editor],
  );

  /** Drop: turn the visual connection into a tree mutation. */
  const onConnect = useCallback(
    (conn: Connection): void => {
      if (!conn.source || !conn.target || !conn.sourceHandle) return;
      editor.connectByHandles(conn.source, conn.sourceHandle, conn.target);
    },
    [editor],
  );

  /**
   * Right-click an edge to delete it. The disconnected subtree's head
   * becomes an orphan at the cursor's flow coordinate so the user can re-
   * wire it without losing the work it represents.
   */
  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge): void => {
      event.preventDefault();
      if (!edge.source || !edge.sourceHandle) return;
      const flowPos = rfInstanceRef.current?.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      }) ?? { x: 0, y: 0 };
      editor.disconnectEdgeByHandle(edge.source, edge.sourceHandle, flowPos);
    },
    [editor],
  );

  /**
   * Right-click on the empty canvas opens the "+ Add piece" context menu.
   * We capture both the screen coordinates (where to paint the menu) and
   * the corresponding flow coordinates so the eventual "Add piece" action
   * (Task 7's library popover) can drop the new step where the user
   * clicked, not at an arbitrary default.
   */
  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent): void => {
      event.preventDefault();
      // Close any other floating affordance before opening this one so we
      // don't end up with overlapping menus.
      closePopover();
      closeNodeContextMenu();
      const mouseEvent = event as React.MouseEvent;
      const flowPos = rfInstanceRef.current?.screenToFlowPosition({
        x: mouseEvent.clientX,
        y: mouseEvent.clientY,
      }) ?? { x: 0, y: 0 };
      setCanvasMenu({
        screen: { x: mouseEvent.clientX, y: mouseEvent.clientY },
        flow: flowPos,
      });
    },
    [closePopover, closeNodeContextMenu],
  );

  /**
   * Right-click on a node opens its per-piece menu (Delete, error
   * handling). The trigger node hides Delete since the engine refuses to
   * remove it -- showing the entry would just mislead the user.
   */
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node<StepNodeData>): void => {
      event.preventDefault();
      closePopover();
      closeCanvasMenu();
      closeLibraryPicker();
      const isTrigger = editor.draftTrigger?.name === node.id;
      setNodeContextMenu({
        screen: { x: event.clientX, y: event.clientY },
        nodeId: node.id,
        isTrigger,
        stepType: node.data.step.type,
      });
    },
    [editor.draftTrigger?.name, closePopover, closeCanvasMenu, closeLibraryPicker],
  );

  /**
   * Open the floating library picker at the right-click location. The
   * picker shows a searchable list of every piece action; choosing one
   * spawns an orphan step at the captured flow coordinates which the
   * user then wires into the chain by dragging from a source handle.
   */
  const onAddPieceFromMenu = useCallback(
    (flowPos: { x: number; y: number }): void => {
      if (!canvasMenu) return;
      setLibraryPicker({ screen: canvasMenu.screen, flow: flowPos });
      closeCanvasMenu();
    },
    [canvasMenu, closeCanvasMenu],
  );

  /**
   * Route a library pick to the right orphan-spawn action.
   *
   *   control-flow      Native LOOP_ON_ITEMS / IF / ROUTER node with
   *                     sensible defaults. Drops + closes immediately.
   *   piece-action      Installed piece + chosen action. Drops + closes
   *                     immediately.
   *   piece-uninstalled Two-phase: install first, then drop the piece's
   *                     first action at the captured flow coords once
   *                     metadata is available. The popover stays open
   *                     during install with the row showing a spinner.
   *                     On success we close and place; on failure we
   *                     leave the popover open so the user can retry.
   *
   * Why we pick the first action automatically rather than re-asking the
   * user: the user-facing semantic the user signed up for here is "I want
   * to add an X step." Once the install finishes we have a piece with a
   * default action that matches that intent; making them re-pick would
   * undermine the "feels atomic" contract.
   */
  const onPickFromLibrary = useCallback(
    (entry: LibraryEntry): void => {
      if (!libraryPicker) return;
      // Block additional picks while an install is already in flight; the
      // popover should also disable interaction visually but defending
      // here too in case a stale event sneaks through.
      if (pendingInstall) return;
      // Replace-mode (clicking an empty piece) only makes sense for a
      // piece-action pick. Control-flow nodes have a different identity
      // and can't be slotted into a PIECE shell; route them to a new
      // orphan instead of silently swapping types.
      const replaceStepName = libraryPicker.replaceStepName ?? null;
      if (entry.kind === "control-flow") {
        editor.createOrphanControlFlowStep(libraryPicker.flow, entry.controlType);
        closeLibraryPicker();
        return;
      }
      if (entry.kind === "piece-action") {
        if (replaceStepName) {
          editor.setStepPiece(replaceStepName, entry.piece.name, entry.action.name);
        } else {
          editor.createOrphanStep(libraryPicker.flow, entry.piece.name, entry.action.name);
        }
        closeLibraryPicker();
        return;
      }
      // piece-uninstalled: install, refresh, place.
      const id = entry.catalogEntry.id;
      const npmPackage = entry.catalogEntry.npmPackage;
      const displayName = entry.catalogEntry.displayName;
      const flow = libraryPicker.flow;
      setPendingInstall({ id, npmPackage, displayName });
      void (async () => {
        try {
          const r = await library.install(id);
          if (!r.ok) {
            setActionMessage({ tone: "warn", text: `${displayName}: ${r.message}` });
            window.setTimeout(() => setActionMessage(null), 4000);
            return; // keep popover open so the user can retry / pick something else
          }
          // Refresh the engine catalog so the new piece's actions are
          // reachable. The install endpoint already triggers a server-side
          // refresh; this reload pulls the result client-side.
          await editor.reload();
          // The catalog we receive from reload() lives in editor.catalog
          // but our closure captured the OLD value. Re-fetch through the
          // /api/workflows/pieces endpoint inline so we can find the new
          // piece + pick its first action without waiting for React to
          // commit a re-render. This is a tiny extra GET that keeps the
          // "click -> wait -> placed" round-trip atomic.
          const piecesRes = await fetch("/api/workflows/pieces");
          if (!piecesRes.ok) {
            setActionMessage({
              tone: "warn",
              text: `${displayName} installed but catalog re-fetch failed -- open Add piece again to use it.`,
            });
            window.setTimeout(() => setActionMessage(null), 4000);
            closeLibraryPicker();
            return;
          }
          const pieces = (await piecesRes.json()) as PieceCatalogEntry[];
          const piece = pieces.find((p) => p.name === npmPackage);
          const action = piece?.actions[0];
          if (!piece || !action) {
            // Engine refresh probably half-failed (catalogRefreshFailed path
            // in the install endpoint). Surface clearly and keep the popover
            // open so the user can refresh or pick something else.
            setActionMessage({
              tone: "warn",
              text: r.partial
                ? `${displayName} installed but ${r.message}`
                : `${displayName} installed but no actions found yet -- open Add piece again to retry.`,
            });
            window.setTimeout(() => setActionMessage(null), 4000);
            return;
          }
          if (replaceStepName) {
            editor.setStepPiece(replaceStepName, piece.name, action.name);
          } else {
            editor.createOrphanStep(flow, piece.name, action.name);
          }
          closeLibraryPicker();
          setActionMessage({ tone: "ok", text: `${displayName}: ${action.displayName}` });
          window.setTimeout(() => setActionMessage(null), 2500);
        } catch (e) {
          setActionMessage({
            tone: "warn",
            text: `Install failed: ${e instanceof Error ? e.message : String(e)}`,
          });
          window.setTimeout(() => setActionMessage(null), 4000);
        } finally {
          setPendingInstall(null);
        }
      })();
    },
    [editor, library, libraryPicker, closeLibraryPicker, pendingInstall],
  );

  /**
   * Queue a run for the current flow. The server runs the latest published
   * version (or the latest draft if no published version exists), so a
   * user with unsaved edits should save first; we warn with a confirm
   * rather than disabling outright so the user can deliberately re-run
   * the last-saved version if that's what they want.
   */
  const handleRun = useCallback(async (): Promise<void> => {
    if (!flowId) return;
    if (editor.dirty) {
      const proceed = window.confirm(
        "You have unsaved changes. Running will use the last SAVED version, not your current edits. Continue?",
      );
      if (!proceed) return;
    }
    const result = await runs.start();
    if (result.ok) {
      setActionMessage({ tone: "ok", text: "Run queued" });
      // Open the panel automatically so the user can watch progress.
      setRunsPanelOpen(true);
    } else {
      setActionMessage({ tone: "warn", text: `Run failed: ${result.message}` });
    }
    window.setTimeout(() => setActionMessage(null), 2500);
  }, [flowId, editor.dirty, runs]);

  // Count of non-terminal runs surfaced as a badge on the Runs button so
  // users see "something's still going" without having to open the panel.
  const activeRunCount = useMemo(
    () => runs.runs.filter((r) => !RUN_TERMINAL_STATUSES.has(r.status)).length,
    [runs.runs],
  );
  // First active run (most recent that's still in-flight). Drives the
  // sticky banner so single-run cases can show specific status / step
  // info rather than just a count.
  const activeRun = useMemo(
    () => runs.runs.find((r) => !RUN_TERMINAL_STATUSES.has(r.status)) ?? null,
    [runs.runs],
  );
  // Resolve the overlay run for the banner. The snapshots used by
  // buildGraph live above (declared early so the memo can depend on
  // them); this lookup just gets the run row for banner labelling.
  const overlayRun = useMemo(
    () => (overlayRunId ? runs.runs.find((r) => r.id === overlayRunId) ?? null : null),
    [overlayRunId, runs.runs],
  );

  return (
    <CurrentFlowIdContext.Provider value={flowId}>
    <div className="wf-editor" role="dialog" aria-modal="true" aria-labelledby="wf-editor-title">
      <header className="wf-editor__header">
        <div className="wf-editor__title">
          {editor.version ? (
            <EditableTitle
              value={editor.version.displayName}
              disabled={editor.version.state === "LOCKED"}
              onCommit={(name) => editor.setVersionDisplayName(name)}
            />
          ) : (
            <h2 id="wf-editor-title">Loading…</h2>
          )}
          <p>
            {editor.version ? (
              <>
                Version <code>{editor.version.id}</code> · {editor.version.state}
                {editor.dirty ? " · unsaved changes" : null}
              </>
            ) : null}
          </p>
        </div>
        <div className="wf-editor__actions">
          {actionMessage ? (
            <span className={`wf-editor__toast wf-editor__toast--${actionMessage.tone}`}>
              {actionMessage.text}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              editor.clearStepPositions();
              // Refit the viewport so the rearranged grid is fully
              // visible (similar to xyflow's "fitView" controls button
              // but triggered by the explicit user action).
              window.requestAnimationFrame(() => {
                rfInstanceRef.current?.fitView({ padding: 0.15, duration: 250 });
              });
            }}
            title="Reset all step positions to the auto-arranged grid (does not change connections)"
            disabled={Object.keys(editor.stepPositions).length === 0}
          >
            <Icon icon={LayoutGrid} size={14} /> Auto-arrange
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => editor.undo()}
            disabled={!editor.canUndo}
            title={
              editor.canUndo
                ? `Undo: ${editor.undoLabel ?? "last destructive change"} (Ctrl+Z)`
                : "Nothing to undo"
            }
          >
            <Icon icon={Undo2} size={14} /> Undo
          </Button>
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={!editor.dirty}>
            <Icon icon={RotateCcw} size={14} /> Discard
          </Button>
          <Button variant="primary" size="sm" onClick={() => void onSave()} disabled={!editor.dirty}>
            <Icon icon={Save} size={14} /> Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleRun()}
            disabled={runs.starting || !editor.version}
            title={
              editor.dirty
                ? "Run the LAST SAVED version (your unsaved edits won't apply)"
                : "Queue a run of this workflow"
            }
          >
            <Icon icon={Play} size={14} /> {runs.starting ? "Queueing..." : "Run"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRunsPanelOpen((v) => !v)}
            title={runsPanelOpen ? "Hide runs panel" : "Show runs panel"}
            aria-expanded={runsPanelOpen}
          >
            <Icon icon={History} size={14} /> Runs
            {activeRunCount > 0 ? (
              <span className="wf-editor__runs-badge" aria-label={`${activeRunCount} active`}>
                {activeRunCount}
              </span>
            ) : runs.runs.length > 0 ? (
              <span className="wf-editor__runs-count">{runs.runs.length}</span>
            ) : null}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close editor">
            <Icon icon={X} size={14} />
          </Button>
        </div>
      </header>

      {/* Sticky banner: surfaces in-flight runs with status + duration so
          the user notices long-running executions even when the right
          panel is closed. Clicking the banner opens the panel; the close
          button just dismisses the banner for this session (the chip on
          the header Runs button still flags the count). */}
      {activeRunCount > 0 && activeRun ? (
        <RunningBanner
          activeCount={activeRunCount}
          run={activeRun}
          onOpenPanel={() => setRunsPanelOpen(true)}
        />
      ) : null}

      {/* Run overlay banner: when a past run is selected for canvas
          overlay, surfaces which run + lets the user exit overlay mode.
          Distinct from the in-flight banner so they can coexist (user
          viewing run #4's overlay while run #5 is currently running).
          Passes `hasOverlayData` so the banner can warn when the run has
          no per-step trace (PRODUCTION runs, runs that timed out before
          any step output streamed). */}
      {overlayRun ? (
        <OverlayBanner
          run={overlayRun}
          hasOverlayData={Object.keys(overlaySnapshots).length > 0}
          onClear={() => setOverlayRunId(null)}
        />
      ) : null}

      <div className="wf-editor__body">
      <section className="wf-editor__canvas" aria-label="Workflow graph">
        {editor.loading ? (
          <div className="wf-editor__placeholder">Loading flow…</div>
        ) : editor.error ? (
          <div className="wf-editor__placeholder wf-editor__placeholder--error">{editor.error}</div>
        ) : nodes.length === 0 ? (
          <div className="wf-editor__placeholder">This flow has no steps yet.</div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onInit={(instance) => {
              rfInstanceRef.current = instance;
            }}
            onNodesChange={onNodesChange}
            nodeTypes={NODE_TYPES}
            onNodeClick={(event, n) => {
              const anchor = { x: event.clientX, y: event.clientY };
              if (overlayRunId) {
                // Overlay mode: clicking a node opens the run-detail
                // popover (input/output/error/duration for that step in
                // the selected run) instead of the settings panel. The
                // user is inspecting a past execution; mutating the flow
                // doesn't make sense in that context.
                setRunDetail({ stepName: n.id, anchor });
                closePopover();
                return;
              }
              // Empty PIECE steps (created by "Add step after" / loop +
              // / branch +) have no piece configured yet. The settings
              // panel has nothing meaningful to show for them since the
              // piece + action are fixed at creation time; route the
              // click straight into the library picker in replace mode
              // so the user can pick a piece. `setStepPiece` mutates in
              // place, preserving the step's connections and position.
              const stepData = (n.data ?? {}) as { step?: FlowStepNode };
              const step = stepData.step;
              const isEmptyPiece =
                step?.type === "PIECE" &&
                (!step.settings?.pieceName || !step.settings.actionName);
              if (isEmptyPiece) {
                const flowPos = rfInstanceRef.current?.screenToFlowPosition({
                  x: event.clientX,
                  y: event.clientY,
                }) ?? { x: 0, y: 0 };
                setLibraryPicker({
                  screen: anchor,
                  flow: flowPos,
                  replaceStepName: n.id,
                });
                closePopover();
                closeRunDetail();
                return;
              }
              setSelectedStepName(n.id);
              setPopoverAnchor(anchor);
              closeRunDetail();
            }}
            onPaneClick={() => {
              closePopover();
              closeRunDetail();
              closeCanvasMenu();
              closeLibraryPicker();
              closeNodeContextMenu();
            }}
            onPaneContextMenu={onPaneContextMenu}
            onNodeContextMenu={onNodeContextMenu}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onEdgeContextMenu={onEdgeContextMenu}
            fitView
            fitViewOptions={{ padding: 0.15, minZoom: 0.4, maxZoom: 1.25 }}
            // Distance (px) from the pointer at which a connection drag
            // snaps to the closest valid handle. The default of 20 forces
            // pixel-perfect drops on the handle dot; raising it to ~140
            // (just under a node's width) lets the user drop anywhere on
            // the target node's body and still land on its input handle.
            // The handles' own hit area is also enlarged in CSS so users
            // who DO aim at the dot get extra slack.
            connectionRadius={140}
            // Per-node `draggable` flag (set to false for the trigger in
            // buildGraph) overrides this. Nodes default to draggable.
            nodesDraggable
            nodesConnectable
            elementsSelectable
            panOnDrag
            zoomOnScroll
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </section>

      {/* Side panel: this flow's run history. Toggled via the header Runs
          button. Stays mounted but visually collapsed when closed so the
          poll loop continues (badge in the header keeps incrementing). */}
      {runsPanelOpen ? (
        <RunsPanel
          runs={runs.runs}
          loading={runs.loading}
          error={runs.error}
          overlayRunId={overlayRunId}
          onClose={() => setRunsPanelOpen(false)}
          onRefresh={() => void runs.refresh()}
          onCancel={async (runId) => {
            const r = await runs.cancel(runId);
            setActionMessage({
              tone: r.ok ? "ok" : "warn",
              text: r.ok ? "Cancel queued" : `Cancel failed: ${r.message}`,
            });
            window.setTimeout(() => setActionMessage(null), 2500);
          }}
          onToggleOverlay={(runId) => {
            setOverlayRunId((cur) => (cur === runId ? null : runId));
          }}
        />
      ) : null}
      </div>

      {/* Canvas right-click menu: anchored at the cursor's screen
          position. First entry opens the floating piece library. */}
      {canvasMenu ? (
        <CanvasContextMenu
          anchor={canvasMenu.screen}
          onClose={closeCanvasMenu}
          items={[
            {
              key: "add-piece",
              icon: Plus,
              label: "Add piece",
              shortcut: "+",
              onSelect: () => onAddPieceFromMenu(canvasMenu.flow),
            },
          ]}
        />
      ) : null}

      {/* Floating piece library picker, opened from the canvas context
          menu. Picking a piece+action spawns an orphan step at the
          captured flow coords (Task 3 wires the drag-to-connect). */}
      {libraryPicker ? (
        <PieceLibraryPopover
          anchor={libraryPicker.screen}
          catalog={editor.catalog}
          library={library.entries}
          installingId={pendingInstall?.id ?? null}
          onPick={onPickFromLibrary}
          onClose={closeLibraryPicker}
        />
      ) : null}

      {/* Per-node right-click menu. Delete is hidden for the trigger
          (the engine treats it as undeletable). "Add error handling"
          only renders for PIECE / CODE steps -- those are the only
          types the engine consults `errorHandlingOptions` for. */}
      {nodeContextMenu ? (
        <CanvasContextMenu
          anchor={nodeContextMenu.screen}
          onClose={closeNodeContextMenu}
          items={[
            ...(nodeContextMenu.isTrigger
              ? []
              : [
                  {
                    key: "delete",
                    icon: Trash2,
                    label: "Delete",
                    destructive: true,
                    onSelect: () => {
                      editor.deleteStep(nodeContextMenu.nodeId);
                      closeNodeContextMenu();
                      // Close the settings popover too if it happened to
                      // be open on the same step -- the step's gone, the
                      // popover would render against a phantom selection.
                      if (selectedStepName === nodeContextMenu.nodeId) {
                        closePopover();
                      }
                    },
                  },
                ]),
            ...(nodeContextMenu.stepType === "PIECE"
              ? [
                  {
                    key: "add-error-handling",
                    icon: ShieldAlert,
                    label: "Add error handling",
                    onSelect: () => {
                      const routerName = editor.addErrorHandling(nodeContextMenu.nodeId);
                      closeNodeContextMenu();
                      // Select the new router so the user immediately sees
                      // the conditions / branches in the settings popover.
                      // Anchor where the menu was painted so the popover
                      // opens predictably.
                      if (routerName) {
                        setSelectedStepName(routerName);
                        setPopoverAnchor(nodeContextMenu.screen);
                      }
                    },
                  },
                ]
              : []),
          ]}
        />
      ) : null}

      {/* Floating settings popover: opens at the cursor when a node is
          clicked, replaces the legacy right-rail aside. Outside-click and
          Esc close it via the shared `closePopover` handler. */}
      {selectedStep && popoverAnchor ? (
        <NodeSettingsPopover
          anchor={popoverAnchor}
          onClose={closePopover}
          predecessors={
            editor.draftTrigger
              ? pathToStep(editor.draftTrigger, selectedStep.name) ?? []
              : []
          }
          sampleData={editor.version?.sampleData ?? {}}
          catalog={editor.catalog}
          // `allSteps` carries FlatStep wrappers; the variable picker
          // wants bare FlowStepNode[] so it can match siblings on
          // (piece, action). Map at the boundary.
          allSteps={editor.allSteps.map((fs) => fs.step)}
        >
          <PropertiesPanel
            step={selectedStep}
            isTriggerStep={editor.draftTrigger?.name === selectedStep.name}
            hasNextAction={!!selectedStep.nextAction}
            isTopLevel={selectedDepth === 0}
            containerKind={selectedFlat?.containerKind}
            catalog={editor.catalog}
            connections={editor.connections}
            onSetTriggerKind={(kind) => editor.setTriggerKind(kind)}
            onSetErrorHandling={(patch) => editor.setStepErrorHandling(selectedStep.name, patch)}
            onSetInput={(key, value) => editor.updateStepInput(selectedStep.name, key, value)}
            onAddInputKey={(key) => editor.updateStepInput(selectedStep.name, key, "")}
            onRemoveInputKey={(key) => {
              const settings = selectedStep.settings ?? {};
              const input = { ...(settings.input ?? {}) };
              delete input[key];
              editor.updateStep(selectedStep.name, { settings: { ...settings, input } });
            }}
            onSetDisplayName={(displayName) => {
              const trimmed = displayName.trim();
              // EditableStepName already guards its own commit; we still
              // defend here so callers other than the widget can't blank
              // the name accidentally.
              if (!trimmed) return;
              editor.updateStep(selectedStep.name, { displayName: trimmed });
            }}
            onAddStepAfter={() => {
              const created = editor.insertStepAfter(selectedStep.name);
              if (created) setSelectedStepName(created);
            }}
            onDelete={() => {
              if (window.confirm(`Delete step "${selectedStep.displayName ?? selectedStep.name}"?`)) {
                editor.deleteStep(selectedStep.name);
                closePopover();
              }
            }}
            // LOOP-specific
            onSetLoopItems={(items) => editor.setLoopItems(selectedStep.name, items)}
            onAddStepToLoopBody={() => {
              const created = editor.addStepToHead({ kind: "loop", parentName: selectedStep.name });
              if (created) setSelectedStepName(created);
            }}
            // ROUTER-specific
            onSetRouterExecutionType={(t) => editor.setRouterExecutionType(selectedStep.name, t)}
            onAddRouterBranch={(name) => editor.addRouterBranch(selectedStep.name, name)}
            onRemoveRouterBranch={(idx) => editor.removeRouterBranch(selectedStep.name, idx)}
            onSetBranchConditions={(idx, conditions) =>
              editor.setBranchConditions(selectedStep.name, idx, conditions)
            }
            onAddStepToBranch={(branchName) => {
              const created = editor.addStepToHead({ kind: "branch", parentName: selectedStep.name, branchName });
              if (created) setSelectedStepName(created);
            }}
            sampleData={editor.version?.sampleData?.[selectedStep.name]}
            sampleInput={editor.version?.sampleInput?.[selectedStep.name]}
            isLocked={editor.version?.state === "LOCKED"}
            onSetSampleData={(output) =>
              editor.setStepSampleData(selectedStep.name, output)
            }
            onSetSampleInput={(input) =>
              editor.setStepSampleInput(selectedStep.name, input)
            }
            onTestFromHere={() => editor.testStepFromHere(selectedStep.name)}
          />
        </NodeSettingsPopover>
      ) : null}

      {/* Run-detail popover (overlay mode only). Opens in place of the
          settings panel when the user clicks a node while a past run is
          overlaid. Shows that step's input / output / error / duration. */}
      {runDetail && overlayRun ? (
        <RunStepDetailPopover
          anchor={runDetail.anchor}
          run={overlayRun}
          stepName={runDetail.stepName}
          onClose={closeRunDetail}
        />
      ) : null}
    </div>
    </CurrentFlowIdContext.Provider>
  );
}

/**
 * The id of the workflow currently being edited. Provided at the top
 * of `WorkflowEditor` and consumed by `FlowRefField` so the workflow
 * picker can filter out the current flow (prevents a one-click
 * self-recursion footgun in `run_workflow`). Defaults to `null` so
 * unit-rendered field components outside the editor still mount.
 */
const CurrentFlowIdContext = createContext<string | null>(null);

/* =========================================================== editable title */

/**
 * Click-to-edit workflow title. Renders as the existing `<h2>` until the
 * user clicks it; swaps to a same-sized `<input>` so the chrome doesn't
 * jump. Enter / blur commits via `onCommit`; Esc reverts. Empty values
 * are silently discarded so a stray double-click + clear-out can't blank
 * the workflow name. Published (LOCKED) versions are read-only.
 */
function EditableTitle({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled?: boolean;
  onCommit: (next: string) => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the local draft in sync when the parent value changes from
  // outside (load, save echo, discard).
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  // Auto-focus + select the field's contents on enter so the user can
  // either type a fresh name or move the cursor without an extra click.
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  const commit = useCallback((): void => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onCommit(trimmed);
    else setDraft(value); // revert on empty / no-op so the input shows truth
    setEditing(false);
  }, [draft, value, onCommit]);

  const cancel = useCallback((): void => {
    setDraft(value);
    setEditing(false);
  }, [value]);

  if (!editing) {
    return (
      <h2
        id="wf-editor-title"
        className={`wf-editor__title-text ${disabled ? "wf-editor__title-text--locked" : ""}`}
        onClick={() => {
          if (disabled) return;
          setEditing(true);
        }}
        title={disabled ? "Published versions are read-only" : "Click to rename"}
        role={disabled ? undefined : "button"}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setEditing(true);
          }
        }}
      >
        {value}
      </h2>
    );
  }

  return (
    <input
      ref={inputRef}
      className="wf-editor__title-input"
      id="wf-editor-title"
      aria-label="Workflow name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    />
  );
}

/**
 * Click-to-edit step title used in the properties panel header. Same
 * UX as `EditableTitle` for the workflow name: the h3 reads as a
 * button on hover; clicking swaps it for an `<input>` sized to match.
 * Enter / blur commits, Esc cancels, empty input reverts. Replaces
 * the separate "Display name" field that used to live in the panel
 * body.
 *
 * Kept distinct from `EditableTitle` (which renders an h2 with
 * workflow-title styling) so the typographic chrome of the two
 * locations can diverge without ifs.
 */
function EditableStepName({
  name,
  fallback,
  onCommit,
}: {
  name: string;
  /** Step name (id), shown as the input's placeholder when displayName is empty. */
  fallback: string;
  onCommit: (next: string) => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  const commit = useCallback((): void => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onCommit(trimmed);
    else setDraft(name);
    setEditing(false);
  }, [draft, name, onCommit]);

  const cancel = useCallback((): void => {
    setDraft(name);
    setEditing(false);
  }, [name]);

  if (!editing) {
    return (
      <h3
        className="wf-props__title"
        title="Click to rename"
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setEditing(true);
          }
        }}
      >
        {name}
      </h3>
    );
  }

  return (
    <input
      ref={inputRef}
      className="wf-props__title-input"
      aria-label="Step name"
      value={draft}
      placeholder={fallback}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    />
  );
}

/* =========================================================== node settings popover */

const POPOVER_WIDTH = 360;
const POPOVER_MARGIN = 12;

/**
 * Active state of the variable picker. Set when a text input in the
 * settings popover gains focus; cleared on blur. `el` is the DOM input
 * to insert into; `onInsert` is the controlled-state setter that should
 * commit the new value after the picker splices in a template.
 */
/**
 * What the picker needs from the focused field. `anchorEl` is the field's
 * root DOM node -- used purely to position the picker beside it.
 * `insert(template)` is the field-specific insertion logic: a native
 * `<input>` splices the template into its `value` via `insertAtCursor`;
 * a contentEditable chip field inserts a chip span at the current
 * selection and emits the new raw value.
 */
interface VariablePickerActive {
  anchorEl: HTMLElement;
  insert: (template: string) => void;
}

interface VariablePickerHandle {
  /** Called by a field on focus -- registers it as the insertion target. */
  open(active: VariablePickerActive): void;
  /** Called on blur. The picker is dismissed after a short delay so a click
   *  inside the picker still fires before the field loses the target. */
  scheduleClose(): void;
  /** Cancels a pending scheduleClose -- the picker calls this from its
   *  own onMouseDown so clicking a variable row doesn't trip the blur path. */
  cancelClose(): void;
}

/** No-op default so a text input rendered outside the popover (legacy
 *  paths) doesn't crash on focus -- it just won't get a picker. */
const NULL_PICKER: VariablePickerHandle = {
  open: () => {},
  scheduleClose: () => {},
  cancelClose: () => {},
};

const VariablePickerContext = createContext<VariablePickerHandle>(NULL_PICKER);

/**
 * Insert `template` at the input's current selection range and emit the
 * new value via `onChange`. Cursor lands after the inserted text on the
 * next tick so the user can keep typing seamlessly. Works for both
 * `<input>` and `<textarea>`.
 */
function insertAtCursor(
  el: HTMLInputElement | HTMLTextAreaElement,
  template: string,
  onChange: (next: string) => void,
): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const next = `${before}${template}${after}`;
  onChange(next);
  // Restore focus + cursor after React commits the new value. Without
  // this the input loses focus to the picker and the cursor jumps.
  window.setTimeout(() => {
    el.focus();
    const caret = start + template.length;
    el.setSelectionRange(caret, caret);
  }, 0);
}

// `buildVariableRows` + the picker-resolution helpers live in
// `./variable-rows` so they can be unit-tested without mounting the
// editor's React tree. The `VariableRow` shape is the row payload the
// floating panel renders.

/**
 * Floating settings panel anchored to the click location. Portal-rendered
 * into document.body so it escapes the canvas overflow, with viewport
 * clamping so it never paints off-screen. Closes on Esc and outside-click;
 * re-anchors when `anchor` changes (clicking a different node).
 *
 * Also hosts the variable-picker context: any text input rendered inside
 * `children` can call `useContext(VariablePickerContext)` and register
 * itself on focus. A floating panel listing predecessor outputs then
 * opens beside the popover.
 */
function NodeSettingsPopover({
  anchor,
  onClose,
  predecessors,
  sampleData,
  catalog,
  allSteps,
  children,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
  predecessors: FlowStepNode[];
  sampleData: Record<string, unknown>;
  /** Piece catalog -- used by the variable picker to fall back to declared output shapes. */
  catalog: PieceCatalogEntry[];
  /**
   * Every step in the version. Lets the picker pull the output shape
   * from a sibling step that shares the same (piece, action) when this
   * step has no captured data of its own.
   */
  allSteps: FlowStepNode[];
  children: React.ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>(() => clampToViewport(anchor, undefined));
  const [pickerActive, setPickerActive] = useState<VariablePickerActive | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const pickerHandle = useMemo<VariablePickerHandle>(
    () => ({
      open: (active) => {
        if (closeTimerRef.current !== null) {
          window.clearTimeout(closeTimerRef.current);
          closeTimerRef.current = null;
        }
        setPickerActive(active);
      },
      scheduleClose: () => {
        if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
        // Defer enough that a mousedown inside the picker (which clears
        // this timer via cancelClose) wins the race.
        closeTimerRef.current = window.setTimeout(() => {
          setPickerActive(null);
          closeTimerRef.current = null;
        }, 180);
      },
      cancelClose: () => {
        if (closeTimerRef.current !== null) {
          window.clearTimeout(closeTimerRef.current);
          closeTimerRef.current = null;
        }
      },
    }),
    [],
  );

  // Re-clamp when anchor changes (new node clicked) or after the panel
  // measures its own height. `useLayoutEffect` so the visible position is
  // correct on first paint -- no flicker from initial click coords to
  // clamped coords.
  useLayoutEffect(() => {
    setPos(clampToViewport(anchor, ref.current ?? undefined));
  }, [anchor]);

  // Outside-click. Defer registration one tick so the same click that
  // opened us doesn't immediately close us. Clicks inside the variable
  // picker are also considered "inside" so they don't dismiss the popover.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!ref.current) return;
      // The xyflow `Node` type shadows the DOM Node in this module, so we
      // disambiguate via globalThis.
      const target = e.target as globalThis.Node;
      if (ref.current.contains(target)) return;
      // Clicks inside any of our portal-rendered popovers shouldn't
      // close the settings panel -- they belong to widgets the user
      // opened from the panel (variable picker for templated inputs;
      // flow_ref picker for `run_workflow.flow`). Add new portals to
      // this allowlist so they don't accidentally dismiss the panel.
      for (const sel of [".wf-var-picker", ".wf-flow-ref__popover"]) {
        const el = document.querySelector(sel);
        if (el && el.contains(target)) return;
      }
      onClose();
    };
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // Don't hijack Esc when the user is editing a field; let it bubble
      // so the field's own handler can revert.
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const variableRows = useMemo(
    () => buildVariableRows(predecessors, sampleData, catalog, allSteps),
    [predecessors, sampleData, catalog, allSteps],
  );

  return (
    <VariablePickerContext.Provider value={pickerHandle}>
      {createPortal(
        <div
          ref={ref}
          className="wf-popover"
          role="dialog"
          aria-label="Step settings"
          style={{ left: pos.left, top: pos.top, width: POPOVER_WIDTH }}
        >
          <button
            type="button"
            className="wf-popover__close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <Icon icon={X} size={14} />
          </button>
          <div className="wf-popover__body">{children}</div>
        </div>,
        document.body,
      )}
      {pickerActive ? (
        <VariablePickerPanel
          settingsPopoverRef={ref}
          anchorEl={pickerActive.anchorEl}
          rows={variableRows}
          onInsert={pickerActive.insert}
          onClose={() => setPickerActive(null)}
          onMouseDownInside={() => pickerHandle.cancelClose()}
        />
      ) : null}
    </VariablePickerContext.Provider>
  );
}

/**
 * Floating panel listing predecessor outputs. Positions itself opposite
 * the settings popover so both stay visible side-by-side. Empty state
 * tells the user nothing's available yet (e.g. editing the trigger or
 * a step with no predecessors).
 *
 * Rows are click-to-insert AND draggable. The drag payload carries the
 * full template (`{{step.field}}`) under both a custom MIME type and
 * `text/plain` so dropping into a target that only supports text still
 * works.
 */
function VariablePickerPanel({
  settingsPopoverRef,
  anchorEl,
  rows,
  onInsert,
  onClose,
  onMouseDownInside,
}: {
  settingsPopoverRef: React.RefObject<HTMLDivElement | null>;
  anchorEl: HTMLElement;
  rows: VariableRow[];
  onInsert: (template: string) => void;
  onClose: () => void;
  onMouseDownInside: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  // Pick a side adjacent to the settings popover. Prefer LEFT (so the
  // picker sits between the canvas and the popover). Fall back to RIGHT
  // when there isn't room on the left.
  useLayoutEffect(() => {
    const settings = settingsPopoverRef.current;
    const picker = ref.current;
    if (!settings || !picker) return;
    const settingsBox = settings.getBoundingClientRect();
    const pickerW = picker.offsetWidth || 280;
    const gap = 12;
    let left = settingsBox.left - pickerW - gap;
    if (left < 12) left = settingsBox.right + gap;
    // Vertically align the picker's top with the focused field's top so
    // it reads as "this menu is for THAT field".
    const inputBox = anchorEl.getBoundingClientRect();
    let top = inputBox.top;
    // Clamp inside viewport.
    const vh = window.innerHeight;
    const pickerH = picker.offsetHeight || 320;
    if (top + pickerH + 12 > vh) top = Math.max(12, vh - pickerH - 12);
    if (top < 12) top = 12;
    setPos({ left, top });
  }, [settingsPopoverRef, anchorEl, rows.length]);

  // Group rows by step for the section headers. We keep the rows array
  // ordered (most-recent step first) so the grouping preserves that order.
  const groups = useMemo(() => {
    const out: Array<{ step: FlowStepNode; rows: VariableRow[] }> = [];
    let current: { step: FlowStepNode; rows: VariableRow[] } | null = null;
    for (const row of rows) {
      if (!current || current.step.name !== row.step.name) {
        current = { step: row.step, rows: [row] };
        out.push(current);
      } else {
        current.rows.push(row);
      }
    }
    return out;
  }, [rows]);

  return createPortal(
    <div
      ref={ref}
      className="wf-var-picker"
      role="dialog"
      aria-label="Insert variable"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={onMouseDownInside}
    >
      <header className="wf-var-picker__head">
        <h3>Insert variable</h3>
        <button
          type="button"
          className="wf-var-picker__close"
          onClick={onClose}
          aria-label="Close variable picker"
        >
          <Icon icon={X} size={12} />
        </button>
      </header>
      {groups.length === 0 ? (
        <div className="wf-var-picker__empty">
          No previous steps. Add steps before this one or set sample data on
          the trigger to expose its payload.
        </div>
      ) : (
        <ul className="wf-var-picker__groups">
          {groups.map((g) => (
            <li key={g.step.name} className="wf-var-picker__group">
              <div className="wf-var-picker__group-head">
                <span className="wf-var-picker__step">
                  {g.step.displayName ?? g.step.name}
                </span>
                <span className="wf-var-picker__step-name">{g.step.name}</span>
              </div>
              <ul className="wf-var-picker__rows">
                {g.rows.map((row) => (
                  <li key={row.template}>
                    <button
                      type="button"
                      className="wf-var-picker__row"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "copy";
                        e.dataTransfer.setData("text/x-wf-variable", row.template);
                        // text/plain fallback so dragging into anything
                        // that accepts plain text inserts the template.
                        e.dataTransfer.setData("text/plain", row.template);
                      }}
                      onClick={() => onInsert(row.template)}
                      // Re-focus the target input on mousedown so the
                      // click insert lands the cursor where it should --
                      // without this the blur fires first, selection
                      // resets, and the template lands at index 0.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        anchorEl.focus();
                      }}
                      title={row.template}
                    >
                      <span className="wf-var-picker__label">{row.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <footer className="wf-var-picker__footer">
        Or type <code>{"{{stepName.field}}"}</code> directly.
      </footer>
    </div>,
    document.body,
  );
}

/**
 * Wire a text-like input to the variable picker context. Centralised so
 * every editable field in the panel gets the same focus/blur/drop
 * behaviour without copy-pasting handlers.
 *
 * Pass the input's current `value` and its `onChange` setter; the hook
 * returns the JSX-ready props you spread onto the `<input>` or
 * `<textarea>`. Existing `onFocus` / `onBlur` / `onDrop` props on the
 * field are composed with the picker handlers.
 */
function useVariableFieldProps(
  value: string,
  onChange: (next: string) => void,
): {
  onFocus: React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onBlur: React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onDragOver: React.DragEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onDrop: React.DragEventHandler<HTMLInputElement | HTMLTextAreaElement>;
} {
  const picker = useContext(VariablePickerContext);
  return {
    onFocus: (e) => {
      const el = e.currentTarget;
      picker.open({
        anchorEl: el,
        insert: (template) => insertAtCursor(el, template, onChange),
      });
    },
    onBlur: () => {
      picker.scheduleClose();
    },
    onDragOver: (e) => {
      // Only accept our own drag payload; ignore unrelated drags.
      const types = Array.from(e.dataTransfer.types ?? []);
      if (!types.includes("text/x-wf-variable") && !types.includes("text/plain")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDrop: (e) => {
      const template =
        e.dataTransfer.getData("text/x-wf-variable") || e.dataTransfer.getData("text/plain");
      if (!template) return;
      e.preventDefault();
      insertAtCursor(e.currentTarget, template, onChange);
    },
  };
}

/* =========================================================== variable chip field */

/**
 * `value` parsed into alternating text and variable segments. Variables
 * are atomic units in the visual editor -- each `{{...}}` template
 * renders as a single chip that the user can delete with one Backspace
 * but can't half-edit. Text segments are freely typed.
 */
type ValueSegment =
  | { kind: "text"; text: string }
  | { kind: "var"; template: string };

const TEMPLATE_REGEX = /\{\{[^{}]+\}\}/g;

/** Split a raw value into segments. Anything matching `{{...}}` becomes a
 *  var segment; the rest is text. Tolerant: unmatched braces stay text. */
function parseSegments(value: string): ValueSegment[] {
  const out: ValueSegment[] = [];
  let lastIndex = 0;
  // Reset before each call -- the regex is module-scoped for perf.
  TEMPLATE_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_REGEX.exec(value)) !== null) {
    if (m.index > lastIndex) {
      out.push({ kind: "text", text: value.slice(lastIndex, m.index) });
    }
    out.push({ kind: "var", template: m[0] });
    lastIndex = TEMPLATE_REGEX.lastIndex;
  }
  if (lastIndex < value.length) {
    out.push({ kind: "text", text: value.slice(lastIndex) });
  }
  return out;
}

/**
 * Extract the user-facing label from a `{{...}}` template. For a typical
 * `{{step_3.email_status}}` template we want "email_status"; for a
 * whole-step `{{step_3}}` template we fall back to the step name itself
 * (no field to drill into).
 */
function templateLabel(template: string): string {
  const inner = template.replace(/^\{\{\s*/, "").replace(/\s*\}\}$/, "").trim();
  const dot = inner.indexOf(".");
  if (dot === -1) return inner;
  // For nested templates like `{{step.user.email}}`, surface the whole
  // dotted path after the step name -- that's enough context.
  return inner.slice(dot + 1);
}

/**
 * Build a DOM chip element representing one `{{...}}` template. The chip
 * is `contentEditable=false` so the browser treats it as a single
 * "character" -- one Backspace removes it whole, typing next to it
 * doesn't split it. The full template lives on a data attribute so
 * `extractValue` can reconstruct the raw string.
 */
function createChipElement(template: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "wf-chip";
  chip.contentEditable = "false";
  chip.setAttribute("data-template", template);
  chip.textContent = templateLabel(template);
  // Native tooltip showing the full template -- helps users learn what
  // the chip resolves to without inspecting state.
  chip.title = template;
  return chip;
}

/**
 * Walk the contentEditable's DOM and reconstruct the raw template-laden
 * string. Chips contribute their `data-template`; text nodes contribute
 * their text; `<br>` becomes `\n` (for multi-line fields).
 */
function extractValue(root: HTMLElement): string {
  // The xyflow `Node` type imported at the top of this module shadows
  // the global DOM Node, so we disambiguate via globalThis everywhere
  // we need the DOM one. Same workaround used elsewhere in this file.
  let out = "";
  const walk = (node: globalThis.Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === globalThis.Node.TEXT_NODE) {
        out += child.textContent ?? "";
      } else if (child.nodeType === globalThis.Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        if (el.classList.contains("wf-chip")) {
          out += el.getAttribute("data-template") ?? "";
        } else if (el.tagName === "BR") {
          out += "\n";
        } else {
          // Anything else (e.g. a stray div from a paste): recurse into
          // its children so the visible text survives.
          walk(child);
        }
      }
    }
  };
  walk(root);
  return out;
}

/** Replace the contentEditable's children with chips + text built from
 *  `value`. Called both on mount and when `value` changes from outside. */
function renderSegmentsTo(root: HTMLElement, value: string, multiline: boolean): void {
  root.innerHTML = "";
  for (const seg of parseSegments(value)) {
    if (seg.kind === "var") {
      root.appendChild(createChipElement(seg.template));
    } else {
      // Multi-line: split on `\n` and insert <br> between, so the line
      // breaks survive the round-trip via extractValue.
      if (multiline && seg.text.includes("\n")) {
        const lines = seg.text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]) root.appendChild(document.createTextNode(lines[i]!));
          if (i < lines.length - 1) root.appendChild(document.createElement("br"));
        }
      } else if (seg.text) {
        root.appendChild(document.createTextNode(seg.text));
      }
    }
  }
}

/** Insert a chip at the current selection inside `root`. If selection
 *  isn't inside the field (lost focus, never set), append at the end.
 *  Leaves the caret right after the inserted chip so subsequent typing
 *  reads as "the user added a thing and is continuing after it". */
function insertChipAtSelection(root: HTMLElement, template: string): void {
  const chip = createChipElement(template);
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
    root.appendChild(chip);
    placeCursorAfter(chip);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(chip);
  placeCursorAfter(chip);
}

function placeCursorAfter(node: globalThis.Node): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Modern + legacy caret-from-point. Used by the drop handler so the
 *  chip lands where the user actually dropped, not at the field's
 *  end-of-text by default. */
function caretRangeFromPoint(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: globalThis.Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

/**
 * Chip-rendering text field. Looks and behaves like a regular input,
 * except `{{step.field}}` templates inside the value render as visible
 * `field` chips. The chip is atomic -- backspace removes it whole, you
 * can't half-edit it.
 *
 * Uncontrolled internally w.r.t. the contentEditable DOM (rebuilding it
 * on every onChange would reset the caret). Re-renders only when the
 * `value` prop changes from OUTSIDE (load, reset, picker insert from
 * another field, ...). The `lastEmittedRef` trick distinguishes "we
 * just emitted this" from "something external set this".
 */
function VariableChipField({
  value,
  onChange,
  placeholder,
  multiline = false,
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const lastEmittedRef = useRef<string>(value);
  const picker = useContext(VariablePickerContext);

  // Initial render. `useLayoutEffect` so the DOM is populated before the
  // first paint -- otherwise the user sees an empty box flash before
  // chips appear.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    renderSegmentsTo(root, value, multiline);
    lastEmittedRef.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value change: rebuild. Skip when this is the echo from our
  // own onChange (lastEmittedRef matches), or the DOM would reset the
  // caret on every keystroke.
  useLayoutEffect(() => {
    if (value === lastEmittedRef.current) return;
    const root = ref.current;
    if (!root) return;
    renderSegmentsTo(root, value, multiline);
    lastEmittedRef.current = value;
  }, [value, multiline]);

  const emit = useCallback((): void => {
    const root = ref.current;
    if (!root) return;
    const raw = extractValue(root);
    lastEmittedRef.current = raw;
    onChange(raw);
  }, [onChange]);

  const handleInput = useCallback((): void => {
    emit();
  }, [emit]);

  const handleFocus = useCallback((): void => {
    const root = ref.current;
    if (!root) return;
    picker.open({
      anchorEl: root,
      insert: (template) => {
        insertChipAtSelection(root, template);
        emit();
      },
    });
  }, [picker, emit]);

  const handleBlur = useCallback((): void => {
    picker.scheduleClose();
  }, [picker]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      // Single-line variant blocks Enter so the field stays one line tall.
      // Tab behaves natively (focus moves), Esc bubbles so popovers close.
      if (!multiline && e.key === "Enter") {
        e.preventDefault();
        return;
      }
    },
    [multiline],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>): void => {
    const types = Array.from(e.dataTransfer.types ?? []);
    if (!types.includes("text/x-wf-variable") && !types.includes("text/plain")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      const template =
        e.dataTransfer.getData("text/x-wf-variable") || e.dataTransfer.getData("text/plain");
      if (!template) return;
      e.preventDefault();
      const root = ref.current;
      if (!root) return;
      // Position the caret where the user dropped before inserting the
      // chip so it lands precisely under the cursor -- otherwise the
      // chip would always append at the field's current selection or end.
      const range = caretRangeFromPoint(e.clientX, e.clientY);
      if (range && root.contains(range.commonAncestorContainer)) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } else {
        root.focus();
      }
      insertChipAtSelection(root, template);
      emit();
    },
    [emit],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>): void => {
      // Force plain-text paste so users can't paste rich HTML that
      // bypasses the chip parsing. `execCommand` is deprecated but still
      // works in all relevant browsers; the modern alternative is to
      // shape a range and insertNode, which is more code for the same effect.
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      // Parse the pasted text for embedded templates so a paste of
      // "{{step.x}} done" produces chip + text, not raw braces.
      const root = ref.current;
      if (!root) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
        // No valid selection -- append at the end.
        for (const seg of parseSegments(text)) {
          if (seg.kind === "var") root.appendChild(createChipElement(seg.template));
          else if (seg.text) root.appendChild(document.createTextNode(seg.text));
        }
      } else {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const fragments: globalThis.Node[] = [];
        for (const seg of parseSegments(text)) {
          if (seg.kind === "var") fragments.push(createChipElement(seg.template));
          else if (seg.text) fragments.push(document.createTextNode(seg.text));
        }
        for (const f of fragments) range.insertNode(f);
        // Move caret after the last inserted fragment.
        const last = fragments[fragments.length - 1];
        if (last) placeCursorAfter(last);
      }
      emit();
    },
    [emit],
  );

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={multiline}
      data-placeholder={placeholder ?? ""}
      className={`wf-chip-field ${multiline ? "wf-chip-field--multiline" : "wf-chip-field--singleline"} ${className}`.trim()}
      onInput={handleInput}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPaste={handlePaste}
    />
  );
}

/* =========================================================== canvas context menu */

interface CanvasMenuItem {
  key: string;
  label: string;
  icon: typeof Plus;
  /** Small chip rendered on the right of the row. Used for keyboard
   *  shortcut hints AND for "Soon" / "WIP" badges. */
  shortcut?: string;
  /** When true, the entry renders dimmed and won't fire on click / Enter.
   *  Used to surface in-progress features (e.g. "Add error handling")
   *  before the wiring lands. */
  disabled?: boolean;
  /** Visual emphasis for destructive entries (Delete). */
  destructive?: boolean;
  onSelect: () => void;
}

/**
 * Small floating menu opened by right-clicking the empty canvas. Painted
 * at the cursor's screen coordinates via a portal so it escapes the
 * canvas's overflow + transform stack. Keyboard navigable (↑/↓ to move,
 * Enter to invoke, Esc to dismiss).
 */
function CanvasContextMenu({
  anchor,
  items,
  onClose,
}: {
  anchor: { x: number; y: number };
  items: CanvasMenuItem[];
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });
  const [activeIdx, setActiveIdx] = useState<number>(0);

  // Re-clamp when the menu first measures itself (after mount).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x;
    let top = anchor.y;
    if (left + el.offsetWidth + 8 > vw) left = Math.max(8, vw - el.offsetWidth - 8);
    if (top + el.offsetHeight + 8 > vh) top = Math.max(8, vh - el.offsetHeight - 8);
    setPos({ left, top });
  }, [anchor]);

  // Outside-click closes. Deferred a tick so the right-click that opened
  // us doesn't immediately close it.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as globalThis.Node)) return;
      onClose();
    };
    const timer = window.setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Keyboard nav. Arrow keys skip disabled entries so Enter always lands
  // on something that fires.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const step = (delta: 1 | -1): void => {
        if (items.length === 0) return;
        setActiveIdx((i) => {
          let next = i;
          for (let k = 0; k < items.length; k++) {
            next = (next + delta + items.length) % items.length;
            if (!items[next]?.disabled) return next;
          }
          return i;
        });
      };
      if (e.key === "ArrowDown") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[activeIdx];
        if (item && !item.disabled) item.onSelect();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, activeIdx, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="wf-canvas-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
    >
      <ul className="wf-canvas-menu__list">
        {items.map((item, i) => {
          const classes = [
            "wf-canvas-menu__item",
            i === activeIdx ? "wf-canvas-menu__item--active" : "",
            item.disabled ? "wf-canvas-menu__item--disabled" : "",
            item.destructive ? "wf-canvas-menu__item--destructive" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li key={item.key}>
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={classes}
                onClick={item.disabled ? undefined : item.onSelect}
                onMouseEnter={() => {
                  if (!item.disabled) setActiveIdx(i);
                }}
              >
                <Icon icon={item.icon} size={14} />
                <span className="wf-canvas-menu__label">{item.label}</span>
                {item.shortcut ? (
                  <span className="wf-canvas-menu__shortcut">{item.shortcut}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}

/**
 * Position the popover near the cursor, then nudge it back inside the
 * viewport on the right / bottom edges. We use the panel's measured height
 * when available so a tall settings form doesn't clip; before the first
 * measurement we estimate from `min(70vh, 600px)`.
 */
function clampToViewport(
  anchor: { x: number; y: number },
  el: HTMLElement | undefined,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const measuredH = el?.offsetHeight ?? Math.min(vh * 0.7, 600);
  const measuredW = el?.offsetWidth ?? POPOVER_WIDTH;
  // Default: a touch below-right of the cursor so the popover doesn't
  // overlap the clicked node card.
  let left = anchor.x + 16;
  let top = anchor.y + 8;
  if (left + measuredW + POPOVER_MARGIN > vw) {
    left = Math.max(POPOVER_MARGIN, anchor.x - measuredW - 16);
  }
  if (top + measuredH + POPOVER_MARGIN > vh) {
    top = Math.max(POPOVER_MARGIN, vh - measuredH - POPOVER_MARGIN);
  }
  return { left, top };
}

/* =========================================================== piece library popover */

const LIBRARY_WIDTH = 360;
const LIBRARY_MAX_ROWS = 14;

/**
 * One pickable entry in the library popover. Discriminated so the
 * picker's `onPick` callback can route the three kinds to the right
 * editor action:
 *
 *   piece-action       Installed piece + specific action. Adds a configured
 *                      PIECE step to the canvas.
 *   piece-uninstalled  Piece visible in the user's curated catalog but not
 *                      yet pulled from npm. Picking it triggers install;
 *                      after install the action list expands on re-open.
 *   control-flow       Engine-native LOOP_ON_ITEMS / IF / ROUTER block.
 */
type LibraryEntry =
  | {
      kind: "piece-action";
      piece: PieceCatalogEntry;
      action: PieceCatalogActionOrTrigger;
    }
  | {
      kind: "piece-uninstalled";
      catalogEntry: InstallableLibraryEntry;
    }
  | {
      kind: "control-flow";
      controlType: "LOOP_ON_ITEMS" | "IF" | "ROUTER";
      displayName: string;
      description: string;
    };

type LibraryCategory = "all" | "installed" | "control";

const CATEGORY_LABEL: Record<LibraryCategory, string> = {
  all: "All",
  installed: "Installed",
  control: "Control flow",
};
const CATEGORY_ORDER: LibraryCategory[] = ["all", "installed", "control"];

/**
 * Engine-built-in control-flow entries surfaced alongside piece actions.
 * These aren't real pieces -- the runtime treats them as native
 * `FlowActionType`s -- but for the user's mental model they're just
 * "another block you add". Defaults applied at spawn time live in
 * `useWorkflowEditor.createOrphanControlFlowStep`.
 */
const CONTROL_FLOW_ENTRIES: LibraryEntry[] = [
  {
    kind: "control-flow",
    controlType: "IF",
    displayName: "If",
    description: "Two-way split on a condition. Locked branches: True (the condition matched) and False (it didn't).",
  },
  {
    kind: "control-flow",
    controlType: "ROUTER",
    displayName: "Router",
    description: "Branch the flow into N renameable paths. Use when you need more than a binary True/False split.",
  },
  {
    kind: "control-flow",
    controlType: "LOOP_ON_ITEMS",
    displayName: "Loop on items",
    description: "Run a body once per item in an array. Reference `{{<name>.item}}` inside the body to read the current iteration.",
  },
];

/**
 * Membership predicate for the category tabs:
 *   - "all"        every kind passes (the popover applies the tab filter)
 *   - "installed"  installed pieces + control-flow (always available)
 *   - "control"    control-flow only
 *
 * Note: `entryCategory` returns a SET-style classification because some
 * kinds belong to multiple tabs (control-flow is in both "installed" and
 * "control"). The caller filters by `inCategory(entry, category)`.
 */
function inCategory(e: LibraryEntry, category: LibraryCategory): boolean {
  if (category === "all") return true;
  if (category === "installed") {
    return e.kind === "piece-action" || e.kind === "control-flow";
  }
  // "control"
  return e.kind === "control-flow";
}

function entryKey(e: LibraryEntry): string {
  if (e.kind === "control-flow") return `control:${e.controlType}`;
  if (e.kind === "piece-uninstalled") return `uninstalled:${e.catalogEntry.id}`;
  return `piece:${e.piece.name}::${e.action.name}`;
}

function entryMatchesQuery(e: LibraryEntry, q: string): boolean {
  if (!q) return true;
  if (e.kind === "control-flow") {
    return (
      e.displayName.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.controlType.toLowerCase().includes(q)
    );
  }
  if (e.kind === "piece-uninstalled") {
    const c = e.catalogEntry;
    return (
      c.displayName.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q) ||
      c.npmPackage.toLowerCase().includes(q)
    );
  }
  return (
    e.piece.displayName.toLowerCase().includes(q) ||
    e.action.displayName.toLowerCase().includes(q) ||
    (e.action.description ?? "").toLowerCase().includes(q)
  );
}

/**
 * Searchable, category-filterable list of things a user can add to the
 * canvas. Picking a row fires `onPick(entry)`; the caller routes piece
 * actions vs. control-flow entries to the appropriate editor mutation.
 *
 * Triggers are NOT in this list -- there's exactly one trigger per flow
 * and it's configured via the trigger node's settings popover, not by
 * adding a new node.
 */
function PieceLibraryPopover({
  anchor,
  catalog,
  library,
  installingId,
  onPick,
  onClose,
}: {
  anchor: { x: number; y: number };
  catalog: PieceCatalogEntry[];
  /**
   * Full curated catalog from `/api/workflows/pieces/library` (verified +
   * community pieces, with per-piece installed status). Drives the
   * "uninstalled but installable" rows that appear in the "All" tab so
   * users can discover pieces before installing them. Empty array is a
   * safe fallback when the library endpoint is still loading.
   */
  library: InstallableLibraryEntry[];
  /**
   * Id of the piece currently being installed via this popover, or null
   * when no install is in flight. The row matching this id renders as a
   * spinner + disabled state; all other picks are blocked while non-null
   * so a stray click can't fire a second pick mid-install.
   */
  installingId: string | null;
  onPick: (entry: LibraryEntry) => void;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<LibraryCategory>("all");
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });

  // Build the unified entry list. Three layers in display order:
  //   1. Control-flow built-ins (top -- always-available, always visible)
  //   2. Installed pieces' actions (one row per action)
  //   3. Uninstalled curated pieces (one row per piece, "Install" chip)
  //
  // Installed pieces are matched against the library catalog by piece name
  // (`@activepieces/piece-<id>` vs the engine's piece.name). Any installed
  // piece NOT in the library catalog still shows under (2) so locally
  // sideloaded pieces -- if that ever ships -- don't go missing.
  const entries = useMemo<LibraryEntry[]>(() => {
    const installedNames = new Set(catalog.map((p) => p.name));
    const pieceEntries: LibraryEntry[] = [];
    for (const p of catalog) {
      for (const a of p.actions) {
        pieceEntries.push({ kind: "piece-action", piece: p, action: a });
      }
    }
    const uninstalledEntries: LibraryEntry[] = [];
    for (const lib of library) {
      // Library ids are bare ("gmail"); the engine's piece.name is the
      // full npm spec ("@activepieces/piece-gmail"). Match on the latter.
      if (installedNames.has(lib.npmPackage)) continue;
      if (lib.installed) continue; // belt + suspenders -- the library hook also tracks this
      uninstalledEntries.push({ kind: "piece-uninstalled", catalogEntry: lib });
    }
    return [...CONTROL_FLOW_ENTRIES, ...pieceEntries, ...uninstalledEntries];
  }, [catalog, library]);

  // Apply the category filter and search query. Same lowercased q is
  // reused across every entry so we don't pay for the per-iteration call.
  const rows = useMemo<LibraryEntry[]>(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => inCategory(e, category) && entryMatchesQuery(e, q));
  }, [entries, category, query]);

  // Reset the keyboard cursor when the result set changes so Enter always
  // targets a visible row.
  useEffect(() => {
    setActiveIdx(0);
  }, [query, category]);

  // Auto-focus the search input on mount so the user can type immediately
  // without clicking the field. Defer one tick so React's commit phase
  // doesn't fight with our focus call.
  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  // Viewport clamp -- same shape as the settings popover's clamp.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x;
    let top = anchor.y;
    if (left + el.offsetWidth + 12 > vw) left = Math.max(12, vw - el.offsetWidth - 12);
    if (top + el.offsetHeight + 12 > vh) top = Math.max(12, vh - el.offsetHeight - 12);
    setPos({ left, top });
  }, [anchor, rows.length]);

  // Outside-click closes. Deferred so the right-click that summoned us
  // doesn't immediately bounce. While an install is in flight we keep the
  // popover open so the user can see the spinner; closing mid-install
  // would also break the install->reload->place handoff in the parent.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as globalThis.Node)) return;
      if (installingId) return;
      onClose();
    };
    const timer = window.setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose, installingId]);

  // Keyboard nav via the shared hook. Enter and Esc are no-ops while
  // an install is in flight -- same reasoning as the outside-click
  // guard above (closing mid-install would break the install->reload
  // ->place handoff). The hook itself doesn't know about install
  // state, so we guard inside the wrapped callbacks.
  const {
    activeIdx,
    setActiveIdx,
    onKeyDown,
  } = useListNav<LibraryEntry>({
    items: rows,
    onSelect: (row) => {
      if (!installingId) onPick(row);
    },
    onClose: () => {
      if (!installingId) onClose();
    },
  });

  return createPortal(
    <div
      ref={ref}
      className="wf-library"
      role="dialog"
      aria-label="Add piece"
      style={{ left: pos.left, top: pos.top, width: LIBRARY_WIDTH }}
      onKeyDown={onKeyDown}
    >
      <div className="wf-library__search">
        <input
          ref={inputRef}
          type="text"
          placeholder="Search pieces..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter pieces by name or description"
        />
      </div>
      <div className="wf-library__categories" role="tablist" aria-label="Category">
        {CATEGORY_ORDER.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={c === category}
            className={`wf-library__category ${c === category ? "wf-library__category--active" : ""}`}
            onClick={() => setCategory(c)}
          >
            {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>
      {/* If the catalog is empty (route returned []), surface a banner so
          the user understands the cause rather than just seeing the two
          built-in control-flow entries. Almost always means engine
          bootstrap failed in the daemon -- the route falls back to []
          when `pieceRegistry` isn't wired. */}
      {catalog.length === 0 ? (
        <div className="wf-library__notice" role="status">
          <strong>No pieces loaded.</strong>{" "}
          The workflow engine may have failed to start. Check the daemon logs
          and rerun <code>bun run scripts/build-engine.ts</code> if the
          engine bundle is missing.
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="wf-library__empty">
          {query.trim()
            ? `No ${category === "all" ? "entries" : CATEGORY_LABEL[category].toLowerCase()} match "${query}".`
            : `No ${CATEGORY_LABEL[category].toLowerCase()} available.`}
        </div>
      ) : (
        <ul
          className="wf-library__list"
          style={{ maxHeight: `calc(${LIBRARY_MAX_ROWS} * 44px)` }}
          role="listbox"
        >
          {rows.map((entry, i) => {
            const isInstallingThis =
              entry.kind === "piece-uninstalled" &&
              installingId !== null &&
              entry.catalogEntry.id === installingId;
            // Once ANY install starts, lock the entire list so a stray
            // click can't fire a second pick before the first resolves.
            // The installing row keeps its visual treatment (spinner +
            // active highlight); others fade to indicate they're paused.
            const lockedByInstall = installingId !== null && !isInstallingThis;
            return (
              <li key={entryKey(entry)}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === activeIdx}
                  aria-disabled={lockedByInstall || isInstallingThis}
                  disabled={lockedByInstall || isInstallingThis}
                  className={`wf-library__row ${i === activeIdx ? "wf-library__row--active" : ""} ${
                    isInstallingThis ? "wf-library__row--installing" : ""
                  } ${lockedByInstall ? "wf-library__row--locked" : ""}`}
                  onClick={() => onPick(entry)}
                  onMouseEnter={() => {
                    if (!lockedByInstall) setActiveIdx(i);
                  }}
                >
                  <LibraryRowContent entry={entry} installing={isInstallingThis} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>,
    document.body,
  );
}

/**
 * Row body for a single library entry. Splits the two shapes (piece
 * action vs. control-flow built-in) so each can render with the right
 * label hierarchy: piece actions read "<piece> · <action>" with the
 * piece name de-emphasised, control-flow entries read with a tag chip on
 * the left signalling they're a different KIND of block.
 */
function LibraryRowContent({
  entry,
  installing,
}: {
  entry: LibraryEntry;
  /** True for the uninstalled-piece row currently being installed. Swaps
   *  the "Install" chip for a spinner + "Installing..." subtext so the
   *  user sees the round-trip in progress. */
  installing: boolean;
}): React.ReactElement {
  if (entry.kind === "control-flow") {
    return (
      <>
        <div className="wf-library__row-head">
          <span className="wf-library__tag">Control</span>
          <span className="wf-library__action">{entry.displayName}</span>
        </div>
        <div className="wf-library__row-desc">{entry.description}</div>
      </>
    );
  }
  if (entry.kind === "piece-uninstalled") {
    // Single row per piece (we don't know the action list yet -- that
    // info comes from the engine after install). The "Install" tag on
    // the left signals that picking this row will trigger a download
    // rather than immediately drop a node on the canvas. While the
    // install is actively running, the tag becomes a spinner + the
    // description is replaced with a status line.
    const c = entry.catalogEntry;
    return (
      <>
        <div className="wf-library__row-head">
          {installing ? (
            <span className="wf-library__tag wf-library__tag--installing" aria-label="Installing">
              <span className="wf-library__spinner" aria-hidden="true" />
            </span>
          ) : (
            <span className="wf-library__tag wf-library__tag--install">Install</span>
          )}
          <span className="wf-library__action">{c.displayName}</span>
          {c.tier === "community" ? (
            <span className="wf-library__tier">community</span>
          ) : null}
        </div>
        <div className="wf-library__row-desc">
          {installing
            ? `Installing ${c.npmPackage}...`
            : (c.description || c.npmPackage)}
        </div>
      </>
    );
  }
  return (
    <>
      <div className="wf-library__row-head">
        <span className="wf-library__piece">{entry.piece.displayName}</span>
        <span className="wf-library__sep">·</span>
        <span className="wf-library__action">{entry.action.displayName}</span>
      </div>
      {entry.action.description ? (
        <div className="wf-library__row-desc">{entry.action.description}</div>
      ) : null}
    </>
  );
}

/* ============================================================ react-flow */

const NODE_TYPES = { stepNode: StepNode };

/**
 * Tree-aware auto-layout. The previous "x = flatten-index * step, y =
 * depth * branch" formula collapsed every router branch onto the same
 * `y` (depth+1), which stacked multiple outputs in a single horizontal
 * line. This walks the trigger tree and distributes branches
 * SYMMETRICALLY around the parent's row using the subtree heights, so
 * a 2-branch router lands with one above and one below, a 3-branch
 * router with one above / one at center / one below, etc.
 *
 * Rows are integer grid units. We measure each subtree's height once
 * (memoised), then a second pass assigns coordinates. Final negative
 * rows are shifted so the topmost row lands at NODE_Y_BASE -- nothing
 * paints outside the viewport on first fit.
 *
 * LOOP body sits below its chain (row + chainHeight) rather than
 * symmetrically: a loop's two outputs are not peers (the "after-loop"
 * IS the chain continuation, the body is the lateral branch), and
 * keeping the chain horizontal preserves the "main path" reading.
 */
function computeAutoLayout(root: FlowStepNode | null): Record<string, { x: number; y: number }> {
  if (!root) return {};
  const heightCache = new Map<string, number>();
  // `height(node)` returns how many rows the subtree starting at `node`
  // occupies. The node itself contributes 1; routers add the sum of
  // branch heights; loops add the body's height below the chain. The
  // chain continuation (`nextAction`) shares this node's row, so the
  // chain's own extent is max'd with the node-local extent.
  const height = (node: FlowStepNode | undefined | null): number => {
    if (!node) return 0;
    const cached = heightCache.get(node.name);
    if (cached !== undefined) return cached;
    let own = 1;
    if (node.type === "ROUTER" && Array.isArray(node.children)) {
      const branches = node.children.filter((c): c is FlowStepNode => !!c);
      if (branches.length > 0) {
        const total = branches.reduce((acc, b) => acc + height(b), 0);
        own = Math.max(own, total);
      }
    }
    if (node.type === "LOOP_ON_ITEMS" && node.firstLoopAction) {
      own += height(node.firstLoopAction);
    }
    const chainH = node.nextAction ? height(node.nextAction) : 0;
    const result = Math.max(own, chainH);
    heightCache.set(node.name, result);
    return result;
  };

  // Horizontal extent (in columns) of a subtree. Used to place a ROUTER's
  // after-step (router.nextAction) clear of its branch chains: branches and
  // the after-router chain sit in SERIES for a router (branches first, then
  // the merge step to their right), so their spans add; for other nodes the
  // lateral output (loop body) and the nextAction chain run in parallel rows,
  // so we take the max.
  const spanCache = new Map<string, number>();
  const span = (node: FlowStepNode | undefined | null): number => {
    if (!node) return 0;
    const cached = spanCache.get(node.name);
    if (cached !== undefined) return cached;
    let result: number;
    if (node.type === "ROUTER" && Array.isArray(node.children)) {
      let maxBranch = 0;
      for (const c of node.children) if (c) maxBranch = Math.max(maxBranch, span(c));
      const after = node.nextAction ? span(node.nextAction) : 0;
      result = 1 + maxBranch + after;
    } else {
      const lateral =
        node.type === "LOOP_ON_ITEMS" && node.firstLoopAction ? span(node.firstLoopAction) : 0;
      const next = node.nextAction ? span(node.nextAction) : 0;
      result = 1 + Math.max(lateral, next);
    }
    spanCache.set(node.name, result);
    return result;
  };

  const gridPositions: Record<string, { col: number; row: number }> = {};
  const layout = (node: FlowStepNode | undefined | null, col: number, row: number): void => {
    if (!node || gridPositions[node.name]) return;
    gridPositions[node.name] = { col, row };

    // Column the chain continuation (nextAction) lands in. Normally the next
    // column; for a router it must clear the branch chains (which occupy
    // col+1 onward) so the merge step doesn't overlap a branch on the
    // router's own row.
    let nextActionCol = col + 1;
    if (node.type === "ROUTER" && Array.isArray(node.children)) {
      const branches = node.children.filter((c): c is FlowStepNode => !!c);
      if (branches.length > 0) {
        const branchHeights = branches.map(height);
        const totalH = branchHeights.reduce((a, b) => a + b, 0);
        // Walk a row cursor starting at `row - (totalH - 1) / 2` so the
        // branches are centred on the router's row. Each branch's
        // CENTRE row = cursor + (h - 1) / 2; advance cursor by `h` for
        // the next branch.
        let cursor = row - (totalH - 1) / 2;
        let maxBranchSpan = 0;
        for (let i = 0; i < branches.length; i++) {
          const h = branchHeights[i] || 1;
          const centre = cursor + (h - 1) / 2;
          layout(branches[i], col + 1, centre);
          maxBranchSpan = Math.max(maxBranchSpan, span(branches[i]));
          cursor += h;
        }
        nextActionCol = col + 1 + maxBranchSpan;
      }
    }
    if (node.type === "LOOP_ON_ITEMS" && node.firstLoopAction) {
      // Body sits below the chain (chain occupies rows row..row+chainH-1).
      const chainH = node.nextAction ? height(node.nextAction) : 1;
      layout(node.firstLoopAction, col + 1, row + chainH);
    }
    if (node.nextAction) {
      layout(node.nextAction, nextActionCol, row);
    }
  };

  layout(root, 0, 0);

  // Some branches end up at negative rows (above the trigger). Shift the
  // whole layout so the topmost row maps to NODE_Y_BASE.
  let minRow = 0;
  for (const p of Object.values(gridPositions)) {
    if (p.row < minRow) minRow = p.row;
  }
  const out: Record<string, { x: number; y: number }> = {};
  for (const [name, { col, row }] of Object.entries(gridPositions)) {
    out[name] = {
      x: col * NODE_X_STEP,
      y: NODE_Y_BASE + (row - minRow) * NODE_Y_BRANCH,
    };
  }
  return out;
}

function buildGraph(
  trigger: FlowStepNode | null,
  steps: FlatStep[],
  orphans: OrphanStep[],
  selected: string | null,
  catalog: PieceCatalogEntry[],
  stepPositions: Record<string, { x: number; y: number }>,
  /**
   * Per-step snapshot from a selected run. Empty when no run is being
   * overlaid; populated drives per-node status pips + border tinting.
   */
  overlay: Record<string, CanvasStepSnapshot>,
): { nodes: Node<StepNodeData>[]; edges: Edge[] } {
  const autoPositions = computeAutoLayout(trigger);
  const buildNodeData = (
    step: FlowStepNode,
    depth: number,
    branchName: string | undefined,
    isOrphan: boolean,
    targetIsFree: boolean,
  ): StepNodeData => {
    const branchConnected: Record<string, boolean> = {};
    if (step.type === "ROUTER" && Array.isArray(step.children)) {
      const branches = step.settings?.branches ?? [];
      for (let i = 0; i < step.children.length; i++) {
        const bName = branches[i]?.branchName ?? `branch_${i}`;
        branchConnected[bName] = !!step.children[i];
      }
    }
    return {
      step,
      selected: selected === step.name,
      catalog,
      depth,
      branchName,
      isOrphan,
      targetIsFree,
      outConnected: !!step.nextAction,
      loopBodyConnected: step.type === "LOOP_ON_ITEMS" && !!step.firstLoopAction,
      branchConnected,
      runStatus: overlay[step.name]?.status ?? null,
      runError: overlay[step.name]?.errorMessage ?? null,
      runDuration: overlay[step.name]?.duration ?? null,
    };
  };

  const nodes: Node<StepNodeData>[] = steps.map((entry) => {
    const step = entry.step;
    const isTrigger = step.type === "PIECE_TRIGGER" || step.type === "EMPTY";
    // Prefer the user's persisted x/y when one exists; fall back to the
    // tree-aware auto-layout (see `computeAutoLayout`) so newly added
    // steps slot in next to their predecessor and multi-output nodes
    // distribute their branches above/below rather than stacking.
    const saved = stepPositions[step.name];
    const auto = autoPositions[step.name];
    const position = saved ?? auto ?? { x: 0, y: NODE_Y_BASE };
    return {
      id: step.name,
      type: "stepNode",
      position,
      // Tell xyflow the natural side for each default handle so smoothstep
      // edges route horizontally even before we render explicit <Handle/>
      // components (Task 2).
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      // Tree steps always have a parent (the trigger or a predecessor)
      // so targetIsFree=false -- new drops are rejected.
      data: buildNodeData(step, entry.depth, entry.branchName, false, false),
      // Trigger is always pinned. Every other node is draggable; the chain
      // it belongs to is inferred at drop time from its FlatStep entry.
      draggable: !isTrigger,
    };
  });

  // Orphan subgraphs: walk each orphan's whole subtree and emit a node
  // for EVERY step it contains, not just the head. Previously we pushed
  // only the head, which silently hid any successors that travelled
  // along with the disconnected subtree (A-B-C-D-E → disconnect B->C →
  // only C was drawn, D and E lived in C.nextAction but were invisible).
  // Internal orphan edges are emitted in the edge loop below alongside
  // tree edges via the unified `allFlatEntries` list.
  for (const o of orphans) {
    const subFlat = flattenSteps(o.node);
    const subAuto = computeAutoLayout(o.node);
    // computeAutoLayout sets the root at NODE_Y_BASE. We want the head
    // to land at the orphan entry's stored (x, y), so translate the
    // whole subtree by (orphan.x - subAuto[head].x, orphan.y - subAuto[head].y).
    const headAuto = subAuto[o.node.name] ?? { x: 0, y: NODE_Y_BASE };
    for (const entry of subFlat) {
      const step = entry.step;
      const isHead = step.name === o.node.name;
      const auto = subAuto[step.name] ?? { x: 0, y: NODE_Y_BASE };
      const saved = stepPositions[step.name];
      const position = saved ?? {
        x: o.x + (auto.x - headAuto.x),
        y: o.y + (auto.y - headAuto.y),
      };
      nodes.push({
        id: step.name,
        type: "stepNode",
        position,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        // Only the head has no parent -- internal orphan steps are wired
        // to the preceding orphan step and should reject new drops on
        // their target handle. Both render with the orphan styling.
        data: buildNodeData(step, entry.depth, entry.branchName, true, isHead),
        draggable: true,
      });
    }
  }

  // Unified entry list for edge emission: tree + every orphan's subtree.
  // We need orphan internal edges (C->D, D->E inside a detached C-D-E
  // chain) to render too -- otherwise the user sees disconnected dots
  // and can't tell the subgraph is still connected internally.
  const orphanFlats: FlatStep[] = orphans.flatMap((o) => flattenSteps(o.node));
  const allFlatEntries: FlatStep[] = [...steps, ...orphanFlats];

  // Edges: each step's structural pointers become an edge. sourceHandle ids
  // mirror the Handle components rendered in StepNode (`out` / `loop-body` /
  // `branch:<name>`) so xyflow attaches the edge to the right circle when a
  // node has multiple source handles (ROUTER especially).
  const edges: Edge[] = [];
  const knownNames = new Set(allFlatEntries.map((s) => s.step.name));
  for (const entry of allFlatEntries) {
    const step = entry.step;
    // Every step's `nextAction` is the chain continuation -- including a
    // ROUTER's (the engine runs router.nextAction after the matched branch,
    // see flow-executor). Routers render a dedicated "out" handle (below the
    // branch handles) so this edge attaches cleanly and "after the router"
    // steps are visible + editable rather than silently undrawn.
    if (step.nextAction && knownNames.has(step.nextAction.name)) {
      edges.push({
        id: `${step.name}->${step.nextAction.name}`,
        source: step.name,
        target: step.nextAction.name,
        sourceHandle: "out",
        targetHandle: "in",
        type: "smoothstep",
        className: "wf-edge",
      });
    }
    if (step.type === "LOOP_ON_ITEMS" && step.firstLoopAction && knownNames.has(step.firstLoopAction.name)) {
      edges.push({
        id: `${step.name}->loop->${step.firstLoopAction.name}`,
        source: step.name,
        target: step.firstLoopAction.name,
        sourceHandle: "loop-body",
        targetHandle: "in",
        type: "smoothstep",
        label: "iterates",
        className: "wf-edge wf-edge--branch",
      });
    }
    if (step.type === "ROUTER" && Array.isArray(step.children)) {
      const branches = step.settings?.branches ?? [];
      for (let i = 0; i < step.children.length; i++) {
        const child = step.children[i];
        if (!child || !knownNames.has(child.name)) continue;
        const bName = branches[i]?.branchName ?? `branch_${i}`;
        edges.push({
          id: `${step.name}->router_${i}->${child.name}`,
          source: step.name,
          target: child.name,
          sourceHandle: `branch:${bName}`,
          targetHandle: "in",
          type: "smoothstep",
          label: bName,
          className: "wf-edge wf-edge--branch",
        });
      }
    }
  }
  return { nodes, edges };
}

function StepNode({ data }: NodeProps): React.ReactElement {
  const {
    step,
    selected,
    catalog,
    depth,
    branchName,
    isOrphan,
    targetIsFree,
    outConnected,
    loopBodyConnected,
    branchConnected,
    runStatus,
    runError,
    runDuration,
  } = data as StepNodeData;
  const isTrigger = step.type === "PIECE_TRIGGER" || step.type === "EMPTY";
  const isLoop = step.type === "LOOP_ON_ITEMS";
  const isRouter = step.type === "ROUTER";
  const piece = catalog.find((p) => p.name === step.settings?.pieceName);
  const subAction = isTrigger ? step.settings?.triggerName : step.settings?.actionName;
  const subDisplayName = piece
    ? (isTrigger
        ? piece.triggers.find((t) => t.name === subAction)?.displayName
        : piece.actions.find((a) => a.name === subAction)?.displayName) ?? subAction
    : subAction;
  const isUnconfigured = step.type === "PIECE" && (!step.settings?.pieceName || !step.settings.actionName);

  const routerKind = step.settings?.routerKind;
  let kindLabel: string;
  let kindTone: "accent" | "neutral" | "warn" | "ok" = "neutral";
  if (step.type === "EMPTY") { kindLabel = "Manual"; kindTone = "accent"; }
  else if (isTrigger) { kindLabel = "Trigger"; kindTone = "accent"; }
  else if (isLoop) { kindLabel = "Loop"; kindTone = "warn"; }
  else if (isRouter) {
    // IF reads as a distinct affordance even though it's a ROUTER under
    // the hood -- the user-visible naming reflects the locked True/False
    // structure rather than the underlying engine type.
    kindLabel = routerKind === "if" ? "If" : "Router";
    kindTone = "warn";
  }
  else { kindLabel = "Action"; }

  // ROUTER branches feed the right-edge source handles. The handle id
  // encodes the branch name so onConnect can route a connection straight
  // into the correct `children[i]` slot.
  const branches = isRouter ? step.settings?.branches ?? [] : [];

  // Compose the right-edge output list. LOOP shows two stacked handles:
  // loop-body (iterates) and out (after-loop continuation). ROUTER shows
  // one handle per branch; no separate continuation -- after-router
  // composition lives inside each branch's chain. PIECE/CODE shows the
  // standard single "out" continuation. The trigger node behaves as a
  // PIECE for output purposes (one "out" to start the chain).
  type RightHandle = {
    id: string;
    title: string;
    used: boolean;
  };
  const rightHandles: RightHandle[] = (() => {
    if (isLoop) {
      // Order matches the auto-layout: "after-loop" is the chain
      // continuation and stays on the main horizontal line, so its
      // handle reads as the TOP (the straight-right edge). The body
      // drops to the row below, so its handle reads as the BOTTOM
      // (the down-right edge). Inverting these makes the upper handle
      // point at a destination drawn beneath the node, which doesn't
      // match the eye's path.
      return [
        { id: "out", title: "After loop", used: outConnected },
        { id: "loop-body", title: "Iterates", used: loopBodyConnected },
      ];
    }
    if (isRouter) {
      const branchHandles = branches.map((b, i) => {
        const name = b?.branchName ?? `branch_${i}`;
        // Tooltip: prefer the branch name; for an unnamed CONDITION
        // branch fall back to a short rendering of its first
        // condition formula so the user can identify the branch even
        // when they haven't labelled it.
        let title = name;
        if (!b?.branchName && b?.branchType === "CONDITION") {
          const first = b.conditions?.[0]?.[0];
          if (first?.firstValue) {
            const op = first.operator ?? "?";
            const second = first.secondValue ?? "";
            title = `${first.firstValue} ${op}${second ? ` ${second}` : ""}`;
          }
        }
        return {
          id: `branch:${name}`,
          title,
          used: !!branchConnected[name],
        };
      });
      // Plus an "out" handle for the step that runs AFTER the router (the
      // merge/continuation). The engine executes router.nextAction once the
      // matched branch finishes; without this handle that step couldn't be
      // wired or seen on the canvas.
      return [...branchHandles, { id: "out", title: "After router", used: outConnected }];
    }
    return [{ id: "out", title: "Next step", used: outConnected }];
  })();

  // Pip + tooltip when a run is overlaid on the canvas. The "not-reached"
  // status doesn't render a pip -- we just fade the node via the CSS
  // modifier so the user's eye flows to the steps that DID execute.
  const runPipTitle = (() => {
    if (!runStatus || runStatus === "not-reached") return null;
    const parts: string[] = [runStatus.toUpperCase()];
    if (runDuration !== null) parts.push(formatDuration(runDuration));
    if (runError) parts.push(`-- ${runError.slice(0, 200)}`);
    return parts.join(" ");
  })();

  return (
    <div
      className={`wf-node ${selected ? "wf-node--selected" : ""} ${isUnconfigured ? "wf-node--unconfigured" : ""} ${depth > 0 ? "wf-node--nested" : ""} ${isOrphan ? "wf-node--orphan" : ""} ${runStatus ? `wf-node--run-${runStatus}` : ""}`}
    >
      {/* Target ("in"): left edge, every non-trigger node accepts an incoming
          connection from a preceding step's source handle. Orphans accept
          drops; nodes already in the tree have a parent and refuse. */}
      {!isTrigger ? (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          className="wf-handle wf-handle--target"
          isConnectableEnd={targetIsFree}
          isConnectableStart={false}
        />
      ) : null}
      {/* Right-edge source handles. For multiple handles we spread them
          vertically using percentage `top` so they stay anchored even
          when the node card grows / shrinks. The `title` attribute drives
          the native tooltip showing each branch's name (or its condition
          formula when unnamed). */}
      {rightHandles.map((h, i) => {
        const pct = ((i + 1) * 100) / (rightHandles.length + 1);
        return (
          <Handle
            key={h.id}
            type="source"
            position={Position.Right}
            id={h.id}
            className={`wf-handle wf-handle--source ${h.used ? "wf-handle--used" : ""}`}
            style={{ top: `${pct}%` }}
            isConnectableStart={!h.used}
            isConnectableEnd={false}
            title={h.title}
          />
        );
      })}

      {branchName ? <div className="wf-node__branch-label">branch: {branchName}</div> : null}
      <div className="wf-node__head">
        <Chip tone={kindTone} dot={false}>{kindLabel}</Chip>
        <span className="wf-node__name">{step.displayName ?? step.name}</span>
        {runPipTitle ? (
          <span
            className={`wf-node__run-pip wf-node__run-pip--${runStatus}`}
            title={runPipTitle}
            aria-label={runPipTitle}
          />
        ) : null}
      </div>
      <div className="wf-node__body">
        {isLoop ? (
          <span className="wf-node__piece">over <code>{String(step.settings?.items ?? "?")}</code></span>
        ) : isRouter ? (
          <span className="wf-node__piece">
            {(step.settings?.branches?.length ?? 0)} branch{(step.settings?.branches?.length ?? 0) === 1 ? "" : "es"} ·{" "}
            {step.settings?.executionType === "EXECUTE_ALL_MATCH" ? "all match" : "first match"}
          </span>
        ) : step.settings?.pieceName ? (
          <>
            <span className="wf-node__piece">{piece?.displayName ?? step.settings.pieceName}</span>
            {subDisplayName ? <span className="wf-node__sep">·</span> : null}
            {subDisplayName ? <span className="wf-node__action">{subDisplayName}</span> : null}
          </>
        ) : step.type === "EMPTY" ? (
          <span className="wf-node__piece">Run on demand</span>
        ) : (
          <span className="wf-node__piece wf-node__piece--missing">Unconfigured</span>
        )}
      </div>
    </div>
  );
}

/* =========================================================== properties */

interface PropertiesPanelProps {
  step: FlowStepNode;
  isTriggerStep: boolean;
  hasNextAction: boolean;
  isTopLevel: boolean;
  containerKind?: "loop" | "router";
  catalog: PieceCatalogEntry[];
  /** Connections list -- drives the connection picker for pieces that declare auth. */
  connections: ConnectionMeta[];
  /**
   * Persisted sample data for this step (the output the engine will feed to
   * downstream steps when running with `stepNameToTest`). Undefined when
   * never set.
   */
  sampleData: unknown | undefined;
  /**
   * Persisted sample INPUT override for this step. Replaces
   * `settings.input` during test-from-here runs only. Undefined when
   * never set.
   */
  sampleInput: unknown | undefined;
  /** True when the loaded version is LOCKED -- disables sample-data editing + test. */
  isLocked: boolean;
  onSetTriggerKind: (kind: "manual" | "schedule" | "webhook" | "event") => void;
  onSetErrorHandling: (patch: { continueOnFailure?: boolean; retryOnFailure?: boolean }) => void;
  onSetInput: (key: string, value: unknown) => void;
  onAddInputKey: (key: string) => void;
  onRemoveInputKey: (key: string) => void;
  /** Commit a new display name for this step. Called by EditableStepName in the panel header. */
  onSetDisplayName: (displayName: string) => void;
  onAddStepAfter: () => void;
  onDelete: () => void;
  onSetLoopItems: (items: string) => void;
  onAddStepToLoopBody: () => void;
  onSetRouterExecutionType: (type: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH") => void;
  onAddRouterBranch: (branchName: string) => void;
  onRemoveRouterBranch: (branchIndex: number) => void;
  onAddStepToBranch: (branchName: string) => void;
  onSetBranchConditions: (branchIndex: number, conditions: BranchConditions) => void;
  /** Save the JSON sample output for this step. Pass null to clear. */
  onSetSampleData: (output: unknown | null) => Promise<{ ok: boolean; message: string }>;
  /** Save the JSON sample input override for this step. Pass null to clear. */
  onSetSampleInput: (input: Record<string, unknown> | null) => Promise<{ ok: boolean; message: string }>;
  /** Trigger a test-from-here run for this step. */
  onTestFromHere: () => Promise<{ ok: boolean; message: string }>;
}

function PropertiesPanel(props: PropertiesPanelProps): React.ReactElement {
  const {
    step,
    isTriggerStep,
    hasNextAction,
    isTopLevel,
    catalog,
    connections,
    onSetTriggerKind,
    onSetErrorHandling,
    onSetInput,
    onAddInputKey,
    onRemoveInputKey,
    onSetDisplayName,
    onAddStepAfter,
    onDelete,
    onSetLoopItems,
    onAddStepToLoopBody,
    onSetRouterExecutionType,
    onAddRouterBranch,
    onRemoveRouterBranch,
    onAddStepToBranch,
    onSetBranchConditions,
  } = props;
  const isTrigger = step.type === "PIECE_TRIGGER" || step.type === "EMPTY";
  const isManual = step.type === "EMPTY";
  const isLoop = step.type === "LOOP_ON_ITEMS";
  const isRouter = step.type === "ROUTER";
  const piece = catalog.find((p) => p.name === step.settings?.pieceName);
  // Detect once per render; consumed by the 4-way picker (to pick the
  // active button) and by the "other" hint below it.
  const detectedTriggerKind = isTriggerStep ? detectTriggerKind(step) : "manual";
  // Look up the selected sub-action's metadata so the typed-input widgets
  // below have a schema to render against. We keep this lookup even
  // though the user can no longer pick a different sub-action from the
  // panel -- the identity-display row above + the input editor still
  // need it.
  const subName = isTrigger ? step.settings?.triggerName : step.settings?.actionName;
  const subList = isTrigger ? piece?.triggers ?? [] : piece?.actions ?? [];
  const selectedSubAction: PieceCatalogActionOrTrigger | undefined = subList.find((s) => s.name === subName);
  const schema = selectedSubAction?.inputSchema ?? null;

  const [newKey, setNewKey] = useState("");

  const inputEntries = useMemo(
    () => Object.entries(step.settings?.input ?? {}),
    [step.settings?.input],
  );

  return (
    <div className="wf-props">
      <header className="wf-props__header">
        <EditableStepName
          name={step.displayName ?? step.name}
          fallback={step.name}
          onCommit={onSetDisplayName}
        />
        <p>
          <code>{step.name}</code> · {isTrigger ? (isManual ? "Manual trigger" : "Piece trigger") : "Action"}
        </p>
      </header>

      {/* The display name is edited by clicking the title above
          (same UX as the workflow title in the editor header).
          The separate "Display name" Field that used to live here is
          gone -- one place to rename, where the user is already
          looking. */}

      {isTriggerStep ? (
        <Field label="Trigger">
          <div className="wf-props__segmented" role="radiogroup">
            {TRIGGER_KINDS.map((tk) => {
              // When the step is a non-canonical PIECE_TRIGGER (community
              // piece, imported flow, ...) detection returns "other" and
              // NO button is marked active. The user has to explicitly
              // click a kind to replace it, instead of the panel silently
              // implying Manual was the current state.
              const active = tk.kind === detectedTriggerKind;
              return (
                <button
                  key={tk.kind}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`wf-props__seg ${active ? "wf-props__seg--on" : ""}`}
                  onClick={() => onSetTriggerKind(tk.kind)}
                  title={tk.description}
                >
                  {tk.label}
                </button>
              );
            })}
          </div>
        </Field>
      ) : null}

      {isManual ? (
        <p className="wf-props__hint">
          Manual triggers fire only when you POST to <code>/api/workflows/:id/run</code>. Pick
          Schedule, Webhook, or Event above to fire automatically.
        </p>
      ) : null}

      {detectedTriggerKind === "other" ? (
        <p className="wf-props__hint">
          This trigger uses a custom piece
          {step.settings?.pieceName ? (
            <> (<code>{step.settings.pieceName}</code>)</>
          ) : null}
          . Pick one of the kinds above to replace it. The current piece configuration will be
          discarded when you switch -- there's no way to bring it back from here.
        </p>
      ) : null}

      {/* Piece + sub-action identity USED to live here as a read-only
          row, but the canvas card already shows "<piece> · <action>" in
          the node body -- repeating it inside the panel is noise. With
          the row + its "Action" section header gone, inputs flow
          directly under the panel head (or under the trigger-mode /
          loop / router sections, whichever applies). */}

      {isLoop ? (
        <LoopEditor step={step} onSetLoopItems={onSetLoopItems} onAddStepToLoopBody={onAddStepToLoopBody} />
      ) : null}

      {isRouter ? (
        <RouterEditor
          step={step}
          onSetRouterExecutionType={onSetRouterExecutionType}
          onAddRouterBranch={onAddRouterBranch}
          onRemoveRouterBranch={onRemoveRouterBranch}
          onAddStepToBranch={onAddStepToBranch}
          onSetBranchConditions={onSetBranchConditions}
        />
      ) : null}

      {/* Connection picker: shown for pieces that declare top-level
          `auth`. The chosen connection is stored in
          `settings.input.auth` as a `{{connections.<externalId>}}`
          template -- the engine resolves it to the actual secret at
          run time. Skipped for connectionless pieces (jarvis-ask,
          schedule, code, webhook). */}
      {!isLoop && !isRouter && piece?.auth ? (
        <ConnectionPicker
          pieceName={piece.name}
          pieceDisplayName={piece.displayName}
          authDisplayName={piece.auth.displayName ?? "Connection"}
          authType={piece.auth.type}
          connections={connections}
          currentValue={(step.settings?.input?.["auth"] as string | undefined) ?? ""}
          onPick={(template) => onSetInput("auth", template)}
        />
      ) : null}

      {!isLoop && !isRouter ? (
        <div className="wf-props__inputs">
          {/* No "Inputs" section title: the panel only has one
              configurable block for a piece (the inputs themselves) plus
              the sample-output editor below, so a section header would
              just be visual noise. */}
          {schema ? (
            <SchemaInputs
              schema={schema}
              input={(step.settings?.input ?? {}) as Record<string, unknown>}
              onSetInput={onSetInput}
            />
          ) : (
            <FreeformInputs
              inputEntries={inputEntries}
              newKey={newKey}
              setNewKey={setNewKey}
              onSetInput={onSetInput}
              onAddInputKey={onAddInputKey}
              onRemoveInputKey={onRemoveInputKey}
            />
          )}
        </div>
      ) : null}

      <div className="wf-props__divider" />

      <div className="wf-props__step-actions">
        <Button variant="ghost" size="sm" onClick={onAddStepAfter} title="Insert a new action after this step">
          <Icon icon={Plus} size={12} /> {hasNextAction ? "Insert step after" : "Add next step"}
        </Button>
        {!isTriggerStep ? (
          <Button variant="danger" size="sm" onClick={onDelete} title="Remove this step from the chain">
            <Icon icon={Trash2} size={12} /> Delete step
          </Button>
        ) : null}
        {!isTopLevel ? (
          <p className="wf-props__hint">
            Inside a {scopeLabel(props.containerKind)}. New steps insert next to this one in the same sub-chain.
          </p>
        ) : null}
      </div>

      {/* Advanced settings: error handling toggles, sample input
          override, sample output, and the test-this-step button live
          here collapsed so the main panel stays focused on the
          step's inputs. Default closed -- expansion is per-step but
          not persisted across reloads (intentional: it's a working
          state, not a configuration). */}
      <AdvancedSettings
        // Key on step name so collapse state resets when the user
        // navigates to a different step. Otherwise an open Advanced
        // section on step A would silently carry over to step B even
        // though the user might not need it there.
        key={`advanced-${step.name}`}
        showErrorHandling={step.type === "PIECE" && !isTriggerStep}
        continueOnFailure={!!step.settings?.errorHandlingOptions?.continueOnFailure?.value}
        retryOnFailure={!!step.settings?.errorHandlingOptions?.retryOnFailure?.value}
        onSetErrorHandling={onSetErrorHandling}
        stepName={step.name}
        sampleData={props.sampleData}
        sampleInput={props.sampleInput}
        // Declared output from the piece catalog -- exposed so the
        // sample-output editor can offer a "Reset to declared" button.
        declaredSample={selectedSubAction?.sampleData ?? selectedSubAction?.outputSample}
        isLocked={props.isLocked}
        isTriggerStep={isTriggerStep}
        onSetSampleData={props.onSetSampleData}
        onSetSampleInput={props.onSetSampleInput}
        onTestFromHere={props.onTestFromHere}
      />
    </div>
  );
}

/**
 * Collapsible "Advanced settings" block. Holds the error-handling
 * toggles, the sample-input override editor, the sample-output editor,
 * and the test-this-step button. Kept as a single component (rather
 * than three sibling collapsibles) so the user has one disclosure
 * affordance instead of three; the most common case is "I just want
 * to test this step" which expands the whole block in one click.
 */
function AdvancedSettings(props: {
  showErrorHandling: boolean;
  continueOnFailure: boolean;
  retryOnFailure: boolean;
  onSetErrorHandling: (patch: { continueOnFailure?: boolean; retryOnFailure?: boolean }) => void;
  stepName: string;
  sampleData: unknown | undefined;
  sampleInput: unknown | undefined;
  declaredSample: unknown | undefined;
  isLocked: boolean;
  isTriggerStep: boolean;
  onSetSampleData: (output: unknown | null) => Promise<{ ok: boolean; message: string }>;
  onSetSampleInput: (input: Record<string, unknown> | null) => Promise<{ ok: boolean; message: string }>;
  onTestFromHere: () => Promise<{ ok: boolean; message: string }>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <section className="wf-props__advanced">
      <button
        type="button"
        className={`wf-props__advanced-toggle ${open ? "wf-props__advanced-toggle--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="wf-props__advanced-caret">{open ? "▾" : "▸"}</span>
        Advanced settings
      </button>
      {open ? (
        <div className="wf-props__advanced-body">
          {props.showErrorHandling ? (
            <ErrorHandlingSection
              continueOnFailure={props.continueOnFailure}
              retryOnFailure={props.retryOnFailure}
              onChange={props.onSetErrorHandling}
            />
          ) : null}
          <SampleInputSection
            sampleInput={props.sampleInput}
            isLocked={props.isLocked}
            onSetSampleInput={props.onSetSampleInput}
          />
          <SampleDataSection
            stepName={props.stepName}
            sampleData={props.sampleData}
            declaredSample={props.declaredSample}
            isLocked={props.isLocked}
            isTriggerStep={props.isTriggerStep}
            onSetSampleData={props.onSetSampleData}
            onTestFromHere={props.onTestFromHere}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Per-step error-handling toggles. These map 1:1 to the activepieces
 * engine's `errorHandlingOptions` shape:
 *   - `continueOnFailure`: flip a FAILED verdict back to RUNNING so the
 *     flow continues. The step's `output` stays undefined -- downstream
 *     templating can use `{{<step>}}` + DOES_NOT_EXIST to branch on the
 *     failure (this is exactly what the "Add error handling" template
 *     wires up automatically).
 *   - `retryOnFailure`: retry with exponential backoff. Cadence is engine
 *     config (max 4 attempts, ~14s total wait); not per-step tunable.
 */

/**
 * Connection picker for pieces that declare a top-level `auth` field.
 * Lists every saved connection whose `pieceName` matches the piece in
 * question; picking one writes `{{connections.<externalId>}}` into the
 * step's `settings.input.auth`. An "empty" option clears the binding
 * (the engine then errors at run time, which is the correct signal).
 *
 * No inline "Add connection" affordance: connection creation is a
 * one-time setup in the Connections panel. Surfacing the same flow
 * here would duplicate the OAuth redirect handling already in that
 * panel and isn't worth the complexity.
 */
function ConnectionPicker({
  pieceName,
  pieceDisplayName,
  authDisplayName,
  authType,
  connections,
  currentValue,
  onPick,
}: {
  pieceName: string;
  pieceDisplayName: string;
  authDisplayName: string;
  authType: PieceCatalogAuth["type"];
  connections: ConnectionMeta[];
  currentValue: string;
  onPick: (template: string) => void;
}): React.ReactElement {
  // Filter to ACTIVE connections for this piece. Inactive (MISSING /
  // ERROR) entries are excluded; they'd parse but fail at runtime, and
  // a stale UI shouldn't let the user select something broken. The
  // Connections panel surfaces those for repair.
  const matching = connections.filter(
    (c) => c.pieceName === pieceName && c.status === "ACTIVE",
  );
  // Extract the external id from the current template, if any. Lets
  // the dropdown reflect the user's choice on re-open.
  const m = /^\{\{connections\.([^}]+)\}\}$/.exec(currentValue.trim());
  const currentExternalId = m ? m[1]! : "";
  return (
    <div className="wf-props__connection">
      <label className="wf-props__field-label">
        {authDisplayName}
        <span className="wf-props__connection-type">({authType})</span>
      </label>
      {matching.length === 0 ? (
        <p className="wf-props__hint wf-props__connection-empty">
          No connection saved for {pieceDisplayName} yet. Add one in the Connections panel,
          then come back and select it here.
        </p>
      ) : (
        <select
          value={currentExternalId}
          onChange={(e) => {
            const id = e.target.value;
            onPick(id ? `{{connections.${id}}}` : "");
          }}
        >
          <option value="">-- pick a connection --</option>
          {matching.map((c) => (
            <option key={c.id} value={c.externalId}>
              {c.displayName} ({c.externalId})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function ErrorHandlingSection({
  continueOnFailure,
  retryOnFailure,
  onChange,
}: {
  continueOnFailure: boolean;
  retryOnFailure: boolean;
  onChange: (patch: { continueOnFailure?: boolean; retryOnFailure?: boolean }) => void;
}): React.ReactElement {
  return (
    <section className="wf-props__error-handling" aria-label="Error handling">
      <h4>Error handling</h4>
      <label className="wf-props__field wf-props__field--inline">
        <input
          type="checkbox"
          checked={continueOnFailure}
          onChange={(e) => onChange({ continueOnFailure: e.target.checked })}
        />
        <span className="wf-props__field-label">Continue on failure</span>
      </label>
      <p className="wf-props__hint">
        Treat this step's failure as success. Downstream steps still run; the
        failure shows up in the step's output for routers to branch on.
      </p>
      <label className="wf-props__field wf-props__field--inline">
        <input
          type="checkbox"
          checked={retryOnFailure}
          onChange={(e) => onChange({ retryOnFailure: e.target.checked })}
        />
        <span className="wf-props__field-label">Retry on failure</span>
      </label>
      <p className="wf-props__hint">
        Retry up to 4 times with exponential backoff (~14s total) before
        giving up. Final failure still respects "Continue on failure".
      </p>
    </section>
  );
}

/**
 * Per-step sample data editor + "Test this step" button. Renders inside the
 * properties panel below the step-actions row.
 *
 * The textarea holds the JSON for THIS step's sample output -- what the
 * engine would feed to downstream steps that reference {{ stepName.foo }}
 * when running with stepNameToTest. The "Test this step" button fires a
 * run with stepNameToTest set to this step name; the engine populates the
 * preceding steps' outputs from the version's persisted sampleData map
 * and applies any sample input override stored for this step.
 *
 * The trigger step also accepts sample data -- that becomes the trigger
 * payload visible to the first action. The button label adapts.
 */
function SampleInputSection({
  sampleInput,
  isLocked,
  onSetSampleInput,
}: {
  sampleInput: unknown | undefined;
  isLocked: boolean;
  onSetSampleInput: (input: Record<string, unknown> | null) => Promise<{ ok: boolean; message: string }>;
}): React.ReactElement {
  // Same persistence pattern as SampleDataSection but constrained to a
  // plain object (the server enforces this since the value replaces
  // `settings.input` at test time).
  const incomingText = useMemo(
    () => (sampleInput === undefined ? "" : JSON.stringify(sampleInput, null, 2)),
    [sampleInput],
  );
  const [text, setText] = useState<string>(incomingText);
  const [savedText, setSavedText] = useState<string>(incomingText);
  const [parseError, setParseError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);

  const hasUnsavedEdits = text !== savedText;

  const flash = (tone: "ok" | "warn", t: string): void => {
    setStatus({ tone, text: t });
    window.setTimeout(() => setStatus(null), 3000);
  };

  const handleSave = async (): Promise<void> => {
    if (text.trim().length === 0) {
      // Empty input means "clear" -- forward null rather than {} so the
      // server drops the entry entirely (no override stored).
      setBusy("save");
      try {
        const r = await onSetSampleInput(null);
        if (r.ok) {
          setSavedText("");
          setParseError(null);
        }
        flash(r.ok ? "ok" : "warn", r.message);
      } finally {
        setBusy(null);
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
      setParseError(null);
    } catch (e) {
      setParseError((e as Error).message);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setParseError("Sample input must be a JSON object (it replaces settings.input at test time).");
      return;
    }
    setBusy("save");
    try {
      const r = await onSetSampleInput(parsed as Record<string, unknown>);
      if (r.ok) setSavedText(text);
      flash(r.ok ? "ok" : "warn", r.message);
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async (): Promise<void> => {
    if (!window.confirm("Clear this step's sample input override?")) return;
    setBusy("clear");
    try {
      const r = await onSetSampleInput(null);
      if (r.ok) {
        setText("");
        setSavedText("");
        setParseError(null);
      }
      flash(r.ok ? "ok" : "warn", r.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="wf-props__sample-data" aria-label="Sample input override">
      <header className="wf-props__sample-header">
        <h4 className="wf-props__sample-title">Sample input</h4>
        <p className="wf-props__hint">
          JSON object that replaces this step's input during a Test run. Use to exercise the step
          with curated parameters without changing the production input. Leave empty to use the
          step's actual input.
        </p>
      </header>
      <textarea
        className="wf-props__sample-textarea"
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='{"toolName": "get_clipboard"}'
        disabled={isLocked}
        spellCheck={false}
      />
      {parseError ? <span className="wf-props__sample-err">{parseError}</span> : null}
      {hasUnsavedEdits ? (
        <span className="wf-props__sample-status wf-props__sample-status--warn">
          Unsaved edits -- save before testing or they won't be used.
        </span>
      ) : null}
      {status ? (
        <span className={`wf-props__sample-status wf-props__sample-status--${status.tone}`}>
          {status.text}
        </span>
      ) : null}
      <div className="wf-props__sample-actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleSave()}
          disabled={isLocked || busy !== null}
        >
          {busy === "save" ? "Saving..." : "Save sample"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleClear()}
          disabled={isLocked || busy !== null || text.trim().length === 0}
        >
          {busy === "clear" ? "Clearing..." : "Clear"}
        </Button>
      </div>
    </section>
  );
}

function SampleDataSection({
  sampleData,
  declaredSample,
  isLocked,
  isTriggerStep,
  onSetSampleData,
  onTestFromHere,
}: {
  stepName: string;
  sampleData: unknown | undefined;
  /**
   * Declared output from the piece catalog (action.outputSample or
   * trigger.sampleData). When set + the persisted cell is non-empty, a
   * "Reset to declared" button appears that clears the cell so the
   * picker falls back to this declared shape. Undefined when the
   * piece author hasn't declared anything.
   */
  declaredSample: unknown | undefined;
  isLocked: boolean;
  isTriggerStep: boolean;
  onSetSampleData: (output: unknown | null) => Promise<{ ok: boolean; message: string }>;
  onTestFromHere: () => Promise<{ ok: boolean; message: string }>;
}): React.ReactElement {
  // The component is mounted with `key={stepName}` by PropertiesPanel, so
  // selecting a different step gives us a fresh instance with state derived
  // from the new step's `sampleData`. That removes the need for an effect-
  // based sync (which previously clobbered in-flight typing during the
  // Save round-trip).
  const incomingText = useMemo(
    () => (sampleData === undefined ? "" : JSON.stringify(sampleData, null, 2)),
    [sampleData],
  );
  const [text, setText] = useState<string>(incomingText);
  const [savedText, setSavedText] = useState<string>(incomingText);
  const [parseError, setParseError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "clear" | "reset" | null>(null);

  // Unsaved-edit indicator: local text diverged from the value we last
  // pushed to the server. Used to nudge the user to save before testing.
  const hasUnsavedEdits = text !== savedText;

  const flash = (tone: "ok" | "warn", t: string): void => {
    setStatus({ tone, text: t });
    window.setTimeout(() => setStatus(null), 3000);
  };

  const parseOrError = (): unknown | undefined => {
    if (text.trim().length === 0) return undefined; // treat empty as "clear"
    try {
      const parsed = JSON.parse(text);
      setParseError(null);
      return parsed;
    } catch (e) {
      setParseError((e as Error).message);
      return undefined;
    }
  };

  const handleSave = async (): Promise<void> => {
    const parsed = parseOrError();
    if (text.trim().length > 0 && parsed === undefined && parseError) {
      return; // parse error already surfaced
    }
    setBusy("save");
    try {
      const r = await onSetSampleData(parsed === undefined ? null : parsed);
      if (r.ok) {
        // Snapshot what we just saved so `hasUnsavedEdits` resets to false.
        // We track our own snapshot rather than re-deriving from the prop:
        // the server might canonicalize whitespace, and the prop sync would
        // momentarily show "saved" -> "edited" -> "saved" as React re-renders.
        setSavedText(text);
      }
      flash(r.ok ? "ok" : "warn", r.message);
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async (): Promise<void> => {
    if (!window.confirm("Clear this step's sample data?")) return;
    setBusy("clear");
    try {
      const r = await onSetSampleData(null);
      if (r.ok) {
        setText("");
        setSavedText("");
        setParseError(null);
      }
      flash(r.ok ? "ok" : "warn", r.message);
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async (): Promise<void> => {
    setBusy("test");
    try {
      const r = await onTestFromHere();
      flash(r.ok ? "ok" : "warn", r.message);
    } finally {
      setBusy(null);
    }
  };

  // "Reset to declared" clears the persisted cell -- same wire op as
  // `Clear` -- but with copy that explains the fallback. We show this
  // ONLY when the piece author actually declared something and the
  // user has pinned a value (an empty cell already uses the declared
  // sample, so no reset is needed).
  const handleResetToDeclared = async (): Promise<void> => {
    setBusy("reset");
    try {
      const r = await onSetSampleData(null);
      if (r.ok) {
        setText("");
        setSavedText("");
        setParseError(null);
        flash(
          "ok",
          "Reset. The variable picker now uses the piece's declared sample.",
        );
      } else {
        flash("warn", r.message);
      }
    } finally {
      setBusy(null);
    }
  };

  const hasDeclaredSample = declaredSample !== undefined;
  // "Pinned" means the user actively set a sampleData value that
  // differs from undefined / empty. A blank cell already falls back to
  // declared, so the reset button is a no-op there.
  const hasPinnedCell = sampleData !== undefined;

  return (
    <section className="wf-props__sample-data" aria-label="Sample output + test this step">
      <header className="wf-props__sample-header">
        <h4 className="wf-props__sample-title">
          Sample {isTriggerStep ? "trigger payload" : "output"}
        </h4>
        <p className="wf-props__hint">
          {isTriggerStep
            ? "JSON the test run feeds to the trigger. Downstream steps see it as the trigger payload."
            : "JSON downstream steps see when they reference {{stepName.field}}. Lets you wire flows without first running this step for real."}
        </p>
      </header>
      <textarea
        className="wf-props__sample-textarea"
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='{"key": "value"}'
        disabled={isLocked}
        spellCheck={false}
      />
      {parseError ? <span className="wf-props__sample-err">{parseError}</span> : null}
      {hasUnsavedEdits ? (
        <span className="wf-props__sample-status wf-props__sample-status--warn">
          Unsaved edits -- save before testing or they won't be used.
        </span>
      ) : null}
      {status ? (
        <span
          className={`wf-props__sample-status wf-props__sample-status--${status.tone}`}
        >
          {status.text}
        </span>
      ) : null}
      <div className="wf-props__sample-actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleSave()}
          disabled={isLocked || busy !== null}
          title={isLocked ? "Published versions are read-only" : "Save sample output"}
        >
          {busy === "save" ? "Saving..." : "Save sample"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleClear()}
          disabled={isLocked || busy !== null || text.trim().length === 0}
        >
          {busy === "clear" ? "Clearing..." : "Clear"}
        </Button>
        {hasDeclaredSample && hasPinnedCell ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleResetToDeclared()}
            disabled={isLocked || busy !== null}
            title="Drop the pinned sample so the variable picker uses the piece's declared output instead."
          >
            {busy === "reset" ? "Resetting..." : "Reset to declared"}
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleTest()}
          // Block Test when the textarea has unsaved edits -- otherwise the
          // run executes against the older saved version and the user sees a
          // confusing "I just typed this, why doesn't it show up" result.
          disabled={isLocked || busy !== null || hasUnsavedEdits}
          title={
            hasUnsavedEdits
              ? "Save your changes first; Test runs the persisted sample data"
              : "Run JUST this step in isolation using the saved sample input + preceding steps' sample data. Does not run downstream steps."
          }
        >
          {busy === "test" ? "Queuing..." : "Test this step"}
        </Button>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="wf-props__field">
      <span className="wf-props__field-label">{label}</span>
      {children}
    </label>
  );
}

/* ---------------------------------------------- schema-aware input forms */

function SchemaInputs({
  schema,
  input,
  onSetInput,
}: {
  schema: { fields: PieceInputField[] };
  input: Record<string, unknown>;
  onSetInput: (key: string, value: unknown) => void;
}): React.ReactElement {
  return (
    <ul className="wf-props__input-list">
      {schema.fields.map((field) => (
        <li key={field.name} className="wf-props__schema-row">
          <TypedField field={field} value={input[field.name]} onChange={(v) => onSetInput(field.name, v)} />
        </li>
      ))}
    </ul>
  );
}

interface TypedFieldProps {
  field: PieceInputField;
  value: unknown;
  onChange: (next: unknown) => void;
}

function TypedField({ field, value, onChange }: TypedFieldProps): React.ReactElement {
  const isEmpty = value === undefined || value === null || value === "";
  const isMissing = field.required && isEmpty;

  const labelEl = (
    <span className={`wf-props__field-label ${isMissing ? "wf-props__field-label--missing" : ""}`}>
      {field.label}
      {field.required ? <span className="wf-props__req" aria-label="required"> *</span> : null}
    </span>
  );

  if (field.type === "boolean") {
    return (
      <label className={`wf-props__field wf-props__field--inline ${isMissing ? "wf-props__field--missing" : ""}`}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {labelEl}
        {/* Inline ? glyph: tooltip shows the description on hover so the
            user doesn't have to read the help line below. Click handler
            is a stop-propagation no-op so tapping the glyph doesn't
            toggle the checkbox. */}
        {field.description ? (
          <span
            className="wf-props__field-helper"
            role="button"
            tabIndex={0}
            title={field.description}
            aria-label={field.description}
            onClick={(e) => e.preventDefault()}
          >
            ?
          </span>
        ) : null}
        {field.description ? <span className="wf-props__field-help">{field.description}</span> : null}
      </label>
    );
  }

  if (field.type === "enum") {
    // Group options by their `group` attribute (when any option carries
    // one) so wide dropdowns -- jarvis-trigger:on_event eventType is
    // the canonical case -- render as <optgroup> sections rather than
    // a flat 15+ item list. Order: groups appear in first-seen order,
    // ungrouped options first. Falls back to a flat list when no
    // option declares a group.
    const opts = field.options ?? [];
    const hasGroups = opts.some((o) => typeof o.group === "string" && o.group.length > 0);
    const groupOrder: string[] = [];
    const grouped = new Map<string, typeof opts>();
    const ungrouped: typeof opts = [];
    for (const o of opts) {
      const g = typeof o.group === "string" && o.group.length > 0 ? o.group : null;
      if (g === null) {
        ungrouped.push(o);
        continue;
      }
      if (!grouped.has(g)) {
        groupOrder.push(g);
        grouped.set(g, []);
      }
      (grouped.get(g) as typeof opts).push(o);
    }
    return (
      <label className={`wf-props__field ${isMissing ? "wf-props__field--missing" : ""}`}>
        {labelEl}
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">{field.required ? "— select —" : "— none —"}</option>
          {hasGroups ? (
            <>
              {groupOrder.map((g) => (
                <optgroup key={g} label={g}>
                  {(grouped.get(g) ?? []).map((o) => (
                    <option key={o.value} value={o.value} title={o.description}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
              {/* Stragglers without a group land in a synthetic "Other"
                  group so they're still labelled rather than floating
                  unlabelled at the top of the dropdown. Today's only
                  consumer (on_event eventType) has no ungrouped
                  options, but this keeps the renderer robust if a
                  future field ships a partial group set. */}
              {ungrouped.length > 0 ? (
                <optgroup label="Other">
                  {ungrouped.map((o) => (
                    <option key={o.value} value={o.value} title={o.description}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </>
          ) : (
            opts.map((o) => (
              <option key={o.value} value={o.value} title={o.description}>
                {o.label}
              </option>
            ))
          )}
        </select>
        {field.description ? <span className="wf-props__field-help">{field.description}</span> : null}
      </label>
    );
  }

  if (field.type === "multi_enum") {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    return (
      <div className={`wf-props__field ${isMissing ? "wf-props__field--missing" : ""}`}>
        {labelEl}
        <div className="wf-props__chips">
          {(field.options ?? []).map((o) => {
            const on = selected.has(o.value);
            return (
              <button
                key={o.value}
                type="button"
                className={`wf-props__chip ${on ? "wf-props__chip--on" : ""}`}
                onClick={() => {
                  const next = new Set(selected);
                  if (on) next.delete(o.value); else next.add(o.value);
                  onChange(Array.from(next));
                }}
                title={o.description}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {field.description ? <span className="wf-props__field-help">{field.description}</span> : null}
      </div>
    );
  }

  if (field.type === "number") {
    return <NumberField field={field} value={value} onChange={onChange} labelEl={labelEl} isMissing={isMissing} />;
  }

  if (field.type === "json") {
    return <JsonField field={field} value={value} onChange={onChange} labelEl={labelEl} />;
  }

  if (field.type === "long_text") {
    return <LongTextField field={field} value={value} onChange={onChange} labelEl={labelEl} isMissing={isMissing} />;
  }

  if (field.type === "datetime") {
    return (
      <label className={`wf-props__field ${isMissing ? "wf-props__field--missing" : ""}`}>
        {labelEl}
        <input
          type="datetime-local"
          value={normalizeDatetimeLocalValue(value)}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : "")}
        />
        {field.description ? <span className="wf-props__field-help">{field.description}</span> : null}
      </label>
    );
  }

  if (field.type === "flow_ref") {
    return <FlowRefField field={field} value={value} onChange={onChange} labelEl={labelEl} isMissing={isMissing} />;
  }

  // default: string
  return <StringField field={field} value={value} onChange={onChange} labelEl={labelEl} isMissing={isMissing} />;
}

/**
 * String-typed input wrapper. Uses the chip field so `{{step.field}}`
 * templates render as visible `field` chips rather than raw braces.
 * Native `<input type="text">` would only show the raw template; the
 * chip field provides the make.com / n8n-style token UI without
 * sacrificing manual typing (Backspace deletes a chip whole; typing
 * around chips just edits the surrounding text).
 */
function StringField({
  field,
  value,
  onChange,
  labelEl,
  isMissing,
}: {
  field: PieceInputField;
  value: unknown;
  onChange: (next: unknown) => void;
  labelEl: React.ReactNode;
  isMissing: boolean;
}): React.ReactElement {
  const text = typeof value === "string" ? value : "";
  return (
    <label className={`wf-props__field ${isMissing ? "wf-props__field--missing" : ""}`}>
      {labelEl}
      <VariableChipField
        value={text}
        onChange={(next) => onChange(next)}
        placeholder={field.placeholder}
      />
      {field.description ? <span className="wf-props__field-help">{field.description}</span> : null}
    </label>
  );
}

/**
 * Workflow picker. Stores a flow id as the field value; renders a
 * trigger button labelled with the resolved flow's displayName.
 * Clicking the button opens a popover with a search box + filtered
 * list of all workflows. Lazy fetch on first open so a panel that
 * never shows a flow_ref field never hits `/api/workflows`.
 *
 * Why custom rather than a plain <select> with options pulled at
 * catalog projection time: the workflow list is per-user state,
 * potentially long, and changes outside the catalog's invalidation
 * lifecycle (a user adds a workflow without restarting the daemon
 * or rebuilding the catalog). Fetching on demand keeps the picker
 * always-fresh and the catalog projection minimal.
 */
function FlowRefField({
  field,
  value,
  onChange,
  labelEl,
  isMissing,
}: {
  field: PieceInputField;
  value: unknown;
  onChange: (next: unknown) => void;
  labelEl: React.ReactNode;
  isMissing: boolean;
}): React.ReactElement {
  const flowId = typeof value === "string" ? value : "";
  // Filter the current workflow out of the list: picking yourself
  // would recurse (the daemon also guards against this at
  // workflows.start, but the UI should not even offer the option).
  const currentWorkflowId = useContext(CurrentFlowIdContext);
  const [open, setOpen] = useState(false);
  const [flows, setFlows] = useState<FlowPickerEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Ref to the rendered popover element. Replaces a previous
  // `document.querySelector(".wf-flow-ref__popover")` lookup that
  // would pick the FIRST flow_ref popover in the document -- not
  // necessarily this picker's. Today only one flow_ref field ships
  // (run_workflow.flow) but the renderer is generic so we scope the
  // outside-click test to the local ref.
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Fetch the flow list on mount AND on every popover open. The
  // mount-fetch lets the button label resolve `flowId` to a
  // displayName without the user having to open the popover first
  // (matters when the panel reopens with a flow already picked).
  // The per-open refresh keeps the list current if the user added a
  // workflow since this component mounted. Cheap GET -- typical
  // response is well under 100KB even for power users.
  useEffect(() => {
    let cancelled = false;
    // Only show the loading skeleton when there's nothing to show
    // already; otherwise the user sees a flash of "Loading..." over
    // the cached list every time they open the picker.
    setLoading((prev) => (flows.length === 0 ? true : prev));
    setError(null);
    (async (): Promise<void> => {
      try {
        const list = await fetchFlowsForPicker();
        if (!cancelled) setFlows(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Refetch when the popover opens; the mount-only run also fires
    // because `open` defaults to false at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset transient picker state when the popover closes: clear the
  // search box / error so the next reopen starts fresh. Keep `flows`
  // cached: the button label below resolves the current value's
  // displayName against this list, so wiping it on close would make
  // the closed-state button read "(unknown flow: <id>)" until the
  // popover is opened again. The next open re-fetches and replaces.
  // `activeIdx` is managed by `useListNav` below; the hook clamps it
  // on filter changes automatically.
  useEffect(() => {
    if (open) return;
    setQuery("");
    setError(null);
  }, [open]);

  // Resolve the current value to a displayName for the button label.
  // Falls back to the raw id (or a placeholder) so the user can still
  // see what's stored when the flow list hasn't loaded yet.
  const selected = flows.find((f) => f.id === flowId);
  const buttonLabel = selected
    ? selected.displayName || selected.id
    : flowId
      ? `(unknown flow: ${flowId})`
      : "Pick a workflow";

  // Filter on display name (case-insensitive substring) so a user
  // typing "morning" matches "Morning briefing" without exact case.
  // Drop the current workflow up front so it never appears as a
  // self-recursion option.
  const filtered = useMemo(
    () =>
      flows
        .filter((f) => f.id !== currentWorkflowId)
        .filter((f) => f.displayName.toLowerCase().includes(query.toLowerCase())),
    [flows, currentWorkflowId, query],
  );

  // Shared keyboard navigation (Arrow / Enter / Escape). The hook
  // owns activeIdx clamping on filter changes and the
  // stopPropagation-on-Escape contract every popover in the editor
  // needs to keep the outer Esc handler from also firing.
  const { activeIdx, setActiveIdx, onKeyDown: onListKeyDown } = useListNav({
    items: filtered,
    onSelect: (pick) => {
      onChange(pick.id);
      setOpen(false);
    },
    onClose: () => setOpen(false),
  });

  // Focus the search box when the popover opens for keyboard users.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape + outside-click. Escape calls stopPropagation so the
  // editor's outer Escape handler (which prompts about unsaved work)
  // doesn't fire when the user is just dismissing the popover.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    function onClick(e: MouseEvent): void {
      if (!(e.target instanceof Node)) return;
      const t = e.target;
      if (btnRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div className={`wf-props__field wf-flow-ref ${isMissing ? "wf-props__field--missing" : ""}`}>
      {labelEl}
      <button
        ref={btnRef}
        type="button"
        className="wf-flow-ref__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="wf-flow-ref__trigger-label">{buttonLabel}</span>
        <span className="wf-flow-ref__trigger-caret">▾</span>
      </button>
      {open
        ? createPortal(
            <FlowRefPopover
              popoverRef={popoverRef}
              anchorEl={btnRef.current}
              inputRef={inputRef}
              query={query}
              setQuery={setQuery}
              filtered={filtered}
              activeIdx={activeIdx}
              setActiveIdx={setActiveIdx}
              onKeyDown={onListKeyDown}
              loading={loading}
              error={error}
              currentId={flowId}
              onPick={(id) => {
                onChange(id);
                setOpen(false);
              }}
              onClear={() => {
                onChange(undefined);
                setOpen(false);
              }}
            />,
            document.body,
          )
        : null}
      {field.description ? <span className="wf-props__field-help">{field.description}</span> : null}
    </div>
  );
}

interface FlowRefPopoverProps {
  popoverRef: React.RefObject<HTMLDivElement | null>;
  anchorEl: HTMLButtonElement | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (v: string) => void;
  filtered: FlowPickerEntry[];
  activeIdx: number;
  setActiveIdx: (i: number) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  loading: boolean;
  error: string | null;
  currentId: string;
  onPick: (id: string) => void;
  onClear: () => void;
}

function FlowRefPopover({
  popoverRef,
  anchorEl,
  inputRef,
  query,
  setQuery,
  filtered,
  activeIdx,
  setActiveIdx,
  onKeyDown,
  loading,
  error,
  currentId,
  onPick,
  onClear,
}: FlowRefPopoverProps): React.ReactElement {
  const [pos, setPos] = useState<{ left: number; top: number; width: number }>({ left: 0, top: 0, width: 240 });
  useLayoutEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    // Align the popover's left edge to the button and place it
    // directly below; clamp into the viewport so it never spills off
    // the right side or bottom.
    const width = Math.max(r.width, 240);
    let left = r.left;
    if (left + width + 8 > window.innerWidth) left = Math.max(8, window.innerWidth - width - 8);
    let top = r.bottom + 4;
    const maxH = 320;
    if (top + maxH + 8 > window.innerHeight) {
      // Open upward when there's no room below.
      top = Math.max(8, r.top - maxH - 4);
    }
    setPos({ left, top, width });
  }, [anchorEl]);

  return (
    <div
      ref={popoverRef}
      className="wf-flow-ref__popover"
      style={{ left: pos.left, top: pos.top, width: pos.width }}
      role="dialog"
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        className="wf-flow-ref__search"
        placeholder="Search workflows..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error ? (
        <p className="wf-flow-ref__hint wf-flow-ref__hint--error">Couldn't load workflows: {error}</p>
      ) : loading ? (
        <p className="wf-flow-ref__hint">Loading workflows...</p>
      ) : filtered.length === 0 ? (
        <p className="wf-flow-ref__hint">
          {query ? "No workflows match." : "No other workflows yet. Create one first, then come back here."}
        </p>
      ) : (
        <ul className="wf-flow-ref__list" role="listbox">
          {filtered.map((f, i) => {
            const active = i === activeIdx;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  className={`wf-flow-ref__row ${f.id === currentId ? "wf-flow-ref__row--on" : ""} ${active ? "wf-flow-ref__row--active" : ""}`}
                  onClick={() => onPick(f.id)}
                  onMouseEnter={() => setActiveIdx(i)}
                  role="option"
                  aria-selected={f.id === currentId}
                  title={f.id}
                >
                  <span className="wf-flow-ref__row-name">{f.displayName || "(no name)"}</span>
                  <span className="wf-flow-ref__row-id">{f.id.slice(0, 8)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {currentId ? (
        <button
          type="button"
          className="wf-flow-ref__clear"
          onClick={onClear}
        >
          Clear selection
        </button>
      ) : null}
    </div>
  );
}

/** Long-text variant -- chip field in multiline mode. */
function LongTextField({
  field,
  value,
  onChange,
  labelEl,
  isMissing,
}: {
  field: PieceInputField;
  value: unknown;
  onChange: (next: unknown) => void;
  labelEl: React.ReactNode;
  isMissing: boolean;
}): React.ReactElement {
  const text = typeof value === "string" ? value : "";
  return (
    <label className={`wf-props__field ${isMissing ? "wf-props__field--missing" : ""}`}>
      {labelEl}
      <VariableChipField
        value={text}
        onChange={(next) => onChange(next)}
        placeholder={field.placeholder}
        multiline
      />
      {field.description ? <span className="wf-props__field-help">{field.description}</span> : null}
    </label>
  );
}

/**
 * Convert a stored datetime value (ISO-8601 or empty) to the
 * `datetime-local`-compatible "YYYY-MM-DDTHH:mm" form. Tolerates whatever
 * the field happened to receive (legacy strings, undefined) without throwing.
 */
function normalizeDatetimeLocalValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  // Strip the timezone + seconds suffix to fit datetime-local's expected shape.
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Number field: holds the user's raw text so partial states like "3." or "3e"
 * survive across renders. Propagates a parsed `number` upward when the text
 * parses cleanly; clears (`undefined`) on empty input. If `value` changes
 * from outside (load, reset, schema default) we sync local text from it; we
 * skip the sync when the change was driven by our own `onChange`.
 */
function NumberField({
  field,
  value,
  onChange,
  labelEl,
  isMissing,
}: {
  field: PieceInputField;
  value: unknown;
  onChange: (next: unknown) => void;
  labelEl: React.ReactNode;
  isMissing: boolean;
}): React.ReactElement {
  const [text, setText] = useState(numberValueToText(value));
  const lastPropagatedRef = useRef<unknown>(value);

  useEffect(() => {
    if (value === lastPropagatedRef.current) return; // self-induced; keep local text
    setText(numberValueToText(value));
    lastPropagatedRef.current = value;
  }, [value]);

  // Variable-picker hookup: an inserted `{{...}}` template lands in the
  // field as a string. The propagate logic above only emits a parsed
  // number when the text matches the numeric regex, so a template won't
  // fire `onChange(number)` -- it'll just sit there until the user types
  // a number. The engine resolves the template at run time. So we pass
  // the raw-text setter as the picker's onInsert.
  const varProps = useVariableFieldProps(text, (next) => {
    setText(next);
    // String-typed value (template). Propagate as the raw string so the
    // engine can resolve it at runtime; the schema validator treats
    // templated number inputs as valid.
    lastPropagatedRef.current = next;
    onChange(next);
  });

  return (
    <label className={`wf-props__field ${isMissing ? "wf-props__field--missing" : ""}`}>
      {labelEl}
      <input
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={field.placeholder}
        {...varProps}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw.trim() === "") {
            lastPropagatedRef.current = undefined;
            onChange(undefined);
            return;
          }
          // Tolerant parse: allow "-", "3.", "3e" while typing — propagate
          // only when Number(raw) yields a finite value AND the string isn't
          // an obvious in-progress fragment.
          if (/^-?\d+(\.\d+)?(e-?\d+)?$/.test(raw)) {
            const n = Number(raw);
            if (Number.isFinite(n)) {
              lastPropagatedRef.current = n;
              onChange(n);
            }
          }
        }}
      />
      {field.description ? <span className="wf-props__field-help">{field.description}</span> : null}
    </label>
  );
}

function numberValueToText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  return "";
}

/**
 * JSON field: holds the raw text in local state so the user can type
 * intermediate (un-parseable) states. On valid JSON, propagates the parsed
 * object up. On invalid JSON, holds the text and shows an error chip.
 *
 * Critically, we track our last self-propagated value via a ref so that
 * round-trips like (user types `{"a":1}` → we propagate `{a:1}` → parent
 * re-renders with the new value → memoized `initial` becomes `{\n  "a": 1\n}`)
 * do NOT clobber the user's whitespace. We only re-sync `text` when `value`
 * differs from what we last sent up (i.e., an external change: load, reset).
 */
function JsonField({
  field,
  value,
  onChange,
  labelEl,
}: {
  field: PieceInputField;
  value: unknown;
  onChange: (next: unknown) => void;
  labelEl: React.ReactNode;
}): React.ReactElement {
  const [text, setText] = useState(() => jsonValueToText(value));
  const [parseError, setParseError] = useState<string | null>(null);
  const lastPropagatedRef = useRef<unknown>(value);

  useEffect(() => {
    if (value === lastPropagatedRef.current) return; // self-induced; keep local text/whitespace
    setText(jsonValueToText(value));
    setParseError(null);
    lastPropagatedRef.current = value;
  }, [value]);

  // Variable-picker hookup: insertions arrive as raw template text. We
  // splice them into the textarea contents and re-run the parse path so
  // a snippet like `{ "to": {{step_3.email}} }` propagates as a parse
  // error (until the user closes the template) which is the right
  // signal -- the picker DOESN'T quote the template for the user.
  const varProps = useVariableFieldProps(text, (next) => {
    setText(next);
    if (next.trim() === "") {
      setParseError(null);
      lastPropagatedRef.current = undefined;
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(next);
      setParseError(null);
      lastPropagatedRef.current = parsed;
      onChange(parsed);
    } catch (err) {
      setParseError((err as Error).message);
    }
  });

  return (
    <label className="wf-props__field">
      {labelEl}
      <textarea
        rows={4}
        value={text}
        placeholder={field.placeholder ?? "{}"}
        {...varProps}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (next.trim() === "") {
            setParseError(null);
            lastPropagatedRef.current = undefined;
            onChange(undefined);
            return;
          }
          try {
            const parsed = JSON.parse(next);
            setParseError(null);
            lastPropagatedRef.current = parsed;
            onChange(parsed);
          } catch (err) {
            setParseError((err as Error).message);
          }
        }}
      />
      {parseError ? (
        <span className="wf-props__field-help wf-props__field-help--error">JSON parse: {parseError}</span>
      ) : field.description ? (
        <span className="wf-props__field-help">{field.description}</span>
      ) : null}
    </label>
  );
}

function jsonValueToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/* ---------------------------------------------------- freeform fallback */

function FreeformInputs({
  inputEntries,
  newKey,
  setNewKey,
  onSetInput,
  onAddInputKey,
  onRemoveInputKey,
}: {
  inputEntries: Array<[string, unknown]>;
  newKey: string;
  setNewKey: (s: string) => void;
  onSetInput: (key: string, value: unknown) => void;
  onAddInputKey: (key: string) => void;
  onRemoveInputKey: (key: string) => void;
}): React.ReactElement {
  return (
    <>
      <p className="wf-props__hint">
        This piece doesn't declare an input schema. Values are stored as strings; use{" "}
        <code>{`{{step_1.field}}`}</code> templates for typed references.
      </p>
      {inputEntries.length === 0 ? (
        <p className="wf-props__hint">No inputs yet. Add one below.</p>
      ) : (
        <ul className="wf-props__input-list">
          {inputEntries.map(([key, value]) => (
            <FreeformInputRow
              key={key}
              inputKey={key}
              value={value}
              onSetInput={onSetInput}
              onRemoveInputKey={onRemoveInputKey}
            />
          ))}
        </ul>
      )}
      <div className="wf-props__add-row">
        <input
          type="text"
          placeholder="new field name"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newKey.trim()) {
              onAddInputKey(newKey.trim());
              setNewKey("");
            }
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={!newKey.trim()}
          onClick={() => {
            onAddInputKey(newKey.trim());
            setNewKey("");
          }}
        >
          <Icon icon={Plus} size={12} /> Add field
        </Button>
      </div>
    </>
  );
}

/**
 * Single key/value row in the freeform inputs editor. Extracted so the
 * variable-picker hook can be called per-row (the row controls its own
 * textarea; the parent's `onSetInput` is partially applied with the
 * row's `key`).
 */
function FreeformInputRow({
  inputKey,
  value,
  onSetInput,
  onRemoveInputKey,
}: {
  inputKey: string;
  value: unknown;
  onSetInput: (key: string, value: unknown) => void;
  onRemoveInputKey: (key: string) => void;
}): React.ReactElement {
  const text = stringifyValue(value);
  return (
    <li className="wf-props__input-row">
      <label>
        <span className="wf-props__input-key">{inputKey}</span>
        <VariableChipField
          value={text}
          onChange={(next) => onSetInput(inputKey, next)}
          multiline
        />
      </label>
      <button
        type="button"
        className="wf-props__input-remove"
        onClick={() => onRemoveInputKey(inputKey)}
        aria-label={`Remove ${inputKey}`}
        title={`Remove ${inputKey}`}
      >
        <Icon icon={Trash2} size={12} />
      </button>
    </li>
  );
}

function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* ----------------------------------------------- LOOP / ROUTER editors */

function LoopEditor({
  step,
  onSetLoopItems,
  onAddStepToLoopBody,
}: {
  step: FlowStepNode;
  onSetLoopItems: (items: string) => void;
  onAddStepToLoopBody: () => void;
}): React.ReactElement {
  const items = step.settings?.items ?? "";
  const hasBody = !!step.firstLoopAction;
  return (
    <>
      <Field label="Items expression">
        <VariableChipField
          value={items}
          onChange={onSetLoopItems}
          placeholder="{{trigger.list}}"
        />
        <span className="wf-props__field-help">
          Must resolve to an array. Inside the body, reference <code>{`{{${step.name}.item}}`}</code> and{" "}
          <code>{`{{${step.name}.index}}`}</code>.
        </span>
      </Field>
      {!hasBody ? (
        <div className="wf-props__step-actions">
          <Button variant="primary" size="sm" onClick={onAddStepToLoopBody}>
            <Icon icon={Plus} size={12} /> Add first step in body
          </Button>
        </div>
      ) : null}
    </>
  );
}

function RouterEditor({
  step,
  onSetRouterExecutionType,
  onAddRouterBranch,
  onRemoveRouterBranch,
  onAddStepToBranch,
  onSetBranchConditions,
}: {
  step: FlowStepNode;
  onSetRouterExecutionType: (type: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH") => void;
  onAddRouterBranch: (branchName: string) => void;
  onRemoveRouterBranch: (branchIndex: number) => void;
  onAddStepToBranch: (branchName: string) => void;
  onSetBranchConditions: (branchIndex: number, conditions: BranchConditions) => void;
}): React.ReactElement {
  const branches = step.settings?.branches ?? [];
  const children = step.children ?? [];
  const executionType = step.settings?.executionType ?? "EXECUTE_FIRST_MATCH";
  // IF is a strict two-way split: branch names ("True" / "False") are
  // locked, and the user can't add or remove branches. Anything that
  // wasn't spawned via the IF library entry (or saved from older flows
  // without the marker) defaults to the renameable Router family.
  const isIf = step.settings?.routerKind === "if";
  const [newBranchName, setNewBranchName] = useState("");

  return (
    <>
      <Field label="Execution mode">
        <div className="wf-props__segmented" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={executionType === "EXECUTE_FIRST_MATCH"}
            className={`wf-props__seg ${executionType === "EXECUTE_FIRST_MATCH" ? "wf-props__seg--on" : ""}`}
            onClick={() => onSetRouterExecutionType("EXECUTE_FIRST_MATCH")}
          >
            First match
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={executionType === "EXECUTE_ALL_MATCH"}
            className={`wf-props__seg ${executionType === "EXECUTE_ALL_MATCH" ? "wf-props__seg--on" : ""}`}
            onClick={() => onSetRouterExecutionType("EXECUTE_ALL_MATCH")}
          >
            All matches
          </button>
        </div>
      </Field>

      <div className="wf-props__inputs">
        <div className="wf-props__inputs-head">
          <h4>Branches</h4>
        </div>
        <p className="wf-props__hint">
          {isIf
            ? "An If has exactly two branches. Write the condition below; the True branch fires when it matches, the False branch fires otherwise."
            : "Each CONDITION branch fires when its conditions match. The FALLBACK runs when no other branch matches."}
        </p>
        <ul className="wf-props__branch-list">
          {branches.map((b, idx) => {
            const child = children[idx];
            const isFallback = b?.branchType === "FALLBACK";
            return (
              <li key={`${idx}_${b?.branchName ?? ""}`} className="wf-props__branch-row">
                <div className="wf-props__branch-row-head">
                  <div className="wf-props__branch-name">
                    <span>{b?.branchName ?? `(branch ${idx})`}</span>
                    {isFallback && !isIf ? <span className="wf-props__branch-tag">fallback</span> : null}
                  </div>
                  <div className="wf-props__branch-actions">
                    {!child && b?.branchName && !isFallback ? (
                      <Button variant="ghost" size="sm" onClick={() => onAddStepToBranch(b.branchName)}>
                        <Icon icon={Plus} size={12} /> Add step
                      </Button>
                    ) : null}
                    {/* Lock branch removal for IF -- the two branches are
                        structurally required. Removal stays available for
                        free-form Router. */}
                    {!isIf ? (
                      <button
                        type="button"
                        className="wf-props__input-remove"
                        onClick={() => {
                          if (window.confirm(`Remove branch "${b?.branchName ?? idx}"?`)) {
                            onRemoveRouterBranch(idx);
                          }
                        }}
                        title="Remove branch"
                      >
                        <Icon icon={Trash2} size={12} />
                      </button>
                    ) : null}
                  </div>
                </div>
                {/* Condition editor inline for CONDITION branches.
                    FALLBACK branches don't carry conditions -- they fire
                    when nothing else matched. */}
                {!isFallback && b?.branchType === "CONDITION" ? (
                  <BranchConditionsEditor
                    conditions={(b.conditions ?? []) as BranchConditions}
                    onChange={(next) => onSetBranchConditions(idx, next)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        {/* "Add branch" UI hidden for IF: the True / False pair is the
            entire taxonomy. If the user needs a third path they should
            use a Router instead. */}
        {!isIf ? (
          <div className="wf-props__add-row">
            <input
              type="text"
              placeholder="new branch name"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newBranchName.trim()) {
                  onAddRouterBranch(newBranchName.trim());
                  setNewBranchName("");
                }
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={!newBranchName.trim()}
              onClick={() => {
                onAddRouterBranch(newBranchName.trim());
                setNewBranchName("");
              }}
            >
              <Icon icon={Plus} size={12} /> Add branch
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

function scopeLabel(kind: "loop" | "router" | undefined): string {
  if (kind === "loop") return "loop body";
  if (kind === "router") return "router branch";
  return "sub-chain";
}

/* =========================================================== branch conditions editor */

/** OR-of-ANDs condition shape mirroring the activepieces schema. */
type BranchCondition = {
  firstValue: string;
  operator: string;
  secondValue?: string;
  caseSensitive?: boolean;
};
type BranchConditions = BranchCondition[][];

/** Operators that don't take a second value -- the engine's
 *  router-executor treats `firstValue` alone. Must mirror
 *  `singleValueConditions` in
 *  `src/workflows/activepieces/.../actions/action.ts`. */
const SINGLE_VALUE_OPERATORS = new Set<string>([
  "EXISTS",
  "DOES_NOT_EXIST",
  "BOOLEAN_IS_TRUE",
  "BOOLEAN_IS_FALSE",
  "LIST_IS_EMPTY",
  "LIST_IS_NOT_EMPTY",
]);

/** Operators that respect a `caseSensitive` flag (text family). */
const CASE_SENSITIVE_OPERATORS = new Set<string>([
  "TEXT_CONTAINS",
  "TEXT_DOES_NOT_CONTAIN",
  "TEXT_EXACTLY_MATCHES",
  "TEXT_DOES_NOT_EXACTLY_MATCH",
  "TEXT_START_WITH",
  "TEXT_DOES_NOT_START_WITH",
  "TEXT_ENDS_WITH",
  "TEXT_DOES_NOT_END_WITH",
]);

/**
 * Human-readable labels for the engine's BranchOperator enum. The select
 * groups them by family (text / number / boolean / date / list /
 * existence) so the dropdown is scannable. Wire values mirror the
 * BranchOperator enum verbatim -- changing a string here would silently
 * desync from the engine and break flows at runtime.
 */
const OPERATOR_GROUPS: Array<{ label: string; options: Array<{ value: string; label: string }> }> = [
  {
    label: "Text",
    options: [
      { value: "TEXT_EXACTLY_MATCHES", label: "equals" },
      { value: "TEXT_DOES_NOT_EXACTLY_MATCH", label: "does not equal" },
      { value: "TEXT_CONTAINS", label: "contains" },
      { value: "TEXT_DOES_NOT_CONTAIN", label: "does not contain" },
      { value: "TEXT_START_WITH", label: "starts with" },
      { value: "TEXT_DOES_NOT_START_WITH", label: "does not start with" },
      { value: "TEXT_ENDS_WITH", label: "ends with" },
      { value: "TEXT_DOES_NOT_END_WITH", label: "does not end with" },
      // Regex operators: the secondValue is a JavaScript pattern.
      // Inline flags via `(?i)` etc.; the per-condition caseSensitive
      // toggle is ignored at runtime because the pattern carries its
      // own modifiers.
      { value: "TEXT_MATCHES_REGEX", label: "matches regex" },
      { value: "TEXT_DOES_NOT_MATCH_REGEX", label: "does not match regex" },
    ],
  },
  {
    label: "Number",
    options: [
      { value: "NUMBER_IS_EQUAL_TO", label: "= number" },
      { value: "NUMBER_IS_GREATER_THAN", label: "> number" },
      { value: "NUMBER_IS_LESS_THAN", label: "< number" },
    ],
  },
  {
    label: "Boolean",
    options: [
      { value: "BOOLEAN_IS_TRUE", label: "is true" },
      { value: "BOOLEAN_IS_FALSE", label: "is false" },
    ],
  },
  {
    label: "Date",
    options: [
      { value: "DATE_IS_BEFORE", label: "is before" },
      { value: "DATE_IS_EQUAL", label: "is equal to" },
      { value: "DATE_IS_AFTER", label: "is after" },
    ],
  },
  {
    label: "List",
    options: [
      { value: "LIST_CONTAINS", label: "list contains" },
      { value: "LIST_DOES_NOT_CONTAIN", label: "list does not contain" },
      { value: "LIST_IS_EMPTY", label: "list is empty" },
      { value: "LIST_IS_NOT_EMPTY", label: "list is not empty" },
    ],
  },
  {
    label: "Existence",
    options: [
      { value: "EXISTS", label: "exists / is set" },
      { value: "DOES_NOT_EXIST", label: "does not exist / is empty" },
    ],
  },
];

/**
 * Visual editor for a CONDITION branch's `conditions` array (the
 * OR-of-ANDs shape the engine consumes).
 *
 * Scope: a single OR group with N AND-ed conditions. The engine supports
 * multiple OR groups (`conditions[0..n][..]`); this UI flattens to the
 * first group so users who need complex OR composition can still edit
 * the JSON via the API, but the common case (a few AND-stacked
 * conditions) doesn't require it. Adding nested OR groups is a follow-
 * up if/when users ask.
 *
 * Each row carries: a `firstValue` (typically a `{{step.field}}`
 * template), an operator, and (for two-value operators) a `secondValue`.
 * Text operators also expose a "case sensitive" toggle.
 */
function BranchConditionsEditor({
  conditions,
  onChange,
}: {
  conditions: BranchConditions;
  onChange: (next: BranchConditions) => void;
}): React.ReactElement {
  // Flatten to the first OR group for editing. If the user authored
  // multiple OR groups elsewhere, this preserves them on the side:
  // edits only touch group 0; everything past it is appended back
  // verbatim when we emit a change.
  const firstGroup: BranchCondition[] = conditions[0] ?? [];
  const tailGroups: BranchCondition[][] = conditions.slice(1);

  const emit = useCallback(
    (nextGroup: BranchCondition[]): void => {
      // Drop the leading group entirely when empty so the engine sees
      // "no conditions" -> branch doesn't match (the user is in a
      // partially-deleted state, FALLBACK takes over).
      const next: BranchConditions = nextGroup.length > 0 ? [nextGroup, ...tailGroups] : tailGroups;
      onChange(next);
    },
    [tailGroups, onChange],
  );

  const updateAt = useCallback(
    (idx: number, patch: Partial<BranchCondition>): void => {
      const next = firstGroup.map((c, i) => (i === idx ? { ...c, ...patch } : c));
      // When the new operator no longer takes a second value, drop the
      // stale `secondValue` so the JSON stays clean (no orphan field).
      if (patch.operator && SINGLE_VALUE_OPERATORS.has(patch.operator)) {
        next[idx] = { ...next[idx]!, secondValue: undefined };
      }
      emit(next);
    },
    [firstGroup, emit],
  );

  const remove = useCallback(
    (idx: number): void => {
      emit(firstGroup.filter((_, i) => i !== idx));
    },
    [firstGroup, emit],
  );

  const add = useCallback((): void => {
    emit([
      ...firstGroup,
      { firstValue: "", operator: "TEXT_EXACTLY_MATCHES", secondValue: "" },
    ]);
  }, [firstGroup, emit]);

  return (
    <div className="wf-props__conditions">
      {firstGroup.length === 0 ? (
        <p className="wf-props__hint wf-props__hint--inline">
          No conditions yet -- this branch will never match. Add one below.
        </p>
      ) : (
        <ul className="wf-props__condition-list">
          {firstGroup.map((c, idx) => (
            <ConditionRow
              key={idx}
              condition={c}
              showAnd={idx > 0}
              onUpdate={(patch) => updateAt(idx, patch)}
              onRemove={() => remove(idx)}
            />
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" onClick={add}>
        <Icon icon={Plus} size={12} /> Add condition
      </Button>
      {tailGroups.length > 0 ? (
        <p className="wf-props__hint wf-props__hint--inline">
          {tailGroups.length} additional OR group{tailGroups.length === 1 ? "" : "s"} not
          shown -- edit them via the API if you need to.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One AND-condition row inside {@link BranchConditionsEditor}. Extracted
 * so the variable-picker hook can be called per-row -- both the
 * `firstValue` and `secondValue` inputs participate in the picker, so a
 * condition like `{{step_3.status}} = "ok"` is two clicks away.
 */
function ConditionRow({
  condition,
  showAnd,
  onUpdate,
  onRemove,
}: {
  condition: BranchCondition;
  showAnd: boolean;
  onUpdate: (patch: Partial<BranchCondition>) => void;
  onRemove: () => void;
}): React.ReactElement {
  const isSingle = SINGLE_VALUE_OPERATORS.has(condition.operator);
  const supportsCase = CASE_SENSITIVE_OPERATORS.has(condition.operator);
  return (
    <li className="wf-props__condition-row">
      {showAnd ? <span className="wf-props__condition-and">AND</span> : null}
      <VariableChipField
        className="wf-props__condition-field"
        value={condition.firstValue}
        onChange={(next) => onUpdate({ firstValue: next })}
        placeholder="{{step.field}}"
      />
      <select
        className="wf-props__condition-op"
        value={condition.operator}
        onChange={(e) => onUpdate({ operator: e.target.value })}
      >
        {OPERATOR_GROUPS.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {!isSingle ? (
        <VariableChipField
          className="wf-props__condition-field"
          value={condition.secondValue ?? ""}
          onChange={(next) => onUpdate({ secondValue: next })}
          placeholder="value"
        />
      ) : null}
      <button
        type="button"
        className="wf-props__input-remove"
        onClick={onRemove}
        title="Remove condition"
        aria-label="Remove condition"
      >
        <Icon icon={Trash2} size={12} />
      </button>
      {supportsCase ? (
        <label className="wf-props__condition-case">
          <input
            type="checkbox"
            checked={condition.caseSensitive === true}
            onChange={(e) => onUpdate({ caseSensitive: e.target.checked })}
          />
          case sensitive
        </label>
      ) : null}
    </li>
  );
}

/* ============================================================= runs panel */

/**
 * Right-side panel showing this flow's run history. Re-uses the polled
 * data from `useFlowRuns`; rows are intentionally tighter than the
 * room-level list because we're working inside the editor's narrower
 * side column. Click a row to expand its step output JSON; non-terminal
 * runs surface a Cancel button.
 */
const RUN_TERMINAL_STATUSES = new Set<FlowRunStatus>([
  "SUCCEEDED",
  "FAILED",
  "STOPPED",
  "TIMEOUT",
  "INTERNAL_ERROR",
  "QUOTA_EXCEEDED",
  "MEMORY_LIMIT_EXCEEDED",
  "SCHEDULE_FAILURE",
]);

const RUN_STATUS_TONE: Record<FlowRunStatus, "ok" | "neutral" | "warn" | "accent"> = {
  QUEUED: "neutral",
  RUNNING: "warn",
  SUCCEEDED: "ok",
  FAILED: "accent",
  PAUSED: "warn",
  TIMEOUT: "accent",
  INTERNAL_ERROR: "accent",
  QUOTA_EXCEEDED: "accent",
  STOPPED: "neutral",
  MEMORY_LIMIT_EXCEEDED: "accent",
  SCHEDULE_FAILURE: "accent",
};

function RunsPanel({
  runs,
  loading,
  error,
  overlayRunId,
  onClose,
  onRefresh,
  onCancel,
  onToggleOverlay,
}: {
  runs: FlowRun[];
  loading: boolean;
  error: string | null;
  /** Id of the run currently being overlaid on the canvas, or null. */
  overlayRunId: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onCancel: (runId: string) => Promise<void>;
  /** Click handler that toggles a run's status overlay on the canvas. */
  onToggleOverlay: (runId: string) => void;
}): React.ReactElement {
  const activeCount = runs.filter((r) => !RUN_TERMINAL_STATUSES.has(r.status)).length;
  return (
    <aside className="wf-editor__runs-panel" aria-label="Workflow runs">
      <header className="wf-editor__runs-header">
        <div className="wf-editor__runs-title">
          <Icon icon={History} size={14} />
          <span>Runs</span>
          <span className="wf-editor__runs-meta">
            {runs.length === 0 ? "no runs yet" : `${runs.length} total${activeCount > 0 ? ` · ${activeCount} active` : ""}`}
          </span>
        </div>
        <div className="wf-editor__runs-actions">
          <Button variant="ghost" size="sm" onClick={onRefresh} title="Refresh">
            <Icon icon={RotateCcw} size={12} />
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close runs panel">
            <Icon icon={X} size={12} />
          </Button>
        </div>
      </header>
      {error ? (
        <div className="wf-editor__runs-error">{error}</div>
      ) : null}
      {runs.length === 0 ? (
        <div className="wf-editor__runs-empty">
          {loading ? "Loading runs..." : "No runs yet. Click Run above to queue one."}
        </div>
      ) : (
        <ul className="wf-editor__runs-list">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              overlayActive={overlayRunId === run.id}
              onCancel={() => onCancel(run.id)}
              onToggleOverlay={() => onToggleOverlay(run.id)}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

function RunRow({
  run,
  overlayActive,
  onCancel,
  onToggleOverlay,
}: {
  run: FlowRun;
  /** True when this run is the one currently overlaid on the canvas. */
  overlayActive: boolean;
  onCancel: () => Promise<void>;
  onToggleOverlay: () => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState<boolean>(false);
  const isTerminal = RUN_TERMINAL_STATUSES.has(run.status);
  const duration = run.startTime && run.finishTime
    ? formatDuration(run.finishTime - run.startTime)
    : run.startTime
      ? formatDuration(Date.now() - run.startTime) + "..."
      : "—";
  const startedAt = run.startTime
    ? new Date(run.startTime).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
  // Pull the failed step's error message (if any) so the row can show a
  // one-line preview without expanding. The error often explains the
  // failure more clearly than the bare status word ("FAILED" -> "rate
  // limit hit at 429").
  const failedStepError = useMemo<string | null>(() => {
    if (!run.failedStep || !run.steps) return null;
    const entry = (run.steps as Record<string, unknown>)[run.failedStep.name];
    if (!entry || typeof entry !== "object") return null;
    const wrapper = entry as { output?: unknown };
    const stepOutput = wrapper.output !== undefined ? wrapper.output : entry;
    const so = stepOutput as { errorMessage?: unknown };
    return stringifyErrorMessage(so.errorMessage);
  }, [run.failedStep, run.steps]);

  return (
    <li
      className={`wf-editor__run wf-editor__run--${RUN_STATUS_TONE[run.status]} ${
        overlayActive ? "wf-editor__run--overlay-active" : ""
      }`}
    >
      <button
        type="button"
        className="wf-editor__run-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="wf-editor__run-icon" aria-hidden="true">
          <RunStatusIcon status={run.status} />
        </span>
        <span className="wf-editor__run-status">{run.status}</span>
        {run.failedStep ? (
          <span className="wf-editor__run-failed">@ {run.failedStep.displayName}</span>
        ) : null}
        <span className="wf-editor__run-time">{startedAt}</span>
        <span className="wf-editor__run-duration">{duration}</span>
      </button>
      {/* One-line error preview, shown directly under the status row so
          the user doesn't have to expand to see what went wrong. Tooltip
          carries the full message when truncated. */}
      {failedStepError ? (
        <p className="wf-editor__run-error" title={failedStepError}>
          {failedStepError}
        </p>
      ) : null}
      {/* Show-on-canvas toggle. Rendered for every run so the user can
          inspect any past run's path, not just failed ones. */}
      <div className="wf-editor__run-actions">
        <Button
          variant={overlayActive ? "primary" : "ghost"}
          size="sm"
          onClick={onToggleOverlay}
          title={overlayActive ? "Hide overlay" : "Highlight this run on the canvas"}
        >
          {overlayActive ? "Hide on canvas" : "Show on canvas"}
        </Button>
      </div>
      {expanded ? (
        <div className="wf-editor__run-body">
          <dl className="wf-editor__run-kv">
            <dt>Id</dt>
            <dd><code>{run.id}</code></dd>
            <dt>Steps</dt>
            <dd>{run.stepsCount ?? 0}</dd>
            <dt>Trigger</dt>
            <dd>{run.triggeredBy ?? "manual"}</dd>
            <dt>Env</dt>
            <dd>{run.environment}</dd>
          </dl>
          {run.steps && Object.keys(run.steps).length > 0 ? (
            <details className="wf-editor__run-output">
              <summary>Step output JSON</summary>
              <pre>{JSON.stringify(run.steps, null, 2)}</pre>
            </details>
          ) : null}
          {!isTerminal ? (
            <Button variant="danger" size="sm" onClick={() => void onCancel()}>
              <Icon icon={X} size={12} /> Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Banner showing which past run is being overlaid on the canvas, with a
 * close button to exit overlay mode. Sits below the running banner when
 * both are active (live in-flight + overlaying a past run).
 *
 * `hasOverlayData=false` means we have a run row but no usable per-step
 * trace (PRODUCTION run with no streamStepProgress, or a run that
 * timed out before any step output landed). In that case the banner
 * surfaces a "limited trace" hint so the user knows why no nodes are
 * lighting up -- otherwise the click feels like a no-op.
 */
function OverlayBanner({
  run,
  hasOverlayData,
  onClear,
}: {
  run: FlowRun;
  hasOverlayData: boolean;
  onClear: () => void;
}): React.ReactElement {
  const startedAt = run.startTime
    ? new Date(run.startTime).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
  return (
    <div
      className={`wf-editor__overlay-banner wf-editor__overlay-banner--${RUN_STATUS_TONE[run.status]}`}
      role="status"
    >
      <span className="wf-editor__overlay-banner-icon" aria-hidden="true">
        <RunStatusIcon status={run.status} />
      </span>
      <span className="wf-editor__overlay-banner-text">
        Viewing run {startedAt} -- <strong>{run.status}</strong>
        {run.failedStep ? <> at <code>{run.failedStep.displayName}</code></> : null}
        {!hasOverlayData ? (
          <em className="wf-editor__overlay-banner-note">
            {" "}-- no per-step trace recorded for this run
          </em>
        ) : null}
      </span>
      <button
        type="button"
        className="wf-editor__overlay-banner-clear"
        onClick={onClear}
        title="Exit overlay mode"
        aria-label="Exit overlay mode"
      >
        <Icon icon={X} size={12} /> Exit
      </button>
    </div>
  );
}

function RunStatusIcon({ status }: { status: FlowRunStatus }): React.ReactElement {
  if (status === "SUCCEEDED") return <Icon icon={CheckCircle2} size={12} />;
  if (status === "FAILED" || status === "INTERNAL_ERROR" || status === "TIMEOUT") {
    return <Icon icon={XCircle} size={12} />;
  }
  if (status === "PAUSED") return <Icon icon={Pause} size={12} />;
  if (status === "RUNNING" || status === "QUEUED") return <Icon icon={Clock} size={12} />;
  return <Icon icon={AlertTriangle} size={12} />;
}

/**
 * Floating popover that surfaces a single step's execution data from the
 * overlaid run -- input, output, error, duration, status. Opens at the
 * cursor when the user clicks a node while overlay mode is active.
 *
 * Read-only. Closing semantics mirror NodeSettingsPopover (outside-click
 * + Esc), so the user can dismiss without leaving overlay mode.
 */
function RunStepDetailPopover({
  anchor,
  run,
  stepName,
  onClose,
}: {
  anchor: { x: number; y: number };
  run: FlowRun;
  stepName: string;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>(() =>
    clampPopoverToViewport(anchor, undefined),
  );

  // Pull the wrapped step entry. Worker handlers store output as
  // `{ output: <StepOutput> }`; some legacy code paths may store the
  // StepOutput directly. Tolerate both.
  const snapshot = useMemo(() => {
    const steps = (run.steps ?? {}) as Record<string, unknown>;
    const entry = steps[stepName];
    if (!entry || typeof entry !== "object") return null;
    const wrapper = entry as { output?: unknown };
    const stepOutput = wrapper.output !== undefined ? wrapper.output : entry;
    return stepOutput as {
      status?: string;
      input?: unknown;
      output?: unknown;
      errorMessage?: unknown;
      duration?: number;
    };
  }, [run.steps, stepName]);

  // Clamp position once we know the popover's measured size. useLayoutEffect
  // so the first paint is already correct (no flicker on the way to the
  // clamped position).
  useLayoutEffect(() => {
    setPos(clampPopoverToViewport(anchor, ref.current ?? undefined));
  }, [anchor, snapshot]);

  // Outside-click closes. Deferred so the click that opened us doesn't
  // immediately dismiss.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!ref.current) return;
      const target = e.target as globalThis.Node;
      if (ref.current.contains(target)) return;
      onClose();
    };
    const timer = window.setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const status = snapshot?.status ?? null;
  const statusTone: "ok" | "warn" | "accent" | "neutral" =
    status === "SUCCEEDED"
      ? "ok"
      : status === "FAILED"
        ? "accent"
        : status === "PAUSED" || status === "RUNNING"
          ? "warn"
          : "neutral";
  const errorText = snapshot ? stringifyErrorMessage(snapshot.errorMessage) : null;

  return createPortal(
    <div
      ref={ref}
      className="wf-run-detail"
      role="dialog"
      aria-label={`Run details for ${stepName}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <header className={`wf-run-detail__header wf-run-detail__header--${statusTone}`}>
        <span className="wf-run-detail__title">
          <code>{stepName}</code>
        </span>
        <span className="wf-run-detail__status">
          {status ?? "not reached"}
          {typeof snapshot?.duration === "number" ? (
            <span className="wf-run-detail__duration">{formatDuration(snapshot.duration)}</span>
          ) : null}
        </span>
        <button
          type="button"
          className="wf-run-detail__close"
          onClick={onClose}
          aria-label="Close run details"
        >
          <Icon icon={X} size={12} />
        </button>
      </header>
      {!snapshot ? (
        <div className="wf-run-detail__empty">
          This step didn't execute in this run.
        </div>
      ) : (
        <div className="wf-run-detail__body">
          {errorText ? (
            <section className="wf-run-detail__section wf-run-detail__section--error">
              <h4>Error</h4>
              <pre>{errorText}</pre>
            </section>
          ) : null}
          {snapshot.output !== undefined ? (
            <section className="wf-run-detail__section">
              <h4>Output</h4>
              <pre>{stringifyForDisplay(snapshot.output)}</pre>
            </section>
          ) : null}
          {snapshot.input !== undefined && !isEmptyValue(snapshot.input) ? (
            <section className="wf-run-detail__section">
              <h4>Input</h4>
              <pre>{stringifyForDisplay(snapshot.input)}</pre>
            </section>
          ) : null}
        </div>
      )}
    </div>,
    document.body,
  );
}

const RUN_DETAIL_WIDTH = 380;

/**
 * Conservative viewport clamp for popovers we render via portal. Mirrors
 * the behaviour of NodeSettingsPopover's `clampToViewport` helper but
 * lives here to avoid leaking that internal helper across components.
 */
function clampPopoverToViewport(
  anchor: { x: number; y: number },
  el: HTMLElement | undefined,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = el?.offsetWidth ?? RUN_DETAIL_WIDTH;
  const height = el?.offsetHeight ?? 320;
  let left = anchor.x;
  let top = anchor.y;
  if (left + width + 12 > vw) left = Math.max(12, vw - width - 12);
  if (top + height + 12 > vh) top = Math.max(12, vh - height - 12);
  return { left, top };
}

function stringifyForDisplay(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "object" && !Array.isArray(v)) {
    return Object.keys(v as Record<string, unknown>).length === 0;
  }
  return false;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs.toString().padStart(2, "0")}s`;
}

/**
 * Per-step status on a canvas node, derived from `flow_run.steps[stepName]`.
 *
 *   succeeded    Step ran and SUCCEEDED -- show a green pip.
 *   failed       Step ran and FAILED   -- show a red pip + the error.
 *   paused       Step is awaiting a waitpoint (PAUSED state).
 *   running      Step is currently in-flight (the run is RUNNING and this
 *                step has a RUNNING StepOutput entry, OR the run is RUNNING
 *                and this step is downstream of the latest progress).
 *   skipped      Step has an entry but didn't execute -- usually a router
 *                branch that wasn't selected.
 *   not-reached  Run terminated before this step was reached.
 */
export type CanvasRunStatus =
  | "succeeded"
  | "failed"
  | "paused"
  | "running"
  | "skipped"
  | "not-reached";

/**
 * One step's snapshot pulled from `flow_run.steps`. The worker wraps each
 * engine-streamed step output in `{ output: <StepOutput> }`, so we unwrap
 * once here and hand callers a flat shape.
 */
export interface CanvasStepSnapshot {
  status: CanvasRunStatus;
  /** Stringified error message when status is "failed". */
  errorMessage: string | null;
  /** ms spent in this step, if the engine recorded one. */
  duration: number | null;
}

/**
 * Decide a CanvasRunStatus per step name from a run row's `steps` map.
 *
 * Three modes:
 *
 *   1. Steps map is populated (TESTING runs, or partially-populated
 *      PRODUCTION runs after a few engine progress updates landed):
 *      each named step gets a status from the entry; unnamed steps fall
 *      through to "not-reached" so the user sees which branches the run
 *      did NOT take.
 *
 *   2. Steps map is EMPTY but the run has a `failedStep` (common for
 *      PRODUCTION runs that ran with `streamStepProgress: NONE` and
 *      failed before any uploadRunLog populated the steps tree): mark
 *      only that one step as "failed" and leave everything else
 *      unmarked (no fade). The banner already tells the user which run
 *      they're viewing; fading the whole canvas would be confusing.
 *
 *   3. Steps map is empty AND no failedStep: the run has no usable
 *      per-step trace. Return an empty map so the canvas renders as
 *      normal -- the overlay banner is enough to convey "viewing this
 *      run" without applying any node-level styling.
 */
export function buildRunOverlay(
  run: FlowRun | null,
  stepNames: string[],
): Record<string, CanvasStepSnapshot> {
  if (!run) return {};
  const steps = (run.steps ?? {}) as Record<string, unknown>;
  const hasStepData = Object.keys(steps).length > 0;
  const canvasNames = new Set(stepNames);

  // Mode 2: empty steps + a known failed step that maps to a CANVAS step.
  // Some engine-level failures (e.g. the terminal-timeout path) emit a
  // synthetic failedStep with name "engine" that doesn't correspond to a
  // user-visible node -- skip the highlight in that case so we don't end
  // up with an overlay map keyed by a name no node can match (which used
  // to silently produce a "nothing happens" feeling).
  if (!hasStepData && run.failedStep && canvasNames.has(run.failedStep.name)) {
    return {
      [run.failedStep.name]: {
        status: "failed",
        errorMessage: null,
        duration: null,
      },
    };
  }
  // Mode 3: nothing actionable -- skip overlay so the canvas isn't dimmed.
  // The OverlayBanner explains the state so the user doesn't feel like
  // the click did nothing.
  if (!hasStepData) return {};

  // Mode 1: rich per-step trace.
  const out: Record<string, CanvasStepSnapshot> = {};
  const isRunActive = run.status === "RUNNING" || run.status === "QUEUED";
  for (const name of stepNames) {
    const entry = steps[name];
    if (!entry || typeof entry !== "object") {
      // No record yet. For a still-running flow we DON'T know if this
      // step is upcoming or skipped, but "not-reached" is the honest
      // default -- it'll flip to "succeeded" once the engine streams
      // its output. For a terminal run, "not-reached" is correct.
      out[name] = { status: "not-reached", errorMessage: null, duration: null };
      continue;
    }
    // `{ output: StepOutput }` wrapper added by the worker. Tolerate
    // already-unwrapped entries (defensive).
    const wrapper = entry as { output?: unknown };
    const stepOutput = wrapper.output !== undefined ? wrapper.output : entry;
    const so = stepOutput as {
      status?: string;
      errorMessage?: unknown;
      duration?: number;
    };
    let status: CanvasRunStatus;
    switch (so.status) {
      case "SUCCEEDED":
        status = "succeeded";
        break;
      case "FAILED":
        status = "failed";
        break;
      case "PAUSED":
        status = "paused";
        break;
      case "RUNNING":
        status = isRunActive ? "running" : "not-reached";
        break;
      case "STOPPED":
        status = "skipped";
        break;
      default:
        status = "not-reached";
    }
    out[name] = {
      status,
      errorMessage: stringifyErrorMessage(so.errorMessage),
      duration: typeof so.duration === "number" ? so.duration : null,
    };
  }
  return out;
}

function stringifyErrorMessage(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

/**
 * Sticky banner at the top of the editor body that surfaces in-flight
 * runs. Clicking the banner opens the runs panel (the natural "I want
 * details" affordance). The banner self-updates the elapsed duration via
 * a 1s ticker while a run is RUNNING so users get live feedback even
 * when the polling loop is on the 2s cadence.
 */
function RunningBanner({
  activeCount,
  run,
  onOpenPanel,
}: {
  activeCount: number;
  run: FlowRun;
  onOpenPanel: () => void;
}): React.ReactElement {
  // Live elapsed time. Re-renders once per second so the duration ticks
  // in real time; the underlying run object only refreshes every 2s.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    // Only RUNNING / PAUSED are worth ticking; QUEUED has no start time
    // yet so the duration display would be meaningless.
    if (run.status !== "RUNNING" && run.status !== "PAUSED") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [run.status]);

  // Compose the headline text. Multiple active runs collapse to a count;
  // single-run is the common case and gets the specific status.
  const headline =
    activeCount === 1
      ? `${run.status}${run.failedStep ? ` @ ${run.failedStep.displayName}` : ""}`
      : `${activeCount} runs in flight`;

  // Duration: live for RUNNING / PAUSED, frozen for QUEUED (no startTime).
  const duration = run.startTime
    ? formatDuration(now - run.startTime)
    : run.status === "QUEUED"
      ? "queued"
      : "—";

  // Tone derived from the status -- maps to a CSS modifier so the bar
  // gets a tinted background appropriate for the state.
  const tone: "warn" | "neutral" =
    run.status === "RUNNING" || run.status === "PAUSED" ? "warn" : "neutral";

  return (
    <button
      type="button"
      className={`wf-editor__running-banner wf-editor__running-banner--${tone}`}
      onClick={onOpenPanel}
      title="Open runs panel"
      aria-live="polite"
    >
      <span className="wf-editor__running-banner-icon" aria-hidden="true">
        <RunStatusIcon status={run.status} />
        {run.status === "RUNNING" ? (
          <span className="wf-editor__running-banner-pulse" />
        ) : null}
      </span>
      <span className="wf-editor__running-banner-text">{headline}</span>
      <span className="wf-editor__running-banner-duration">{duration}</span>
      <span className="wf-editor__running-banner-cta">View runs</span>
    </button>
  );
}
