import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BriefCapabilities } from "../../../../../src/brief/capabilities";
import { goalView, matchingReceipt, queuedDestination, type GoalAcceptRequest, type GoalAcceptResult, type GoalCardBinding } from "./model";
import { goalFixture, MAYA_TITLE } from "../preview/goalFixtures";
import { outcomeFixture } from "../preview/outcomeFixtures";

GlobalRegistrator.register({ url:"http://localhost:4390/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let GoalCard: typeof import("./GoalCard").GoalCard, GoalQueueCue: typeof import("./GoalCard").GoalQueueCue;
let useGoalHandoff: typeof import("./useGoalHandoff").useGoalHandoff;
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
let binding: GoalCardBinding;
const destination = {decisionId:"decision-maya",workItemId:"work-maya",title:MAYA_TITLE};
const front = {decisionId:"decision-alex",workItemId:"work-alex",title:"Alex’s follow-up"};
const request: GoalAcceptRequest = {requestId:"request",recommendationId:"fixture-recommendation-maya",revision:"rec-v1",goalId:"fixture-design-partners",goalRevision:"goal-v1"};
const receipt = (req=request): GoalAcceptResult => ({...req,state:"confirmed",receiptId:"receipt-maya",destination});
beforeAll(async () => {
  React = await import("react"); ({createRoot}=await import("react-dom/client"));
  ({GoalCard,GoalQueueCue}=await import("./GoalCard")); ({useGoalHandoff}=await import("./useGoalHandoff"));
});
beforeEach(() => {host=document.createElement("div");document.body.append(host);root=createRoot(host);binding=goalFixture(outcomeFixture(),"ready",[front]);});
afterEach(async () => {await React.act(async()=>root.unmount());host.remove();});
afterAll(()=>GlobalRegistrator.unregister());
function Example({binding, compact=false, dark=false, reduced=true, mode="preview"}: {binding:GoalCardBinding;compact?:boolean;dark?:boolean;reduced?:boolean;mode?:"live"|"preview"}) {
  const handoff=useGoalHandoff(mode,binding,reduced);
  return <div className="brief-root" data-brief-theme={dark?"dark":"light"}><div data-compact={compact}><GoalCard handoff={handoff}/></div><GoalQueueCue handoff={handoff}/></div>;
}
async function render(compact=false,dark=false) {await React.act(async()=>root.render(<Example binding={binding} compact={compact} dark={dark}/>));}
async function click(selector: string) {await React.act(async()=>host.querySelector<HTMLButtonElement>(selector)!.click());}
async function open(){await click(".brief-goal-next");}
const feedback=()=>host.querySelector(".brief-goal-feedback")?.textContent;
const tick=async(ms=10)=>React.act(async()=>new Promise(resolve=>setTimeout(resolve,ms)));

test("measurement and recommendation gates are independent and never mix fixtures into live",()=>{
  const provider={readiness:()=>"ready" as const};
  expect(goalView("live",binding).state.status).toBe("unavailable");
  const live={...binding,source:"live" as const,capabilities:new BriefCapabilities([{id:"goalMeasurements",provider}],["goalMeasurements"]).snapshot(),onAccept:async()=>receipt()};
  expect(goalView("live",live).state.status).toBe("ready");expect(goalView("live",live).onAccept).toBeUndefined();
  expect(goalView("preview",live).state.status).toBe("unavailable");
  live.capabilities=new BriefCapabilities(["goalMeasurements","recommendations","decisions"].map(id=>({id:id as "goalMeasurements"|"recommendations"|"decisions",provider})),["goalMeasurements","recommendations","decisions"]).snapshot();
  expect(goalView("live",live).onAccept).toBe(live.onAccept);
});

test("ten open/return cycles retain title, measured value, progress node and keyboard return",async()=>{
  await render();const title=host.querySelector("h2"),value=host.querySelector(".brief-goal-value"),bar=host.querySelector(".brief-outcome-progress");
  for(let i=0;i<10;i++) {await open();expect(host.querySelector("h2")).toBe(title);expect(host.querySelector(".brief-goal-value")).toBe(value);expect(host.querySelector(".brief-outcome-progress")).toBe(bar);
    expect(document.activeElement?.textContent).toContain("Back to goal");
    await React.act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
    expect(document.activeElement).toBe(host.querySelector(".brief-goal-next"));
  }
});

test("two immediate presses issue one request; receipt waits for a fresh matching queue; progress never changes",async()=>{
  let calls=0;let resolve!: (r:GoalAcceptResult)=>void;let sent!:GoalAcceptRequest;
  binding.onAccept=req=>{calls++;sent=req;return new Promise(r=>{resolve=r;});};
  await render();await open();const value=host.querySelector(".brief-goal-value")!.textContent;
  await React.act(async()=>{const b=host.querySelector<HTMLButtonElement>(".brief-goal-accept")!;b.click();b.click();});
  expect(calls).toBe(1);expect(feedback()).toBe("Adding to Today…");
  await React.act(async()=>resolve(receipt(sent)));expect(feedback()).toContain("Waiting for the refreshed Today stack");
  expect(host.querySelector("[data-work-item-id]")).toBeNull();
  binding={...binding,queue:{status:"ready",data:[front,destination]}};await render();await tick();
  expect(feedback()).toBe("Added to Today");expect(host.querySelector("[data-work-item-id]")!.getAttribute("data-work-item-id")).toBe("work-maya");
  expect(binding.queue.status==="ready"&&binding.queue.data[0]).toBe(front);expect(host.querySelector(".brief-goal-value")!.textContent).toBe(value);
  await click(".brief-goal-accept");await render(true,true);expect(calls).toBe(1);expect(feedback()).toBe("Added to Today");
  binding={...binding,queue:{status:"ready",data:[]}};await render();expect(feedback()).toBe("Added to Today");
});

test("each receipt identity field must match; a changed title, wrong destination or duplicate queue is not confirmation",()=>{
  for(const key of ["requestId","recommendationId","revision","goalId","goalRevision"] as const) expect(matchingReceipt(request,{...receipt(),[key]:"wrong"})).toBe(false);
  expect(matchingReceipt(request,undefined)).toBe(false);
  for(const data of [[{...destination,title:"Different work"}],[{...destination,workItemId:"wrong"}],[destination,destination],[]]) expect(queuedDestination(receipt(),MAYA_TITLE,{status:"ready",data})).toBeNull();
  expect(queuedDestination(receipt(),MAYA_TITLE,{status:"stale",data:[destination],reason:"stale"})).toBeNull();
});

test("failed, conflicting, unknown and lost responses never announce success or enable a blind retry",async()=>{
  for(const state of ["failed","conflict","unknown","lost"] as const) {
    await React.act(async()=>root.render(null));let calls=0;
    binding.onAccept=async req=>{calls++;if(state==="lost")throw Error("network");return {...req,state};};
    await render();await open();await click(".brief-goal-accept");await tick();
    expect(feedback()).not.toBe("Added to Today");expect(host.querySelector("[data-work-item-id]")).toBeNull();
    await click(".brief-goal-accept");expect(calls).toBe(1);
  }
});

test("blocked, expired, stale, changed-goal and historical accepted recommendations cannot dispatch",async()=>{
  for(const scenario of ["blocked","expired","changed-goal","accepted","stale"]) {
    await React.act(async()=>root.render(null));let calls=0;
    binding={...goalFixture(outcomeFixture(),scenario),onAccept:async req=>{calls++;return receipt(req);}};
    await render();await open();await click(".brief-goal-accept");expect(calls).toBe(0);expect(feedback()).toBeTruthy();expect(host.querySelector("[data-work-item-id]")).toBeNull();
  }
});

test("expiry while visible disables acceptance without waiting for a user navigation",async()=>{
  if(binding.recommendation.status!=="ready")throw Error("fixture");binding.recommendation.data.expiresAt=Date.now()+80;
  let calls=0;binding.onAccept=async req=>{calls++;return receipt(req);};await render();await open();await tick(100);
  expect(feedback()).toContain("expired");await click(".brief-goal-accept");expect(calls).toBe(0);
});

test("old async completion cannot enter a changed goal or a lost capability",async()=>{
  let resolve!:(r:GoalAcceptResult)=>void,sent!:GoalAcceptRequest;
  binding.onAccept=req=>{sent=req;return new Promise(r=>resolve=r);};await render();await open();await click(".brief-goal-accept");
  binding={...binding,state:{status:"unavailable",reason:"Owner unavailable"}};await render();
  await React.act(async()=>resolve(receipt(sent)));expect(host.textContent).not.toContain("Added to Today");expect(host.querySelector("[data-work-item-id]")).toBeNull();
});

test("a remounted accepted projection does not replay destination motion or submit",async()=>{
  binding=goalFixture(outcomeFixture(),"accepted",[destination]);await render();await open();await tick();
  expect(feedback()).toBe("Added to Today");expect(host.querySelector("[data-work-item-id]")).toBeNull();
});

test("a receipt for different work never confirms even when that other item exists in the queue",async()=>{
  const wrong = {...destination,title:"Unrelated work"};
  binding.queue={status:"ready",data:[front,wrong]};
  binding.onAccept=async req=>({...req,state:"confirmed",receiptId:"wrong-receipt",destination:wrong});
  await render();await open();await click(".brief-goal-accept");
  expect(feedback()).toContain("not confirmed");
  expect(host.querySelector("[data-work-item-id]")).toBeNull();
});

test("a changed recommendation revision ignores the old response and allows review of the new identity",async()=>{
  let resolve!:(r:GoalAcceptResult)=>void,sent!:GoalAcceptRequest;
  binding.onAccept=req=>{sent=req;return new Promise(r=>resolve=r);};
  await render();await open();await click(".brief-goal-accept");
  if(binding.recommendation.status!=="ready")throw Error("fixture");
  binding={...binding,recommendation:{status:"ready",data:{...binding.recommendation.data,revision:"rec-v2"}}};
  await render();await open();await React.act(async()=>resolve(receipt(sent)));
  expect(feedback()).not.toContain("Added to Today");
  expect(host.querySelector("[data-work-item-id]")).toBeNull();
  expect(host.querySelector(".brief-goal-accept")!.getAttribute("aria-disabled")).not.toBe("true");
});

test("a settled receipt highlights once; unchanged refresh and returning to the recommendation do not replay it",async()=>{
  binding.onAccept=async req=>receipt(req);binding.queue={status:"ready",data:[front,destination]};
  await React.act(async()=>root.render(<Example binding={binding} reduced={false}/>));
  await open();await click(".brief-goal-accept");await tick(190);
  expect(host.querySelector("[data-work-item-id]")).not.toBeNull();
  await tick(1850);expect(host.querySelector("[data-work-item-id]")).toBeNull();
  await React.act(async()=>host.querySelector<HTMLButtonElement>(".brief-goal-actions .brief-button--text")!.click());
  await open();await render(true,true);await tick(200);
  expect(feedback()).toBe("Added to Today");expect(host.querySelector("[data-work-item-id]")).toBeNull();
});

test("loading, empty and unavailable recommendations keep a local return; unknown progress is never zero",async()=>{
  for(const scenario of ["loading","empty","unavailable","unsupported"]) {
    await React.act(async()=>root.render(null));binding=goalFixture(outcomeFixture("unknown-goal"),scenario);await render();await open();
    expect(host.textContent).toContain("Progress not measured yet");expect(host.querySelector(".brief-goal-value")).toBeNull();expect(host.querySelector(".brief-goal-accept")).toBeNull();
    expect(document.activeElement?.textContent).toContain("Back to goal");
  }
});

test("temporary recommendation loss retains the pending attempt and its response without a second dispatch",async()=>{
  for (const settlesWhileMissing of [false, true]) {
    await React.act(async()=>root.render(null));
    binding=goalFixture(outcomeFixture(),"ready",[front]);
    let calls=0, resolve!:(r:GoalAcceptResult)=>void, sent!:GoalAcceptRequest;
    binding.onAccept=req=>{calls++;sent=req;return new Promise(r=>resolve=r);};
    await render();await open();await click(".brief-goal-accept");
    const ready=binding;
    binding={...binding,recommendation:{status:"loading"}};await render();
    if(settlesWhileMissing) await React.act(async()=>resolve(receipt(sent)));
    binding={...ready,queue:{status:"ready",data:[front,destination]}};await render();
    if(!host.querySelector(".brief-goal-accept"))await open();
    await click(".brief-goal-accept");expect(calls).toBe(1);
    if(!settlesWhileMissing) await React.act(async()=>resolve(receipt(sent)));
    expect(feedback()).toBe("Added to Today");
  }
});

test("interleaved recommendation requests retain separate results across an identity round trip",async()=>{
  const pending=new Map<string,{request:GoalAcceptRequest;resolve:(r:GoalAcceptResult)=>void;reject:(error:Error)=>void}>();
  let calls=0;
  binding.onAccept=req=>{calls++;return new Promise((resolve,reject)=>pending.set(req.revision,{request:req,resolve,reject}));};
  const first=binding;
  if(first.recommendation.status!=="ready")throw Error("fixture");
  const second={...first,recommendation:{status:"ready" as const,data:{...first.recommendation.data,revision:"rec-v2"}}};
  await render();await open();await click(".brief-goal-accept");
  binding=second;await render();await open();await click(".brief-goal-accept");
  binding=first;await render();await open();await click(".brief-goal-accept");
  expect(calls).toBe(2);
  const newer=pending.get("rec-v2")!;
  await React.act(async()=>newer.resolve(receipt(newer.request)));
  expect(feedback()).toBe("Adding to Today…");
  binding={...second,queue:{status:"ready",data:[front,destination]}};await render();await open();
  expect(feedback()).toBe("Added to Today");
  await React.act(async()=>pending.get("rec-v1")!.reject(Error("Late old failure")));
  expect(feedback()).toBe("Added to Today");
  binding=first;await render();await open();
  expect(feedback()).toContain("not confirmed");
  await click(".brief-goal-accept");expect(calls).toBe(2);
});

test("lost goal data does not replay a settled receipt or unlock a completed attempt on recovery",async()=>{
  let calls=0;binding.onAccept=async req=>{calls++;return receipt(req);};
  binding.queue={status:"ready",data:[front,destination]};
  await render();await open();await click(".brief-goal-accept");await tick();
  expect(host.querySelector("[data-work-item-id]")).not.toBeNull();
  await tick(1250);
  const ready=binding;
  binding={...binding,state:{status:"unavailable",reason:"Reconnecting"}};await render();
  binding={...ready,queue:{status:"ready",data:[]}};await render();
  if(!host.querySelector(".brief-goal-accept"))await open();
  await tick();expect(feedback()).toBe("Added to Today");
  expect(host.querySelector("[data-work-item-id]")).toBeNull();
  await click(".brief-goal-accept");expect(calls).toBe(1);
});

test("background recommendation revisions and recovery preserve focus and text in another control",async()=>{
  const composer=document.createElement("textarea");composer.value="Keep my draft";document.body.append(composer);
  try {
    await render();await open();composer.focus();
    if(binding.recommendation.status!=="ready")throw Error("fixture");
    binding={...binding,recommendation:{status:"ready",data:{...binding.recommendation.data,revision:"rec-v2"}}};
    await render();expect(document.activeElement===composer).toBe(true);expect(composer.value).toBe("Keep my draft");
    await open();composer.focus();const ready=binding;
    binding={...binding,recommendation:{status:"loading"}};await render();expect(document.activeElement===composer).toBe(true);
    binding=ready;await render();expect(document.activeElement===composer).toBe(true);
  } finally {composer.remove();}
});

test("an automatic recommendation close restores focus when its removed control held it",async()=>{
  await render();await open();expect(document.activeElement?.textContent).toContain("Back to goal");
  if(binding.recommendation.status!=="ready")throw Error("fixture");
  binding={...binding,recommendation:{status:"ready",data:{...binding.recommendation.data,revision:"rec-v2"}}};
  await render();expect(document.activeElement).toBe(host.querySelector(".brief-goal-next"));
});

test("callbacks from a replaced owner scope cannot overwrite a new request for the same identity",async()=>{
  for(const lateResult of ["failed","rejected"] as const) {
    await React.act(async()=>root.render(null));binding=goalFixture(outcomeFixture(),"ready",[front,destination]);
    const pending:{request:GoalAcceptRequest;resolve:(r:GoalAcceptResult)=>void;reject:(e:Error)=>void}[]=[];
    binding.onAccept=req=>new Promise((resolve,reject)=>pending.push({request:req,resolve,reject}));
    await render();await open();await click(".brief-goal-accept");
    await React.act(async()=>root.render(<Example binding={binding} mode="live"/>));
    await render();if(!host.querySelector(".brief-goal-accept"))await open();
    await click(".brief-goal-accept");expect(pending.length).toBe(2);
    await React.act(async()=>pending[1]!.resolve(receipt(pending[1]!.request)));
    expect(feedback()).toBe("Added to Today");
    await React.act(async()=>{
      if(lateResult==="failed")pending[0]!.resolve({...pending[0]!.request,state:"failed"});
      else pending[0]!.reject(Error("Old owner response"));
    });
    expect(feedback()).toBe("Added to Today");
  }
});
