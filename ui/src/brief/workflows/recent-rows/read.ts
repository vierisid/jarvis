import type { BriefReadState } from "../../contracts";
import type { Flow, FlowRun } from "../../../v2/rooms/workflows/useWorkflowsData";
import { projectRecentWorkflows, type RecentWorkflow } from "./model";

/** Explicit read adapter for the current workflow API. No implicit polling.
 * There is no global recent-run endpoint: inspect latest runs with four bounded
 * workers, and disclose an incomplete inventory instead of claiming global recency.
 * F-25 owns invocation, cancellation and scope retention; do not run every render. */
export async function readRecentWorkflows(request: (url:string, init?:RequestInit)=>Promise<Response> = fetch,
  signal?: AbortSignal): Promise<BriefReadState<readonly RecentWorkflow[]>> {
  const flows:Pick<Flow,"id"|"displayName">[]=[], runs:Array<Parameters<typeof projectRecentWorkflows>[1][number]>=[];
  let incomplete=false;
  const read=async(path:string)=>{
    signal?.throwIfAborted();
    const res=await request(path,{credentials:"same-origin",cache:"no-store",signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)});
    if(!res.ok)throw Error("Unavailable");return res.json();
  };
  try {
    for(let offset=0;offset<=200;offset+=50){
      const list:unknown=await read(`/api/workflows?limit=${offset===200?1:50}&offset=${offset}`);
      if(!Array.isArray(list)||list.length>(offset===200?1:50)||list.some(f=>!f||typeof f.id!=="string"||!f.id))throw Error("Invalid inventory");
      if(offset===200){incomplete=list.length>0;break;}
      for(const f of list)if(!flows.some(x=>x.id===f.id))flows.push({id:f.id});
      if(list.length<50)break;
    }
  } catch { return {status:"unavailable",reason:"Recent runs are unavailable."}; }
  let index=0;
  await Promise.all(Array.from({length:Math.min(4,flows.length)},async()=>{
    while(index<flows.length){
      const flow=flows[index++]!;
      if(signal?.aborted){incomplete=true;break;}
      try {
        const list:unknown=await read(`/api/workflows/${encodeURIComponent(flow.id)}/runs?limit=1`);
        if(!Array.isArray(list)||list.length>1)throw Error("Invalid runs");
        if(!list.length)continue;
        const run=list[0] as FlowRun;
        if(run.flowId!==flow.id||typeof run.id!=="string"||!run.id||typeof run.flowVersionId!=="string"||!run.flowVersionId
          ||typeof run.status!=="string"||!["PRODUCTION","TESTING"].includes(run.environment)
          ||!Number.isFinite(run.startTime??run.created))throw Error("Invalid run");
        // Project only identity/status/time. Captured step output is never copy.
        runs.push({id:run.id,flowId:run.flowId,flowVersionId:run.flowVersionId,status:run.status,startTime:run.startTime,created:run.created,environment:run.environment});
        const detail=await read(`/api/workflows/${encodeURIComponent(flow.id)}`) as {latestDraft?:{displayName?:unknown};published?:{displayName?:unknown}};
        const name=detail.latestDraft?.displayName??detail.published?.displayName;
        if(typeof name==="string"&&name.trim())flow.displayName=name;
      }catch{incomplete=true;}
    }
  }));
  const data=projectRecentWorkflows(flows,runs);
  return incomplete ? data.length ? {status:"stale",data,reason:"Some recent runs could not be checked. This list may be incomplete."}
    : {status:"unavailable",reason:"Recent runs could not be checked."}
    : data.length ? {status:"ready",data} : {status:"empty"};
}
