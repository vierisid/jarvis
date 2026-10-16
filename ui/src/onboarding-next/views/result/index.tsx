import React, { Component, useEffect, useId, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { artifactKey, savedResult, unavailableMessage } from './model';
import type { ResultModel, SavedResult } from './model';
import './result.css';
export type { ResultModel, SavedResult, DraftReference, Continuation } from './model';

/** Supplied D18 canvas/inspector adapter. Keep this component type stable across layout changes. */
export interface ResultCanvasProps {
  draft: SavedResult; reviewing: boolean;
  onDirtyChange(dirty: boolean): void;
  /** Revoke the reveal when the renderer detects a deleted/replaced/inaccessible version. */
  onUnavailable(): void;
}
export interface ResultAction {
  action: 'review' | 'finish' | 'refresh' | 'open_workflow' | 'back';
  scopeId: string; journeyId: string; jobId: string; requestId: string; revision: number;
  commandId: string; draft: SavedResult | null;
}
export interface ResultViewProps {
  model: ResultModel; Canvas?: ComponentType<ResultCanvasProps>;
  onReview?: (action: ResultAction) => void | Promise<void>;
  onContinue?: (action: ResultAction) => void | Promise<void>;
  onRefresh?: (action: ResultAction) => void | Promise<void>;
  onOpenWorkflow?: (action: ResultAction) => void | Promise<void>;
  onBack?: (action: ResultAction) => void | Promise<void>;
}
class CanvasBoundary extends Component<{ children: ReactNode; onUnavailable(): void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() { this.props.onUnavailable(); }
  override render() { return this.state.failed ? null : this.props.children; }
}
export function ResultView(props: ResultViewProps) {
  return <ResultSession key={JSON.stringify([props.model.scopeId, props.model.journeyId, props.model.jobId, props.model.requestId])} {...props} />;
}
function ResultSession(props: ResultViewProps) {
  // A stale same-scope observation cannot revive a withdrawn result or completion descriptor.
  const accepted = useRef(props.model);
  if (props.model.revision > accepted.current.revision) accepted.current = props.model;
  const model = { ...accepted.current, theme: props.model.theme };
  const draft = savedResult(model);
  return <ResultContent key={draft ? artifactKey(draft) : 'unavailable'} {...props} model={model} draft={draft} />;
}
function ResultContent({ model, draft, Canvas, onReview, onContinue, onRefresh, onOpenWorkflow, onBack }: ResultViewProps & { draft: SavedResult | null }) {
  const [reviewing, setReviewing] = useState(false), [dirty, setDirty] = useState(false);
  const [revoked, setRevoked] = useState<number | null>(null);
  const [pending, setPending] = useState<ResultAction | null>(null), [error, setError] = useState(false);
  const active = useRef<ResultAction | null>(null), mounted = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null), canvas = useRef<HTMLDivElement>(null);
  const id = useId();
  const live = useRef({ model, draft }); live.current = { model, draft };
  const valid = !!draft && revoked !== model.revision;
  const canvasReady = valid && !!Canvas;
  useEffect(() => { mounted.current = true; heading.current?.focus(); return () => { mounted.current = false; active.current = null; }; }, []);
  useEffect(() => { active.current = null; setPending(null); setError(false); }, [model.revision]);
  const revoke = () => { setRevoked(model.revision); setDirty(false); heading.current?.focus(); };
  async function invoke(action: ResultAction['action'], callback: ResultViewProps['onContinue']) {
    if (!callback || (active.current && action !== 'refresh')) return;
    if (action !== 'refresh' && error) return;
    if ((action === 'finish' || action === 'open_workflow' || action === 'back' || action === 'refresh') && dirty) return;
    if (action === 'finish' && (!valid || !draft?.continuation)) return;
    if ((action === 'review' && !canvasReady) || (action === 'open_workflow' && !valid)) return;
    const command: ResultAction = { action, scopeId: model.scopeId, journeyId: model.journeyId, jobId: model.jobId,
      requestId: model.requestId, revision: model.revision, commandId: crypto.randomUUID(), draft: valid ? draft : null };
    // Reconcile an uncertain command instead of repeating finish/navigation.
    if (action === 'refresh' && active.current?.action === 'refresh') return;
    active.current = command; setPending(command); setError(false);
    if (action === 'review') { setReviewing(true); canvas.current?.focus(); }
    try {
      await callback(command);
      if (!mounted.current || active.current !== command || live.current.model.revision !== command.revision) return;
      if (action === 'review') {
        active.current = null; setPending(null); setReviewing(true); canvas.current?.focus();
      }
      // Other deliveries await an authoritative host acknowledgement or navigation.
    } catch {
      if (!mounted.current || active.current !== command || live.current.model.revision !== command.revision) return;
      active.current = null; setPending(null); setError(true);
    }
  }
  const locked = !!pending || error;
  const review = () => {
    if (locked || !canvasReady) return;
    if (onReview) void invoke('review', onReview);
    else { setReviewing(true); canvas.current?.focus(); }
  };
  return <section className="on-result" data-theme={model.theme} aria-labelledby={`${id}-title`}>
    <header className="on-result__header">
      <div><p className="on-result__eyebrow">Your first workflow</p><h1 ref={heading} tabIndex={-1} id={`${id}-title`}>{valid ? draft!.title : 'Let’s find your draft.'}</h1></div>
      {valid && <div className="on-result__header-actions">{reviewing && <button type="button" onClick={() => setReviewing(false)}>View draft summary</button>}<span className="on-result__badge">Draft · Not enabled</span><button type="button" onClick={review} disabled={!canvasReady || locked}>Review steps</button></div>}
    </header>
    <div className="on-result__body">
      <div className="on-result__canvas" ref={canvas} tabIndex={-1} role="region" aria-label="Workflow canvas">
        {canvasReady ? <CanvasBoundary key={revoked === null ? 'canvas' : model.revision} onUnavailable={revoke}>
          <Canvas draft={draft!} reviewing={reviewing} onDirtyChange={setDirty} onUnavailable={revoke} />
        </CanvasBoundary> : <div className="on-result__empty"><h2>{valid ? 'Canvas unavailable' : 'Draft recovery'}</h2><p role="status">{valid ? 'Your draft is saved. Open it in Workflows or check again when the canvas is available.' : unavailableMessage(model.result)}</p></div>}
      </div>
      {valid && !reviewing && <aside className="on-result__review" aria-label="Draft review">
        <p className="on-result__eyebrow">{reviewing ? 'Review your draft' : 'Ready for your review'}</p>
        <h2>{reviewing ? 'Make it yours.' : 'Your first workflow is ready.'}</h2>
        <p>Review the steps and connections. This workflow is a draft and is not enabled.</p>
        {reviewing ? <p>Select a step to open its inspector.</p> : <button className="on-result__primary" type="button" onClick={review} disabled={!canvasReady || locked}>Review the steps</button>}
        <div className="on-result__readiness" role="status">
          <strong>{draft!.readiness.ready ? 'Draft checks passed' : 'Needs your input'}</strong>
          <p>{draft!.readiness.ready ? 'Running or enabling this workflow requires the existing workflow checks and Authority.' : 'Review the missing inputs and connections before running this workflow.'}</p>
        </div>
        {(draft!.readiness.issues.length > 0 || draft!.missingBindings.length > 0) && <details open><summary>Inputs and connections to review</summary><ul>{[...new Map([...draft!.readiness.issues, ...draft!.missingBindings].map(i => [JSON.stringify([i.node, i.path, i.code]), i])).values()].map(i => <li key={JSON.stringify([i.node, i.path, i.code])}><strong>{i.node || 'Workflow'}</strong><p>{i.message}</p><small>{i.path}</small></li>)}</ul></details>}
        {!!draft!.readiness.runtimeChecks.length && <p>Additional checks will run when you choose to run this workflow.</p>}
        {!draft!.continuation && <p role="status">Checking saved progress before continuing. You can still review your draft.</p>}
      </aside>}
    </div>
    <footer className="on-result__footer">
      <div className="on-result__feedback" role="status" aria-live="polite">{error ? 'We could not confirm that action. Check again before continuing.' : pending ? 'Waiting for confirmation…' : dirty ? 'Save or discard your canvas edits before leaving or refreshing.' : reviewing ? 'Select a step to open its inspector.' : ''}</div>
      <div className="on-result__actions">
        {onBack && <button type="button" disabled={locked || dirty} onClick={() => void invoke('back', onBack)}>Back to your request</button>}
        {onRefresh && <button type="button" disabled={dirty || pending?.action === 'refresh'} onClick={() => void invoke('refresh', onRefresh)}>Check again</button>}
        {valid && onOpenWorkflow && <button type="button" disabled={locked || dirty} onClick={() => void invoke('open_workflow', onOpenWorkflow)}>Open in Workflows</button>}
        {valid && onContinue && <button className="on-result__primary" type="button" disabled={locked || dirty || !draft!.continuation} onClick={() => void invoke('finish', onContinue)}>Continue to dashboard</button>}
      </div>
    </footer>
  </section>;
}
