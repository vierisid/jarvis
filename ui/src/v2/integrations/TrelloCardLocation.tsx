import React,{useEffect,useRef,useState} from 'react';
import './trello.css';
type Option={value:string;label:string};
export function TrelloCardLocation({input,onChange,boardOnly=false}:{input:Record<string,unknown>;onChange:(key:string,value:string)=>void;boardOnly?:boolean}) {
  const board=String(input.board_id ?? ''),list=String(input.list_id ?? '');
  const [boards,setBoards]=useState<Option[]>([]),[lists,setLists]=useState<Option[]>([]);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [manual,setManual]=useState(board.includes('{{') || list.includes('{{'));
  const generation=useRef<string|null>(null);
  useEffect(()=>{
    let live=true;setBusy(true);setError('');
    const load=async()=>{
      try {
        const get=async(query:string)=>{const r=await fetch('/api/integrations/trello/options'+query);const v=await r.json();if(!r.ok)throw Error(v.error || 'Could not load Trello choices.');return v;};
        const root=await get('');if(!live)return;
        if(generation.current && generation.current!==root.generation){setBoards([]);setLists([]);generation.current=null;throw Error('Trello account changed. Reload and choose the board and list again.');}
        generation.current=root.generation;setBoards(root.options);setLists([]);
        if(board && !board.includes('{{') && !boardOnly){const v=await get('?board='+encodeURIComponent(board)+'&generation='+encodeURIComponent(root.generation));if(live)setLists(v.options);}
      } catch(e){if(live)setError(e instanceof Error?e.message:'Could not load Trello choices.');}
      finally {if(live)setBusy(false);}
    };void load();return()=>{live=false;};
  },[board,boardOnly,revision]);
  const choices=(label:string,key:string,value:string,options:Option[])=><label>{label}{manual
    ?<input value={value} onChange={e=>onChange(key,e.target.value)} placeholder={label+' ID or workflow variable'} />
    :<select value={value} disabled={busy || (key==='list_id' && !board)} onChange={e=>{onChange(key,e.target.value);if(key==='board_id')onChange('list_id','');}}>
      <option value="">Choose a {label.toLowerCase()}</option>
      {value && !options.some(o=>o.value===value) && <option value={value}>{value} (saved selection)</option>}
      {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
    </select>}</label>;
  return <section className="trello-location" aria-label="Trello card location">
    {choices('Board','board_id',board,boards)}
    {!boardOnly && choices('List','list_id',list,lists)}
    {busy && <p role="status">Loading Trello choices…</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={()=>{generation.current=null;setRevision(v=>v+1);}}>Reload boards</button>
    <button type="button" onClick={()=>setManual(v=>!v)}>{manual?'Choose from Trello':'Enter IDs or workflow variables'}</button>
  </section>;
}
