import React, { useRef, useState } from 'react';
import type { Fact } from './useMemoryData';
import { isSingleValued, appliesAt } from '../../../../../src/vault/fact-policy';

const time = (value: number | null) => value === null ? 'Unspecified' : new Date(value).toLocaleString();
export function FactDetails({ fact }: { fact: Fact }) {
  const [mode, setMode] = useState<'confirm' | 'correct' | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Fact[] | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (saving.current || !mode) return;
    const values = new FormData(event.currentTarget);
    saving.current = true; setBusy(true); setError('');
    try {
      const response = await fetch(`/api/vault/facts/${encodeURIComponent(fact.id)}/${mode}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true, reason: values.get('reason'),
          ...(mode === 'correct' ? { object: values.get('object') } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save. Try again.');
      setMode(null); setHistory(null); window.dispatchEvent(new Event('vault-facts-updated'));
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save'); }
    finally { saving.current = false; setBusy(false); }
  }
  async function loadHistory() {
    try {
      const response = await fetch(`/api/vault/facts?subject_id=${encodeURIComponent(fact.subject_id)}&include_superseded=true`);
      if (!response.ok) throw new Error('Could not load earlier values');
      const all: Fact[] = await response.json();
      setHistory(all.filter(f => f.status === 'superseded' && f.predicate_key === fact.predicate_key && f.scope === fact.scope));
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load history'); }
  }
  return <>
    <div className="v2-mem__fact-pred">{fact.predicate}</div>
    <div className="v2-mem__fact-obj">{fact.object}</div>
    <div className="v2-mem__fact-meta">{fact.basis} · {fact.status}{!appliesAt(fact) && ' · outside recorded validity'} · {(fact.confidence * 100).toFixed(0)}% confidence · {fact.source || 'Source unspecified'}</div>
    <details>
      <summary>Source and dates</summary>
      <p>Recorded: {time(fact.created_at)}<br />Confirmed: {time(fact.verified_at)}<br />
        Scope: {fact.scope || 'Unspecified'}<br />Valid from: {time(fact.valid_from)}<br />Valid until: {time(fact.valid_to)}</p>
      {fact.evidence.map(e => <p key={e.id}>{e.basis} · {e.source || 'Source unspecified'} · {(e.confidence * 100).toFixed(0)}% · {time(e.recorded_at)}
        {e.source_ref && <><br />{e.source_ref}</>}{e.quote && <><br />{e.quote}</>}</p>)}
      <button type="button" onClick={loadHistory}>Earlier values</button>
      {history && (history.length ? history.map(f => <p key={f.id}>{f.object} · superseded · {f.source || 'Source unspecified'} · {time(f.created_at)}</p>) : <p>No earlier values.</p>)}
    </details>
    {!mode && fact.status !== 'superseded' && <div className="v2-mem__fact-controls">
      {(fact.basis !== 'confirmed' || fact.status === 'contested') && <button type="button" onClick={() => { setError(''); setMode('confirm'); }}>Confirm fact</button>}
      <button type="button" onClick={() => { setError(''); setMode('correct'); }}>Correct fact</button>
    </div>}
    {mode && <form className="v2-mem__fact-review" onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>{mode === 'correct' ? 'Correct this fact' : 'Confirm this value'}</legend>
        {mode === 'correct' && <label>Correct value<textarea name="object" defaultValue={fact.object} required maxLength={4000} /></label>}
        <label>Reason or source<textarea name="reason" required maxLength={1000} /></label>
        <p>{isSingleValued(fact.predicate) ? 'This confirms the value and replaces competing values in the same scope and period.' : 'Other locations, aliases and values will be kept.'}</p>
        <button type="submit">{busy ? 'Saving…' : 'Save confirmed value'}</button>
        <button type="button" onClick={() => setMode(null)}>Cancel</button>
      </fieldset>
    </form>}
    {error && <p role="alert">{error}</p>}
  </>;
}
