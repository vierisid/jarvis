import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../../v2/ui/ConfirmDialog.css';
interface Prompt { label: string; initial: string; signal?: AbortSignal; validate?: (value: string) => string | null; fields?: string[]; resolve(value: string | null): void }
let open: ((prompt: Prompt) => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** Native prompts are unavailable in embedded WebViews. Never fall back to them. */
export function inputDialog(label: string, initial = '', signal?: AbortSignal, validate?: Prompt['validate'], fields?: string[]): Promise<string | null> {
  const result = queue.then(() => new Promise<string | null>(resolve => {
    if (!open || signal?.aborted) return resolve(null);
    open({ label, initial, signal, validate, fields, resolve });
  }));
  queue = result.catch(() => null); return result;
}
/** Keep malformed input in the dialog. A returned value has passed this exact parser. */
export async function manualRunInput(signal?: AbortSignal, fields: string[] = []): Promise<Record<string, unknown> | null> {
  const raw = await inputDialog(fields.length ? 'Input for this manual run' : 'Input for this manual run (JSON object)', '{}', signal, value => {
    try { const parsed = JSON.parse(value); if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return null; } catch { /* Offer correction in place. */ }
    return 'Enter a valid JSON object, for example {"customerId":"123"}. Your input has been kept. No run has started.';
  }, fields);
  return raw === null ? null : JSON.parse(raw);
}
export function InputHost() {
  const [prompt, setPrompt] = useState<Prompt | null>(null), [value, setValue] = useState(''), [error, setError] = useState(''), [advanced, setAdvanced] = useState(false), [entries, setEntries] = useState<Record<string, string>>({});
  const current = useRef(prompt), box = useRef<HTMLFormElement>(null), restore = useRef<HTMLElement | null>(null); current.current = prompt;
  useEffect(() => {
    open = next => { restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setValue(next.initial); setError(''); setAdvanced(false); setEntries({}); setPrompt(next); };
    return () => { open = null; current.current?.resolve(null); };
  }, []);
  const close = (value: string | null) => { current.current?.resolve(value); setPrompt(null); };
  useEffect(() => {
    if (!prompt) return;
    const previous = restore.current;
    const abort = () => close(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(null); }
      if (event.key === 'Tab') {
        const items = box.current?.querySelectorAll<HTMLElement>('textarea, input, button');
        if (!items?.length) return;
        const first = items[0]!, last = items[items.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    prompt.signal?.addEventListener('abort', abort, { once: true }); window.addEventListener('keydown', key, true);
    return () => { prompt.signal?.removeEventListener('abort', abort); window.removeEventListener('keydown', key, true); previous?.focus(); };
  }, [prompt]);
  if (!prompt) return null;
  const fields = prompt.fields ?? [], form = fields.length > 0 && !advanced;
  // Own keys only: a field named like an Object.prototype member ("toString",
  // "constructor") must read as empty, not as the inherited function.
  const own = (from: unknown, name: string): unknown => from !== null && typeof from === 'object' && Object.prototype.hasOwnProperty.call(from, name) ? (from as Record<string, unknown>)[name] : undefined;
  const entry = (name: string): string => { const v = own(entries, name); return typeof v === 'string' ? v : ''; };
  const answers = () => JSON.stringify(Object.fromEntries(fields.map(name => [name, entry(name)])));
  const toggleAdvanced = () => {
    // Carry what was typed across, in the shape the other view reads.
    if (form) setValue(answers());
    else { try { const parsed: unknown = JSON.parse(value); setEntries(Object.fromEntries(fields.map(name => { const v = own(parsed, name); return [name, typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v)]; }))); } catch { /* Keep the entries as they were. */ } }
    setError(''); setAdvanced(!advanced);
  };
  return createPortal(<div className="jconfirm" role="presentation"><form ref={box} className="jconfirm__box" role="dialog" aria-modal="true" aria-label={prompt.label}
    onSubmit={event => { event.preventDefault();
      if (form) { close(answers()); return; }
      if (!value.trim()) return; const invalid = prompt.validate?.(value); if (invalid) { setError(invalid); box.current?.querySelector('textarea')?.focus(); } else close(value); }}>
    {form ? <>
      <h2 className="jconfirm__title">{prompt.label}</h2>
      <p className="jconfirm__body">This workflow starts with these values. Leave a field empty to send it blank.</p>
      {fields.map((name, index) => <label key={name} className="jconfirm__body" style={{ display: 'grid', gap: 4 }}>{name}
        <input type="text" autoFocus={index === 0} value={entry(name)} onChange={event => setEntries({ ...entries, [name]: event.target.value })} />
      </label>)}
    </> : <>
      <label className="jconfirm__title" htmlFor="brief-command-input">{prompt.label}</label>
      <textarea id="brief-command-input" autoFocus rows={4} value={value} aria-invalid={!!error} aria-describedby={error ? "brief-command-error" : undefined} onChange={event => { setValue(event.target.value); setError(''); }} />
      {error && <p id="brief-command-error" className="jconfirm__body" role="alert">{error}</p>}
    </>}
    <div className="jconfirm__actions">
      {fields.length > 0 && <button type="button" className="jconfirm__btn jconfirm__btn--ghost" aria-pressed={advanced} onClick={toggleAdvanced}>{advanced ? 'Use the form' : 'Advanced: JSON'}</button>}
      <button type="button" className="jconfirm__btn jconfirm__btn--ghost" onClick={() => close(null)}>Cancel</button>
      <button type="submit" className="jconfirm__btn jconfirm__btn--pri" disabled={!form && !value.trim()}>Continue</button></div>
  </form></div>, document.body);
}
