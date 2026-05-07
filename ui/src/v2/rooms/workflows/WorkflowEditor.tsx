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
import { ReactFlow, Background, Controls, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Save, RotateCcw, X, Plus, Trash2 } from "lucide-react";
import { Button, Chip, Icon } from "../../ui";
import {
  useWorkflowEditor,
  type FlowStepNode,
  type PieceCatalogActionOrTrigger,
  type PieceCatalogEntry,
  type PieceInputField,
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
