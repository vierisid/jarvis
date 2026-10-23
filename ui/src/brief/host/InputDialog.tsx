import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../../v2/ui/ConfirmDialog.css';
interface Prompt { label: string; initial: string; signal?: AbortSignal; resolve(value: string | null): void }
let open: ((prompt: Prompt) => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** Native prompts are unavailable in embedded WebViews. Never fall back to them. */
export function inputDialog(label: string, initial = '', signal?: AbortSignal): Promise<string | null> {
  const result = queue.then(() => new Promise<string | null>(resolve => {
    if (!open || signal?.aborted) return resolve(null);
    open({ label, initial, signal, resolve });
  }));
  queue = result.catch(() => null); return result;
}
export function InputHost() {
  const [prompt, setPrompt] = useState<Prompt | null>(null), [value, setValue] = useState('');
  const current = useRef(prompt), box = useRef<HTMLFormElement>(null), restore = useRef<HTMLElement | null>(null); current.current = prompt;
  useEffect(() => {
    open = next => { restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setValue(next.initial); setPrompt(next); };
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
        const items = box.current?.querySelectorAll<HTMLElement>('textarea, button');
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
  return createPortal(<div className="jconfirm" role="presentation"><form ref={box} className="jconfirm__box" role="dialog" aria-modal="true" aria-label={prompt.label}
    onSubmit={event => { event.preventDefault(); if (value.trim()) close(value); }}>
    <label className="jconfirm__title" htmlFor="brief-command-input">{prompt.label}</label>
    <textarea id="brief-command-input" autoFocus rows={4} value={value} onChange={event => setValue(event.target.value)} />
    <div className="jconfirm__actions"><button type="button" className="jconfirm__btn jconfirm__btn--ghost" onClick={() => close(null)}>Cancel</button>
      <button type="submit" className="jconfirm__btn jconfirm__btn--pri" disabled={!value.trim()}>Continue</button></div>
  </form></div>, document.body);
}
