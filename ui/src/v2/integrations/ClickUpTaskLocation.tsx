import React, {useEffect, useState} from 'react';
import './clickup.css';
type Option={value:string;label:string};
export function ClickUpTaskLocation({input,onChange}:{input:Record<string,unknown>;onChange:(key:string,value:unknown)=>void}) {
  const [workspaces,setWorkspaces]=useState<Option[]>([]),[spaces,setSpaces]=useState<Option[]>([]),[lists,setLists]=useState<Option[]>([]);
  const [error,setError]=useState(''),[revision,setRevision]=useState(0);
  const [manual,setManual]=useState(false);
  const workspace=String(input.workspace_id ?? ''),space=String(input.space_id ?? ''),list=String(input.list_id ?? '');
  useEffect(()=>{let live=true;fetch('/api/integrations/clickup').then(async r=>{if(!r.ok)throw Error('Could not load ClickUp workspaces.');return r.json();}).then(s=>{if(live)setWorkspaces(s.workspaces.map((w:{id:string;name:string})=>({value:w.id,label:w.name})));}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[revision]);
  useEffect(()=>{let live=true;setSpaces([]);setLists([]);if(!workspace || workspace.includes('{{'))return;
    fetch('/api/integrations/clickup/options?kind=spaces&id='+encodeURIComponent(workspace)).then(async r=>{const v=await r.json();if(!r.ok)throw Error(v.error);return v.options;}).then(v=>{if(live){setSpaces(v);setError('');}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[workspace,revision]);
  useEffect(()=>{let live=true;setLists([]);if(!space || space.includes('{{'))return;
    fetch('/api/integrations/clickup/options?kind=lists&id='+encodeURIComponent(space)).then(async r=>{const v=await r.json();if(!r.ok)throw Error(v.error);return v.options;}).then(v=>{if(live){setLists(v);setError('');}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[space,workspace,revision]);
  const fields:[string,string,string,Option[]][]=[['workspace_id','Workspace',workspace,workspaces],['space_id','Space',space,spaces],['list_id','List',list,lists]];
  return <section className="clickup-location" aria-label="ClickUp task location">
    {fields.map(([key,label,value,options],index)=><label key={key}>{label}
      {manual || value.includes('{{') ? <input value={value} onChange={e=>onChange(key,e.target.value)} placeholder={label+' ID or workflow variable'}/>
        : <select value={value} disabled={index===1&&!workspace || index===2&&!space} onChange={e=>{onChange(key,e.target.value);if(index<1)onChange('space_id','');if(index<2)onChange('list_id','');}}>
          <option value="">Choose {label.toLowerCase()}</option>
          {value&&!options.some(o=>o.value===value)&&<option value={value}>{value}</option>}
          {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
        </select>}
    </label>)}
    <button type="button" onClick={()=>setManual(!manual)}>{manual?'Choose from ClickUp':'Enter IDs or variables'}</button>
    {error&&<p role="alert">{error} <button type="button" onClick={()=>setRevision(v=>v+1)}>Try again</button></p>}
  </section>;
}
