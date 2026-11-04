import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { answerErrors, type HumanRequest } from '../../../../src/workflows/runtime/human-input-contract';
import type { HostTransport } from './http';
import { post } from './http';
import './human-inputs.css';
/** Polls only while the decisions capability is on, like the other Needs you lists. */
export function useHumanInputQueue(http: HostTransport, enabled = true) {
  const [requests, setRequests] = useState<HumanRequest[]>([]), [error, setError] = useState('');
  const active = useRef(true), reading = useRef(false);
  const refresh = async () => {
    if (reading.current || http.signal.aborted) return;
    reading.current = true;
    try {
      const value = await http.json('/api/workflow-inputs');
      if (!Array.isArray(value.requests)) throw Error();
      if (active.current) { setRequests(value.requests); setError(''); }
    } catch { if (active.current && !http.signal.aborted) setError('Workflow requests could not be refreshed. Reconnect and check again.'); }
    finally { reading.current = false; }
  };
  useEffect(() => {
    if (!enabled) { setRequests([]); setError(''); return; }
    active.current = true; void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const focus = () => void refresh(); window.addEventListener('focus', focus);
    return () => { active.current = false; clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [http, enabled]);
  return { requests, error, refresh };
}
export const HumanInputsContext = createContext({ pending: 0 });
export const useHumanInputCount = () => useContext(HumanInputsContext).pending;
export function HumanInputForm({ request, http, changed, focused = false }: { request: HumanRequest; http: HostTransport; changed(): Promise<void>; focused?: boolean }) {
  const storageKey = `jarvis:workflow-input:${request.id}`;
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey) ?? '{}'); } catch { return {}; }
  });
  const [errors, setErrors] = useState<Record<string, string>>({}), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const lock = useRef(false), card = useRef<HTMLElement>(null);
  // A link from Create Approval Links names its request: bring that card into view and focus.
  useEffect(() => { if (focused) { card.current?.scrollIntoView?.({ block: 'start' }); card.current?.focus(); } }, [focused]);
  const update = (key: string, value: unknown) => {
    const next = { ...answers, [key]: value }; setAnswers(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Form remains usable without browser storage. */ }
    setErrors(previous => ({ ...previous, [key]: '' }));
  };
  const respond = async (decision: string) => {
    if (lock.current) return;
    const invalid = decision === 'submit' ? answerErrors(request.fields, answers) : {};
    setErrors(invalid);
    if (Object.keys(invalid).length) { setMessage('Check the highlighted answers.'); return; }
    lock.current = true; setBusy(true); setMessage('');
    try {
      const response = await http.request(`/api/workflow-inputs/${encodeURIComponent(request.id)}`, post({ decision, ...(decision === 'submit' ? { answers } : {}) }));
      const result = await response.json();
      if (!response.ok) { setErrors(result.errors ?? {}); setMessage(result.error ?? 'Response could not be saved.'); await changed(); return; }
      sessionStorage.removeItem(storageKey);
      setMessage(`Response saved: ${result.request.status}.`);
      await changed();
    } catch { setMessage('Your response could not be confirmed. Your answers are kept here. Check the request status before retrying.'); await changed(); }
    finally { lock.current = false; setBusy(false); }
  };
  return <article ref={card} tabIndex={-1} className="brief-human-card" aria-current={focused || undefined} aria-labelledby={`human-title-${request.id}`}>
    <header><span className="brief-human-kind">{request.kind === 'approval' ? 'Approval requested' : 'Your update is needed'}</span>
      <h2 id={`human-title-${request.id}`}>{request.title}</h2>
      <p>{request.workflowName} · {request.requestKey}</p></header>
    <p className="brief-human-prompt">{request.prompt}</p>
    <p className="brief-human-deadline">Requested <time dateTime={new Date(request.created).toISOString()}>{new Date(request.created).toLocaleString()}</time>. Respond by <time dateTime={new Date(request.deadline).toISOString()}>{new Date(request.deadline).toLocaleString()}</time>.</p>
    <form noValidate onSubmit={event => { event.preventDefault(); void respond(request.kind === 'approval' ? 'approve' : 'submit'); }}>
      <fieldset disabled={busy}><legend className="brief-human-sr">{request.kind === 'approval' ? 'Decision' : 'Your answers'}</legend>
        {request.fields.map(field => {
          const id = `human-${request.id}-${field.key}`;
          const props = { id, required: field.required, 'aria-invalid': !!errors[field.key], 'aria-describedby': errors[field.key] ? `${id}-error` : undefined };
          return <div className="brief-human-field" key={field.key}><label htmlFor={id}>{field.label}{field.required ? ' (required)' : ' (optional)'}</label>
            {field.type === 'long_text' ? <textarea {...props} rows={4} maxLength={10000} value={String(answers[field.key] ?? '')} onChange={e => update(field.key, e.target.value)} />
              : field.type === 'boolean' || field.type === 'select' ? <select {...props} value={String(answers[field.key] ?? '')} onChange={e => update(field.key, field.type === 'boolean' && e.target.value ? e.target.value === 'true' : e.target.value)}>
                <option value="">Choose an answer</option>{(field.type === 'boolean' ? ['true', 'false'] : field.options!).map(option => <option key={option} value={option}>{field.type === 'boolean' ? option === 'true' ? 'Yes' : 'No' : option}</option>)}</select>
              : <input {...props} type={field.type === 'number' ? 'number' : 'text'} step={field.type === 'number' ? 'any' : undefined} maxLength={10000}
                value={String(answers[field.key] ?? '')} onChange={e => update(field.key, field.type === 'number' && e.target.value !== '' ? e.target.valueAsNumber : e.target.value)} />}
            {errors[field.key] && <p id={`${id}-error`} className="brief-human-error">{errors[field.key]}</p>}
          </div>;
        })}
        {errors._form && <p role="alert">{errors._form}</p>}
        <div className="brief-human-actions"><button type="submit">{busy ? 'Saving response…' : request.kind === 'approval' ? 'Approve and continue' : 'Submit update'}</button>
          <button type="button" onClick={() => void respond(request.kind === 'approval' ? 'reject' : 'cancel')}>{request.kind === 'approval' ? 'Reject request' : 'Cancel this request'}</button></div>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </form>
    <a href={`/?brief=1#/brief/workflows/${encodeURIComponent(request.flowId)}/runs`}>View workflow run</a>
  </article>;
}
export function HumanInputInbox({ queue, http, focusId }: { queue: ReturnType<typeof useHumanInputQueue>; http: HostTransport; focusId?: string }) {
  const pending = queue.requests.filter(r => r.status === 'pending');
  const recent = queue.requests.filter(r => r.status !== 'pending').sort((a, b) => b.created - a.created).slice(0, 10);
  if (!pending.length && !recent.length && !queue.error) return null;
  return <section className="brief-human-inbox" aria-label="Workflow requests">
    {queue.error && <p role="status">{queue.error} <button onClick={() => void queue.refresh()}>Check again</button></p>}
    {pending.map(request => <HumanInputForm key={request.id} request={request} http={http} changed={queue.refresh} focused={request.id === focusId} />)}
    {!!recent.length && <details className="brief-human-history"><summary>Recent responses ({recent.length})</summary>
      <ul>{recent.map(r => <li key={r.id}><strong>{r.title}</strong> · {r.requestKey} · {r.status}</li>)}</ul></details>}
  </section>;
}
