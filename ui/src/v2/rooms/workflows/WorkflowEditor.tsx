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

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Save, RotateCcw, X, Plus, Trash2 } from "lucide-react";
import { Button, Chip, Icon } from "../../ui";
import {
  useWorkflowEditor,
  type FlowStepNode,
  type PieceCatalogEntry,
} from "./useWorkflowEditor";
import "./WorkflowEditor.css";

const NODE_X = 0;
const NODE_Y_STEP = 130;

interface WorkflowEditorProps {
  flowId: string;
  onClose: () => void;
}

interface StepNodeData extends Record<string, unknown> {
  step: FlowStepNode;
  selected: boolean;
  catalog: PieceCatalogEntry[];
}

export function WorkflowEditor({ flowId, onClose }: WorkflowEditorProps): React.ReactElement {
  const editor = useWorkflowEditor(flowId);
  const [selectedStepName, setSelectedStepName] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  // Keep selection valid: when steps shift, drop the selection if it doesn't exist.
  useEffect(() => {
    if (!selectedStepName) return;
    const found = editor.allSteps.some((s) => s.name === selectedStepName);
    if (!found) setSelectedStepName(null);
  }, [editor.allSteps, selectedStepName]);

  const onSave = async (): Promise<void> => {
    const result = await editor.save();
    setActionMessage({ tone: result.ok ? "ok" : "warn", text: result.message });
    window.setTimeout(() => setActionMessage(null), 2500);
  };

  const onDiscard = (): void => {
    editor.reset();
    setActionMessage({ tone: "ok", text: "Reverted to saved version" });
    window.setTimeout(() => setActionMessage(null), 2000);
  };

  const selectedStep = useMemo(
    () => editor.allSteps.find((s) => s.name === selectedStepName) ?? null,
    [editor.allSteps, selectedStepName],
  );

  const { nodes, edges } = useMemo(
    () => buildGraph(editor.allSteps, selectedStepName, editor.catalog),
    [editor.allSteps, selectedStepName, editor.catalog],
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
              nodeTypes={NODE_TYPES}
              onNodeClick={(_, n) => setSelectedStepName(n.id)}
              onPaneClick={() => setSelectedStepName(null)}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
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
  steps: FlowStepNode[],
  selected: string | null,
  catalog: PieceCatalogEntry[],
): { nodes: Node<StepNodeData>[]; edges: Edge[] } {
  const nodes: Node<StepNodeData>[] = steps.map((step, i) => ({
    id: step.name,
    type: "stepNode",
    position: { x: NODE_X, y: i * NODE_Y_STEP },
    data: { step, selected: selected === step.name, catalog },
  }));
  const edges: Edge[] = [];
  for (let i = 0; i < steps.length - 1; i++) {
    const from = steps[i]!;
    const to = steps[i + 1]!;
    edges.push({
      id: `${from.name}->${to.name}`,
      source: from.name,
      target: to.name,
      type: "smoothstep",
    });
  }
  return { nodes, edges };
}

function StepNode({ data }: NodeProps): React.ReactElement {
  const { step, selected, catalog } = data as StepNodeData;
  const isTrigger = step.type === "PIECE_TRIGGER" || step.type === "EMPTY";
  const piece = catalog.find((p) => p.name === step.settings?.pieceName);
  const subAction = isTrigger ? step.settings?.triggerName : step.settings?.actionName;
  const subDisplayName = piece
    ? (isTrigger
        ? piece.triggers.find((t) => t.name === subAction)?.displayName
        : piece.actions.find((a) => a.name === subAction)?.displayName) ?? subAction
    : subAction;
  const isUnconfigured = step.type === "PIECE" && (!step.settings?.pieceName || !step.settings.actionName);

  return (
    <div className={`wf-node ${selected ? "wf-node--selected" : ""} ${isUnconfigured ? "wf-node--unconfigured" : ""}`}>
      <div className="wf-node__head">
        <Chip tone={isTrigger ? "accent" : "neutral"} dot={false}>
          {step.type === "EMPTY" ? "Manual" : isTrigger ? "Trigger" : "Action"}
        </Chip>
        <span className="wf-node__name">{step.displayName ?? step.name}</span>
      </div>
      <div className="wf-node__body">
        {step.settings?.pieceName ? (
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
  catalog: PieceCatalogEntry[];
  onSetPiece: (pieceName: string, actionName: string) => void;
  onSetTriggerType: (type: "EMPTY" | "PIECE_TRIGGER") => void;
  onSetInput: (key: string, value: unknown) => void;
  onAddInputKey: (key: string) => void;
  onRemoveInputKey: (key: string) => void;
  onSetDisplayName: (displayName: string) => void;
  onAddStepAfter: () => void;
  onDelete: () => void;
}

function PropertiesPanel(props: PropertiesPanelProps): React.ReactElement {
  const {
    step,
    isTriggerStep,
    hasNextAction,
    catalog,
    onSetPiece,
    onSetTriggerType,
    onSetInput,
    onAddInputKey,
    onRemoveInputKey,
    onSetDisplayName,
    onAddStepAfter,
    onDelete,
  } = props;
  const isTrigger = step.type === "PIECE_TRIGGER" || step.type === "EMPTY";
  const isManual = step.type === "EMPTY";
  const piece = catalog.find((p) => p.name === step.settings?.pieceName);
  const subActions = isTrigger ? piece?.triggers ?? [] : piece?.actions ?? [];

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

      {!isManual ? (
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

      <div className="wf-props__divider" />

      <div className="wf-props__inputs">
        <div className="wf-props__inputs-head">
          <h4>Inputs</h4>
        </div>
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
      </div>

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
      </div>
    </div>
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

function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
