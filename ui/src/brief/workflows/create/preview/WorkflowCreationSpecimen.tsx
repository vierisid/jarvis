import React, { useMemo, useRef, useState } from "react";
import { BriefButton } from "../../../components/controls";
import type { BriefRoute, BriefShellPort } from "../../../contracts";
import { useTheme } from "../../../../v2/shell/useTheme";
import { NavigationShell } from "../../../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION, type BriefNavigationBinding } from "../../../shell/navigation/model";
import { ConversationComposer } from "../../../chat/composer/ConversationComposer";
import { WorkflowCreationController } from "../controller";
import type { CompositionJob, CompositionPort, CompositionRequest } from "../model";
import { WorkflowCreationRoom } from "../WorkflowCreationRoom";
import type { RecentWorkflowBinding } from "../../recent-rows/model";
import "../../../today/preview/specimen.css";

export const compositionCapabilities = (enabled = true) => ({ contractVersion:1, capabilities:{ workflowComposition:{supported:true,ready:true,enabled,state:"ready",reason:enabled ? null : "disabled"} } });
/** Isolated representative receipts. No HTTP, model, draft creation or run occurs. */
export function WorkflowCreationSpecimen() {
  const [route, setRoute] = useState<BriefRoute>({room:"workflows",selection:{}});
  const [sidebar,setSidebar] = useState<"expanded"|"rail">("expanded"), [chatOpen,setChatOpen] = useState(false);
  const [theme,setTheme] = useTheme(), [reduced,setReduced] = useState(false), [chatDraft,setChatDraft] = useState("");
  const [scenario,setScenario] = useState("ready"), [recentState,setRecentState] = useState("ready"), [long,setLong] = useState(false);
  const [calls,setCalls] = useState(0), [revision,setRevision] = useState(0);
  const outcome = useRef(scenario); outcome.current=scenario;
  const controller = useMemo(() => {
    let saved: string | null = null;
    const jobs = new Map<string,{job:CompositionJob;result:string}>();
    const makeJob = (request:CompositionRequest): CompositionJob => ({jobId:`fixture-job-${jobs.size+1}`,requestId:request.requestId,specification:{name:"New workflow",prompt:request.prompt},state:"queued",progress:{checkedCandidates:0},compositionId:null,workflow:null,blocker:null,createdAt:Date.now(),updatedAt:Date.now()});
    function finish(entry:{job:CompositionJob;result:string}) {
      const {job,result}=entry;
      return {...job,state:result==="blocked" ? "blocked" : result==="failed" ? "failed" : "draft_ready",progress:{checkedCandidates:1},
        workflow:result==="blocked"||result==="failed" ? null : {flowId:`prepared-flow-${job.jobId}`,versionId:`prepared-version-${job.jobId}`},
        blocker:result==="blocked" ? {code:"insufficient_information",message:"Choose the destination for this report.",details:["Add where the finished brief should be saved, then send again."]} : result==="failed" ? {code:"timeout",message:"Preparation timed out. Your prompt is kept.",details:[]} : null} as CompositionJob;
    }
    const port:CompositionPort={
      async submit(request){setCalls(n=>n+1);const existing=jobs.get(request.requestId);if(existing)return existing.job;
        const entry={job:makeJob(request),result:outcome.current};jobs.set(request.requestId,entry);
        await new Promise(r=>setTimeout(r,450));if(entry.result==="lost-response")throw Error("Simulated lost response");return entry.job;},
      async recover(request){const entry=jobs.get(request.requestId);return entry ? finish(entry) : null;},
      async read(id){const entry=[...jobs.values()].find(e=>e.job.jobId===id)!;await new Promise(r=>setTimeout(r,400));return finish(entry);},
    };
    return new WorkflowCreationController(port,{read:()=>saved,write:value=>{saved=value;}},{source:"fixture",scopeId:`workflow-review-${revision}`});
  },[revision]);
  const shell=useMemo<BriefShellPort>(()=>({mode:"preview",route,sidebar,setSidebar,chatOpen,setChatOpen,theme,setTheme,navigate:setRoute}),[route,sidebar,chatOpen,theme,setTheme]);
  const nav:BriefNavigationBinding={capabilities:null,view:{source:"fixture",state:{status:"ready",data:{...UNKNOWN_NAVIGATION,workspaceName:"Vieri’s workspace",connection:"connected",account:{name:"Vieri Balboni",plan:{status:"ready",data:"Pro plan"}},badges:{workflows:4}}}}};
  const rows=[
    {flowId:"meeting",versionId:"meeting-v3",runId:"meeting-012",name:"Meeting follow-ups",status:"PAUSED",result:"Follow-up drafted for Alex",at:Date.UTC(2026,9,7,9,14),environment:"PRODUCTION" as const},
    {flowId:"inbox",versionId:"inbox-v2",runId:"inbox-028",name:"Morning inbox brief",status:"SUCCEEDED",result:"14 messages summarised",at:Date.UTC(2026,9,7,8,31),environment:"PRODUCTION" as const},
    {flowId:"competitor",versionId:"competitor-v1",runId:"competitor-004",name:"Competitor watch",status:"FAILED",result:"Never show this as success",at:Date.UTC(2026,9,6,9,0),environment:"PRODUCTION" as const},
  ];
  if(long)rows.push(...Array.from({length:16},(_,i)=>({...rows[1]!,flowId:`long-${i}`,runId:`long-run-${i}`,name:`Long workflow ${i+1}: gather the weekly product research and prepare a team briefing`,result:"A longer representative result with enough detail to verify wrapping and retained row position."})));
  const recent:RecentWorkflowBinding={source:"fixture",state:recentState==="ready"?{status:"ready",data:rows}:recentState==="stale"?{status:"stale",data:rows,reason:"Fixture"}:recentState==="empty"||recentState==="loading"?{status:recentState}:{status:"unavailable",reason:"Fixture"},refresh:()=>setRecentState("ready")};
  return <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
    <div className="brief-today-review-toolbar" aria-label="Isolated review controls"><span>D-16 · Workflow creation and recent work</span>
      <button onClick={()=>setTheme(theme==="light"?"dark":"light")}>Switch to {theme==="light"?"dark":"light"}</button>
      <label>Composition <select aria-label="Composition scenario" value={scenario} onChange={e=>setScenario(e.target.value)}>{["ready","blocked","failed","lost-response","unavailable"].map(x=><option key={x}>{x}</option>)}</select></label>
      <label>Recent runs <select aria-label="Recent runs scenario" value={recentState} onChange={e=>setRecentState(e.target.value)}>{["ready","loading","empty","stale","unavailable"].map(x=><option key={x}>{x}</option>)}</select></label>
      <label><input type="checkbox" checked={long} onChange={e=>setLong(e.target.checked)}/>Long rows</label>
      <label><input type="checkbox" checked={reduced} onChange={e=>setReduced(e.target.checked)}/>Reduce motion</label>
      <button onClick={()=>{controller.dispose();setRevision(n=>n+1);setCalls(0);setRoute({room:"workflows",selection:{}});}}>Reset example</button>
      <output aria-label="Composition submissions">{calls}</output><small>Illustrative data only. No workflow or model is connected.</small>
    </div>
    <div className="brief-today-review-viewport" style={{width:"100%"}}>
      <NavigationShell shell={shell} rooms={{workflows:{id:"workflows",title:"Workflows"},"all-workflows":{id:"all-workflows",title:"All workflows"},"workflow-draft":{id:"workflow-draft",title:"Prepared workflow"},workflow:{id:"workflow",title:"Workflow"}}} binding={nav} reducedMotion={reduced}
        conversation={{source:"fixture",content:<><div className="sample-conversation-tabs">General</div><div className="sample-conversation-thread"><h2 className="brief-type-section-heading">What are we moving forward?</h2></div>
          <ConversationComposer mode="preview" reducedMotion={reduced} binding={{source:"fixture",scopeId:"workflow-preview-chat",conversationId:"general",mode:"scoped",connected:true,metadataPending:false,draft:chatDraft,turn:null,pendingAcceptance:false,error:null,actions:{setDraft:setChatDraft,send:()=>setChatDraft(""),cancel:()=>{}}}} /></>}}>
        {route.room==="workflows" ? <WorkflowCreationRoom shell={shell} binding={{controller,capabilities:compositionCapabilities(scenario!=="unavailable"),recent}} reducedMotion={reduced}/>
          : <section className="brief-workflow-preview-destination"><h1 className="brief-type-room-title">{route.room==="all-workflows"?"All workflows":route.room==="workflow-draft"?"Prepared draft":"Selected workflow"}</h1>
            <p className="brief-workflow-notice">Destination handoff only. Canvas, run details and management are later roadmap steps.</p>
            <dl aria-label="Exact destination IDs">{Object.entries(route.selection).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
            <BriefButton onClick={()=>setRoute({room:"workflows",selection:{}})}>Back to workflow creation</BriefButton></section>}
      </NavigationShell>
    </div>
  </div>;
}
