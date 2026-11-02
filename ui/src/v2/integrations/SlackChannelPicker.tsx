import React, {useEffect, useRef, useState} from 'react';
import './slack.css';
type Option = {value:string;label:string};
export function SlackChannelPicker({value,onChange}:{value:string;onChange:(value:string)=>void}) {
  const [options,setOptions]=useState<Option[]>([]),[cursor,setCursor]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[manual,setManual]=useState(value.includes('{{'));
  const [revision,setRevision]=useState(0);
  const generation=useRef<string|null>(null), live=useRef(true), requestId=useRef(0);
  const load=async(next='')=>{
    const id=++requestId.current;setBusy(true);setError('');
    try {
      const response=await fetch('/api/integrations/slack/options?cursor='+encodeURIComponent(next));
      const result=await response.json();if(!response.ok)throw Error(result.error || 'Could not load Slack channels.');
      if(!live.current || id!==requestId.current)return;
      if(next && generation.current!==result.generation)throw Error('Slack account changed. Reload channels before choosing.');
      generation.current=result.generation;
      setOptions(current=>[...new Map([...(next?current:[]),...result.options].map((o:Option)=>[o.value,o])).values()] as Option[]);
      setCursor(result.next_cursor===next?'':result.next_cursor);
    } catch(e) {if(live.current && id===requestId.current)setError(e instanceof Error?e.message:'Could not load Slack channels.');}
    finally {if(live.current && id===requestId.current)setBusy(false);}
  };
  useEffect(()=>{live.current=true;void load();return()=>{live.current=false;requestId.current++;};},[revision]);
  return <section className="slack-location" aria-label="Slack channel">
    <label>Channel *{manual?<input required value={value} onChange={e=>onChange(e.target.value)} placeholder="Channel ID or workflow variable" />
      :<select required value={value} onChange={e=>onChange(e.target.value)} disabled={busy}>
        <option value="">Choose a channel</option>
        {value && !options.some(o=>o.value===value) && <option value={value}>{value} (saved channel)</option>}
        {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
      </select>}</label>
    <p>Invite the Jarvis app to the channel in Slack. Only channels it has joined appear here.</p>
    {busy && <p role="status">Loading channels…</p>}
    {error && <p role="alert">{error}</p>}
    {cursor && <button type="button" disabled={busy} onClick={()=>void load(cursor)}>Load more channels</button>}
    <button type="button" disabled={busy} onClick={()=>{setOptions([]);setCursor('');generation.current=null;setRevision(v=>v+1);}}>Reload channels</button>
    <button type="button" onClick={()=>setManual(v=>!v)}>{manual?'Choose from Slack':'Enter a channel ID or variable'}</button>
  </section>;
}
