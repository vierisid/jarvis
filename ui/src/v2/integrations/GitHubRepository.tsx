import React, {useEffect, useId, useState} from 'react';
import './github.css';
type Choice = {value: {owner: string; repo: string}; label: string};
const name = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && 'owner' in value && 'repo' in value ? `${value.owner}/${value.repo}` : '';
export function GitHubRepository({input, onChange}: {input: Record<string, unknown>; onChange: (key: string, value: unknown) => void}) {
  const [options, setOptions] = useState<Choice[]>([]), [manual, setManual] = useState(() => typeof input.repository === 'string');
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [more, setMore] = useState(false);
  const [revision, setRevision] = useState(0); const id = useId(), value = name(input.repository);
  useEffect(() => {
    let live = true; setLoading(true); setOptions([]); setError(''); setMore(false);
    fetch('/api/integrations/github/options')
      .then(async response => {const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not load repositories.'); return result;})
      .then(result => {if (live) {setOptions(result.options); setMore(result.has_more);}})
      .catch(e => {if (live) setError(e instanceof Error ? e.message : 'Could not load repositories.');})
      .finally(() => {if (live) setLoading(false);});
    return () => {live = false;};
  }, [revision]);
  useEffect(() => {const refresh = () => setRevision(r => r + 1); window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh);}, []);
  const update = (text: string) => {const parts = text.split('/'); onChange('repository', !text.includes('{{') && parts.length === 2 ? {owner: parts[0], repo: parts[1]} : text);};
  return <section className="github-location" aria-label="GitHub repository">
    <label htmlFor={id}>Repository {manual ? <input id={id} value={value} required placeholder="owner/repository or workflow variable" onChange={e => update(e.target.value)} />
      : <select id={id} value={value} required disabled={loading || !!error} onChange={e => update(e.target.value)}>
        <option value="">{loading ? 'Loading…' : 'Choose a repository'}</option>
        {!!value && !options.some(option => option.label === value) && <option value={value}>Saved repository: {value} (check account access)</option>}
        {options.map(option => <option key={option.label} value={option.label}>{option.label}</option>)}
      </select>}</label>
    {!loading && !error && !options.length && <p role="status">No active repositories with issues found. Check organization access in GitHub or enter a repository name.</p>}
    {more && <p>Showing active repositories from the first 100 results. Enter another repository by name if needed.</p>}
    {manual && <p>A workflow variable must contain an object with owner and repo.</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" onClick={() => setManual(!manual)}>{manual ? 'Choose from GitHub' : 'Enter a repository or variable'}</button>
    <button type="button" disabled={loading} onClick={() => setRevision(r => r + 1)}>Reload repositories</button>
  </section>;
}
