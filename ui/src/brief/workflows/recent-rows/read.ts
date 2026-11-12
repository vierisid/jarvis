import type { BriefReadState } from "../../contracts";
import type { FlowRun } from "../../../v2/rooms/workflows/useWorkflowsData";
import { projectRecentWorkflows, type RecentWorkflow } from "./model";

/** One read of `GET /api/workflows/recent-runs`: the newest run of each workflow, most recent first, with
 * the workflow's name. It reads recent runs, not a window of workflows, so a workflow that ran today shows
 * however many workflows there are. One request, whatever the number of workflows.
 * F-25 owns invocation, cancellation and scope retention; do not run every render. */
export async function readRecentWorkflows(request: (url:string, init?:RequestInit)=>Promise<Response> = fetch,
  signal?: AbortSignal): Promise<BriefReadState<readonly RecentWorkflow[]>> {
  let items:unknown;
  try {
    signal?.throwIfAborted();
    const res=await request("/api/workflows/recent-runs?limit=6",{credentials:"same-origin",cache:"no-store",
      signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)});
    if(!res.ok)throw Error("Unavailable");
    items=(await res.json() as {items?:unknown})?.items;
    if(!Array.isArray(items)||items.length>20)throw Error("Invalid runs");
  } catch { return {status:"unavailable",reason:"Recent runs are unavailable."}; }
  const flows:{id:string;displayName:string}[]=[], runs:Array<Parameters<typeof projectRecentWorkflows>[1][number]>=[];
  let skipped=false;
  for(const value of items as (FlowRun&{displayName?:unknown})[]){
    // Project only identity/status/time. Captured step output is never copy.
    if(!value||typeof value.id!=="string"||!value.id||typeof value.flowId!=="string"||!value.flowId||typeof value.flowVersionId!=="string"||!value.flowVersionId
      ||typeof value.status!=="string"||!["PRODUCTION","TESTING"].includes(value.environment)||!Number.isFinite(value.startTime??value.created)){skipped=true;continue;}
    flows.push({id:value.flowId,displayName:typeof value.displayName==="string"&&value.displayName.trim()?value.displayName:value.flowId});
    runs.push({id:value.id,flowId:value.flowId,flowVersionId:value.flowVersionId,status:value.status,startTime:value.startTime,created:value.created,environment:value.environment});
  }
  const data=projectRecentWorkflows(flows,runs);
  return skipped ? data.length ? {status:"stale",data,reason:"Some recent runs could not be checked. This list may be incomplete."}
    : {status:"unavailable",reason:"Recent runs could not be checked."}
    : data.length ? {status:"ready",data} : {status:"empty"};
}
