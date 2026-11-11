import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { answerErrors, humanRequestDismissable, humanRequestNeedsAttention, withoutBidiControls, type HumanRequest } from '../../../../src/workflows/runtime/human-input-contract';
import type { HostTransport } from './http';
import { EmergencyStatusContext } from './EmergencyStatus';
import { post } from './http';
import { briefHash } from '../entry/route';
import './human-inputs.css';
import { draftKey, instanceKey, rememberDraft, forgetDraft, localDraftRequests, localDraftIds, filled, storedAnswers, answerOnlyDrafts, forgetStoredDraft } from './human-input-drafts';
type HumanInputQueue = { requests: HumanRequest[]; error: string; refresh(): Promise<void>; historyCursor?: string | null; unavailable?: string[];
  /** Every pending request the server holds, listed or not. */
  pendingTotal?: number; showMore?(): void };
/** Pending requests asked for at first, and added by each "Show more": a list of a thousand is read a page at a time. */
export const HUMAN_INPUT_PAGE = 50;
/**
 * Polls only while the decisions capability is on, like the other Needs you lists, and only while
 * the page is visible: a hidden tab reads nothing, and reads once when it is shown again.
 */
export function useHumanInputQueue(http: HostTransport, enabled = true): HumanInputQueue {
  const [requests, setRequests] = useState<HumanRequest[]>([]), [error, setError] = useState('');
  const [historyCursor, setHistoryCursor] = useState<string | null>(null), [unavailable, setUnavailable] = useState<string[]>([]);
  const [pendingTotal, setPendingTotal] = useState<number | undefined>(), [limit, setLimit] = useState(HUMAN_INPUT_PAGE);
  const active = useRef(true), reading = useRef(false), again = useRef(false), wanted = useRef(HUMAN_INPUT_PAGE);
  wanted.current = limit;
  // Requests read for local drafts beyond the recent page, by id; null once the
  // server said it has no such request. A request outside the page is closed (a
  // pending one is always listed, and a reopen lists it again), so the copy read
  // once stays right; it is read again only after it was listed in between.
  const beyondPage = useRef(new Map<string, HumanRequest | null>());
  const refresh = async () => {
    if (http.signal.aborted) return;
    if (reading.current) { again.current = true; return; }
    reading.current = true;
    try {
      const value = await http.json(`/api/workflow-inputs?limit=${wanted.current}`);
      if (!Array.isArray(value.requests)) throw Error();
      // A browser draft must remain reachable even after it leaves the recent page.
      const listed = new Set<string>(value.requests.map((r: HumanRequest) => r.id)), drafts = localDraftIds();
      const cache = beyondPage.current;
      for (const id of [...cache.keys()]) if (listed.has(id) || !drafts.includes(id)) cache.delete(id);
      await Promise.all(drafts.filter(id => !listed.has(id) && !cache.has(id)).map(async id => {
        try {
          const response = await http.request(`/api/workflow-inputs/${encodeURIComponent(id)}`);
          if (response.status === 404) { cache.set(id, null); return; }
          if (!response.ok) return; // Asked again on the next refresh.
          const request = (await response.json()).request as HumanRequest;
          if (request?.id === id) cache.set(id, request);
        } catch { /* Asked again on the next refresh; the local copy stays available meanwhile. */ }
      }));
      const recovered = [...cache.values()].filter((r): r is HumanRequest => !!r);
      const gone = [...cache.entries()].filter(([, r]) => r === null).map(([id]) => id);
      if (active.current) {
        setRequests([...value.requests, ...recovered]); setHistoryCursor(value.historyCursor ?? null);
        setPendingTotal(Number.isSafeInteger(value.pendingTotal) ? value.pendingTotal : undefined);
        setUnavailable(previous => previous.length === gone.length && previous.every((id, i) => id === gone[i]) ? previous : gone); setError('');
      }
    } catch { if (active.current && !http.signal.aborted) setError('Workflow requests could not be refreshed. Reconnect and check again.'); }
    finally { reading.current = false; if (again.current) { again.current = false; void refresh(); } }
  };
  useEffect(() => {
    if (!enabled) { setRequests([]); setError(''); return; }
    active.current = true; void refresh();
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 5000);
    const focus = () => void refresh(); window.addEventListener('focus', focus);
    const shown = () => { if (document.visibilityState === 'visible') void refresh(); }; document.addEventListener('visibilitychange', shown);
    return () => { active.current = false; clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', shown); };
  }, [http, enabled]);
  const showMore = () => { wanted.current += HUMAN_INPUT_PAGE; setLimit(wanted.current); void refresh(); };
  return { requests, error, refresh, historyCursor, unavailable, pendingTotal, showMore };
}
export const HumanInputsContext = createContext({ pending: 0 });
export const useHumanInputCount = () => useContext(HumanInputsContext).pending;
export function HumanInputForm({ request, http, changed, focused = false, recoveryOnly = false, onAnswers }: {
  request: HumanRequest; http: HostTransport; changed(): Promise<void>; focused?: boolean; recoveryOnly?: boolean;
  /** Told what this card holds in memory, so the inbox can tell an unsent answer from an empty card. */
  onAnswers?(answers: Record<string, unknown>): void;
}) {
  const storageKey = draftKey(request), domId = request.generation ? `${request.id}-generation-${request.generation}` : request.id;
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => {
    try { const value = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
  });
  const [errors, setErrors] = useState<Record<string, string>>({}), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const lock = useRef(false), card = useRef<HTMLElement>(null);
  // A link from Create Approval Links names its request: bring that card into view and focus.
  useEffect(() => { if (focused) { card.current?.scrollIntoView?.({ block: 'start' }); card.current?.focus(); } }, [focused]);
  const update = (key: string, value: unknown) => {
    const next = { ...answers, [key]: value }; setAnswers(next); onAnswers?.(next); rememberDraft(request);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Form remains usable without browser storage. */ }
    setErrors(previous => ({ ...previous, [key]: '' }));
  };
  const respond = async (decision: string) => {
    if (lock.current || recoveryOnly || request.status !== 'pending') return;
    const invalid = decision === 'submit' ? answerErrors(request.fields, answers) : {};
    setErrors(invalid);
    if (Object.keys(invalid).length) { setMessage('Check the highlighted answers.'); return; }
    lock.current = true; setBusy(true); setMessage('');
    try {
      const response = await http.request(`/api/workflow-inputs/${encodeURIComponent(request.id)}`, post({ decision, generation: request.generation ?? 0, ...(decision === 'submit' ? { answers } : {}) }));
      const result = await response.json();
      if (!response.ok) { setErrors(result.errors ?? {}); setMessage(result.error ?? 'Response could not be saved.'); await changed(); return; }
      // Any accepted decision, including an explicit cancel, ends this draft.
      forgetDraft(request); setAnswers({}); onAnswers?.({});
      setMessage(`Response saved: ${result.request.status}.`);
      await changed();
    } catch { setMessage('Your response could not be confirmed. Your answers are kept here. Check the request status before retrying.'); await changed(); }
    finally { lock.current = false; setBusy(false); }
  };
  // Answered in another tab: this tab's copy is no longer a draft of anything.
  useEffect(() => {
    if (answered(request) && !recoveryOnly) forgetDraft(request);
    else if (filled(answers).length) rememberDraft(request);
  }, [request.status, storageKey, recoveryOnly]);
  const pending = !recoveryOnly && request.status === 'pending';
  // Answered elsewhere (another tab): the local draft is no longer "unsent".
  const unsent = (recoveryOnly || !answered(request)) && filled(answers).length > 0;
  const draftText = request.fields.filter(field => filled(answers).includes(field.key)).map(field => `${field.label}: ${String(answers[field.key])}`).join('\n');
  const copy = async () => {
    try { await navigator.clipboard.writeText(draftText); setMessage('Unsent answers copied.'); }
    catch { setMessage('Copy was unavailable. Select the text in the fields and copy it.'); }
  };
  const discard = () => { forgetDraft(request); setAnswers({}); onAnswers?.({}); setMessage('Unsent answers discarded.'); };
  const dismiss = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try {
      const response = await http.request(`/api/workflow-inputs/${encodeURIComponent(request.id)}/dismiss`, post({ generation: request.generation ?? 0 }));
      const result = await response.json().catch(() => ({}));
      setMessage(response.ok ? 'Dismissed. This request no longer needs you.' : result.error ?? 'This request could not be dismissed.');
    } catch { setMessage('Dismiss could not be confirmed. Check again before retrying.'); }
    finally { lock.current = false; setBusy(false); await changed(); }
  };
  return <article ref={card} tabIndex={-1} className="brief-human-card" aria-current={focused || undefined} aria-labelledby={`human-title-${domId}`}>
    <header><span className="brief-human-kind">{recoveryOnly ? 'Unsent answer' : pending ? request.kind === 'approval' ? 'Approval requested' : 'Your update is needed' : `Request ${request.status}`}</span>
      <h2 id={`human-title-${domId}`}>{request.title}</h2>
      <p>{request.workflowName} · {request.requestKey}</p></header>
    <p className="brief-human-prompt">{request.prompt}</p>
    <p className="brief-human-deadline">Requested <time dateTime={new Date(request.created).toISOString()}>{new Date(request.created).toLocaleString()}</time>. Respond by <time dateTime={new Date(request.deadline).toISOString()}>{new Date(request.deadline).toLocaleString()}</time>.</p>
    {!pending && <p role="status">{recoveryOnly ? 'This saved answer belongs to an earlier or unavailable request. It has not been submitted. You can copy or discard it below.' : request.closureReason === 'workflow_changed'
      ? 'This workflow changed while waiting. Your answer was not accepted. Review the run and start a new request from the updated workflow.'
      : request.status === 'expired' ? 'The response deadline passed. This request cannot accept answers.'
      : request.status === 'cancelled' ? 'This request was cancelled and cannot accept answers.'
      : request.status === 'rejected' ? 'You rejected this request.' : 'Your response was saved. Check the run status below for what happened next.'}</p>}
    {!pending && unsent && <p>Your unsent answers are kept below. They have not been submitted.</p>}
    {(pending || unsent) && <form noValidate onSubmit={event => { event.preventDefault(); void respond(request.kind === 'approval' ? 'approve' : 'submit'); }}>
      <fieldset disabled={busy}><legend className="brief-human-sr">{request.kind === 'approval' ? 'Decision' : 'Your answers'}</legend>
        {request.fields.map(field => {
          const id = `human-${domId}-${field.key}`;
          const props = { id, required: pending && field.required, 'aria-invalid': !!errors[field.key], 'aria-describedby': errors[field.key] ? `${id}-error` : undefined };
          return <div className="brief-human-field" key={field.key}><label htmlFor={id}>{field.label}{field.required ? ' (required)' : ' (optional)'}</label>
            {field.type === 'long_text' ? <textarea {...props} readOnly={!pending} rows={4} maxLength={10000} value={String(answers[field.key] ?? '')} onChange={e => update(field.key, e.target.value)} />
              : field.type === 'boolean' || field.type === 'select' ? <select {...props} disabled={!pending} value={String(answers[field.key] ?? '')} onChange={e => update(field.key, field.type === 'boolean' && e.target.value ? e.target.value === 'true' : e.target.value)}>
                <option value="">Choose an answer</option>{(field.type === 'boolean' ? ['true', 'false'] : field.options!).map(option => <option key={option} value={option}>{field.type === 'boolean' ? option === 'true' ? 'Yes' : 'No' : withoutBidiControls(option)}</option>)}</select>
              : <input {...props} readOnly={!pending} type={field.type === 'number' ? 'number' : 'text'} step={field.type === 'number' ? 'any' : undefined} maxLength={10000}
                value={String(answers[field.key] ?? '')} onChange={e => update(field.key, field.type === 'number' && e.target.value !== '' ? e.target.valueAsNumber : e.target.value)} />}
            {errors[field.key] && <p id={`${id}-error`} className="brief-human-error">{errors[field.key]}</p>}
          </div>;
        })}
        {errors._form && <p role="alert">{errors._form}</p>}
        {pending && <div className="brief-human-actions"><button type="submit">{busy ? 'Saving response…' : request.kind === 'approval' ? 'Approve and continue' : 'Submit update'}</button>
          <button type="button" onClick={() => void respond(request.kind === 'approval' ? 'reject' : 'cancel')}>{request.kind === 'approval' ? 'Reject request' : 'Cancel this request'}</button></div>}
      </fieldset>
    </form>}
    {!pending && unsent && <div className="brief-human-actions"><button type="button" onClick={() => void copy()}>Copy unsent answers</button><button type="button" onClick={discard}>Discard unsent answers</button></div>}
    {!recoveryOnly && humanRequestDismissable(request) && <div className="brief-human-actions"><button type="button" disabled={busy} onClick={() => void dismiss()}>Dismiss</button></div>}
    {message && <p role="status">{message}</p>}
    {!recoveryOnly && request.status === 'submitted' && request.answers && <SubmittedAnswers request={request} />}
    {!recoveryOnly && <RunOutcomes request={request} />}
  </article>;
}
function RunOutcomes({ request }: { request: HumanRequest }) {
  const emergency = React.useContext(EmergencyStatusContext);
  const runs = request.runs ?? [{ runId: request.runId, versionId: '', status: 'UNKNOWN' }];
  return <ul className="brief-human-runs" aria-label="Workflow continuation">{runs.map(run => {
    const href = '/?brief=1' + briefHash({ room: 'workflow-runs', selection: { flowId: request.flowId, runId: run.runId, ...(run.versionId ? { versionId: run.versionId } : {}) } });
    const status = run.status === 'SUCCEEDED' ? 'Workflow completed.'
      // Under a global pause a waiting or queued run does not continue: say why.
      : emergency === 'paused' && ['PAUSED', 'QUEUED'].includes(run.status) ? 'Global emergency pause is holding this workflow. Saved responses will continue after you resume Jarvis.'
      : run.status === 'PAUSED' ? 'Workflow is waiting.'
      : ['QUEUED', 'RUNNING'].includes(run.status) ? 'Workflow is continuing.'
      : run.status === 'STOPPED' ? 'Workflow was stopped.'
      : ['UNKNOWN', 'UNAVAILABLE'].includes(run.status) ? 'Run status is unavailable. Open the run to check.'
      : 'Workflow failed. Review the run before retrying.';
    return <li key={run.runId}><p>{status}</p><a href={href}>View workflow run</a></li>;
  })}</ul>;
}
const answered = (request: HumanRequest) => request.status === 'submitted' || request.status === 'approved';
/** A draft that should keep the request in Needs you: not once it was answered or dismissed. */
export function hasLocalDraft(request: HumanRequest): boolean {
  if (answered(request) || request.dismissedAt) return false;
  try { return filled(JSON.parse(sessionStorage.getItem(draftKey(request)) ?? '{}')).length > 0; } catch { return false; }
}
export function HumanInputInbox({ queue, http, focusId }: { queue: HumanInputQueue; http: HostTransport; focusId?: string }) {
  const retained = useRef(new Map<string, HumanRequest>());
  // Answers each mounted card holds, which may never have reached browser storage.
  const memory = useRef(new Map<string, Record<string, unknown>>()), [, setEmptied] = useState(0);
  const remember = (key: string) => (answers: Record<string, unknown>) => {
    const had = filled(memory.current.get(key)).length > 0; memory.current.set(key, answers);
    if (had && !filled(answers).length) setEmptied(n => n + 1); // A discarded recovery card can now go.
  };
  const unsentDraft = (request: HumanRequest) => filled(storedAnswers(request)).length > 0 || filled(memory.current.get(instanceKey(request))).length > 0;
  const [focused, setFocused] = useState<HumanRequest | null>(null), [focusError, setFocusError] = useState('');
  const [older, setOlder] = useState<HumanRequest[]>([]), [cursor, setCursor] = useState<string | null | undefined>();
  const [loading, setLoading] = useState(false), [historyError, setHistoryError] = useState('');
  const [focusAttempt, setFocusAttempt] = useState(0);
  // Closed requests seen on the recent page once older pages are loaded: one that
  // a new close pushes off page one is then on neither, and would drop out of history.
  const leftPage = useRef(new Map<string, HumanRequest>());
  // Keyed on whether the queue has the request, not on each poll's new array.
  const focusListed = !!focusId && queue.requests.some(r => r.id === focusId);
  useEffect(() => {
    let live = true; setFocused(null); setFocusError('');
    if (focusId && !focusListed) {
      void http.request(`/api/workflow-inputs/${encodeURIComponent(focusId)}`).then(async response => {
        if (!live) return;
        if (response.status === 404) { setFocusError('This request was not found in this workspace.'); return; }
        if (!response.ok) throw Error();
        const value = await response.json();
        if (live) setFocused(value.request);
      }).catch(() => { if (live) setFocusError('This request could not be loaded. Check your connection and try again.'); });
    }
    return () => { live = false; };
  }, [focusId, focusListed, focusAttempt, http]);
  if (cursor !== undefined) for (const request of queue.requests) if (request.status !== 'pending') leftPage.current.set(instanceKey(request), request);
  const all = new Map<string, HumanRequest>();
  for (const request of [...older, ...leftPage.current.values(), ...(focused ? [focused] : []), ...queue.requests]) all.set(instanceKey(request), request);
  for (const request of all.values()) {
    const key = instanceKey(request);
    if (humanRequestNeedsAttention(request) || hasLocalDraft(request) || request.id === focusId || retained.current.has(key)) retained.current.set(key, request);
    // hasLocalDraft is false once a request is dismissed: a dismissed card always leaves.
    if (request.dismissedAt) retained.current.delete(key);
  }
  // Keep an in-memory card after it falls out of the recent page, even when
  // browser storage is full. On remount recover the persisted copy read-only.
  const recovered = localDraftRequests().filter(r => !all.has(instanceKey(r)) && !retained.current.has(instanceKey(r)));
  // A superseded instance, or a pending one the server no longer lists, can only
  // be shown as an unsent answer. With nothing typed into it there is nothing to show.
  const recoveryOnly = (request: HumanRequest) => [...all.values()].some(r => r.id === request.id && (r.generation ?? 0) > (request.generation ?? 0))
    || (!all.has(instanceKey(request)) && request.status === 'pending');
  // Nor does a card the server stopped listing, unless it holds an answer or the link names it.
  for (const [key, request] of [...retained.current]) {
    if ((recoveryOnly(request) || !all.has(key)) && !unsentDraft(request) && request.id !== focusId) retained.current.delete(key);
  }
  const visible = [...retained.current.values()].sort((a,b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.created - a.created);
  // Saved answers whose request the server no longer has and whose labels were never stored.
  const known = new Set([...all.values(), ...retained.current.values(), ...recovered].map(r => r.id));
  const orphaned = (queue.unavailable ?? []).filter(id => !known.has(id)).flatMap(answerOnlyDrafts);
  const recent = [...all.values()].filter(r => !retained.current.has(instanceKey(r))).sort((a,b) => (b.closedAt ?? b.created) - (a.closedAt ?? a.created));
  const hiddenPending = Math.max(0, (queue.pendingTotal ?? 0) - queue.requests.filter(r => r.status === 'pending').length);
  const nextCursor = cursor === undefined ? queue.historyCursor : cursor;
  const loadOlder = async () => {
    if (loading || !nextCursor) return;
    setLoading(true); setHistoryError('');
    try {
      const value = await http.json('/api/workflow-inputs/history?cursor=' + encodeURIComponent(nextCursor));
      setOlder(previous => [...previous, ...value.requests]); setCursor(value.nextCursor);
    } catch { setHistoryError('Older responses could not be loaded. Try again.'); }
    finally { setLoading(false); }
  };
  if (!visible.length && !recent.length && !recovered.length && !orphaned.length && !queue.error && !focusError) return null;
  return <section className="brief-human-inbox" aria-label="Workflow requests">
    {queue.error && <p role="status">{queue.error} <button onClick={() => void queue.refresh()}>Check again</button></p>}
    {focusError && <p role="status">{focusError} <button onClick={() => setFocusAttempt(n => n + 1)}>Check again</button></p>}
    {visible.map(request => {
      const recovery = recoveryOnly(request);
      return <HumanInputForm key={instanceKey(request)} request={request} http={http} changed={queue.refresh} focused={request.id === focusId && !recovery} recoveryOnly={recovery} onAnswers={remember(instanceKey(request))} />;
    })}
    {recovered.map(request => <HumanInputForm key={instanceKey(request)} request={request} http={http} changed={queue.refresh} recoveryOnly
      onAnswers={answers => { if (!filled(answers).length) setEmptied(n => n + 1); }} />)}
    {orphaned.map(draft => <UnavailableDraft key={draft.storageKey} draft={draft} discarded={() => setEmptied(n => n + 1)} />)}
    {queue.showMore && hiddenPending > 0 && <div className="brief-human-actions"><button type="button" onClick={queue.showMore}>Show more requests ({hiddenPending} more waiting)</button></div>}
    {(!!recent.length || !!nextCursor) && <details className="brief-human-history"><summary>Response history ({recent.length})</summary>
      {recent.map(request => <HumanInputForm key={instanceKey(request)} request={request} http={http} changed={queue.refresh} />)}
      {historyError && <p role="status">{historyError}</p>}
      {nextCursor && <div className="brief-human-actions"><button disabled={loading} onClick={() => void loadOlder()}>{loading ? 'Loading responses…' : 'Load older responses'}</button></div>}
    </details>}
  </section>;
}
/** A saved answer from before drafts kept their labels, whose request the server no longer has. */
function UnavailableDraft({ draft, discarded }: { draft: { storageKey: string; answers: Record<string, unknown> }; discarded(): void }) {
  const [message, setMessage] = useState('');
  const text = filled(draft.answers).map(key => `${key}: ${String(draft.answers[key])}`).join('\n');
  return <article className="brief-human-card" aria-label="Unsent answer">
    <header><span className="brief-human-kind">Unsent answer</span></header>
    <p role="status">The request for this saved answer is no longer available. It has not been submitted. You can copy or discard it below.</p>
    <pre className="brief-human-prompt">{text}</pre>
    <div className="brief-human-actions">
      <button type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(text); setMessage('Unsent answers copied.'); }
        catch { setMessage('Copy was unavailable. Select the text above and copy it.'); }
      }}>Copy unsent answers</button>
      <button type="button" onClick={() => { forgetStoredDraft(draft.storageKey); discarded(); }}>Discard unsent answers</button>
    </div>
    {message && <p role="status">{message}</p>}
  </article>;
}
function SubmittedAnswers({ request }: { request: HumanRequest }) {
  const [message, setMessage] = useState('');
  const value = (key: string) => Object.hasOwn(request.answers!, key) ? String(request.answers![key]) : 'Not provided';
  const text = request.fields.map(field => `${field.label}: ${value(field.key)}`).join('\n');
  return <section className="brief-human-receipt" aria-label="Submitted answers">
    <h3>Submitted answers</h3>
    <dl>{request.fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{value(field.key)}</dd></div>)}</dl>
    <div className="brief-human-actions"><button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setMessage('Submitted answers copied.'); }
      catch { setMessage('Copy was unavailable. Select the answer text and copy it.'); }
    }}>Copy submitted answers</button></div>
    {message && <p role="status">{message}</p>}
  </section>;
}
