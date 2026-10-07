import React, { useMemo, useRef, useState } from "react";
import { ArrowLeft, LayoutGrid, RotateCcw, Undo2 } from "lucide-react";
import type { BriefShellPort, BriefRoomModule } from "../../contracts";
import { BriefButton } from "../../components/controls";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import {
  WorkflowEditor,
  EditableTitle,
  type WorkflowEditorControls,
} from "../../../v2/rooms/workflows/WorkflowEditor";
import {
  WorkflowEditorEnvironment,
  type WorkflowRequest,
} from "../../../v2/rooms/workflows/WorkflowEditorEnvironment";
import { versionBoundRequest } from "./request";
import "./canvas.css";

export interface WorkflowCanvasBinding {
  source: "live" | "fixture";
  scopeId: string;
  flowId: string;
  /** F-21 owner must bind requests to the selected editable version and redact inspector data. */
  versionId: string;
  capabilities: unknown;
  request: WorkflowRequest;
  /** Explicit, owner-bounded manual-run command. No automatic retry. */
  /** Host uses this to guard room/account navigation while draft edits exist. */
  onDirtyChange?: (dirty: boolean) => void;
  run?: () => Promise<{ ok: boolean; message: string }>;
}
export function canvasAvailable(
  shell: BriefShellPort,
  binding?: WorkflowCanvasBinding,
): binding is WorkflowCanvasBinding {
  return (
    !!binding &&
    !!binding.scopeId.trim() &&
    !!binding.flowId.trim() &&
    !!binding.versionId.trim() &&
    binding.source === (shell.mode === "preview" ? "fixture" : "live") &&
    shell.route.selection.flowId === binding.flowId &&
    (!shell.route.selection.versionId ||
      shell.route.selection.versionId === binding.versionId) &&
    isBriefCapabilityEnabled(binding.capabilities, "workflowContext")
  );
}
export function WorkflowCanvasRoom({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: WorkflowCanvasBinding;
}) {
  if (!canvasAvailable(shell, binding))
    return (
      <section className="brief-workflow-canvas-unavailable">
        <h1 className="brief-type-room-title">Workflow</h1>
        <p role="status">The selected workflow editor is unavailable.</p>
        <BriefButton
          onClick={() => shell.navigate({ room: "workflows", selection: {} })}
        >
          Back to workflows
        </BriefButton>
      </section>
    );
  // Layout/theme are deliberately absent from the key. Changing ownership or the
  // selected version MUST retire the edit buffer; the host owns unsaved navigation.
  return (
    <BoundCanvas
      key={JSON.stringify([binding.scopeId, binding.flowId, binding.versionId])}
      shell={shell}
      binding={binding}
    />
  );
}
function BoundCanvas({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding: WorkflowCanvasBinding;
}) {
  const sampleDrafts = useRef(new Map<string, string>());
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const request = useMemo(
    () =>
      versionBoundRequest(binding.request, binding.flowId, binding.versionId),
    [binding.request, binding.flowId, binding.versionId],
  );
  const environment = useMemo(
    () => ({ request, portalHost, workspace: true, sampleDrafts:sampleDrafts.current }),
    [request, portalHost],
  );
  return (
    <div className="brief-workflow-canvas">
      <WorkflowEditorEnvironment.Provider value={environment}>
        <WorkflowEditor
          flowId={binding.flowId}
          workspace
          onDirtyChange={binding.onDirtyChange}
          onClose={() => {}}
          renderHeader={(controls) => (
            <CanvasHeader {...controls} shell={shell} binding={binding} />
          )}
        />
        <div className="brief-workflow-portals" ref={setPortalHost} />
      </WorkflowEditorEnvironment.Provider>
    </div>
  );
}
function CanvasHeader({
  editor,
  save,
  saving,
  discard,
  arrange,
  message,
  shell,
  binding,
}: WorkflowEditorControls & {
  shell: BriefShellPort;
  binding: WorkflowCanvasBinding;
}) {
  const [running, setRunning] = useState(false),
    [runMessage, setRunMessage] = useState("");
  const busy = useRef(false);
  const versionMatches = editor.version?.id === binding.versionId;
  async function run() {
    if (busy.current || !binding.run || editor.dirty || !versionMatches) return;
    busy.current = true;
    setRunning(true);
    setRunMessage("");
    try {
      const result = await binding.run();
      setRunMessage(result.message);
    } catch {
      setRunMessage(
        "Run request could not be confirmed. Check Runs before trying again.",
      );
    } finally {
      setRunning(
        false,
      ); /* An uncertain submission must not be retried here. F-21 owns reconciliation. */
    }
  }
  return (
    <header className="brief-canvas-header">
      <div className="brief-canvas-heading">
        <div className="brief-canvas-name">
          {editor.version ? (
            <EditableTitle
              value={editor.version.displayName}
              disabled={saving || editor.version.state === "LOCKED"}
              onCommit={editor.setVersionDisplayName}
            />
          ) : (
            <h1 className="brief-type-room-title">Workflow</h1>
          )}
        </div>
        <BriefButton
          variant="primary"
          disabled={
            !binding.run ||
            running ||
            editor.dirty ||
            !versionMatches ||
            busy.current
          }
          onClick={() => void run()}
          title={
            editor.dirty
              ? "Save your changes before running"
              : !binding.run
                ? "Run is not available"
                : undefined
          }
        >
          {running ? "Queueing…" : "Run workflow"}
        </BriefButton>
      </div>
      <nav className="brief-canvas-tabs" aria-label="Workflow views">
        <span aria-current="page">Canvas</span>
        {["Runs", "Context & rules"].map((label, i) => (
          <button
            type="button"
            key={label}
            disabled={editor.dirty}
            title={
              editor.dirty ? "Save or discard your changes first" : undefined
            }
            onClick={() =>
              shell.navigate({
                room: i === 0 ? "workflow-runs" : "workflow-context",
                selection: {
                  flowId: binding.flowId,
                  versionId: binding.versionId,
                },
              })
            }
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="brief-canvas-tools" aria-label="Draft tools">
        <BriefButton
          size="sm"
          onClick={() => shell.navigate({ room: "workflows", selection: {} })}
          disabled={editor.dirty}
          icon={<ArrowLeft size={14} />}
        >
          Workflows
        </BriefButton>
        <BriefButton
          size="sm"
          onClick={arrange}
          disabled={saving || !Object.keys(editor.stepPositions).length}
          icon={<LayoutGrid size={14} />}
        >
          Arrange
        </BriefButton>
        <BriefButton
          size="sm"
          onClick={() => editor.undo()}
          disabled={saving || !editor.canUndo}
          title={editor.undoLabel ?? "Nothing to undo"}
          icon={<Undo2 size={14} />}
        >
          Undo
        </BriefButton>
        <BriefButton
          size="sm"
          onClick={discard}
          disabled={!editor.dirty || saving}
          icon={<RotateCcw size={14} />}
        >
          Discard
        </BriefButton>
        <BriefButton
          size="sm"
          onClick={() => void save()}
          disabled={!editor.dirty || saving || !versionMatches}
        >
          {saving ? "Saving…" : "Save changes"}
        </BriefButton>
        <span className="brief-canvas-feedback" role="status">
          {editor.loading
            ? "Loading workflow…"
            : editor.error
              ? "Workflow unavailable"
              : !versionMatches && editor.version
                ? "Version changed. Reopen from Workflows before editing."
                : runMessage ||
                  message?.text ||
                  (editor.dirty
                    ? "Unsaved changes"
                    : editor.version?.state === "LOCKED"
                      ? "Published version"
                      : "Saved draft")}
        </span>
      </div>
    </header>
  );
}
/** Opt-in only. No change to the production registry or legacy workflow route. */
export function workflowCanvasRegistration(
  useBinding: () => WorkflowCanvasBinding | undefined,
  id: "workflow" | "workflow-draft" = "workflow",
): BriefRoomModule {
  return {
    id,
    title: "Workflow",
    legacyRoom: "workflows",
    Body: ({ shell }) => (
      <WorkflowCanvasRoom shell={shell} binding={useBinding()} />
    ),
  };
}
