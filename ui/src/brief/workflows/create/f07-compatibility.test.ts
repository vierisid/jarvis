import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowCreationController } from "./controller";
import { createCompositionPort } from "./client";

// Optional real sibling owner, not a compile/merge dependency. No paid model.
const ownerRoot=process.env.JARVIS_F07_ROOT;
test.skipIf(!ownerRoot)("actual F07 service/routes create one populated disabled draft after a lost POST",async()=>{
  const load=(path:string)=>import(`${ownerRoot}/${path}`);
  const [{BriefCompositionProvider},{BriefCapabilities},{createCompositionRoutes},db,{configureWorkflowReadiness},{sampleCatalog},{getFlow},{getFlowVersion}]=await Promise.all([
    load("src/brief/composition.ts"),load("src/brief/capabilities.ts"),load("src/brief/composition-routes.ts"),load("src/workflows/db/index.ts"),load("src/workflows/db/repos/flow-readiness.ts"),load("src/workflows/runtime/test-fixtures.ts"),load("src/workflows/db/repos/flow.ts"),load("src/workflows/db/repos/flow-version.ts")]);
  const directory=mkdtempSync(join(tmpdir(),"jarvis-d16-f07-"));db.initWorkflowDb(join(directory,"fixture.db"));configureWorkflowReadiness({pieces:sampleCatalog()});
  const provider=new BriefCompositionProvider(db.getWorkflowDb(),undefined,3000);let modelCalls=0;
  const graph={displayName:"Private report",trigger:{name:"trigger",type:"EMPTY",nextAction:{name:"report",type:"PIECE",settings:{pieceName:"jarvis-ask",actionName:"ask",input:{prompt:"Draft a report. Never send email."}}}}};
  provider.configure(()=>({llm:{async chat(){modelCalls++;return {text:JSON.stringify(graph)};}},pieceRegistry:sampleCatalog(),maxAttempts:2}));
  try{
    const caps=new BriefCapabilities([{id:"workflowComposition",provider}],["workflowComposition"]);
    const routes=createCompositionRoutes(caps,(body:unknown,status=200)=>Response.json(body,{status}),provider);
    let lost=true,posts=0;const port=createCompositionPort(()=>caps.snapshot(),(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const req=new Request(new URL(String(input),"http://fixture.local"),init);const path=new URL(req.url).pathname;
      if(path==="/api/brief/workflow-compositions"){
        const response=await routes[path][req.method as "GET"|"POST"](req);
        if(req.method==="POST"){posts++;if(lost){lost=false;throw Error("Simulated response loss");}}return response;
      }
      Object.assign(req,{params:{id:decodeURIComponent(path.split("/").at(-1)!)}});return routes["/api/brief/workflow-compositions/:id"].GET(req);
    }) as typeof fetch);
    let saved:string|null=null;const controller=new WorkflowCreationController(port,{read:()=>saved,write:v=>{saved=v;}},{scopeId:"fixture-account:vault",source:"fixture",requestId:()=>"d16-real-f07"});
    const prompt="On manual trigger draft a report. Never send email.";controller.setDraft(prompt);await controller.submit(prompt);expect(controller.getSnapshot().error).not.toBeNull();await provider.idle();await controller.recover();
    const result=controller.getSnapshot().job!;expect(result.state).toBe("draft_ready");expect(modelCalls).toBe(1);expect(posts).toBe(1);
    expect(getFlow(result.workflow!.flowId)).toMatchObject({status:"DISABLED",published_version_id:null});expect(getFlowVersion(result.workflow!.versionId)).toMatchObject({state:"DRAFT",trigger:graph.trigger});
    for(const table of ["flow","flow_version","workflow_composition"]){expect(db.getWorkflowDb().query(`SELECT COUNT(*) n FROM ${table}`).get().n).toBe(1);}expect(db.getWorkflowDb().query("SELECT COUNT(*) n FROM flow_run").get().n).toBe(0);
    controller.dispose();
  }finally{provider.stop();await provider.idle();db.closeWorkflowDb();rmSync(directory,{recursive:true,force:true});}
});
