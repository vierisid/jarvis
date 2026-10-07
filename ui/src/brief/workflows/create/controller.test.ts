import { expect, test } from "bun:test";
import { WorkflowCreationController, sessionCreationStorage, type CreationStorage } from "./controller";
import { readJob, validPrompt, type CompositionJob, type CompositionPort, type CompositionRequest } from "./model";
import { createCompositionPort } from "./client";
import { projectRecentWorkflows, runPresentation } from "../recent-rows/model";

export const fixtureJob = (request:CompositionRequest, patch:Partial<CompositionJob>={}):CompositionJob => ({jobId:"actual-job",requestId:request.requestId,specification:{name:request.name??"New workflow",prompt:request.prompt},state:"queued",progress:{checkedCandidates:0},compositionId:null,workflow:null,blocker:null,createdAt:1,updatedAt:1,...patch});
const ready = {state:"draft_ready" as const,workflow:{flowId:"actual-flow",versionId:"actual-version"}};
function memory():CreationStorage {let raw:string|null=null;return {read:()=>raw,write:s=>{raw=s;}};}
function setup(port:Partial<CompositionPort>={}, storage=memory()) {
  let n=0;const requests:CompositionRequest[]=[];
  const controller=new WorkflowCreationController({submit:async r=>{requests.push(r);return fixtureJob(r);},recover:async()=>null,read:async()=>fixtureJob(requests[0]!,ready),...port},storage,{source:"fixture",scopeId:"account:vault",requestId:()=>`request-${++n}`});
  return {controller,requests,storage};
}
test("one rapid submission persists the exact prompt and key before POST",async()=>{
  const storage=memory();let release!:(job:CompositionJob)=>void,calls=0;const waiting=new Promise<CompositionJob>(r=>{release=r;});
  const {controller:c}=setup({submit:async r=>{calls++;expect(JSON.parse(storage.read()!).request).toEqual(r);return waiting;}},storage);
  c.setDraft("  keep spaces\n");const pending=c.submit(c.getSnapshot().draft);for(let i=0;i<10;i++)void c.submit("other");expect(calls).toBe(1);
  release(fixtureJob({requestId:"request-1",prompt:"  keep spaces\n"}));await pending;expect(c.getSnapshot().draft).toBe("  keep spaces\n");await c.recover();
});
test("lost POST recovers its receipt without generating a second draft",async()=>{
  let accepted!:CompositionRequest;const {controller:c}=setup({submit:async r=>{accepted=r;throw Error("network");},recover:async r=>{expect(r).toEqual(accepted);return fixtureJob(r,ready);}});
  c.setDraft("Build my brief");await c.submit(c.getSnapshot().draft);expect(c.getSnapshot().error).toContain("Check this request");
  await c.submit("Different prompt");await c.recover();expect(c.getSnapshot().job?.workflow).toEqual(ready.workflow);expect(c.getSnapshot().draft).toBe("");
});
test("unknown request replay keeps the original key and wording after edits and remount",async()=>{
  const storage=memory();let calls=0;const specs:CompositionRequest[]=[];
  const port:CompositionPort={submit:async r=>{calls++;specs.push(r);if(calls===1)throw Error("network");return fixtureJob(r);},read:async()=>fixtureJob(specs[0]!,ready),recover:async()=>null};
  const {controller:c}=setup(port,storage);c.setDraft("Original\n");await c.submit(c.getSnapshot().draft);c.setDraft("New edit");c.dispose();
  const next=setup(port,storage).controller;await next.recover();expect(specs).toEqual([{requestId:"request-1",prompt:"Original\n"},{requestId:"request-1",prompt:"Original\n"}]);await next.recover();expect(next.getSnapshot().draft).toBe("New edit");
});
test.each(["failed","blocked","cancelled"] as const)("terminal %s retains prompt and permits an explicit new request",async state=>{
  const {controller:c,requests}=setup({read:async()=>fixtureJob(requests[0]!,{state})});c.setDraft("Prompt");await c.submit("Prompt");await c.recover();expect(c.getSnapshot().draft).toBe("Prompt");await c.submit("Prompt");expect(requests.map(r=>r.requestId)).toEqual(["request-1","request-2"]);
});
test("persist failure makes zero requests and keeps the prompt",async()=>{
  let calls=0;const {controller:c}=setup({submit:async r=>{calls++;return fixtureJob(r);}},{read:()=>null,write:()=>{throw Error("quota");}});c.setDraft("Kept");await c.submit("Kept");expect(calls).toBe(0);expect(c.getSnapshot().draft).toBe("Kept");expect(c.getSnapshot().storageFailed).toBe(true);
});
test("receipt save failure cannot acknowledge navigation",async()=>{
  let raw:string|null=null,fail=false;const storage={read:()=>raw,write:(s:string)=>{if(fail)throw Error("full");raw=s;}};
  const {controller:c}=setup({submit:async r=>{fail=true;return fixtureJob(r,ready);}},storage);await c.submit("Prompt");expect(c.getSnapshot().storageFailed).toBe(true);expect(c.acknowledgeOpened("actual-job")).toBe(false);
});
test("saved result opens once and retains exact IDs and selected position",async()=>{
  const {controller:c,storage}=setup({submit:async r=>fixtureJob(r,ready)});await c.submit("Prompt");expect(c.acknowledgeOpened("wrong")).toBe(false);expect(c.acknowledgeOpened("actual-job")).toBe(true);c.savePosition(528,"run-exact");
  const next=setup({},storage).controller;expect(next.getSnapshot()).toMatchObject({openedJobId:"actual-job",scrollTop:528,selectedRunId:"run-exact",job:{workflow:ready.workflow}});
});
test("retiring a scope fences late results and further effects",async()=>{
  let release!:(job:CompositionJob)=>void;const waiting=new Promise<CompositionJob>(r=>{release=r;});const {controller:c}=setup({submit:()=>waiting});const submit=c.submit("Old");c.dispose();release(fixtureJob({requestId:"request-1",prompt:"Old"},ready));await submit;expect(c.getSnapshot().job).toBeNull();await c.recover();
});
test("scope storage keys cannot collide or expose another prompt",()=>{
  const values=new Map<string,string>();const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
  const a=sessionCreationStorage("account-a:vault",storage),b=sessionCreationStorage("account-b:vault",storage);a.write("private");expect(b.read()).toBeNull();expect(a.read()).toBe("private");
});
test("malformed storage blocks new composition instead of discarding an unknown key",async()=>{
  let called=false;const {controller:c}=setup({submit:async r=>{called=true;return fixtureJob(r);}},{read:()=>"{",write:()=>{}});await c.submit("Prompt");expect(called).toBe(false);expect(c.getSnapshot().storageFailed).toBe(true);
});
test("foreign request or changed job receipts never navigate",async()=>{
  const {controller:c}=setup({submit:async r=>fixtureJob({...r,prompt:"different"},ready)});await c.submit("Prompt");expect(c.getSnapshot().job).toBeNull();expect(c.getSnapshot().error).not.toBeNull();
  const t=setup({read:async()=>fixtureJob(t.requests[0]!,{...ready,jobId:"wrong-job"})});await t.controller.submit("Prompt");await t.controller.recover();expect(t.controller.getSnapshot().job?.workflow).toBeNull();
});
test("UTF-8 bound rejects oversized prompts; raw markup remains text",()=>{
  expect(validPrompt(" ")).toBe(false);expect(validPrompt("a".repeat(16_384))).toBe(true);expect(validPrompt("😀".repeat(4097))).toBe(false);
  expect(()=>readJob(fixtureJob({requestId:"r",prompt:"P"},{state:"draft_ready"}))).toThrow();
});
test("capability-disabled and mismatched servers perform zero requests",async()=>{
  let calls=0;const fetcher=async()=>{calls++;return Response.json({});};
  for(const capabilities of [null,{}, {contractVersion:2,capabilities:{}},{contractVersion:1,capabilities:{workflowComposition:{enabled:true}}}]) {
    const port=createCompositionPort(()=>capabilities,fetcher);await expect(port.submit({requestId:"r",prompt:"P"})).rejects.toThrow();
  }expect(calls).toBe(0);
});
test("F07 HTTP adapter uses only composition routes and matches exact receipts",async()=>{
  const requests:Array<{url:string;init?:RequestInit}>=[];const spec={requestId:"r-1",prompt:"P"};
  const port=createCompositionPort(()=>({contractVersion:1,capabilities:{workflowComposition:{supported:true,ready:true,enabled:true,state:"ready",reason:null}}}), (async(url,init)=>{
    requests.push({url:String(url),init});return Response.json(init?.method==="POST"?{job:fixtureJob(spec)}:String(url).includes("?")?{jobs:[fixtureJob(spec)]}:fixtureJob(spec,ready));
  }) as typeof fetch);
  expect((await port.submit(spec)).requestId).toBe(spec.requestId);expect((await port.recover(spec))?.requestId).toBe(spec.requestId);expect((await port.read("id /?")).workflow).toEqual(ready.workflow);
  expect(requests.map(r=>r.url)).toEqual(["/api/brief/workflow-compositions","/api/brief/workflow-compositions?requestId=r-1","/api/brief/workflow-compositions/id%20%2F%3F"]);
  expect(requests[0]?.init?.credentials).toBe("same-origin");expect(JSON.parse(requests[0]?.init?.body as string)).toEqual(spec);
});
test("canonical recents select latest per flow, carry stable IDs and distinguish every failure",()=>{
  const runs=["SUCCEEDED","FAILED","TIMEOUT","INTERNAL_ERROR","QUOTA_EXCEEDED","MEMORY_LIMIT_EXCEEDED","SCHEDULE_FAILURE","STOPPED","PAUSED","QUEUED","RUNNING"].map((status,i)=>({id:`run${i}`,flowId:`flow${i}`,flowVersionId:`v${i}`,status:status as "SUCCEEDED",startTime:i+1,created:i+1,environment:"PRODUCTION" as const}));
  const rows=projectRecentWorkflows(runs.map(r=>({id:r.flowId,displayName:r.flowId})),[...runs,{...runs[0]!,id:"old",created:0,startTime:0}],20);
  expect(rows.length).toBe(11);expect(rows.some(r=>r.runId==="old")).toBe(false);for(const row of rows.filter(r=>r.status!=="SUCCEEDED"))expect(row.result).not.toBe("Run completed");
  expect(runPresentation("NEW_STATE").label).toBe("Unknown");expect(projectRecentWorkflows([],runs)).toEqual([]);
});
