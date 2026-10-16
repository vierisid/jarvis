import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowCreationController } from "../create/controller";
import { createCompositionPort } from "../create/client";
import { readIngredientCatalog } from "./read";
import { BriefCompositionProvider } from "../../../../../src/brief/composition";
import { BriefCapabilities } from "../../../../../src/brief/capabilities";
import { createCompositionRoutes } from "../../../../../src/brief/composition-routes";
import * as db from "../../../../../src/workflows/db/index";
import { configureWorkflowReadiness } from "../../../../../src/workflows/db/repos/flow-readiness";
import { PieceCatalog } from "../../../../../src/workflows/runtime/piece-catalog";
import { getFlow } from "../../../../../src/workflows/db/repos/flow";
import { getFlowVersion } from "../../../../../src/workflows/db/repos/flow-version";

// Drives F-08's real discovery, provider, routes and SQLite through this picker's reader, port and
// controller. Fake model only; a credential canary proves no secret reaches the UI or the model.
test("actual F08 discovery and pinned request recover one populated draft, no credentials or execution",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"jarvis-d17-f08-"));db.initWorkflowDb(join(directory,"fixture.db"));
 const pieceName="@fixture/piece-account",secret="D17_CREDENTIAL_CANARY";
 const catalog=new PieceCatalog([{name:pieceName,version:"1.2.3",displayName:"  Account",description:"Fixture",auth:{type:"SECRET_TEXT"},actions:{send:{name:"send",displayName:"Send \n",description:"Send a message",requireAuth:true,inputSchema:{fields:[{name:"text",label:"Text",type:"string",required:true}]}}}}]);
 configureWorkflowReadiness({pieces:catalog});
 db.getWorkflowDb().run(`INSERT INTO app_connection(id,external_id,display_name,type,scope,status,piece_name,piece_version,project_id,owner_id,value,metadata,created,updated) VALUES (?,? ,?,'SECRET_TEXT','PROJECT','ACTIVE',?,'0.0.0',?,NULL,?,?,1,1)`,[pieceName,"selected-account",secret,pieceName,db.DEFAULT_IDS.project,secret,JSON.stringify({private:secret})]);
 const provider=new BriefCompositionProvider(db.getWorkflowDb(),undefined,3000);let calls=0,posts=0;
 const graph={displayName:"Selected account",trigger:{name:"trigger",type:"EMPTY",nextAction:{name:"send",type:"PIECE",settings:{pieceName,actionName:"send",input:{text:"Hello",auth:"{{connections.selected-account}}"}}}}};
 provider.configure(()=>({llm:{async chat(args:unknown){calls++;expect(JSON.stringify(args)).not.toContain(secret);return {text:JSON.stringify(graph)};}},pieceRegistry:catalog,maxAttempts:2}));
 try {
  const caps=new BriefCapabilities([{id:"workflowComposition",provider},{id:"compositionIngredients",provider}],["workflowComposition","compositionIngredients"]);
  const routes=createCompositionRoutes(caps,(body:unknown,status=200)=>Response.json(body,{status}),provider);let lose=true;
  const request=async(input:string,init?:RequestInit)=>{
   if(input==="/api/workflows/pieces/library")return Response.json({managed:true,entries:[]});
   const req=new Request(new URL(input,"http://fixture.local"),init),path=new URL(req.url).pathname;
   if(path==="/api/brief/composition-ingredients")return routes[path].GET(req);
   if(path==="/api/brief/workflow-compositions"){const response=await routes[path][req.method as "GET"|"POST"](req);if(req.method==="POST"){posts++;if(lose){lose=false;throw Error("lost");}}return response;}
   return routes["/api/brief/workflow-compositions/:id"].GET(Object.assign(req,{params:{id:decodeURIComponent(path.split("/").at(-1)!)}}));
  };
  const choices=await readIngredientCatalog(()=>caps.snapshot(),new AbortController().signal,request);expect(choices).toHaveLength(2);expect(choices.find(c=>c.tab==="library-action")!.displayName).toBe("Account: Send");expect(JSON.stringify(choices)).not.toContain(secret);
  expect(choices.map(c=>c.selection!.kind).sort()).toEqual(["connection","library-action"]);
  let raw:string|null=null;const controller=new WorkflowCreationController(createCompositionPort(()=>caps.snapshot(),request),{read:()=>raw,write:v=>{raw=v;}},{source:"fixture",scopeId:"account:vault",requestId:()=>"d17-f08"});
  const selected=choices.map(c=>({selection:c.selection!,displayName:c.displayName}));controller.setIngredients(selected);controller.setDraft("Use the chosen account and send action to prepare a workflow.");await controller.submit(controller.getSnapshot().draft);expect(controller.getSnapshot().error).not.toBeNull();await provider.idle();await controller.recover();
  const job=controller.getSnapshot().job!;expect(job.state).toBe("draft_ready");expect(job.specification.ingredients).toEqual(selected.map(s=>s.selection));expect(posts).toBe(1);expect(calls).toBe(1);
  expect(getFlow(job.workflow!.flowId)).toMatchObject({status:"DISABLED",published_version_id:null});expect(getFlowVersion(job.workflow!.versionId)).toMatchObject({state:"DRAFT",trigger:graph.trigger});
  expect(db.getWorkflowDb().query<{n:number},[]>("SELECT COUNT(*) n FROM flow").get()!.n).toBe(1);expect(db.getWorkflowDb().query<{n:number},[]>("SELECT COUNT(*) n FROM flow_run").get()!.n).toBe(0);expect(raw).not.toContain(secret);controller.dispose();
 } finally {provider.stop();await provider.idle();db.closeWorkflowDb();rmSync(directory,{recursive:true,force:true});}
});
