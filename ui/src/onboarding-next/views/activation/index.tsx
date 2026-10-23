import React, { useId, useLayoutEffect, useRef, useState } from "react";
import "./activation.css";

export const MAX_PROMPT_LENGTH = 2000;
export const activationExamples = [
  { id: "meeting", label: "Meeting follow-up", prompt: "After each meeting, use my notes to draft a follow-up. Ask me to review it before anything is sent." },
  { id: "update", label: "Weekly update", prompt: "Every Friday, collect my company metrics and draft an investor update for me to review before sending." },
  { id: "competitor", label: "Competitor brief", prompt: "Every Tuesday, check competitor websites and prepare a short brief of the changes for me to review." },
] as const;

/** Opaque references supplied by the host, never inferred from prompt text. */
export interface ActivationContextRef { kind: string; id: string; }
export interface ActivationDraft {
  prompt: string;
  contextRefs: ActivationContextRef[];
  answers: Record<string, string>;
}
export interface ActivationRequest {
  schemaVersion: 1;
  requestId: string;
  intentVersion: 1;
  prompt: string;
  contextRefs: ActivationContextRef[];
}
export interface ActivationIssue {
  id: string;
  kind: "detail" | "connection";
  label: string;
  message: string;
  /** A user-selected reference that can be explicitly removed from this draft. */
  reference?: ActivationContextRef;
}
export interface ActivationModel {
  journeyId: string;
  /** Advance only for authoritative feedback, not keystrokes/theme changes. */
  revision: number;
  theme: "light" | "dark";
  availability: "ready" | "unavailable" | "unsupported";
  phase: "ready" | "checking" | "submitting" | "needs_input" | "invalid" | "accepted";
  draft: ActivationDraft;
  interview?: { state: "ready" | "unavailable"; goal?: string; suggestions: Array<{ id: string; label: string; prompt: string }> };
  issues?: ActivationIssue[];
  message?: string;
  /** Restore this exact request and its answers when a submit needs reconciliation. */
  pendingRequest?: { request: ActivationRequest; answers: Record<string, string> };
}
export type ActivationIntent = {
  journeyId: string; revision: number; from: "activation";
} & (
  | { action: "create"; request: ActivationRequest; answers: Record<string, string> }
  | { action: "back"; to: "tour"; draft: ActivationDraft }
  | { action: "explore"; to: "exited"; draft: ActivationDraft }
  | { action: "resolve_connection"; issueId: string; draft: ActivationDraft }
);
export interface ActivationViewProps {
  model: ActivationModel;
  onDraftChange: (draft: ActivationDraft) => void;
  onIntent: (intent: ActivationIntent) => void | Promise<void>;
  canResolveConnection?: boolean;
}

/** Optional presentation only. ON-U-10 owns registration and durable draft state;
 * B-07/B-08 own validation, reconciliation, job acceptance and safe persistence. */
export function ActivationView(props: ActivationViewProps) {
  return <ActivationSession key={props.model.journeyId} {...props} />;
}
function ActivationSession({ model, onDraftChange, onIntent, canResolveConnection }: ActivationViewProps) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const live = useRef({ mounted: true, revision: model.revision });
  live.current.revision = model.revision;
  const lock = useRef<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const pendingAction = useRef<string | null>(null);
  const [localError, setLocalError] = useState("");
  const uncertain = useRef<ActivationIntent & { action: "create" } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const blocked = model.phase === "checking" || model.phase === "submitting" || model.phase === "accepted";
  const busy = blocked || pending === model.revision;
  const recovery = retrying || Boolean(model.pendingRequest);
  const editable = !busy && !recovery;
  const valid = Boolean(model.draft.prompt.trim()) && model.draft.prompt.length <= MAX_PROMPT_LENGTH;
  const available = model.availability === "ready";
  const canSubmit = !busy && available && (recovery || valid);
  const personalized = Boolean(model.interview?.suggestions.length);
  const examples = personalized ? model.interview!.suggestions : model.interview?.goal || model.interview?.state === "unavailable" ? [] : activationExamples;
  const issues = model.issues?.filter(issue => !issue.reference || model.draft.contextRefs.some(ref =>
    ref.kind === issue.reference!.kind && ref.id === issue.reference!.id)) ?? [];

  useLayoutEffect(() => { live.current.mounted = true; input.current?.focus({ preventScroll: true });
    return () => { live.current.mounted = false; }; }, []);
  useLayoutEffect(() => {
    lock.current = null; setPending(null); setLocalError(""); uncertain.current = null; setRetrying(false);
  }, [model.revision]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(224, Math.max(124, el.scrollHeight))}px`;
  }, [model.draft.prompt]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      cancelAnimationFrame(frame);
      // Defer layout writes out of ResizeObserver delivery. A height-only
      // notification must not schedule another measurement or create a loop.
      frame = requestAnimationFrame(() => {
        el.style.height = "0px";
        el.style.height = `${Math.min(224, Math.max(124, el.scrollHeight))}px`;
      });
    });
    observer.observe(el); return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  const edit = (draft: ActivationDraft) => { if (!editable) return; setLocalError(""); onDraftChange(draft); };
  const dispatch = (intent: ActivationIntent) => {
    if (busy || lock.current === model.revision) return;
    pendingAction.current = intent.action;
    lock.current = model.revision; setPending(model.revision); setLocalError("");
    const revision = model.revision;
    const fail = () => {
      if (!live.current.mounted || live.current.revision !== revision) return;
      lock.current = null; setPending(null);
      if (intent.action === "create") {
        uncertain.current = intent; setRetrying(true);
        setLocalError("We couldn’t confirm your request. Retry the same request to check it safely. Your text is still here.");
      } else setLocalError("Couldn’t continue. Your text is still here. Try again.");
    };
    try {
      const result = onIntent(intent);
      // A resolved callback is delivery, not authoritative job/journey acceptance.
      if (result) Promise.resolve(result).catch(fail);
    } catch { fail(); }
  };
  const submit = () => {
    if (!canSubmit || composing.current || lock.current === model.revision) return;
    const prior = uncertain.current ?? (model.pendingRequest ? {
      ...model.pendingRequest, journeyId: model.journeyId, revision: model.revision,
      from: "activation" as const, action: "create" as const,
    } : null);
    dispatch(prior ?? {
      journeyId: model.journeyId, revision: model.revision, from: "activation", action: "create",
      request: { schemaVersion: 1, requestId: crypto.randomUUID(), intentVersion: 1,
        prompt: model.draft.prompt, contextRefs: model.draft.contextRefs.map(ref => ({ ...ref })) },
      answers: { ...model.draft.answers },
    });
  };
  const navigate = (action: "back" | "explore") => {
    if (!editable) return;
    dispatch({ journeyId: model.journeyId, revision: model.revision, from: "activation", draft: model.draft,
      ...(action === "back" ? { action: "back", to: "tour" } : { action: "explore", to: "exited" }) });
  };
  const notice = localError || model.message || (model.phase === "accepted" ? "Your request was accepted. Opening the build…"
    : busy ? pendingAction.current === "explore" ? "Preparing your goal plan and opening your workspace…" : "Checking your request…" : !available ? "Workflow creation isn’t available yet. You can keep your request and explore Jarvis first." : "");
  return <section className="on-activation" data-theme={model.theme} data-personalized={personalized || Boolean(model.interview?.goal)} aria-labelledby={`${id}-title`}>
    <div className="on-activation__content">
      {/* Official mark path from the D-line brand asset; geometry is unchanged. */}
      <svg className="on-activation__mark" viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="M50 0 L80.4 0 A19.6 19.6 0 0 1 100 19.6 L100 50 A50 50 0 0 1 50 100 A50 50 0 0 1 0 50 A50 50 0 0 1 50 0 Z" /></svg>
      <h1 id={`${id}-title`} className="on-activation__title">Let’s make room for your work.</h1>
      <label className="on-activation__question" htmlFor={`${id}-prompt`}>{personalized || model.interview?.goal ? "Which part of your work should we start with?" : "What’s one task you keep doing?"}</label>
      <form className="on-activation__form" onSubmit={event => { event.preventDefault(); submit(); }}>
        {model.interview?.goal && <p className="on-activation__goal"><strong>Your goal:</strong> {model.interview.goal}</p>}
        <p className="on-activation__hint" id={`${id}-hint`}>{model.interview?.state === "unavailable"
          ? "We couldn’t load your interview. Describe your routine below, or reload to try again."
          : personalized ? "From your interview. Choose a starting point, then edit the request below."
          : model.interview?.goal ? "Describe a routine that will help you work toward this goal."
          : "No interview suggestions yet. Try a general example, or describe your own routine."}</p>
        {examples.length > 0 && <div className={`on-activation__examples${personalized ? " on-activation__examples--personal" : ""}`} role="group" aria-label={personalized ? "From your interview" : "General workflow examples"}>
          {examples.map(example => <button key={example.id} type="button" aria-disabled={!editable}
            aria-pressed={model.draft.prompt === example.prompt} className="on-activation__example" onClick={() => {
              if (!editable) return; edit({ ...model.draft, prompt: example.prompt }); input.current?.focus();
            }}>{example.label}</button>)}
        </div>}
        <div className="on-activation__prompt-space">
          <textarea ref={input} id={`${id}-prompt`} className="on-activation__prompt" value={model.draft.prompt}
            onChange={event => edit({ ...model.draft, prompt: event.target.value })} readOnly={!editable}
            aria-describedby={`${id}-hint ${id}-review ${id}-notice`} aria-invalid={model.phase === "invalid" || model.draft.prompt.length > MAX_PROMPT_LENGTH}
            placeholder="Every week, I…" rows={3} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
              // Enter writes a new line, including while composing with an IME.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.repeat && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault(); submit();
              }
            }} />
        </div>
        {model.draft.prompt.length > MAX_PROMPT_LENGTH && <p className="on-activation__error" role="alert">Keep your request under {MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters. Your text hasn’t been shortened.</p>}
        {Boolean(issues.length) && <div className="on-activation__issues" aria-label="Details to continue">
          {issues.map((issue, i) => <div className="on-activation__issue" key={issue.id}>
            {issue.reference ? <>
              <p className="on-activation__issue-label">{issue.label}</p><p>{issue.message}</p>
              <p>{issue.reference.kind}: {issue.reference.id}</p>
              <button type="button" className="on-activation__connection" aria-disabled={!editable}
                aria-label={`Remove selection ${issue.reference.kind}: ${issue.reference.id}`}
                onClick={() => {
                  if (!editable || lock.current === model.revision) return;
                  edit({ ...model.draft, contextRefs: model.draft.contextRefs.filter(ref =>
                    ref.kind !== issue.reference!.kind || ref.id !== issue.reference!.id) });
                  input.current?.focus();
                }}>Remove selection</button>
              {issue.kind === "connection" && canResolveConnection && <button type="button" className="on-activation__connection" aria-disabled={!editable}
                onClick={() => { if (editable) dispatch({ journeyId: model.journeyId, revision: model.revision, from: "activation", action: "resolve_connection", issueId: issue.id, draft: model.draft }); }}>Choose connection</button>}
            </> : issue.kind === "detail" ? <>
              <label htmlFor={`${id}-detail-${i}`} className="on-activation__issue-label">{issue.label}</label>
              <p id={`${id}-detail-help-${i}`}>{issue.message}</p>
              <input id={`${id}-detail-${i}`} type="text" value={model.draft.answers[issue.id] ?? ""} readOnly={!editable}
                aria-describedby={`${id}-detail-help-${i}`} onChange={event => edit({ ...model.draft, answers: { ...model.draft.answers, [issue.id]: event.target.value } })} />
            </> : <><p className="on-activation__issue-label">{issue.label}</p><p>{issue.message}</p>
              {canResolveConnection && <button type="button" className="on-activation__connection" aria-disabled={!editable}
                onClick={() => { if (editable) dispatch({ journeyId: model.journeyId, revision: model.revision, from: "activation", action: "resolve_connection", issueId: issue.id, draft: model.draft }); }}>Choose connection</button>}
            </>}
          </div>)}
        </div>}
        <p className="on-activation__review" id={`${id}-review`}>Jarvis will build the steps. You’ll review the workflow before it runs.</p>
        <div className="on-activation__notice" id={`${id}-notice`} role="status" aria-live="polite">{notice}</div>
        <button type="submit" className="on-activation__create" aria-disabled={!canSubmit}>
          {busy ? "Checking your request…" : recovery ? "Retry same request" : "Create my workflow"}
        </button>
        <nav className="on-activation__navigation" aria-label="Onboarding navigation">
          <button type="button" aria-disabled={!editable} onClick={() => navigate("back")}>Back to the tour</button>
          <button type="button" aria-disabled={!editable} onClick={() => navigate("explore")}>Explore Jarvis first</button>
        </nav>
      </form>
    </div>
  </section>;
}
