import { IngredientPicker, IngredientChips } from "../ingredient-picker/IngredientPicker";
import type { IngredientCatalog } from "../ingredient-picker/model";
import React, { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Plus } from "lucide-react";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import { BriefButton, BriefTooltip } from "../../components/controls";
import { ConversationComposer } from "../../chat/composer/ConversationComposer";
import type { BriefShellPort } from "../../contracts";
import { RecentWorkflows } from "../recent-rows/RecentWorkflows";
import type { RecentWorkflowBinding } from "../recent-rows/model";
import { WorkflowCreationController } from "./controller";
import { pendingJob, PROMPT_BYTES, WORKFLOW_SUGGESTIONS } from "./model";
import "./creation.css";

export interface WorkflowCreationBinding {
  controller: WorkflowCreationController;
  capabilities: unknown;
  recent?: RecentWorkflowBinding;
  ingredients?: IngredientCatalog;
  /** Optional host entry; never interpreted as a chat attachment. */
  ingredientControl?: React.ReactNode;
}
export function WorkflowCreationRoom({ shell, binding, reducedMotion }: {
  shell: BriefShellPort; binding?: WorkflowCreationBinding; reducedMotion?: boolean;
}) {
  if (!binding || binding.controller.source !== (shell.mode === "live" ? "live" : "fixture")) return <section className="brief-workflow-creation">
    <h1 className="brief-type-room-title">Create your workflow</h1><p className="brief-workflow-notice" role="status">Workflow creation is unavailable.</p>
  </section>;
  return <BoundCreation key={binding.controller.scopeId} shell={shell} binding={binding} reducedMotion={reducedMotion} />;
}
function BoundCreation({ shell, binding, reducedMotion }: { shell: BriefShellPort; binding: WorkflowCreationBinding; reducedMotion?: boolean }) {
  const controller = binding.controller;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const element = useRef<HTMLDivElement>(null);
  const restore = useRef({ done:false, top:controller.getSnapshot().scrollTop });
  const recentReady = binding.recent?.source === controller.source && ["ready","empty","stale"].includes(binding.recent.state.status);
  const enabled = isBriefCapabilityEnabled(binding.capabilities, "workflowComposition");
  const unresolved = !!state.request && pendingJob(state.job);
  const ingredientEnabled = isBriefCapabilityEnabled(binding.capabilities, "compositionIngredients");
  const ingredients = state.ingredients ?? [];
  const catalog = binding.ingredients?.source === controller.source && binding.ingredients.scopeId === controller.scopeId ? binding.ingredients : undefined;
  const ingredientBlocked = !!ingredients.length && !ingredientEnabled;
  const locked = state.busy || unresolved || state.storageFailed || !enabled || ingredientBlocked;
  const job = state.job;
  useEffect(() => {
    if (!enabled || state.error || state.busy || state.storageFailed || !unresolved) return;
    const timer = setTimeout(() => void controller.recover(), 1000);
    return () => clearTimeout(timer);
  }, [controller, enabled, unresolved, state.error, state.busy, state.storageFailed, job]);
  useEffect(() => {
    if (state.storageFailed || state.busy || job?.state !== "draft_ready" || !job.workflow || state.openedJobId === job.jobId) return;
    // Persist the acknowledgement before navigating; returning does not reopen it.
    if (controller.acknowledgeOpened(job.jobId)) shell.navigate({ room:"workflow-draft", selection:{ flowId:job.workflow.flowId, versionId:job.workflow.versionId } });
  }, [controller, job, shell.navigate, state.openedJobId, state.storageFailed, state.busy]);
  useLayoutEffect(() => {
    const scroll = element.current?.closest<HTMLElement>(".brief-workspace-content");
    if (!scroll) return;
    const save = () => { if (restore.current.done) controller.savePosition(scroll.scrollTop); };
    scroll.addEventListener("scroll", save, { passive:true });
    return () => scroll.removeEventListener("scroll", save);
  }, [controller]);
  useLayoutEffect(() => {
    const scroll = element.current?.closest<HTMLElement>(".brief-workspace-content");
    if (!scroll || restore.current.done || !recentReady) return;
    // Wait for actual rows, then restore after the shell's room reset. Loading
    // or failed reads cannot overwrite a saved position with a temporary zero.
    const frame = requestAnimationFrame(() => { scroll.scrollTop = restore.current.top; restore.current.done = true; });
    return () => cancelAnimationFrame(frame);
  }, [controller, recentReady]);
  function navigate(route: Parameters<BriefShellPort["navigate"]>[0], runId = state.selectedRunId) {
    controller.savePosition(restore.current.done ? element.current?.closest<HTMLElement>(".brief-workspace-content")?.scrollTop ?? 0 : restore.current.top, runId);
    shell.navigate(route);
  }
  const notice = state.error ?? (ingredientBlocked ? "Selected ingredients are unavailable. Your selection is kept; remove them to create without them." : !enabled ? "Workflow creation is unavailable. Your prompt is kept." : state.busy ? "Preparing your workflow…"
    : unresolved ? job?.state === "running" ? "Building and checking your workflow…" : "Waiting to prepare your workflow…"
    : job?.state === "draft_ready" ? "Your draft is ready. It has not been enabled or run."
    : job?.blocker?.message ?? (job?.state === "cancelled" ? "Creation cancelled. Your prompt is kept." : job?.state === "failed" || job?.state === "blocked" ? "Could not prepare this workflow. Your prompt is kept; revise it or send again." : ""));
  return <div ref={element} className="brief-workflow-creation">
    <section className="brief-workflow-create-group" aria-labelledby="brief-workflow-create-title">
      <h1 id="brief-workflow-create-title" className="brief-type-room-title">Create your workflow</h1>
      <ConversationComposer mode={shell.mode} reducedMotion={reducedMotion} label="Workflow prompt" placeholder="Describe the work you want to automate…"
        suggestions={WORKFLOW_SUGGESTIONS} sendingLabel="Preparing your workflow…" suggestionsLabel="Workflow suggestions"
        ingredients={ingredients.length ? <IngredientChips selected={ingredients} onChange={controller.setIngredients}/> : undefined}
        attachmentControl={catalog ? <IngredientPicker catalog={catalog} selected={ingredients} onChange={controller.setIngredients} enabled={ingredientEnabled && !state.storageFailed} reducedMotion={reducedMotion}/> : binding.ingredientControl ?? <BriefTooltip label="Connection and library selection unavailable"><button type="button" aria-label="Add connection or library node" aria-disabled="true"><Plus size={18} aria-hidden="true" /></button></BriefTooltip>}
        binding={{ source:controller.source, scopeId:controller.scopeId, conversationId:"workflow-creation", mode:"scoped", connected:true,
          draft:state.draft, metadataPending:locked, turn:null, pendingAcceptance:false, error:null, maxBytes:PROMPT_BYTES,
          actions:{ setDraft:controller.setDraft, send:controller.submit, cancel:()=>{} } }} />
      <div className="brief-workflow-create-feedback" aria-live="polite">
        <p>{notice}</p>
        {job?.blocker?.details?.length ? <ul>{job.blocker.details.map((detail, i) => <li key={i}>{detail}</li>)}</ul> : null}
        {state.error && unresolved && !state.storageFailed && enabled && <BriefButton size="sm" disabled={state.busy} onClick={() => void controller.recover()}>Check request</BriefButton>}
        {!unresolved && job?.state === "draft_ready" && job.workflow && <BriefButton size="sm" variant="text" onClick={() => navigate({room:"workflow-draft",selection:{flowId:job.workflow!.flowId,versionId:job.workflow!.versionId}})}>Open draft</BriefButton>}
      </div>
    </section>
    <RecentWorkflows mode={shell.mode} binding={binding.recent} selectedRunId={state.selectedRunId}
      onOpen={row => navigate({room:"workflow",selection:{flowId:row.flowId,versionId:row.versionId,runId:row.runId}}, row.runId)}
      onAll={() => navigate({room:"all-workflows",selection:{}})} />
  </div>;
}
