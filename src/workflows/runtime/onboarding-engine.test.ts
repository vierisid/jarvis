/** The saved builder graph runs through the real worker/engine with synthetic providers only. */
import {afterAll,beforeAll,expect,test} from 'bun:test';
import {dirname,join} from 'node:path';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {initWorkflowDb,closeWorkflowDb,DEFAULT_IDS} from '../db';
import {setEncryptionKey} from '../db/encryption';
import {createFlow,getFlow,listFlows,setPublishedVersion,updateFlowStatus} from '../db/repos/flow';
import {createDraftVersion,getLatestDraft,lockVersion,updateDraftVersion} from '../db/repos/flow-version';
import {createFlowRun,getFlowRun,listRuns} from '../db/repos/flow-run';
import {enqueue} from '../db/repos/job-queue';
import {upsertConnection} from '../db/repos/app-connection';
import {configureWorkflowReadiness,versionReadiness} from '../db/repos/flow-readiness';
import {pinFlowBindings} from '../db/repos/binding-pins';
import {AuthorityEngine} from '../../authority/engine';
import {AuditTrail} from '../../authority/audit';
import {EmergencyController} from '../../authority/emergency';
import {ApprovalManager} from '../../authority/approval';
import {CredentialResolver} from '../credentials/adapter';
import {SandboxApi} from '../sandbox-api/server';
import {workflowLogsBase} from '../sandbox-api/config';
import {EngineRuntime} from '../runner/engine-runtime/engine-runtime';
import {EngineFlowExecutor} from '../runner/engine-runtime/engine-flow-executor';
import {buildEngineBundle} from '../runner/engine-runtime/build';
import {buildPiece} from '../runner/engine-runtime/build-pieces';
import {Worker} from '../queue/worker';
import {createRunFlowHandler,RUN_FLOW} from '../runner/handler';
import {buildSandboxServiceBackends} from './service-backends';
import {WorkflowEventBuffer} from './event-buffer';
import {PieceCatalog,metadataToCatalogEntry} from './piece-catalog';
import {compileWorkflow} from './workflow-readiness';
import {createManageWorkflowTool} from '../../actions/tools/manage-workflow';
import {onboardingFixturePayload,onboardingFixtureProvider,onboardingFixtureSetup,validateOnboardingFixtures} from './onboarding-fixtures';
import {ONBOARDING_PIECE,ONBOARDING_ACTION,ONBOARDING_REQUIRED} from './customer-onboarding';
import {onboardingTestGraph} from './onboarding-test-data';

let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,catalog:PieceCatalog,authority:AuthorityEngine,approvals:ApprovalManager;
let services:ReturnType<typeof buildSandboxServiceBackends>;
const versions:Record<string,string>={},notifications:string[]=[],runIds:string[]=[];
let provider=onboardingFixtureProvider();
beforeAll(async()=>{
  dir=mkdtempSync(join(tmpdir(),'jarvis-onboarding-engine-'));initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,78));
  const bundle=await buildEngineBundle();
  for(const name of ['onboarding','notify']) {
    const path=join(import.meta.dir,'../activepieces/packages/pieces/jarvis',name);await buildPiece(path);
    const meta=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));versions[meta.name]=meta.version;
    const installed=join(dir,'node_modules',meta.name);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
  }
  for(const name of ['clickup','google-drive'])upsertConnection({externalId:'fixture-'+name,displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-'+name,pieceVersion:'0.0.1',value:{access_token:'synthetic-'+name}});
  authority=new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'});
  approvals=new ApprovalManager();
  services=buildSandboxServiceBackends({credentialResolver:new CredentialResolver(),authorityEngine:authority,approvalManager:approvals,emergencyController:new EmergencyController(),auditTrail:new AuditTrail(),eventBuffer:new WorkflowEventBuffer(),
    onboardingFetch:(async(url:any,init:any)=>{
      const u=new URL(String(url));
      expect(['api.clickup.com','www.googleapis.com']).toContain(u.hostname);
      expect(init.headers.Authorization).toBe(u.hostname==='api.clickup.com'?'synthetic-clickup':'Bearer synthetic-google-drive');
      return provider.fetchImpl(url,init);
    }) as typeof fetch,llmManager:{chat:async()=>{throw Error('No model tools or delegate may execute');}} as any,
    channelService:{sendWorkflowNotification:async()=>{throw Error('No external notifications');}} as any,wsService:{broadcastNotificationToDashboard:(text:string)=>{notifications.push(text);return 1;}} as any});
  api=new SandboxApi({services});await api.start({port:0});runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
  const handle=await runtime.acquire({runId:'onboarding-metadata',projectId:DEFAULT_IDS.project});
  try {const entries=[];for(const[pieceName,pieceVersion]of Object.entries(versions))entries.push(metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName,pieceVersion})));catalog=new PieceCatalog(entries);configureWorkflowReadiness({pieces:catalog});if(process.env.JARVIS_ONBOARDING_CATALOG_EXPORT)writeFileSync(process.env.JARVIS_ONBOARDING_CATALOG_EXPORT,JSON.stringify(entries));}
  finally{await handle.release();}
  worker=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime)})}});
},120_000);
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();setEncryptionKey(null);for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});
const setup={...onboardingFixtureSetup,driveConnection:'fixture-google-drive'};
function configuredGraph(original=onboardingTestGraph()):any {
 const g=structuredClone(original),node=g.nextAction;
 for(const key of ONBOARDING_REQUIRED) if(node.settings.input[key]===''||node.settings.input[key]===null||node.settings.input[key]===undefined)node.settings.input[key]=setup[key];
 return g;
}
async function run(flowId:string,flowVersionId:string,payload=onboardingFixturePayload){
 const r=createFlowRun({flowId,flowVersionId});runIds.push(r.id);
 enqueue({jobType:RUN_FLOW,payload:{runId:r.id,flowVersionId,projectId:DEFAULT_IDS.project,payload},flowId,flowRunId:r.id});await worker.drain();return getFlowRun(r.id)!;
}
async function fixture(original=onboardingTestGraph()){
 provider=onboardingFixtureProvider();authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});
 const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Onboarding fixture',trigger:configuredGraph(original)});
 expect(versionReadiness(flow.id,version.id).issues).toEqual([]);lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');
 return {flow,version,run:()=>run(flow.id,version.id)};
}
test('composer saves disabled supported graph; public fixtures validate exact saved definition',async()=>{
 await fixture();let turn=0;
 const tool=createManageWorkflowTool({pieceRegistry:catalog,llm:{chat:async()=>{throw Error('Use discovery');},chatTools:async()=>turn++===0?{content:'',tool_calls:[{id:'inspect',name:'get_piece_details',arguments:{pieceName:ONBOARDING_PIECE}}]}:{content:'',tool_calls:[{id:'save',name:'submit_flow',arguments:{displayName:'Customer onboarding generated draft',trigger:onboardingTestGraph()}}]}}});
 const raw=await tool.execute({action:'compose',name:'Customer onboarding generated draft',description:'Create a ClickUp onboarding task and Drive customer folder independently. Wait for both outcomes and send one dashboard summary. Retry without duplicating completed resources. Disabled draft, missing setup, fixtures only.'}) as string;
 expect(raw).toContain('"ok":true');const saved=listFlows().find(f=>getLatestDraft(f.id)?.displayName==='Customer onboarding generated draft')!,draft=getLatestDraft(saved.id)!;
 expect(saved.status).toBe('DISABLED');expect(saved.published_version_id).toBeNull();expect(listRuns({flowId:saved.id})).toHaveLength(0);
 const v=compileWorkflow(draft.trigger,{pieces:catalog,phase:'composition'});expect(v.ready).toBe(true);expect(v.setupIssues).toHaveLength(6);
 expect(versionReadiness(saved.id,draft.id).ready).toBe(false);
 const report=String(await tool.execute({action:'validate_fixtures',flow:saved.id}));expect(report).toContain('"passed":true');expect(report).toContain('"externalActions":0');
 expect(provider.calls).toHaveLength(0);
},60_000);
test('engine all-settled success, failure, partial retry and summary deduplication',async()=>{
 for(const failed of [null,'clickup','drive'] as const){
  const f=await fixture();if(failed)provider.modes[failed]='fail';const n=notifications.length;
  expect((await f.run()).status).toBe('SUCCEEDED');expect(provider.calls).toHaveLength(2);expect(notifications.length).toBe(n+1);
  expect(notifications.at(-1)).toContain('ClickUp task:');expect(notifications.at(-1)).toContain('Drive folder:');
  if(failed){expect(notifications.at(-1)).toContain('failed');provider.modes[failed]='ok';}
  expect((await f.run()).status).toBe('SUCCEEDED');expect(provider.calls.length).toBe(failed?3:2);expect(notifications.length).toBe(n+(failed?2:1));
  expect(provider.resources.filter(b=>b==='clickup')).toHaveLength(1);expect(provider.resources.filter(b=>b==='drive')).toHaveLength(1);
  expect((await f.run()).status).toBe('SUCCEEDED');expect(provider.calls.length).toBe(failed?3:2);
 }
},60_000);
test('engine uncertainty fences only the uncertain branch and survives database reopen',async()=>{
 const f=await fixture();provider.modes.drive='unknown';const n=notifications.length;
 expect((await f.run()).status).toBe('SUCCEEDED');expect(notifications.at(-1)).toContain('unknown');expect(notifications.at(-1)).toContain('https://app.clickup.com/t/fixture-task');
 closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,78));configureWorkflowReadiness({pieces:catalog});provider.modes.drive='ok';
 expect((await f.run()).status).toBe('SUCCEEDED');expect(provider.calls).toHaveLength(2);expect(notifications.length).toBe(n+1);
},60_000);
test('saved version change reuses receipts and customer identity separates resources',async()=>{
 const f=await fixture();await f.run();const v=createDraftVersion({flowId:f.flow.id,displayName:'Republished',trigger:configuredGraph()});lockVersion(v.id);setPublishedVersion(f.flow.id,v.id);
 expect((await run(f.flow.id,v.id)).status).toBe('SUCCEEDED');expect(provider.calls).toHaveLength(2);
 expect((await run(f.flow.id,v.id,{customer:{id:'customer-2',name:'Second'}})).status).toBe('SUCCEEDED');expect(provider.calls).toHaveLength(4);
},60_000);
test('authority denial prevents both operations; approved work uses bound arguments',async()=>{
 const f=await fixture();authority.addOverride({action:'write_data',allowed:false});expect((await f.run()).status).toBe('FAILED');expect(provider.calls).toHaveLength(0);
 authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:['write_data']});
 const r=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(r.id);const ctx={runId:r.id,projectId:DEFAULT_IDS.project,stepName:'resources',executionPath:[] as Array<[string,number]>};
 const pending=await services.customerOnboarding!({...setup,customer:onboardingFixturePayload},ctx) as any;expect(pending.approval).toBeDefined();expect(provider.calls).toHaveLength(0);
 approvals.approve(pending.approval.approvalId,'fixture');const result=await services.customerOnboarding!({...setup,customer:onboardingFixturePayload},ctx) as any;expect(result.outcomes.clickup.status).toBe('succeeded');expect(provider.calls).toHaveLength(2);
},60_000);
test('changed account is isolated to its branch; changed destination cannot recreate resources',async()=>{
 const f=await fixture();pinFlowBindings(f.flow.id);upsertConnection({externalId:'fixture-clickup',displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-clickup',pieceVersion:'0.0.1',value:{access_token:'changed'}});
 try{expect((await f.run()).status).toBe('SUCCEEDED');expect(provider.calls).toEqual(['drive']);expect(notifications.at(-1)).toContain('ClickUp task: failed');}finally{upsertConnection({externalId:'fixture-clickup',displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-clickup',pieceVersion:'0.0.1',value:{access_token:'synthetic-clickup'}});}
 const g=await fixture();await g.run();const modified=configuredGraph();modified.nextAction.settings.input.driveParentId='different-parent';const v=createDraftVersion({flowId:g.flow.id,displayName:'Changed',trigger:modified});lockVersion(v.id);setPublishedVersion(g.flow.id,v.id);
 expect((await run(g.flow.id,v.id)).status).toBe('FAILED');expect(provider.calls).toHaveLength(2);
},60_000);

// Captured from the configured model via the real compose tool in isolated storage.
// Only missing setup is filled. Node names, expressions and edges stay unchanged.
test('actual model-generated saved graph passes all outcomes and partial retries in the engine',async()=>{
 const generated=JSON.parse(readFileSync(join(import.meta.dir,'fixtures/onboarding-generated-test14.json'),'utf8'));
 const draftFlow=createFlow(),draft=createDraftVersion({flowId:draftFlow.id,displayName:'Captured Test 14 draft',trigger:generated});
 expect(getFlow(draftFlow.id)?.status).toBe('DISABLED');expect(listRuns({flowId:draftFlow.id})).toHaveLength(0);
 const validation=compileWorkflow(generated,{pieces:catalog,phase:'composition'});expect(validation.ready).toBe(true);expect(validation.setupIssues).toHaveLength(6);
 expect((await validateOnboardingFixtures(generated)).cases.every(c=>c.passed)).toBe(true);
 for(const [clickup,drive] of [['ok','ok'],['fail','ok'],['ok','fail'],['unknown','ok'],['ok','unknown']] as const){
  const f=await fixture(generated);provider.modes.clickup=clickup;provider.modes.drive=drive;const n=notifications.length;
  expect((await f.run()).status).toBe('SUCCEEDED');expect(notifications.length).toBe(n+1);expect(provider.calls).toHaveLength(2);
  expect(notifications.at(-1)).toContain('ClickUp task: '+(clickup==='ok'?'succeeded':clickup==='fail'?'failed':'unknown'));
  expect(notifications.at(-1)).toContain('Drive folder: '+(drive==='ok'?'succeeded':drive==='fail'?'failed':'unknown'));
  provider.modes.clickup='ok';provider.modes.drive='ok';expect((await f.run()).status).toBe('SUCCEEDED');
  expect(provider.calls.length).toBe(2+Number(clickup==='fail')+Number(drive==='fail'));
  expect(provider.resources.filter(b=>b==='clickup')).toHaveLength(1);expect(provider.resources.filter(b=>b==='drive')).toHaveLength(1);
 }
},60_000);

test('concurrent customer deliveries create at most one task/folder pair',async()=>{
 const f=await fixture();const before=notifications.length;
 const results=await Promise.all([f.run(),f.run()]);
 expect(results.some(r=>r.status==='SUCCEEDED')).toBe(true);
 expect(provider.resources.filter(b=>b==='clickup')).toHaveLength(1);expect(provider.resources.filter(b=>b==='drive')).toHaveLength(1);
 expect(notifications.length).toBe(before+1);
},60_000);
