import React, {useEffect, useId, useState} from 'react';
import './mailchimp.css';
type Choice = {value: string; label: string};
export function MailchimpLocation({input, onChange, campaign = false}: {
  input: Record<string, unknown>; onChange: (key: string, value: unknown) => void; campaign?: boolean;
}) {
  const field = campaign ? 'campaign_id' : 'list_id', label = campaign ? 'Sent campaign' : 'Audience';
  const [options, setOptions] = useState<Choice[]>([]);
  const [manual, setManual] = useState(() => typeof input[field] === 'string' && (input[field] as string).includes('{{'));
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [more, setMore] = useState(false);
  const [revision, setRevision] = useState(0); const id = useId();
  useEffect(() => {
    let live = true; setLoading(true); setOptions([]); setError('');
    fetch('/api/integrations/mailchimp/options?kind=' + (campaign ? 'campaigns' : 'audiences'))
      .then(async response => {const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not load Mailchimp choices.'); return result;})
      .then(result => {if (live) {setOptions(result.options); setMore(result.has_more);}})
      .catch(e => {if (live) setError(e instanceof Error ? e.message : 'Could not load Mailchimp choices.');})
      .finally(() => {if (live) setLoading(false);});
    return () => {live = false;};
  }, [campaign, revision]);
  useEffect(() => {const refresh = () => setRevision(r => r + 1); window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh);}, []);
  const value = typeof input[field] === 'string' ? input[field] as string : '';
  const unknown = !!value && !options.some(option => option.value === value);
  return <section className="mailchimp-location" aria-label="Mailchimp selection">
    <label htmlFor={id}>{label} {manual ? <input id={id} value={value} required placeholder="ID or workflow variable" onChange={e => onChange(field, e.target.value)} />
      : <select id={id} value={value} required disabled={loading || !!error} onChange={e => onChange(field, e.target.value)}>
        <option value="">{loading ? 'Loading…' : `Choose ${campaign ? 'a sent campaign' : 'an audience'}`}</option>
        {unknown && <option value={value}>{value.includes('{{') ? `Workflow variable: ${value}` : `Saved ID: ${value} (check account access)`}</option>}
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>}</label>
    {!loading && !error && !options.length && <p role="status">{campaign ? 'No sent campaigns found. Reports are available after a campaign has been sent.' : 'No audiences found in this account.'}</p>}
    {more && <p>Showing the first 100 {campaign ? 'sent campaigns' : 'audiences'}. Enter an ID or use a workflow variable for another selection.</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" onClick={() => setManual(!manual)}>{manual ? 'Choose from Mailchimp' : 'Enter an ID or variable'}</button>
    <button type="button" disabled={loading} onClick={() => setRevision(r => r + 1)}>Reload choices</button>
  </section>;
}
