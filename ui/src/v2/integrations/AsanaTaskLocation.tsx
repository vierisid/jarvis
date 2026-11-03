import React, {useEffect, useState} from "react";
import {useAsanaStatus} from "./AsanaConnection";
import "./clickup.css";
type Option={value:string;label:string};
export function AsanaTaskLocation({input,onChange}:{input:Record<string,unknown>;onChange:(key:string,value:unknown)=>void}) {
  const status=useAsanaStatus();
  const [projects,setProjects]=useState<Option[]>([]),[error,setError]=useState(""),[manual,setManual]=useState(false);
  const [cursor,setCursor]=useState<string|null>(null),[next,setNext]=useState<string|null>(null),[revision,setRevision]=useState(0),[loading,setLoading]=useState(false);
  const workspace=String(input.workspace ?? ""),project=String(input.project ?? "");
  useEffect(()=>{setProjects([]);setCursor(null);setNext(null);setError("");},[workspace]);
  useEffect(()=>{
    let live=true;
    if(!workspace || workspace.includes("{{"))return;
    setLoading(true);setError("");
    const params=new URLSearchParams({workspace});if(cursor)params.set("offset",cursor);
    fetch("/api/integrations/asana/options?"+params).then(async r=>{const value=await r.json();if(!r.ok)throw new Error(value.error || "Could not load Asana projects.");return value;})
      .then(value=>{if(live){setProjects(previous=>cursor?[...new Map([...previous,...value.options].map((o:Option)=>[o.value,o])).values()] : value.options);setNext(value.next_offset);}})
      .catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[workspace,cursor,revision]);
  const workspaces=(status?.workspaces ?? []).map(w=>({value:w.id,label:w.name}));
  const fields:[string,string,string,Option[]][]=[["workspace","Workspace",workspace,workspaces],["project","Project",project,projects]];
  return <section className="clickup-location" aria-label="Asana task location">
    {fields.map(([key,label,value,options])=><label key={key}>{label}
      {manual || value.includes("{{") ? <input value={value} onChange={e=>onChange(key,e.target.value)} placeholder={label+" ID or workflow variable"}/>
        : <select value={value} disabled={key==="project"&&!workspace} onChange={e=>{onChange(key,e.target.value);if(key==="workspace")onChange("project","");}}>
          <option value="">Choose {label.toLowerCase()}</option>
          {value&&!options.some(o=>o.value===value)&&<option value={value}>{value}</option>}
          {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
        </select>}
    </label>)}
    <button type="button" onClick={()=>setManual(!manual)}>{manual?"Choose from Asana":"Enter IDs or variables"}</button>
    {!manual&&next&&<button type="button" disabled={loading} onClick={()=>setCursor(next)}>Load more projects</button>}
    {loading&&<p role="status">Loading projects…</p>}
    {error&&<p role="alert">{error} <button type="button" onClick={()=>setRevision(v=>v+1)}>Try again</button></p>}
  </section>;
}
