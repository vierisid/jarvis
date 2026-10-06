import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BriefCapabilities } from "../../../../../src/brief/capabilities";
import { activationBlock, confirmedResult, opportunityView, type OpportunityBinding, type OpportunityRequest, type OpportunityResult } from "./model";
import { opportunityFixture, opportunityReceipt } from "../preview/opportunityFixtures";

GlobalRegistrator.register({url:"http://localhost:4391/"});
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let OpportunityStack: typeof import("./OpportunityStack").OpportunityStack;
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, binding: OpportunityBinding;
beforeAll(async()=>{React=await import("react");({createRoot}=await import("react-dom/client"));({OpportunityStack}=await import("./OpportunityStack"));});
beforeEach(()=>{host=document.createElement("div");document.body.append(host);root=createRoot(host);binding={...opportunityFixture(),onAction:async req=>opportunityReceipt(req)};});
afterEach(async()=>{await React.act(async()=>root.unmount());host.remove();});
afterAll(()=>GlobalRegistrator.unregister());
async function render(mode:"live"|"preview"="preview",compact=false,dark=false){await React.act(async()=>root.render(<div className="brief-root" data-brief-theme={dark?"dark":"light"}><div className="brief-today-layout" data-compact={compact}><section><h2>Opportunities</h2><OpportunityStack mode={mode} binding={binding} reducedMotion/></section></div><textarea aria-label="Composer"/></div>));}
async function click(selector:string){await React.act(async()=>host.querySelector<HTMLButtonElement>(selector)!.click());}
const accept=()=>click(".brief-opportunity-approve"),dismiss=()=>click(".brief-opportunity-dismiss"),next=()=>click('[aria-label="Next opportunity"]');
const tick=async(ms=20)=>React.act(async()=>new Promise(r=>setTimeout(r,ms)));
const front=()=>host.querySelector("[data-proposal-id]")?.getAttribute("data-proposal-id") ?? null;
const phase=()=>host.querySelector(".brief-opportunity-stack")?.getAttribute("data-phase");
const count=()=>host.querySelector('[aria-label="Opportunity position"]')?.textContent;
const feedback=()=>host.querySelector(".brief-opportunity-feedback")?.textContent;
async function settle(){await tick(550);await tick();await tick();}
function data(){if(binding.state.status!=="ready")throw Error("test binding");return binding.state.data;}

test("preview/live sources and preparation/activation gates remain separate",()=>{
  const provider={readiness:()=>"ready" as const};
  expect(opportunityView("live",binding).state.status).toBe("unsupported");
  const caps=new BriefCapabilities([{id:"preparedOpportunities",provider}], ["preparedOpportunities"]).snapshot();
  const live={...binding,source:"live" as const,capabilities:caps};
  expect(opportunityView("live",live).state.status).toBe("ready");
  expect(opportunityView("live",live).onAction).toBeUndefined();
  expect(opportunityView("preview",live).state.status).toBe("unsupported");
  const both=new BriefCapabilities([{id:"preparedOpportunities",provider},{id:"opportunityActivation",provider}],["preparedOpportunities","opportunityActivation"]).snapshot();
  expect(opportunityView("live",{...live,capabilities:both}).onAction).toBe(binding.onAction);
});
test("acceptance requires the exact receipt, action and immutable workflow version",()=>{
  const req:OpportunityRequest={requestId:"req",proposalId:"p",revision:"r",action:"approve_enable",flowId:"f",versionId:"v"};
  expect(confirmedResult(req,opportunityReceipt(req))).toBe(true);
  for(const key of ["requestId","proposalId","revision","flowId","versionId","receiptId"]) expect(confirmedResult(req,{...opportunityReceipt(req),[key]:key==="receiptId"?"":"wrong"})).toBe(false);
  expect(confirmedResult(req,{...req,state:"confirmed",receiptId:"receipt",outcome:"dismissed"})).toBe(false);
});
test("preparation, stale reads, missing binding credentials and absent writers never enable",async()=>{
  for(const scenario of ["preparing","blocked","missing-connection","stale","no-owner"]){
    await React.act(async()=>root.render(null));let calls=0;binding=opportunityFixture(scenario);
    if(scenario!=="no-owner")binding.onAction=async req=>{calls++;return opportunityReceipt(req);};
    await render();expect(host.querySelector(".brief-opportunity-approve")!.getAttribute("aria-disabled")).toBe("true");
    await accept();expect(calls).toBe(0);expect(feedback()).toBeTruthy();
  }
});
test("malformed ready snapshots cannot enable",()=>{
  const card=data()[0]!;
  expect(activationBlock(binding,card)).toBeNull();
  for(const patch of [{evidence:[]},{goal:null},{workflow:null},{compositionId:""},{readiness:{state:"ready",checkedAt:NaN}},{previewBasis:null}]){
    const invalid={...card,proposal:{...card.proposal,...patch}} as typeof card;
    expect(activationBlock(binding,invalid)).not.toBeNull();
  }
});
test("ten local next cycles retain the list; light/dark and compact changes retain selection",async()=>{
  await render();for(let i=0;i<10;i++){await next();await tick();await tick();expect(front()).toBe(`fixture-opportunity-${(i+1)%3}`);expect(phase()).toBe("rest");}
  await render("preview",true,true);expect(front()).toBe("fixture-opportunity-1");expect(count()).toBe("2 / 3");
  expect(host.querySelectorAll(".brief-opportunity-backing").length).toBe(2);
});
test("double approval confirms locally, then removes exactly one and leaves the next actionable",async()=>{
  let calls=0;binding.onAction=async req=>{calls++;return opportunityReceipt(req);};await render();
  await React.act(async()=>{const b=host.querySelector<HTMLButtonElement>(".brief-opportunity-approve")!;b.click();b.click();});
  expect(calls).toBe(1);expect(front()).toBe("fixture-opportunity-0");expect(feedback()).toBe("Workflow enabled");expect(count()).toBe("1 / 3");
  await next();expect(front()).toBe("fixture-opportunity-0");
  await settle();expect(front()).toBe("fixture-opportunity-1");expect(count()).toBe("1 / 2");
  await accept();await settle();expect(calls).toBe(2);expect(front()).toBe("fixture-opportunity-2");
});
test("dismiss has a neutral acknowledgement and final empty state restores local focus",async()=>{
  await render();for(let i=0;i<3;i++){
    host.querySelector<HTMLButtonElement>(".brief-opportunity-dismiss")!.focus();await dismiss();
    expect(feedback()).toBe("Dismissed");expect(feedback()).not.toContain("enabled");await settle();
  }
  expect(count()).toBe("0");expect(front()).toBeNull();expect(host.querySelectorAll(".brief-opportunity-backing").length).toBe(0);
  expect(document.activeElement?.textContent).toBe("Nothing else to review.");
});
test("missing reads do not reset a pending operation or permit a duplicate submission",async()=>{
  let resolve!:(r:OpportunityResult)=>void,request!:OpportunityRequest,calls=0;
  binding.onAction=req=>{calls++;request=req;return new Promise(r=>resolve=r);};const ready=binding;
  await render();await accept();binding={...ready,state:{status:"loading"}};await render();
  await React.act(async()=>resolve(opportunityReceipt(request)));
  expect(host.textContent).not.toContain("Workflow enabled");
  binding=ready;await render();await accept();expect(calls).toBe(1);expect(feedback()).toBe("Workflow enabled");await settle();expect(count()).toBe("1 / 2");
  binding={...ready,state:{status:"unavailable",reason:"Offline"}};await render();binding=ready;await render();expect(count()).toBe("1 / 2");
});
test("lost, mismatched, unknown, failed and conflicting results keep the proposal and block retries",async()=>{
  for(const result of ["lost","mismatch","unknown","failed","conflict"]){
    await React.act(async()=>root.render(null));let calls=0;binding=opportunityFixture();binding.onAction=async req=>{calls++;if(result==="lost")throw Error("lost");if(result==="mismatch")return {...opportunityReceipt(req),versionId:"wrong"};return {...req,state:result as "unknown"|"failed"|"conflict"};};
    await render();await accept();await settle();expect(front()).toBe("fixture-opportunity-0");expect(count()).toBe("1 / 3");expect(feedback()).not.toBe("Workflow enabled");
    await accept();await dismiss();expect(calls).toBe(1);
    await next();await tick();await tick();expect(front()).toBe("fixture-opportunity-1");
  }
});
test("a lost response can recover only from a receipt matching the outstanding request",async()=>{
  let request!:OpportunityRequest;binding.onAction=async req=>{request=req;throw Error("lost");};await render();await accept();
  binding={...binding,receipts:[{...opportunityReceipt(request),requestId:"other"}]};await render();expect(feedback()).not.toBe("Workflow enabled");
  binding={...binding,receipts:[opportunityReceipt(request)]};await render();expect(feedback()).toBe("Workflow enabled");await settle();expect(count()).toBe("1 / 2");
  await render();expect(count()).toBe("1 / 2");expect(phase()).toBe("rest");
});
test("a changed revision fences the old callback and permits reviewing the new prepared version",async()=>{
  let resolve!:(r:OpportunityResult)=>void,request!:OpportunityRequest;
  binding.onAction=req=>{request=req;return new Promise(r=>resolve=r);};await render();await accept();
  binding={...binding,state:{status:"ready",data:data().map((card,i)=>i?card:{...card,proposal:{...card.proposal,revision:"v2"}})}};await render();
  await React.act(async()=>resolve(opportunityReceipt(request)));expect(feedback()).not.toBe("Workflow enabled");expect(count()).toBe("1 / 3");
  expect(host.querySelector(".brief-opportunity-approve")!.getAttribute("aria-disabled")).toBe("false");
});
test("a changed account cannot display or settle another account's request",async()=>{
  let resolve!:(r:OpportunityResult)=>void,request!:OpportunityRequest;binding.onAction=req=>{request=req;return new Promise(r=>resolve=r);};await render();await accept();
  binding={...binding,scopeKey:"other-account"};await render();await React.act(async()=>resolve(opportunityReceipt(request)));await settle();expect(feedback()).not.toBe("Workflow enabled");expect(count()).toBe("1 / 3");
});
test("owner removing the accepted item before its response does not skip another proposal",async()=>{
  let resolve!:(r:OpportunityResult)=>void,request!:OpportunityRequest;binding.onAction=req=>{request=req;return new Promise(r=>resolve=r);};await render();await accept();
  binding={...binding,state:{status:"ready",data:data().slice(1)}};await render();expect(front()).toBe("fixture-opportunity-0");
  await React.act(async()=>resolve(opportunityReceipt(request)));await settle();expect(front()).toBe("fixture-opportunity-1");expect(count()).toBe("1 / 2");
});
test("background changes leave external composer focus and content intact",async()=>{
  await render();const composer=host.querySelector<HTMLTextAreaElement>("textarea")!;composer.value="Keep my draft";composer.focus();const ready=binding;
  for(const status of ["loading","unavailable","ready"] as const){binding=status==="ready"?ready:{...ready,state:status==="loading"?{status}:{status,reason:"Offline"}};await render("preview",true,true);expect(document.activeElement).toBe(composer);expect(composer.value).toBe("Keep my draft");}
});
test("terminal snapshots stay absent, duplicate identities fail closed, unknown count is not zero",async()=>{
  binding={...binding,state:{status:"ready",data:[data()[0]!,data()[0]!]}};await render();expect(host.textContent).toContain("could not be verified");expect(count()).toBe("—");expect(host.querySelector(".brief-opportunity-approve")).toBeNull();
  binding=opportunityFixture("unavailable");await render();expect(count()).toBe("—");
  binding=opportunityFixture();binding={...binding,state:{status:"ready",data:data().map(card=>({...card,proposal:{...card.proposal,state:"accepted" as const}}))}};await render();expect(count()).toBe("0");expect(host.querySelector(".brief-opportunity-approve")).toBeNull();
});

test("freshness loss during an exit keeps the stale card readable and resumes safely",async()=>{
  await render();await next();expect(phase()).toBe("exit");const ready=binding;
  binding={...binding,state:{status:"stale",data:data(),reason:"Offline"}};await render();expect(phase()).toBe("rest");expect(feedback()).toContain("Refresh");
  await tick();expect(front()).toBe("fixture-opportunity-0");binding=ready;await render();await tick();await tick();expect(front()).toBe("fixture-opportunity-1");expect(phase()).toBe("rest");
});
test("refresh order does not replace the initially selected identity",async()=>{
  await render();binding={...binding,state:{status:"ready",data:[...data()].reverse()}};await render();expect(front()).toBe("fixture-opportunity-0");expect(count()).toBe("3 / 3");
});
test("a response after remount cannot alter the new stack",async()=>{
  let resolve!:(r:OpportunityResult)=>void,request!:OpportunityRequest;binding.onAction=req=>{request=req;return new Promise(r=>resolve=r);};await render();await accept();
  await React.act(async()=>root.render(null));binding={...opportunityFixture(),onAction:async req=>opportunityReceipt(req)};await render();await React.act(async()=>resolve(opportunityReceipt(request)));await settle();expect(phase()).toBe("rest");expect(count()).toBe("1 / 3");expect(feedback()).not.toBe("Workflow enabled");
});

test("an in-flight identity can be left and restored without losing its request or receipt",async()=>{
  let resolve!:(r:OpportunityResult)=>void,request!:OpportunityRequest,calls=0;
  binding.onAction=req=>{calls++;request=req;return new Promise(r=>resolve=r);};const original=binding;
  await render();await accept();binding={...binding,scopeKey:"other"};await render();
  binding=original;await render();expect(phase()).toBe("pending");await accept();expect(calls).toBe(1);
  binding={...binding,scopeKey:"other"};await render();await React.act(async()=>resolve(opportunityReceipt(request)));expect(feedback()).not.toBe("Workflow enabled");
  binding=original;await render();expect(feedback()).toBe("Workflow enabled");await settle();expect(count()).toBe("1 / 2");
});

test("an authoritative recovery cannot be overwritten by a late transport failure",async()=>{
  let reject!:(r:Error)=>void,request!:OpportunityRequest;
  binding.onAction=req=>{request=req;return new Promise((_,r)=>reject=r);};await render();await accept();
  binding={...binding,receipts:[opportunityReceipt(request)]};await render();expect(feedback()).toBe("Workflow enabled");
  binding={...binding,scopeKey:"other",receipts:[]};await render();await React.act(async()=>reject(Error("late lost response")));
  binding={...binding,scopeKey:"fixture-workspace"};await render();expect(feedback()).toBe("Workflow enabled");await settle();expect(count()).toBe("1 / 2");
});
