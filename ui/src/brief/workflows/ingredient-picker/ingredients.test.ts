import { expect, test } from "bun:test";
import { readIngredients, readSelected, ingredientKey } from "./model";
import { readIngredientCatalog } from "./read";
import { INGREDIENT_FIXTURES } from "./fixtures";
import { WorkflowCreationController } from "../create/controller";
import { readJob, type CompositionJob, type CompositionRequest } from "../create/model";
import { createCompositionPort } from "../create/client";
const selected = INGREDIENT_FIXTURES.filter(c=>c.selection).map(c=>({selection:c.selection!,displayName:c.displayName}));
const pins = selected.slice(0,3).map(s=>s.selection);
const capabilities=(enabled=true)=>({contractVersion:1,capabilities:{workflowComposition:{supported:true,ready:true,enabled:true,state:"ready",reason:null},compositionIngredients:{supported:true,ready:true,enabled,state:"ready",reason:null}}});
const receipt=(r:CompositionRequest):CompositionJob=>({jobId:"j1",requestId:r.requestId,specification:{name:"New workflow",prompt:r.prompt,...(r.ingredients?{ingredients:r.ingredients}:{})},state:"draft_ready",progress:{checkedCandidates:1},compositionId:"c1",workflow:{flowId:"f1",versionId:"v1"},blocker:null,createdAt:1,updatedAt:1});
function owner(submit:(r:CompositionRequest)=>Promise<CompositionJob>) {
 let raw:string|null=null;const store={read:()=>raw,write:(v:string)=>{raw=v;}};
 const port={submit,recover:async()=>null,read:async()=>{throw Error();}};
 return {controller:new WorkflowCreationController(port,store,{source:"fixture",scopeId:"test",requestId:()=>"request-1"}),store,port};
}
test("canonical pins copy only the public union, reject extras, duplicates and stale hash formats",()=>{
 expect(readIngredients(pins)).toEqual(pins);expect(readIngredients(pins)[0]).not.toBe(pins[0]);
 expect(()=>readIngredients([{...pins[0],token:"secret"}])).toThrow();expect(()=>readIngredients([pins[0],pins[0]])).toThrow();
 expect(()=>readIngredients([{...pins[2],actionVersion:"latest"}])).toThrow();expect(()=>readIngredients(Array(65).fill(pins[0]))).toThrow();
 expect(()=>readIngredients([{...pins[0],pieceVersion:" bad "}])).toThrow();
 expect(readSelected([{...selected[0],metadata:{secret:"canary"}}])).toEqual([selected[0]!]);
 expect(ingredientKey(pins[0]!)).not.toBe(ingredientKey({...pins[2]!,id:pins[0]!.id}));
});
test("unknown receipts cannot drop, reorder or repin selected ingredients",()=>{
 const r={requestId:"id",prompt:"build",ingredients:pins};expect(readJob(receipt(r),r).specification.ingredients).toEqual(pins);
 for(const ingredients of [undefined,[],[...pins].reverse(),pins.map(p=>({...p,pieceVersion:"9.0"}))])expect(()=>readJob({...receipt(r),specification:{name:"New workflow",prompt:"build",ingredients}},r)).toThrow();
 expect(()=>readJob(receipt({requestId:"id",prompt:"build"}),{requestId:"id",prompt:"build",ingredients:[]})).not.toThrow();
});
test("pinned ingredients persist before POST, retry exact uncertain request and survive remount",async()=>{
 const requests:CompositionRequest[]=[];const o=owner(async r=>{requests.push(structuredClone(r));expect(JSON.parse(o.store.read()!).request.ingredients).toEqual(pins);throw Error("lost");});
 o.controller.setDraft("build this");o.controller.setIngredients(selected.slice(0,3));await o.controller.submit("build this");
 o.controller.setDraft("new editing");o.controller.setIngredients([selected[3]!]);
 const restored=new WorkflowCreationController(o.port,o.store,{source:"fixture",scopeId:"test"});await restored.recover();
 expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);expect(restored.getSnapshot().ingredients).toEqual([selected[3]!]);expect(restored.getSnapshot().draft).toBe("new editing");
});
test("clear only a matching prompt AND selection; retain edits during a pending success",async()=>{
 let resolve!:(j:CompositionJob)=>void,request!:CompositionRequest;
 const o=owner(r=>{request=r;return new Promise(done=>resolve=done);});o.controller.setDraft("build");o.controller.setIngredients([selected[0]!]);
 const pending=o.controller.submit("build");o.controller.setIngredients([selected[2]!]);resolve(receipt(request));await pending;
 expect(o.controller.getSnapshot().draft).toBe("build");expect(o.controller.getSnapshot().ingredients).toEqual([selected[2]!]);
 const clean=owner(async r=>receipt(r));clean.controller.setDraft("build");clean.controller.setIngredients(selected.slice(0,2));await clean.controller.submit("build");expect(clean.controller.getSnapshot().draft).toBe("");expect(clean.controller.getSnapshot().ingredients).toEqual([]);
});
test("legacy saved state without ingredients remains readable, malformed pins cannot replace stored state",()=>{
 const base=owner(async r=>receipt(r));base.controller.setDraft("old");const saved=JSON.parse(base.store.read()!);delete saved.ingredients;base.store.write(JSON.stringify(saved));
 expect(new WorkflowCreationController(base.port,base.store,{source:"fixture",scopeId:"test"}).getSnapshot().ingredients).toEqual([]);
 saved.ingredients=[{...selected[0],selection:{...pins[0],token:"secret"}}];const raw=JSON.stringify(saved);base.store.write(raw);
 const broken=new WorkflowCreationController(base.port,base.store,{source:"fixture",scopeId:"test"});expect(broken.getSnapshot().storageFailed).toBe(true);broken.setIngredients([]);expect(base.store.read()).toBe(raw);
});
test("F08 gates admission but existing receipts remain recoverable when the picker is disabled",async()=>{
 const calls:string[]=[];const r={requestId:"id",prompt:"build",ingredients:pins};
 const port=createCompositionPort(()=>capabilities(false),async (url)=>{calls.push(url);return Response.json({jobs:[receipt(r)]});});
 await expect(port.submit(r)).rejects.toThrow();expect(calls).toHaveLength(0);expect(await port.recover(r)).toEqual(receipt(r));expect(calls).toHaveLength(1);
});
test("real discovery pins grant selection; package metadata never does; credential fields never copied",async()=>{
 const calls:string[]=[];const results=await readIngredientCatalog(()=>capabilities(),new AbortController().signal,async url=>{
  calls.push(url);return Response.json(url.includes("pieces/library")?{entries:[{npmPackage:"@activepieces/piece-gmail",displayName:"Gmail",installed:{resolvedVersion:"0.9.0"}},{npmPackage:"@activepieces/piece-hubspot",displayName:"HubSpot",installed:null,token:"SECRET-CANARY"}]}:
   url.endsWith("offset=0")?{ingredients:[{...selected[0],credentials:"SECRET-CANARY"}],nextOffset:100}:{ingredients:[selected[2]],nextOffset:null});
 });
 expect(calls).toHaveLength(3);expect(results[0]!.group).toBe("Gmail");expect(results.filter(c=>c.selection)).toHaveLength(2);expect(results.at(-1)!.status).toBe("uninstalled");expect(results.at(-1)!.selection).toBeUndefined();expect(JSON.stringify(results)).not.toContain("CANARY");
});
test("disabled discovery performs no network request",async()=>{
 let count=0;await expect(readIngredientCatalog(()=>capabilities(false),new AbortController().signal,async()=>{count++;return Response.json({});})).rejects.toThrow();expect(count).toBe(0);
});
test("duplicate pages and partial failures never masquerade as a complete catalog",async()=>{
 for(const fail of [false,true])await expect(readIngredientCatalog(()=>capabilities(),new AbortController().signal,async url=>url.includes("library")?Response.json({entries:[]}):url.endsWith("offset=0")?Response.json({ingredients:[selected[0]],nextOffset:100}):fail?new Response(null,{status:500}):Response.json({ingredients:[selected[0]],nextOffset:null}))).rejects.toThrow();
});
test("retired catalog reads abort without committing partial choices; 100-entry discovery page is valid",async()=>{
 const stop=new AbortController();await expect(readIngredientCatalog(()=>capabilities(),stop.signal,async()=>{stop.abort();return Response.json({ingredients:[],nextOffset:null});})).rejects.toThrow();
 const hundred=Array.from({length:100},(_,i)=>({selection:{...pins[0],id:`connection-${i}`},displayName:`Account ${i}`}));
 expect((await readIngredientCatalog(()=>capabilities(),new AbortController().signal,async url=>Response.json(url.includes("library")?{managed:true,entries:[]}:{ingredients:hundred,nextOffset:null}))).length).toBe(100);
});

// Review R1: presentation labels are not contract identities.
test("discovery normalizes public whitespace labels without changing pinned identities",async()=>{
 const names=[" Gmail: Create draft ","\tCalendar:\nList events\u0000 ","x".repeat(319)+" "," \n\t "];
 const inputs=names.map((displayName,i)=>({selection:{...pins[2]!,actionName:`action-${i}`},displayName}));
 const rows=await readIngredientCatalog(()=>capabilities(),new AbortController().signal,async url=>Response.json(url.includes("library")?{entries:[]}:{ingredients:inputs,nextOffset:null}));
 expect(rows.map(r=>r.selection)).toEqual(inputs.map(r=>r.selection));
 expect(rows.map(r=>r.displayName)).toEqual(["Gmail: Create draft","Calendar: List events","x".repeat(319),`${pins[2]!.id}: action-3`]);
 expect(readSelected(rows)).toHaveLength(4);
 await expect(readIngredientCatalog(()=>capabilities(),new AbortController().signal,async url=>Response.json(url.includes("library")?{entries:[]}:{ingredients:[{...inputs[0],selection:{...inputs[0]!.selection,pieceVersion:" bad "}}],nextOffset:null}))).rejects.toThrow();
});
test("service identities survive optional metadata loss and metadata renaming",async()=>{
 const discover=async(entries:unknown[])=>readIngredientCatalog(()=>capabilities(),new AbortController().signal,async url=>Response.json(url.includes("library")?{entries}:{ingredients:[selected[2]],nextOffset:null}));
 const named=await discover([{npmPackage:pins[2]!.id,displayName:"Gmail",installed:{}}]);
 const fallback=await discover([]),renamed=await discover([{npmPackage:pins[2]!.id,displayName:"Google Mail",installed:{}}]);
 expect(named[0]!.groupId).toBe(pins[2]!.id);expect(fallback[0]!.groupId).toBe(named[0]!.groupId);expect(renamed[0]!.groupId).toBe(named[0]!.groupId);
 expect([named[0]!.group,fallback[0]!.group,renamed[0]!.group]).toEqual(["Gmail",pins[2]!.id,"Google Mail"]);
});
