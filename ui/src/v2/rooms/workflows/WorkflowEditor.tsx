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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Save, RotateCcw, X, Plus, Trash2 } from "lucide-react";
import { Button, Chip, Icon } from "../../ui";
import {
  useWorkflowEditor,
  type FlatStep,
  type FlowStepNode,
  type PieceCatalogActionOrTrigger,
  type PieceCatalogEntry,
  type PieceInputField,
} from "./useWorkflowEditor";
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
}

export function WorkflowEditor({ flowId, onClose }: WorkflowEditorProps): React.ReactElement {
  const editor = useWorkflowEditor(flowId);
  const [selectedStepName, setSelectedStepName] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  // Keep selection valid: when steps shift, drop the selection if it doesn't exist.
  useEffect(() => {
    if (!selectedStepName) return;
    const found = editor.allSteps.some((fs) => fs.step.name === selectedStepName);
    if (!found) setSelectedStepName(null);
  }, [editor.allSteps, selectedStepName]);

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

  // Single lookup for the selected step's FlatStep entry; downstream `step`
  // and `depth` derive from it without a second pass over allSteps.
  const selectedFlat = useMemo(
    () => editor.allSteps.find((fs) => fs.step.name === selectedStepName) ?? null,
    [editor.allSteps, selectedStepName],
  );
  const selectedStep = selectedFlat?.step ?? null;
  const selectedDepth = selectedFlat?.depth ?? 0;

  // Build the canonical graph from the chain. `baseNodes` reflects the
  // chain's authoritative order; React Flow needs an internal mutable copy
  // so dragged positions update visually without losing reactivity.
  const { nodes: baseNodes, edges } = useMemo(
    () => buildGraph(editor.allSteps, selectedStepName, editor.catalog),
    [editor.allSteps, selectedStepName, editor.catalog],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StepNodeData>>(baseNodes);
  // Sync incoming chain order changes back into React Flow's internal state.
  // Comparing by id+position keeps drag-induced renders from clobbering the
  // user's in-flight dragged position.
  useEffect(() => {
    setNodes(baseNodes);
  }, [baseNodes, setNodes]);

  const triggerName = editor.draftTrigger?.name ?? null;

  // Drag-rearrange: when a node is dropped, identify its chain (top-level /
  // LOOP body / ROUTER branch) from its FlatStep entry, gather siblings in
  // the SAME chain, sort by Y, and propagate. Cross-chain moves are not
  // supported -- React Flow allows them visually, but we ignore the move.
  const onNodeDragStop = useCallback(
    (_e: React.MouseEvent | TouchEvent | MouseEvent, draggedNode: Node<StepNodeData>) => {
      if (!triggerName) return;
      const draggedFlat = editor.allSteps.find((fs) => fs.step.name === draggedNode.id);
      if (!draggedFlat) return;
      // Build scope from the dragged node's container info.
      let scope: { kind: "top" } | { kind: "loop"; parentName: string } | { kind: "branch"; parentName: string; branchName: string };
      if (draggedFlat.depth === 0) {
        scope = { kind: "top" };
      } else if (draggedFlat.containerKind === "loop" && draggedFlat.parentName) {
        scope = { kind: "loop", parentName: draggedFlat.parentName };
      } else if (draggedFlat.containerKind === "router" && draggedFlat.parentName && draggedFlat.branchName) {
        scope = { kind: "branch", parentName: draggedFlat.parentName, branchName: draggedFlat.branchName };
      } else {
        return; // unknown scope; refuse to act
      }
      // Sibling FlatSteps share parentName + branchName + containerKind.
      const siblings = editor.allSteps.filter(
        (fs) =>
          fs.parentName === draggedFlat.parentName &&
          fs.branchName === draggedFlat.branchName &&
          fs.containerKind === draggedFlat.containerKind,
      );
      const siblingNames = new Set(siblings.map((s) => s.step.name));
      // Horizontal layout: chain order = left-to-right, so sort siblings
      // by their dragged x position.
      const sorted = nodes
        .filter((n) => siblingNames.has(n.id) && n.id !== triggerName)
        .sort((a, b) => a.position.x - b.position.x);
      const newOrder = sorted.map((n) => n.id);
      editor.reorderChain(scope, newOrder);
    },
    [nodes, triggerName, editor],
  );

  return (
    <div className="wf-editor" role="dialog" aria-modal="true" aria-labelledby="wf-editor-title">
      <header className="wf-editor__header">
        <div className="wf-editor__title">
          <h2 id="wf-editor-title">{editor.version?.displayName ?? "Loading…"}</h2>
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

      <div className="wf-editor__layout">
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
              onNodesChange={onNodesChange}
              nodeTypes={NODE_TYPES}
              onNodeClick={(_, n) => setSelectedStepName(n.id)}
              onPaneClick={() => setSelectedStepName(null)}
              onNodeDragStop={onNodeDragStop}
              fitView
              fitViewOptions={{ padding: 0.15, minZoom: 0.4, maxZoom: 1.25 }}
              // Per-node `draggable` flag (set to false for the trigger in
              // buildGraph) overrides this. Nodes default to draggable.
              nodesDraggable
              nodesConnectable={false}
              elementsSelectable
              panOnDrag
              zoomOnScroll
            >
              <Background gap={16} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </section>

        <aside className="wf-editor__panel" aria-label="Step properties">
          {selectedStep ? (
            <PropertiesPanel
              step={selectedStep}
              isTriggerStep={editor.draftTrigger?.name === selectedStep.name}
              hasNextAction={!!selectedStep.nextAction}
              isTopLevel={selectedDepth === 0}
              containerKind={selectedFlat?.containerKind}
              catalog={editor.catalog}
              onSetPiece={(pieceName, actionName) => editor.setStepPiece(selectedStep.name, pieceName, actionName)}
              onSetTriggerType={(type) => editor.setTriggerType(type)}
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
                  setSelectedStepName(null);
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
          ) : editor.draftTrigger && !editor.draftTrigger.nextAction ? (
            <div className="wf-editor__panel-empty">
              <p>This flow has no actions yet.</p>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  if (!editor.draftTrigger) return;
                  const created = editor.insertStepAfter(editor.draftTrigger.name);
                  if (created) setSelectedStepName(created);
                }}
              >
                <Icon icon={Plus} size={12} /> Add first action
              </Button>
              <p className="wf-editor__hint">
                Or click the trigger node to configure when the flow fires.
              </p>
            </div>
          ) : (
            <div className="wf-editor__panel-empty">
              <p>Click a node to edit its piece, action, and inputs.</p>
              <p className="wf-editor__hint">
                Use <code>{`{{stepName.field}}`}</code> in any input to reference a previous step's output.
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ============================================================ react-flow */

const NODE_TYPES = { stepNode: StepNode };

function buildGraph(
  steps: FlatStep[],
  selected: string | null,
  catalog: PieceCatalogEntry[],
): { nodes: Node<StepNodeData>[]; edges: Edge[] } {
  const nodes: Node<StepNodeData>[] = steps.map((entry, i) => {
    const step = entry.step;
    const isTrigger = step.type === "PIECE_TRIGGER" || step.type === "EMPTY";
    return {
      id: step.name,
      type: "stepNode",
      position: { x: i * NODE_X_STEP, y: NODE_Y_BASE + entry.depth * NODE_Y_BRANCH },
      // Tell xyflow the natural side for each default handle so smoothstep
      // edges route horizontally even before we render explicit <Handle/>
      // components (Task 2).
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: { step, selected: selected === step.name, catalog, depth: entry.depth, branchName: entry.branchName },
      // Trigger is always pinned. Every other node is draggable; the chain
      // it belongs to is inferred at drop time from its FlatStep entry.
      draggable: !isTrigger,
    };
  });

  // Edges: each step's structural pointers become an edge. sourceHandle ids
  // mirror the Handle components rendered in StepNode (`out` / `loop-body` /
  // `branch:<name>`) so xyflow attaches the edge to the right circle when a
  // node has multiple source handles (ROUTER especially).
  const edges: Edge[] = [];
  const knownNames = new Set(steps.map((s) => s.step.name));
  for (const entry of steps) {
    const step = entry.step;
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
  const { step, selected, catalog, depth, branchName } = data as StepNodeData;
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

  let kindLabel: string;
  let kindTone: "accent" | "neutral" | "warn" | "ok" = "neutral";
  if (step.type === "EMPTY") { kindLabel = "Manual"; kindTone = "accent"; }
  else if (isTrigger) { kindLabel = "Trigger"; kindTone = "accent"; }
  else if (isLoop) { kindLabel = "Loop"; kindTone = "warn"; }
  else if (isRouter) { kindLabel = "Router"; kindTone = "warn"; }
  else { kindLabel = "Action"; }

  // ROUTER lays out one bottom-edge source handle per branch, spread evenly.
  // The handle id encodes the branch name so the eventual onConnect (Task 3)
  // can route a connection straight into the correct `children[i]` slot.
  const branches = isRouter ? step.settings?.branches ?? [] : [];

  return (
    <div
      className={`wf-node ${selected ? "wf-node--selected" : ""} ${isUnconfigured ? "wf-node--unconfigured" : ""} ${depth > 0 ? "wf-node--nested" : ""}`}
    >
      {/* Target ("in"): left edge, every non-trigger node accepts an incoming
          connection from a preceding step's source handle. */}
      {!isTrigger ? (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          className="wf-handle wf-handle--target"
        />
      ) : null}
      {/* Main source ("out"): right edge. Represents `nextAction` -- the
          sequential continuation of this chain. Every node has it, including
          LOOP/ROUTER (their successor runs after the loop/router itself
          finishes). The trigger uses it to start the top-level chain. */}
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className="wf-handle wf-handle--source"
      />
      {/* LOOP body source: bottom-edge handle that feeds into the loop's
          `firstLoopAction`. Visually distinct from the main "out" so the
          user can tell which sub-chain a connection wires. */}
      {isLoop ? (
        <Handle
          type="source"
          position={Position.Bottom}
          id="loop-body"
          className="wf-handle wf-handle--source wf-handle--branch"
          style={{ left: "50%" }}
        />
      ) : null}
      {/* ROUTER branches: one bottom source handle per branch, spread along
          the bottom edge. Handle id = `branch:<branchName>` so onConnect can
          locate the matching slot in `settings.branches` / `children`. */}
      {isRouter && branches.length > 0
        ? branches.map((b, i) => {
            const name = b?.branchName ?? `branch_${i}`;
            const pct = ((i + 1) * 100) / (branches.length + 1);
            return (
              <Handle
                key={`branch:${name}`}
                type="source"
                position={Position.Bottom}
                id={`branch:${name}`}
                className="wf-handle wf-handle--source wf-handle--branch"
                style={{ left: `${pct}%` }}
              />
            );
          })
        : null}

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
    return (
      <label className={`wf-props__field ${isMissing ? "wf-props__field--missing" : ""}`}>
        {labelEl}
        <textarea
          rows={3}
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {field.description ? <span className="wf-props__field-help">{field.description}</span> : null}
      </label>
    );
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
  return (
    <label className={`wf-props__field ${isMissing ? "wf-props__field--missing" : ""}`}>
      {labelEl}
      <input
        type="text"
        value={typeof value === "string" ? value : ""}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
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

  return (
    <label className={`wf-props__field ${isMissing ? "wf-props__field--missing" : ""}`}>
      {labelEl}
      <input
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={field.placeholder}
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

  return (
    <label className="wf-props__field">
      {labelEl}
      <textarea
        rows={4}
        value={text}
        placeholder={field.placeholder ?? "{}"}
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
            <li key={key} className="wf-props__input-row">
              <label>
                <span className="wf-props__input-key">{key}</span>
                <textarea
                  rows={typeof value === "string" && value.length > 60 ? 3 : 1}
                  value={stringifyValue(value)}
                  onChange={(e) => onSetInput(key, e.target.value)}
                />
              </label>
              <button
                type="button"
                className="wf-props__input-remove"
                onClick={() => onRemoveInputKey(key)}
                aria-label={`Remove ${key}`}
                title={`Remove ${key}`}
              >
                <Icon icon={Trash2} size={12} />
              </button>
            </li>
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
        <input
          type="text"
          value={items}
          placeholder="{{trigger.list}}"
          onChange={(e) => onSetLoopItems(e.target.value)}
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
}: {
  step: FlowStepNode;
  onSetRouterExecutionType: (type: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH") => void;
  onAddRouterBranch: (branchName: string) => void;
  onRemoveRouterBranch: (branchIndex: number) => void;
  onAddStepToBranch: (branchName: string) => void;
}): React.ReactElement {
  const branches = step.settings?.branches ?? [];
  const children = step.children ?? [];
  const executionType = step.settings?.executionType ?? "EXECUTE_FIRST_MATCH";
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
          Branch conditions are not editable in the panel yet. Use{" "}
          <code>manage_workflow compose</code> for new flows, or hand-edit the JSON via{" "}
          <code>PATCH /api/workflows/.../versions/...</code>.
        </p>
        <ul className="wf-props__branch-list">
          {branches.map((b, idx) => {
            const child = children[idx];
            const isFallback = b?.branchType === "FALLBACK";
            return (
              <li key={`${idx}_${b?.branchName ?? ""}`} className="wf-props__branch-row">
                <div className="wf-props__branch-name">
                  <span>{b?.branchName ?? `(branch ${idx})`}</span>
                  {isFallback ? <span className="wf-props__branch-tag">fallback</span> : null}
                </div>
                <div className="wf-props__branch-actions">
                  {!child && b?.branchName && !isFallback ? (
                    <Button variant="ghost" size="sm" onClick={() => onAddStepToBranch(b.branchName)}>
                      <Icon icon={Plus} size={12} /> Add step
                    </Button>
                  ) : null}
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
                </div>
              </li>
            );
          })}
        </ul>
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
      </div>
    </>
  );
}

function scopeLabel(kind: "loop" | "router" | undefined): string {
  if (kind === "loop") return "loop body";
  if (kind === "router") return "router branch";
  return "sub-chain";
}
