import { FlowPermissions } from '../../../v2/rooms/workflows/FlowPermissions';
import { flattenSteps } from "../../../v2/rooms/workflows/tree";
import type { Flow } from '../../../v2/rooms/workflows/useWorkflowsData';
import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { cardName, issueLine, refusalMessage } from "../../../v2/rooms/workflows/readiness-text";
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
  const environment = useMemo(
    () => ({
      request,
      portalHost,
      workspace: true,
      sampleDrafts: sampleDrafts.current,
    }),
    [request, portalHost],
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
  // Titles for the steps the server's readiness issues name by their internal id.
  const stepTitles = useMemo(() => new Map([editor.draftTrigger, ...editor.draftOrphans.map(o => o.node)]
    .flatMap(root => root ? flattenSteps(root).map(({ step }) => [step.name, step.displayName ?? step.name] as const) : [])),
  [editor.draftTrigger, editor.draftOrphans]);
  const nameOf = (name: string) => stepTitles.get(name);
  async function change(action: () => Promise<void>, doing: string) {
    if (busy.current || editor.dirty) return;
    busy.current = true; setChanging(true); setRunMessage('');
    try { await action(); }
    catch (error) {
      // A refusal says what is wrong (a step reads a deleted step's result, a field is empty): say it.
      const refused = error as { body?: unknown; status?: unknown } | null;
      const reason = refusalMessage(refused?.body, nameOf, typeof refused?.status === 'number' ? refused.status : undefined);
      setRunMessage(reason ? `${doing} stopped. ${reason}` : 'The version change could not be confirmed. Reopen this workflow to check before trying again.');
    }
    finally { setChanging(false); busy.current = false; }
  }
  // What the server says is wrong with the saved version, read after every save.
  const [serverIssues, setServerIssues] = useState<unknown[]>([]);
  const savedVersionId = editor.version?.id, savedAt = editor.version?.updated;
  useEffect(() => {
    if (binding.source !== 'live' || !savedVersionId || editor.dirty || editor.loading || savedVersionId !== binding.versionId) return;
    const abort = new AbortController();
    void binding.request(`/api/workflows/${encodeURIComponent(binding.flowId)}/versions/${encodeURIComponent(savedVersionId)}/readiness`, { signal: abort.signal })
      .then(response => response.ok ? response.json() : null)
      .then(body => { if (!abort.signal.aborted) setServerIssues(body && body.ready === false && Array.isArray(body.issues) ? body.issues : []); })
      // The notice is extra (the server still refuses what is not ready), but a list from an
      // earlier save must not stay up as if it were this one's.
      .catch(() => { if (!abort.signal.aborted) setServerIssues([]); });
    return () => abort.abort();
  }, [binding.source, binding.request, binding.flowId, binding.versionId, savedVersionId, savedAt, editor.dirty, editor.loading]);
  const setupSteps = [...new Set(editor.validationGaps.map(gap => gap.stepName))].map(name => ({
    name, gaps: editor.validationGaps.filter(gap => gap.stepName === name),
  }));
  const needsSetup = setupSteps.length > 0;
  const hasCode = editor.allSteps.some(({ step }) => step.type === 'CODE');
  const codeBlocked = hasCode && binding.permissions?.codeSteps?.enabled !== true;
  const versionMatches = editor.version?.id === binding.versionId;
  // Fixing what the editor already flags comes first, so these are the rest.
  const blockers = serverIssues.filter((issue): issue is Record<string, unknown> => typeof issue === 'object' && issue !== null
    && !(needsSetup && (issue as { code?: unknown }).code === 'SETUP_REQUIRED'));
  const runBlockedBy = !binding.run && !binding.publish && !binding.edit ? '' // read-only view elsewhere
    : codeBlocked ? 'CODE steps are not allowed yet. Open Flow permissions below to allow them.'
    : needsSetup ? 'Finish setup first: the steps listed below still need details.'
    : editor.dirty ? 'Save your changes to run this workflow.'
    : !versionMatches ? 'This page now shows a different version. Reopen the workflow from Workflows.'
    : !binding.run ? (binding.publish ? (blockers.length ? 'This draft cannot be published yet. See what to fix below.' : 'Publish this draft to run it.') : 'This version cannot be run from here.')
    : '';
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
          aria-describedby={runBlockedBy ? 'brief-run-reason' : undefined}
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
        {binding.publish && <BriefButton size="sm" disabled={codeBlocked || needsSetup || changing || saving || editor.dirty || !versionMatches} onClick={() => void change(binding.publish!, 'Publishing')}>Publish version</BriefButton>}
        {binding.edit && <BriefButton size="sm" disabled={changing} onClick={() => void change(binding.edit!, 'Starting a new draft')}>Edit a new draft</BriefButton>}
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
          disabled={!editor.dirty || editor.hasInvalidJson || saving || !versionMatches}
          title={editor.invalidJsonMessage ?? undefined}
        >
          {saving ? "Saving…" : "Save changes"}
        </BriefButton>
        <span className="brief-canvas-feedback" role={message?.tone === 'warn' ? 'alert' : 'status'} data-tone={message?.tone}>
          {editor.loading
            ? "Loading workflow…"
            : editor.error
              ? "Workflow unavailable"
              : !versionMatches && editor.version
                ? "Version changed. Reopen from Workflows before editing."
                : runMessage ||
                  message?.text ||
                  (editor.dirty
                    ? editor.invalidJsonMessage ?? "Unsaved changes"
                    : editor.version?.state === "LOCKED"
                      ? "Published version"
                      : needsSetup ? "Saved draft · Setup required" : "Saved draft")}
        </span>
      </div>
      {binding.permissions && <details className="brief-canvas-setup" open={hasCode || undefined}>
        <summary>Flow permissions{codeBlocked ? ' · CODE steps not allowed' : ''}</summary>
        <FlowPermissions key={binding.flowId} flow={binding.permissions} request={binding.request as typeof fetch}
          onChanged={() => { void binding.permissionsChanged?.().catch(() => setRunMessage('Permission state could not be refreshed. Reopen this workflow to check.')); }} />
      </details>}
      {runBlockedBy && !editor.loading && !editor.error && <p className="brief-canvas-run-reason" id="brief-run-reason">{runBlockedBy}</p>}
      {!editor.dirty && blockers.length > 0 && <details className="brief-canvas-setup" open>
        <summary>{binding.readOnly ? 'Not ready to run' : 'Not ready to publish'}</summary>
        <ul>{blockers.map((issue, index) => <li key={index}>
          {typeof issue.node === 'string' && stepTitles.has(issue.node) && <BriefButton size="sm" onClick={() => selectSetupStep(issue.node as string)}>{cardName(stepTitles.get(issue.node))}</BriefButton>}
          <span>{issueLine(issue, nameOf)}</span>
        </li>)}</ul>
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
