import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { WORKFLOW_EXAMPLES } from '../../v2/onboarding/WorkflowActivation';
import { OnboardingDraft, pendingDraft } from './draft';
import { ONBOARDING_TARGETS } from './targets';

/** The final step prepares only a disabled F-07 draft, on an explicit click. */
export function BriefWorkflowActivation({ draft, onContinue }: {
  draft: OnboardingDraft; onContinue: () => void | Promise<void>;
}) {
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const handoff = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');
  const pending = !!state.request && pendingDraft(state.job);
  const ready = state.job?.state === 'draft_ready';
  const enabled = draft.available();
  const busy = state.busy || leaving;
  useEffect(() => {
    if (!enabled || !state.job || !pending || state.error) return;
    const timer = setTimeout(() => { void draft.check(); }, 1000);
    return () => clearTimeout(timer);
  }, [draft, enabled, pending, state]);
  const leave = async (review: boolean) => {
    if (handoff.current) return;
    handoff.current = true; setLeaving(true); setError('');
    try {
      if (review) await draft.openDraft();
      await onContinue();
    } catch { setError('Couldn’t open Jarvis. Your task and draft are kept. Try again.'); }
    finally { handoff.current = false; setLeaving(false); }
  };
  return <form className="obw-activation" onSubmit={event => {
    event.preventDefault(); setError('');
    if (ready) void leave(true); else void draft.prepare();
  }}>
    <label htmlFor={id}>What’s one task you keep doing?</label>
    <p className="obw-activation__intro" id={`${id}-help`}>Describe the repetition. Jarvis can help turn it into your first workflow.</p>
    <textarea id={id} ref={input} data-onboarding-target={ONBOARDING_TARGETS.workflows.id}
      value={state.routine} onChange={event => draft.setRoutine(event.target.value)}
      placeholder="Every week, I…" rows={3} maxLength={2000} disabled={busy || pending || ready}
      aria-describedby={`${id}-help ${id}-review`} />
    <div className="obw-activation__examples" role="group" aria-label="Example recurring tasks">
      <span>Try an example</span>
      {WORKFLOW_EXAMPLES.map(example => <button type="button" key={example.label} disabled={busy || pending || ready}
        onClick={() => { draft.setRoutine(example.task); input.current?.focus(); }}>{example.label}</button>)}
    </div>
    <p className="obw-activation__note" id={`${id}-review`}>Prepare a draft, then review its steps in Workflows. Nothing is enabled or run by this tutorial.</p>
    <p role="status">{!enabled ? 'Workflow preparation is unavailable. Your task is kept until setup is ready.'
      : ready ? 'Your draft is ready to review.'
      : state.job?.state === 'blocked' ? 'The draft needs more details or connections. Edit your task and try again.'
      : state.job?.state === 'failed' || state.job?.state === 'cancelled' ? 'The draft could not be prepared. Your task is kept for another attempt.'
      : pending && !state.error ? state.job ? 'Preparing your draft…' : 'Your request is saved. Check its result to continue.' : ''}</p>
    {(error || state.error) && <p className="obw-activation__error" role="alert">{error || state.error}</p>}
    <button className="obw-btn obw-btn-pri" type="submit" disabled={busy || !enabled || !state.routine.trim()}>
      {leaving ? 'Opening Jarvis…' : state.busy ? 'Preparing your draft…' : ready ? 'Review draft'
        : pending ? 'Check request' : state.job ? 'Retry draft' : 'Prepare draft'}
    </button>
    <button className="obw-skip" type="button" disabled={busy} onClick={() => void leave(false)}>Explore Jarvis first</button>
  </form>;
}
