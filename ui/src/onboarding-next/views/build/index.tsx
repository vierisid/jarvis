import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { acceptStatus, isTerminal, phases, verifiedReference, type BuildStatus, type DraftReference } from "./state";
import "./build.css";
export type { BuildPhase, BuildOutcome, BuildStatus, DraftReference } from "./state";

export type BuildAction = "cancel" | "resume" | "retry" | "provide_input" | "explore";
export interface BuildModel {
  journeyId: string;
  jobId: string;
  requestId: string;
  /** Control acknowledgement revision. Phase events do not advance this counter. */
  revision: number;
  title: string;
  prompt: string;
  theme: "light" | "dark";
  availability: "ready" | "unsupported" | "unavailable";
  status?: BuildStatus;
  transport: "connected" | "disconnected";
  timedOut?: boolean;
  cancellation: "not_requested" | "requested" | "acknowledged";
  result?: { state: "pending" | "ready" | "unavailable"; reference?: DraftReference; safeError?: string };
  /** Explicit host permissions/readiness, not permissions inferred from UI state. */
  actions: Partial<Record<BuildAction, boolean>> & { openResult?: boolean };
}
export type BuildIntent = {
  journeyId: string; jobId: string; requestId: string;
  revision: number; statusRevision: number | null; commandId: string;
} & ({ action: BuildAction } | { action: "open_result"; result: DraftReference });
export interface BuildViewProps {
  model: BuildModel;
  onIntent: (intent: BuildIntent) => void | Promise<void>;
  reducedMotion?: boolean;
}

const markPath = "M50 0 L80.4 0 A19.6 19.6 0 0 1 100 19.6 L100 50 A50 50 0 0 1 50 100 A50 50 0 0 1 0 50 A50 50 0 0 1 50 0 Z";
function Mark({ small = false }: { small?: boolean }) {
  return <svg className={small ? "on-build__pebble" : "on-build__mark"} viewBox="0 0 100 100" aria-hidden="true"><path d={markPath} fill="currentColor" /></svg>;
}
export function BuildView(props: BuildViewProps) {
  return <BuildSession key={JSON.stringify([props.model.journeyId, props.model.jobId, props.model.requestId])} {...props} />;
}

function BuildSession({ model, onIntent, reducedMotion = false }: BuildViewProps) {
  const id = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<BuildStatus | null>(() => acceptStatus(null, model.status, model.jobId));
  const next = acceptStatus(status, model.status, model.jobId);
  if (next !== status) setStatus(next);
  const current = next;
  const live = useRef({ mounted: true, revision: model.revision });
  live.current.revision = model.revision;
  const pendingRef = useRef<BuildAction | null>(null);
  const commandAttempt = useRef(0);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [pending, setPending] = useState<BuildAction | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const commands = useRef(new Map<BuildAction, BuildIntent>());
  const [requestOpen, setRequestOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const opened = useRef<string | null>(null);
  const openAttempt = useRef(0);
  const latestOpen = useRef<BuildIntent | null>(null);

  useLayoutEffect(() => { live.current.mounted = true; titleRef.current?.focus({ preventScroll: true });
    return () => { live.current.mounted = false; }; }, []);
  useLayoutEffect(() => {
    pendingRef.current = null; commandAttempt.current++; setPending(null); setCancelRequested(false); setUncertain(false); setError(""); commands.current.clear();
  }, [model.revision]);

  // If a provider transition removes the focused recovery control, place focus
  // on its successor. Never steal focus from the request or another page control.
  const priorFocus = typeof document !== "undefined" && actionsRef.current?.contains(document.activeElement)
    ? document.activeElement as HTMLElement : null;
  useLayoutEffect(() => {
    if (priorFocus && !priorFocus.isConnected && document.activeElement === document.body) {
      const successor = actionsRef.current?.querySelector<HTMLButtonElement>('button:not([aria-disabled="true"])');
      (successor ?? titleRef.current)?.focus({ preventScroll: true });
    }
  });

  const terminal = isTerminal(current);
  const available = model.availability === "ready";
  const reference = model.result?.state === "ready" && verifiedReference(model.result.reference, model.jobId, model.requestId) ? model.result.reference : undefined;
  // A durable saved draft can survive a failed/cancelled build. Offer explicit
  // recovery there, but automatically hand off only an authoritative success.
  const canOpen = available && model.actions.openResult === true && terminal && Boolean(reference);
  const resultKey = reference ? JSON.stringify([reference.jobId, reference.compositionRecordId, reference.flowId, reference.versionId]) : null;
  useLayoutEffect(() => {
    if (opened.current && opened.current !== resultKey) {
      openAttempt.current++; opened.current = null; latestOpen.current = null;
      setOpening(false); setOpenError("");
    }
  }, [resultKey]);
  const autoOpen = canOpen && current?.outcome === "succeeded";
  const connected = model.transport === "connected";
  const cancelling = !terminal && (model.cancellation !== "not_requested" || cancelRequested);
  const waiting = !current;
  const recovering = !connected || model.timedOut || uncertain;
  const permitted = (action: BuildAction): boolean => {
    if (!available || !model.actions[action] || opening) return false;
    if (action === "resume") return pendingRef.current !== "resume";
    if (pendingRef.current || uncertain) return false;
    if (action === "cancel") return !terminal && !waiting && !cancelling && connected && !model.timedOut;
    if (action === "retry") return terminal && current?.outcome !== "succeeded" && connected && !reference;
    if (action === "provide_input") return current?.outcome === "needs_input" && connected && !cancelling && !model.timedOut;
    return terminal || current?.outcome === "needs_input";
  };
  const envelope = () => ({ journeyId: model.journeyId, jobId: model.jobId, requestId: model.requestId,
    revision: model.revision, statusRevision: current?.revision ?? null, commandId: crypto.randomUUID() });
  const dispatch = (action: BuildAction) => {
    if (!permitted(action)) return;
    const intent = commands.current.get(action) ?? { ...envelope(), action };
    commands.current.set(action, intent);
    pendingRef.current = action; setPending(action); setError("");
    const revision = model.revision;
    const attempt = ++commandAttempt.current;
    if (action === "cancel") setCancelRequested(true);
    const fail = () => {
      if (!live.current.mounted || live.current.revision !== revision || commandAttempt.current !== attempt || opened.current) return;
      pendingRef.current = null; setPending(null); setUncertain(true);
      setError("We couldn’t confirm that action. Check the build status before trying again.");
    };
    try { const result = onIntent(intent); if (result) Promise.resolve(result).catch(fail); } catch { fail(); }
  };
  const openResult = (retry = false) => {
    if (!canOpen || !reference || !resultKey || opening || (!retry && opened.current === resultKey)) return;
    opened.current = resultKey; setOpening(true); setOpenError("");
    const attempt = ++openAttempt.current;
    const intent: BuildIntent = retry && latestOpen.current?.action === "open_result"
      && latestOpen.current.result.flowId === reference.flowId && latestOpen.current.result.versionId === reference.versionId
      ? latestOpen.current : { ...envelope(), action: "open_result", result: { ...reference } };
    latestOpen.current = intent;
    const fail = () => {
      if (!live.current.mounted || openAttempt.current !== attempt) return;
      setOpening(false); setOpenError("Your draft is saved, but we couldn’t open it. Try opening it again.");
    };
    try { const result = onIntent(intent); if (result) Promise.resolve(result).catch(fail); } catch { fail(); }
  };
  useEffect(() => { if (autoOpen && opened.current !== resultKey) openResult(); });
  // No timers progress the build or create success. Motion decorates only the
  // provider's active phase, and never changes status or triggers navigation.
  let heading = "Building your first workflow.";
  let commentary = "You’ll land directly on the canvas when it’s ready.";
  if (!available) { heading = "Build status is unavailable."; commentary = "Your request is still here. The build service needs to reconnect."; }
  else if (opening) { heading = "Your draft is saved."; commentary = "Opening your workflow…"; }
  else if (current?.outcome === "succeeded") { heading = reference ? "Your draft is saved." : "Finishing your workflow."; commentary = reference ? "Your workflow is ready to review." : "Checking that your draft was saved before opening it."; }
  else if (current?.outcome === "failed") { heading = model.timedOut ? "The build timed out." : "The build needs another try."; commentary = current.safeError || "Your request is still here. Nothing has been enabled or run."; }
  else if (current?.outcome === "cancelled") { heading = "The build was cancelled."; commentary = reference ? "A draft was saved before the build stopped. You can still review it." : "Your request is still here."; }
  else if (cancelling) { heading = "Stopping the build."; commentary = "Waiting for confirmation. The build may still finish."; }
  else if (!connected) { heading = "Reconnecting to your build."; commentary = "The connection was lost. Your build may still be running."; }
  else if (model.timedOut) { heading = "Waiting for an update."; commentary = "The status check timed out. We haven’t confirmed that the build stopped."; }
  else if (current?.outcome === "needs_input") { heading = "One detail before we continue."; commentary = "Your original request is saved."; }
  else if (current?.outcome === "queued") commentary = "Your request is queued. We’ll show each step as work begins.";
  else if (waiting) commentary = "Waiting for the first build update.";
  const active = available && connected && !recovering && !cancelling && current?.outcome === "working" && Boolean(current.phase);
  return <section className="on-build" data-theme={model.theme} data-reduced-motion={reducedMotion} aria-labelledby={id + "-title"}>
    <div className="on-build__content">
      <Mark />
      <h1 ref={titleRef} tabIndex={-1} id={id + "-title"} className="on-build__title">{heading}</h1>
      <p className="on-build__name">{model.title}</p>
      <ol className="on-build__phases" aria-label="Workflow build phases">
        {phases.map(phase => {
          // Saving is shown complete only once the host verified the saved draft.
          const complete = current?.completedPhases?.includes(phase.id) && (phase.id !== "saving" || Boolean(reference));
          const isCurrent = current?.phase === phase.id && current.outcome === "working";
          return <li key={phase.id} className="on-build__phase" data-state={complete ? "complete" : isCurrent ? "current" : "waiting"}
            data-active={active && isCurrent} aria-current={isCurrent ? "step" : undefined}>
            <span className="on-build__indicator">{complete ? <span aria-hidden="true">✓</span> : isCurrent ? <Mark small /> : <span className="on-build__dot" />}</span>
            <span>{phase.label}<span className="on-build__sr">: {complete ? "complete" : isCurrent ? "current step" : "not confirmed complete"}</span></span>
          </li>;
        })}
      </ol>
      <div className="on-build__feedback">
        <p role="status" aria-live="polite" aria-atomic="true" className="on-build__commentary">{commentary}<span className="on-build__sr">{active ? " Current step: " + phases.find(phase => phase.id === current?.phase)?.label : ""}</span></p>
        {current?.outcome === "needs_input" && Boolean(current.missingInputs?.length) && <ul className="on-build__missing">{current.missingInputs!.map((item, i) => <li key={i}>{item}</li>)}</ul>}
        {model.result?.state === "unavailable" && <p className="on-build__error">{model.result.safeError || "The saved draft could not be verified. Check its status to continue."}</p>}
        {(error || openError) && <p role="alert" className="on-build__error">{openError || error}</p>}
      </div>
      <div ref={actionsRef} className="on-build__actions" aria-label="Build actions">
        {canOpen && !opening && <button className="on-build__primary" onClick={() => openResult(true)}>{openError ? "Try opening again" : "Open saved draft"}</button>}
        {current?.outcome === "needs_input" && <button className="on-build__primary" aria-disabled={!permitted("provide_input")} onClick={() => dispatch("provide_input")}>Add missing details</button>}
        {terminal && current?.outcome !== "succeeded" && !reference && <button className="on-build__primary" aria-disabled={!permitted("retry")} onClick={() => dispatch("retry")}>Retry build</button>}
        {(!terminal || !reference || openError) && <button aria-disabled={!permitted("resume")} onClick={() => dispatch("resume")}>{pending === "resume" ? "Checking status…" : "Check status"}</button>}
        {!terminal && current && <button aria-disabled={!permitted("cancel")} onClick={() => dispatch("cancel")}>{cancelling ? "Cancellation requested" : "Cancel build"}</button>}
        {(terminal || current?.outcome === "needs_input") && <button className="on-build__text" aria-disabled={!permitted("explore")} onClick={() => dispatch("explore")}>Explore Jarvis</button>}
      </div>
      <div className="on-build__request">
        <button className="on-build__text" aria-expanded={requestOpen} aria-controls={id + "-request"} onClick={() => setRequestOpen(open => !open)}>{requestOpen ? "Hide your request" : "View your request"}<span aria-hidden="true">{requestOpen ? "−" : "+"}</span></button>
        <div id={id + "-request"} hidden={!requestOpen}><p>{model.prompt}</p></div>
      </div>
    </div>
  </section>;
}
