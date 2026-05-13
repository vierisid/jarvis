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
import { LayoutGrid, Save, RotateCcw, ShieldAlert, X, Plus, Trash2 } from "lucide-react";
import { Button, Chip, Icon } from "../../ui";
import {
  useWorkflowEditor,
  type FlatStep,
  type FlowStepNode,
  type OrphanStep,
  type PieceCatalogActionOrTrigger,
  type PieceCatalogEntry,
  type PieceInputField,
} from "./useWorkflowEditor";
import { flattenSteps, pathToStep } from "./tree";
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
}

export function WorkflowEditor({ flowId, onClose }: WorkflowEditorProps): React.ReactElement {
  const editor = useWorkflowEditor(flowId);
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
    | { screen: { x: number; y: number }; flow: { x: number; y: number } }
    | null
  >(null);
  const closeLibraryPicker = useCallback((): void => setLibraryPicker(null), []);
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

  // Build the canonical graph from the chain. `baseNodes` reflects the
  // chain's authoritative order; React Flow needs an internal mutable copy
  // so dragged positions update visually without losing reactivity.
  const { nodes: baseNodes, edges } = useMemo(
    () => buildGraph(editor.draftTrigger, editor.allSteps, editor.draftOrphans, selectedStepName, editor.catalog, editor.stepPositions),
    [editor.draftTrigger, editor.allSteps, editor.draftOrphans, selectedStepName, editor.catalog, editor.stepPositions],
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
   * Route a library pick to the right orphan-spawn action. Piece actions
   * land as configured PIECE steps with schema-default inputs; control-
   * flow built-ins land as native LOOP_ON_ITEMS / ROUTER nodes with
   * sensible defaults (see `createOrphanControlFlowStep`).
   */
  const onPickFromLibrary = useCallback(
    (entry: LibraryEntry): void => {
      if (!libraryPicker) return;
      if (entry.kind === "control-flow") {
        editor.createOrphanControlFlowStep(libraryPicker.flow, entry.controlType);
      } else {
        editor.createOrphanStep(libraryPicker.flow, entry.piece.name, entry.action.name);
      }
      closeLibraryPicker();
    },
    [editor, libraryPicker, closeLibraryPicker],
  );

  return (
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
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={!editor.dirty}>
            <Icon icon={RotateCcw} size={14} /> Discard
          </Button>
          <Button variant="primary" size="sm" onClick={() => void onSave()} disabled={!editor.dirty}>
            <Icon icon={Save} size={14} /> Save
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close editor">
            <Icon icon={X} size={14} />
          </Button>
        </div>
      </header>

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
              setSelectedStepName(n.id);
              setPopoverAnchor({ x: event.clientX, y: event.clientY });
            }}
            onPaneClick={() => {
              closePopover();
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
        >
          <PropertiesPanel
            step={selectedStep}
            isTriggerStep={editor.draftTrigger?.name === selectedStep.name}
            hasNextAction={!!selectedStep.nextAction}
            isTopLevel={selectedDepth === 0}
            containerKind={selectedFlat?.containerKind}
            catalog={editor.catalog}
            onSetPiece={(pieceName, actionName) => editor.setStepPiece(selectedStep.name, pieceName, actionName)}
            onSetTriggerType={(type) => editor.setTriggerType(type)}
            onSetErrorHandling={(patch) => editor.setStepErrorHandling(selectedStep.name, patch)}
            onSetInput={(key, value) => editor.updateStepInput(selectedStep.name, key, value)}
            onAddInputKey={(key) => editor.updateStepInput(selectedStep.name, key, "")}
            onRemoveInputKey={(key) => {
              const settings = selectedStep.settings ?? {};
              const input = { ...(settings.input ?? {}) };
              delete input[key];
              editor.updateStep(selectedStep.name, { settings: { ...settings, input } });
            }}
            onSetDisplayName={(displayName) => editor.updateStep(selectedStep.name, { displayName })}
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
            isLocked={editor.version?.state === "LOCKED"}
            onSetSampleData={(output) =>
              editor.setStepSampleData(selectedStep.name, output)
            }
            onTestFromHere={() => editor.testStepFromHere(selectedStep.name)}
          />
        </NodeSettingsPopover>
      ) : null}
    </div>
  );
}

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

/**
 * Build a flat list of "output rows" from a chain of predecessor steps.
 * Recent steps come first ({@code reverse()}); within each step, we list
 * one row per top-level key of its sample data. Steps with no sample
 * data show a single "(output)" row that inserts the whole-step template.
 */
interface VariableRow {
  /** The step that produces this output. */
  step: FlowStepNode;
  /** Field key (`"name"`) -- empty for whole-output rows. */
  field: string;
  /** Display label shown in the picker; matches `field` or "(output)". */
  label: string;
  /** Full template inserted into the input: `{{stepName.field}}` or `{{stepName}}`. */
  template: string;
}

function buildVariableRows(
  predecessors: FlowStepNode[],
  sampleData: Record<string, unknown>,
): VariableRow[] {
  const rows: VariableRow[] = [];
  // Most-recent first: the chain comes out trigger-first from
  // pathToStep, but the user wants the closest predecessor on top.
  const ordered = [...predecessors].reverse();
  for (const step of ordered) {
    const sample = sampleData[step.name];
    if (sample && typeof sample === "object" && !Array.isArray(sample)) {
      const entries = Object.keys(sample as Record<string, unknown>);
      if (entries.length === 0) {
        rows.push({ step, field: "", label: "(output)", template: `{{${step.name}}}` });
      } else {
        for (const key of entries) {
          rows.push({
            step,
            field: key,
            label: key,
            template: `{{${step.name}.${key}}}`,
          });
        }
      }
    } else {
      // No sample data, array-typed, or primitive -- offer the
      // whole-step template; the user can drill in with `.field` manually.
      rows.push({ step, field: "", label: "(output)", template: `{{${step.name}}}` });
    }
  }
  return rows;
}

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
  children,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
  predecessors: FlowStepNode[];
  sampleData: Record<string, unknown>;
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
      // Clicks inside the picker shouldn't close the settings popover.
      const pickerEl = document.querySelector(".wf-var-picker");
      if (pickerEl && pickerEl.contains(target)) return;
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
    () => buildVariableRows(predecessors, sampleData),
    [predecessors, sampleData],
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
 * picker's `onPick` callback can route piece actions and engine-built-in
 * control-flow steps to the right editor action.
 */
type LibraryEntry =
  | {
      kind: "piece-action";
      piece: PieceCatalogEntry;
      action: PieceCatalogActionOrTrigger;
    }
  | {
      kind: "control-flow";
      controlType: "LOOP_ON_ITEMS" | "IF" | "ROUTER";
      displayName: string;
      description: string;
    };

type LibraryCategory = "all" | "action" | "control";

const CATEGORY_LABEL: Record<LibraryCategory, string> = {
  all: "All",
  action: "Actions",
  control: "Control flow",
};
const CATEGORY_ORDER: LibraryCategory[] = ["all", "action", "control"];

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

function entryCategory(e: LibraryEntry): "action" | "control" {
  return e.kind === "control-flow" ? "control" : "action";
}

function entryKey(e: LibraryEntry): string {
  return e.kind === "control-flow"
    ? `control:${e.controlType}`
    : `piece:${e.piece.name}::${e.action.name}`;
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
  onPick,
  onClose,
}: {
  anchor: { x: number; y: number };
  catalog: PieceCatalogEntry[];
  onPick: (entry: LibraryEntry) => void;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<LibraryCategory>("all");
  const [activeIdx, setActiveIdx] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });

  // Build the unified entry list. Control-flow entries are pushed up top
  // when the user is in "all" or "control" so they're immediately
  // visible (they're the more common "where do I add an if?" question).
  const entries = useMemo<LibraryEntry[]>(() => {
    const pieceEntries: LibraryEntry[] = [];
    for (const p of catalog) {
      for (const a of p.actions) {
        pieceEntries.push({ kind: "piece-action", piece: p, action: a });
      }
    }
    return [...CONTROL_FLOW_ENTRIES, ...pieceEntries];
  }, [catalog]);

  // Apply the category filter and search query. Same lowercased q is
  // reused across every entry so we don't pay for the per-iteration call.
  const rows = useMemo<LibraryEntry[]>(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (category !== "all" && entryCategory(e) !== category) return false;
      return entryMatchesQuery(e, q);
    });
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
  // doesn't immediately bounce.
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

  // Keyboard nav: handled via a keydown attached to the popover so it
  // doesn't fight with the global Esc-closes-editor handler.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(rows.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const row = rows[activeIdx];
        if (row) onPick(row);
      }
    },
    [rows, activeIdx, onPick, onClose],
  );

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
          {rows.map((entry, i) => (
            <li key={entryKey(entry)}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIdx}
                className={`wf-library__row ${i === activeIdx ? "wf-library__row--active" : ""}`}
                onClick={() => onPick(entry)}
                onMouseEnter={() => setActiveIdx(i)}
              >
                <LibraryRowContent entry={entry} />
              </button>
            </li>
          ))}
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
function LibraryRowContent({ entry }: { entry: LibraryEntry }): React.ReactElement {
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

  const gridPositions: Record<string, { col: number; row: number }> = {};
  const layout = (node: FlowStepNode | undefined | null, col: number, row: number): void => {
    if (!node || gridPositions[node.name]) return;
    gridPositions[node.name] = { col, row };

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
        for (let i = 0; i < branches.length; i++) {
          const h = branchHeights[i] || 1;
          const centre = cursor + (h - 1) / 2;
          layout(branches[i], col + 1, centre);
          cursor += h;
        }
      }
    }
    if (node.type === "LOOP_ON_ITEMS" && node.firstLoopAction) {
      // Body sits below the chain (chain occupies rows row..row+chainH-1).
      const chainH = node.nextAction ? height(node.nextAction) : 1;
      layout(node.firstLoopAction, col + 1, row + chainH);
    }
    if (node.nextAction) {
      layout(node.nextAction, col + 1, row);
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
    // ROUTER nodes don't render a separate "out" handle -- after-router
    // composition lives inside each branch's chain. Emitting an edge to
    // a non-existent source handle would leave xyflow routing from the
    // node centre, which looks broken; skip the edge entirely. Any
    // existing `router.nextAction` in the data model survives the
    // round-trip (we don't mutate it), it's just not drawn.
    if (
      step.nextAction &&
      knownNames.has(step.nextAction.name) &&
      step.type !== "ROUTER"
    ) {
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
      return [
        { id: "loop-body", title: "Iterates", used: loopBodyConnected },
        { id: "out", title: "After loop", used: outConnected },
      ];
    }
    if (isRouter) {
      return branches.map((b, i) => {
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
    }
    return [{ id: "out", title: "Next step", used: outConnected }];
  })();

  return (
    <div
      className={`wf-node ${selected ? "wf-node--selected" : ""} ${isUnconfigured ? "wf-node--unconfigured" : ""} ${depth > 0 ? "wf-node--nested" : ""} ${isOrphan ? "wf-node--orphan" : ""}`}
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
  /**
   * Persisted sample data for this step (the output the engine will feed to
   * downstream steps when running with `stepNameToTest`). Undefined when
   * never set.
   */
  sampleData: unknown | undefined;
  /** True when the loaded version is LOCKED -- disables sample-data editing + test. */
  isLocked: boolean;
  onSetPiece: (pieceName: string, actionName: string) => void;
  onSetTriggerType: (type: "EMPTY" | "PIECE_TRIGGER") => void;
  onSetErrorHandling: (patch: { continueOnFailure?: boolean; retryOnFailure?: boolean }) => void;
  onSetInput: (key: string, value: unknown) => void;
  onAddInputKey: (key: string) => void;
  onRemoveInputKey: (key: string) => void;
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
    onSetPiece,
    onSetTriggerType,
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
  const subActions = isTrigger ? piece?.triggers ?? [] : piece?.actions ?? [];

  // Find the selected sub-action's metadata. If it has an inputSchema we
  // render typed widgets; otherwise the freeform key/value editor stays as
  // the fallback (pieces without a declared schema still work).
  const subName = isTrigger ? step.settings?.triggerName : step.settings?.actionName;
  const selectedSubAction: PieceCatalogActionOrTrigger | undefined = subActions.find((s) => s.name === subName);
  const schema = selectedSubAction?.inputSchema ?? null;

  const [newKey, setNewKey] = useState("");

  const onPieceChange = useCallback(
    (pieceName: string): void => {
      const target = catalog.find((p) => p.name === pieceName);
      if (!target) return;
      const list = isTrigger ? target.triggers : target.actions;
      const firstSub = list[0]?.name ?? "";
      onSetPiece(pieceName, firstSub);
    },
    [catalog, isTrigger, onSetPiece],
  );

  const onSubChange = useCallback(
    (subName: string): void => {
      if (step.settings?.pieceName) onSetPiece(step.settings.pieceName, subName);
    },
    [step.settings?.pieceName, onSetPiece],
  );

  const inputEntries = useMemo(
    () => Object.entries(step.settings?.input ?? {}),
    [step.settings?.input],
  );

  return (
    <div className="wf-props">
      <header className="wf-props__header">
        <h3>{step.displayName ?? step.name}</h3>
        <p>
          <code>{step.name}</code> · {isTrigger ? (isManual ? "Manual trigger" : "Piece trigger") : "Action"}
        </p>
      </header>

      <Field label="Display name">
        <input
          type="text"
          value={step.displayName ?? ""}
          placeholder={step.name}
          onChange={(e) => onSetDisplayName(e.target.value)}
        />
      </Field>

      {isTriggerStep ? (
        <Field label="Trigger mode">
          <div className="wf-props__segmented" role="radiogroup">
            <button
              type="button"
              role="radio"
              aria-checked={step.type === "EMPTY"}
              className={`wf-props__seg ${step.type === "EMPTY" ? "wf-props__seg--on" : ""}`}
              onClick={() => onSetTriggerType("EMPTY")}
            >
              Manual
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={step.type === "PIECE_TRIGGER"}
              className={`wf-props__seg ${step.type === "PIECE_TRIGGER" ? "wf-props__seg--on" : ""}`}
              onClick={() => onSetTriggerType("PIECE_TRIGGER")}
            >
              Schedule / webhook / event
            </button>
          </div>
        </Field>
      ) : null}

      {isManual ? (
        <p className="wf-props__hint">
          Manual triggers fire only when you POST to <code>/api/workflows/:id/run</code>. Switch to
          "Schedule / webhook / event" above to fire automatically.
        </p>
      ) : null}

      {!isManual && !isLoop && !isRouter ? (
        <>
          <Field label={isTrigger ? "Trigger piece" : "Action piece"}>
            <select
              value={step.settings?.pieceName ?? ""}
              onChange={(e) => onPieceChange(e.target.value)}
            >
              <option value="" disabled>
                — pick a piece —
              </option>
              {catalog
                .filter((p) => (isTrigger ? p.triggers.length > 0 : p.actions.length > 0))
                .map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.displayName}
                  </option>
                ))}
            </select>
          </Field>

          {piece ? (
            <Field label={isTrigger ? "Trigger" : "Action"}>
              <select
                value={(isTrigger ? step.settings?.triggerName : step.settings?.actionName) ?? ""}
                onChange={(e) => onSubChange(e.target.value)}
              >
                <option value="" disabled>
                  — pick {isTrigger ? "a trigger" : "an action"} —
                </option>
                {subActions.map((s) => (
                  <option key={s.name} value={s.name} title={s.description}>
                    {s.displayName}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </>
      ) : null}

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

      <div className="wf-props__divider" />

      {!isLoop && !isRouter ? (
        <div className="wf-props__inputs">
          <div className="wf-props__inputs-head">
            <h4>Inputs</h4>
          </div>

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

      {/* Error handling lives on PIECE / CODE steps only -- the engine's
          retry + continue-on-failure helpers explicitly type-narrow to
          those. Rendering this for LOOP/ROUTER/EMPTY would mislead the
          user since their toggles would be ignored at runtime. */}
      {step.type === "PIECE" && !isTriggerStep ? (
        <>
          <div className="wf-props__divider" />
          <ErrorHandlingSection
            continueOnFailure={!!step.settings?.errorHandlingOptions?.continueOnFailure?.value}
            retryOnFailure={!!step.settings?.errorHandlingOptions?.retryOnFailure?.value}
            onChange={onSetErrorHandling}
          />
        </>
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

      <SampleDataSection
        // `key` resets the section's internal text/state cleanly when the
        // user switches steps, so the textarea always starts from the new
        // step's persisted value rather than effect-syncing mid-edit (which
        // would clobber in-flight typing during a Save round-trip).
        key={step.name}
        stepName={step.name}
        sampleData={props.sampleData}
        isLocked={props.isLocked}
        isTriggerStep={isTriggerStep}
        onSetSampleData={props.onSetSampleData}
        onTestFromHere={props.onTestFromHere}
      />
    </div>
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
 * Per-step sample data editor + "Test from here" button. Renders inside the
 * properties panel below the step-actions row.
 *
 * The textarea holds the JSON for THIS step's sample output -- what the
 * engine would feed to downstream steps that reference {{ stepName.foo }}
 * when running with stepNameToTest. The "Test from here" button fires a
 * run with stepNameToTest set to this step name; the engine populates the
 * preceding steps' outputs from the version's persisted sampleData map.
 *
 * The trigger step also accepts sample data -- that becomes the trigger
 * payload visible to the first action. The button label adapts.
 */
function SampleDataSection({
  sampleData,
  isLocked,
  isTriggerStep,
  onSetSampleData,
  onTestFromHere,
}: {
  stepName: string;
  sampleData: unknown | undefined;
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
  const [busy, setBusy] = useState<"save" | "test" | "clear" | null>(null);

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

  return (
    <section className="wf-props__sample-data" aria-label="Sample data + test from here">
      <header className="wf-props__sample-header">
        <h4 className="wf-props__sample-title">
          Sample {isTriggerStep ? "trigger payload" : "output"}
        </h4>
        <p className="wf-props__hint">
          {isTriggerStep
            ? "JSON the test run feeds to the trigger. Downstream steps see it as the trigger payload."
            : "JSON the test run feeds to downstream steps. Lets you run a step in isolation without re-executing the chain."}
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
              : "Run only this step using the saved sample data for preceding steps"
          }
        >
          {busy === "test" ? "Queuing..." : "Test from here"}
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
        {field.description ? <span className="wf-props__field-help">{field.description}</span> : null}
      </label>
    );
  }

  if (field.type === "enum") {
    return (
      <label className={`wf-props__field ${isMissing ? "wf-props__field--missing" : ""}`}>
        {labelEl}
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">{field.required ? "— select —" : "— none —"}</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value} title={o.description}>
              {o.label}
            </option>
          ))}
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
