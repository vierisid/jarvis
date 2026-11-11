import { FlowPermissions } from '../../../v2/rooms/workflows/FlowPermissions';
import type { Flow } from '../../../v2/rooms/workflows/useWorkflowsData';
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
import { WorkflowViewHeader } from "../runs/WorkflowViewHeader";

export interface WorkflowCanvasBinding {
  source: "live" | "fixture";
  scopeId: string;
  flowId: string;
  /** F-21 owner must bind requests to the selected editable version and redact inspector data. */
  versionId: string;
  capabilities: unknown;
  request: WorkflowRequest;
  /** Host uses this to guard room/account navigation while draft edits exist. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Explicit, owner-bounded manual-run command. No automatic retry. */
  run?: () => Promise<{ ok: boolean; message: string }>;
  readOnly?: boolean;
  permissions?: Flow;
  permissionsChanged?: () => Promise<void>;
  publish?: () => Promise<void>;
  edit?: () => Promise<void>;
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
      versionBoundRequest(binding.request, binding.flowId, binding.versionId, binding.readOnly),
    [binding.request, binding.flowId, binding.versionId, binding.readOnly],
  );
  // Unsaved edits are copied into this tab (not shared storage: a draft may hold secrets), so a
  // reload or a session that ended does not lose them. Fixtures and blocked storage get none.
  const editCopy = useMemo(() => {
    if (binding.source !== "live" || binding.readOnly) return undefined;
    const key = `jarvis:brief:workflow-edits:v1:${binding.scopeId}:${binding.flowId}:${binding.versionId}`;
    return {
      read: () => { try { return window.sessionStorage.getItem(key); } catch { return null; } },
      write: (value: string) => { try { window.sessionStorage.setItem(key, value); } catch { /* full or blocked */ } },
      clear: () => { try { window.sessionStorage.removeItem(key); } catch { /* blocked */ } },
    };
  }, [binding.source, binding.readOnly, binding.scopeId, binding.flowId, binding.versionId]);
  const environment = useMemo(
    () => ({
      request,
      portalHost,
      workspace: true,
      sampleDrafts: sampleDrafts.current,
      editCopy,
    }),
    [request, portalHost, editCopy],
  );
  return (
    <div className="brief-workflow-canvas">
      <WorkflowEditorEnvironment.Provider value={environment}>
        <WorkflowEditor
          flowId={binding.flowId}
          workspace
          readOnly={binding.readOnly}
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
  selectSetupStep,
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
  const [changing, setChanging] = useState(false);
  async function change(action: () => Promise<void>) {
    if (busy.current || editor.dirty) return;
    busy.current = true; setChanging(true); setRunMessage('');
    try { await action(); }
    catch { setRunMessage('The version change could not be confirmed. Reopen this workflow to check before trying again.'); }
    finally { setChanging(false); busy.current = false; }
  }
  const setupSteps = [...new Set(editor.validationGaps.map(gap => gap.stepName))].map(name => ({
    name, gaps: editor.validationGaps.filter(gap => gap.stepName === name),
  }));
  const needsSetup = setupSteps.length > 0;
  const hasCode = editor.allSteps.some(({ step }) => step.type === 'CODE');
  const codeBlocked = hasCode && binding.permissions?.codeSteps?.enabled !== true;
  const versionMatches = editor.version?.id === binding.versionId;
  async function run() {
    if (busy.current || !binding.run || codeBlocked || editor.dirty || !versionMatches) return;
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
      busy.current = false;
      setRunning(
        false,
      ); /* An uncertain submission must not be retried here. F-21 owns reconciliation. */
    }
  }
  // One line for the state of the draft. A failed save keeps "Unsaved changes" beside its reason:
  // the reason alone would read as if the edits were safe.
  const restored = editor.dirty && editor.restoredAt
    ? `Restored your unsaved edits from ${new Date(editor.restoredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : "";
  const note = runMessage || message?.text || restored;
  const feedback = editor.loading ? "Loading workflow…"
    : editor.error ? "Workflow unavailable"
    : !versionMatches && editor.version ? "Version changed. Reopen from Workflows before editing."
    : note ? (editor.dirty && !runMessage ? `${note} Unsaved changes` : note)
    : editor.dirty ? editor.invalidJsonMessage ?? "Unsaved changes"
    : editor.version?.state === "LOCKED" ? "Published version"
    : needsSetup ? "Saved draft · Setup required" : "Saved draft";
  return (
    <WorkflowViewHeader
      shell={shell}
      flowId={binding.flowId}
      versionId={binding.versionId}
      active="canvas"
      disabled={editor.dirty}
      title={
        editor.version ? (
          <EditableTitle
            value={editor.version.displayName}
            disabled={saving || editor.version.state === "LOCKED"}
            onCommit={editor.setVersionDisplayName}
          />
        ) : (
          <h1 className="brief-type-room-title">Workflow</h1>
        )
      }
      runAction={
        <BriefButton
          variant="primary"
          disabled={
            codeBlocked || !binding.run || needsSetup ||
            running ||
            editor.dirty ||
            !versionMatches ||
            busy.current
          }
          onClick={() => void run()}
          title={
            codeBlocked ? "Review Flow permissions to allow CODE steps" : needsSetup ? "Complete setup before running" : editor.dirty
              ? "Save your changes before running"
              : !binding.run
                ? binding.publish ? "Publish this saved draft before running" : "Run is not available"
                : undefined
          }
        >
          {running ? "Queueing…" : "Run workflow"}
        </BriefButton>
      }
    >
      <div className="brief-canvas-tools" aria-label="Draft tools">
        {binding.publish && <BriefButton size="sm" disabled={codeBlocked || needsSetup || changing || saving || editor.dirty || !versionMatches} onClick={() => void change(binding.publish!)}>Publish version</BriefButton>}
        {binding.edit && <BriefButton size="sm" disabled={changing} onClick={() => void change(binding.edit!)}>Edit a new draft</BriefButton>}
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
          disabled={binding.readOnly || saving || !Object.keys(editor.stepPositions).length}
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
          disabled={!editor.dirty || editor.hasInvalidJson || saving || !versionMatches || editor.workflowRemoved}
          title={editor.invalidJsonMessage ?? undefined}
        >
          {saving ? "Saving…" : "Save changes"}
        </BriefButton>
        <span className="brief-canvas-feedback" role={message?.tone === 'warn' ? 'alert' : 'status'} data-tone={message?.tone}>
          {feedback}
        </span>
      </div>
      {editor.workflowRemoved && <div className="brief-canvas-removed" role="alert">
        <p><strong>This workflow was deleted in another tab or window.</strong> Your edits are still here but cannot be saved to it. Copy anything you want to keep, then go back to All workflows.</p>
        <BriefButton size="sm" onClick={() => { discard(); window.setTimeout(() => shell.navigate({ room: "all-workflows", selection: {} }), 50); }}>Discard edits and go to All workflows</BriefButton>
      </div>}
      {binding.permissions && <details className="brief-canvas-setup" open={hasCode || undefined}>
        <summary>Flow permissions{codeBlocked ? ' · CODE steps not allowed' : ''}</summary>
        <FlowPermissions key={binding.flowId} flow={binding.permissions} request={binding.request as typeof fetch}
          onChanged={() => { void binding.permissionsChanged?.().catch(() => setRunMessage('Permission state could not be refreshed. Reopen this workflow to check.')); }} />
      </details>}
      {needsSetup && <details className="brief-canvas-setup" open>
        <summary>Setup required</summary>
        <p>Fill in these details when you're ready. Save your progress at any time. Running and publishing stay unavailable until setup is complete.</p>
        <ul>{setupSteps.map(({ name, gaps }) => <li key={name}>
          <BriefButton size="sm" onClick={() => selectSetupStep(name)}>{gaps[0]!.stepDisplayName}</BriefButton>
          <span>{gaps.map(gap => gap.fieldLabel).join(', ')}</span>
        </li>)}</ul>
      </details>}
    </WorkflowViewHeader>
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
