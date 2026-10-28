import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import { createRequire } from 'node:module';
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from '../../workflows/db';
import { createFlow, getFlow, listFlows, setPublishedVersion, updateFlowMetadata, updateFlowStatus } from '../../workflows/db/repos/flow';
import { createDraftVersion, getFlowVersion, getLatestDraft, listVersions, lockVersion, setSampleDataEntry, updateDraftVersion } from '../../workflows/db/repos/flow-version';
import { configureWorkflowReadiness } from '../../workflows/db/repos/flow-readiness';
import { createFlowRun, getFlowRun, listRuns } from '../../workflows/db/repos/flow-run';
import { createCompositionJournal } from '../../workflows/db/repos/workflow-composition';
import { PieceCatalog, metadataToCatalogEntry } from '../../workflows/runtime/piece-catalog';
import { sampleCatalog } from '../../workflows/runtime/test-fixtures';
import { orderGraph, repairedOrderGraph, orderSetup, orderCases } from '../../workflows/runtime/order-fixture-data';
import { WorkflowRemoval } from '../../brief/workflow-removal';
import { createManageWorkflowTool } from './manage-workflow';
import { patchDraftGraph } from './workflow-draft-update';
import { toolDefToLLMTool } from './builtin';
import { buildToolGuide } from '../../roles/tool-guide';

const json = createRequire(import.meta.url)('@activepieces/piece-json').json;
const catalog = new PieceCatalog([...sampleCatalog().list(),
  metadataToCatalogEntry({name:'@activepieces/piece-json',version:'0.1.14',displayName:json.displayName,description:json.description,actions:json.actions(),triggers:json.triggers()}),
  {name:'@activepieces/piece-google-sheets',version:'0.18.2',displayName:'Fixture Sheets',description:'No transport',auth:{type:'OAUTH2'},actions:{sheets_append_values:{name:'sheets_append_values',displayName:'Append',description:'Fixture schema',inputSchema:{fields:[
    ...['spreadsheet_id','worksheet_title','range'].map(name=>({name,label:name,type:'string' as const,required:true})),
    {name:'values',label:'Values',type:'json',required:true},{name:'value_input_option',label:'Mode',type:'string',required:true},
  ]}}}},
  {name:'@jarvispieces/piece-jarvis-subflow',displayName:'Return',description:'',actions:{return_result:{name:'return_result',displayName:'Return',description:'',inputSchema:{fields:[{name:'result',label:'Result',type:'json',required:true}]}}}},
]);
const tool = createManageWorkflowTool({pieceRegistry:catalog});
const unwrap = (raw:any) => JSON.parse(String(raw).split('\n').slice(2,-1).join('\n'));
const call = async (args:any) => unwrap(await tool.execute(args));
beforeEach(()=>{initWorkflowDb(':memory:');configureWorkflowReadiness({pieces:catalog});});
afterEach(()=>closeWorkflowDb());
function fixture(graph:any={name:'trigger',type:'EMPTY',settings:{},nextAction:{name:'ask',type:'PIECE',settings:{pieceName:'jarvis-ask',actionName:'ask',input:{prompt:''}}}}){
  const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Existing workflow',trigger:graph});
  return {flow,version};
}
async function read(flowId:string) {
  let page=await call({action:'get',flow:flowId,view:'definition'}),content=page.content;
  const revision=page.revision;
  while(page.nextCursor){page=await call({action:'get',flow:flowId,view:'definition',version_id:page.versionId,cursor:page.nextCursor});expect(page.revision).toBe(revision);content+=page.content;}
  const document=JSON.parse(content);expect(document.revision).toBe(revision);return document;
}
const args=(flowId:string,v:any,patches:any[])=>({action:'update',flow:flowId,version_id:v.id,expected_revision:v.revision,patches});

test('public tool repairs captured generated order expression in place, then all 26 saved-graph fixtures pass',async()=>{
  const graph=repairedOrderGraph();graph.nextAction.nextAction.settings.input.query=orderGraph().nextAction.settings.input.query;
  const {flow,version}=fixture(graph),v=await read(flow.id);
  await expect(call({action:'validate_fixtures',flow:flow.id,fixture_input:{setup:orderSetup(),cases:[orderCases()[0]]}})).rejects.toThrow('typed 2D array');
  const output=await call(args(flow.id,v,[{op:'replace',path:'/nextAction/nextAction/settings/input/query',value:repairedOrderGraph().nextAction.nextAction.settings.input.query}]));
  expect(output).toMatchObject({ok:true,changed:true,flowId:flow.id,versionId:version.id,status:'DISABLED',publishedVersionId:null,validation:{structureValid:true,readyToRun:false}});
  expect(output.revision).not.toBe(v.revision);
  const fixt={action:'validate_fixtures',flow:flow.id,fixture_input:{setup:orderSetup(),cases:orderCases()}};
  let page=await call(fixt),content=page.content;
  while(page.nextCursor){page=await call({...fixt,cursor:page.nextCursor});content+=page.content;}
  const report=JSON.parse(content);expect(report.passed).toBe(true);expect(report.cases).toHaveLength(26);expect(report.externalActions).toBe(0);
  expect(listFlows()).toHaveLength(1);expect(listVersions(flow.id)).toHaveLength(1);expect(listRuns({flowId:flow.id})).toHaveLength(0);
  expect(getFlowVersion(version.id)!.trigger).toEqual(repairedOrderGraph());
});

test('narrow updates preserve configured inputs, empty setup, samples, metadata, runs and identities',async()=>{
  const graph=repairedOrderGraph();graph.nextAction.nextAction.nextAction.children[0].settings.input.auth='{{connections.fixture}}';
  graph.nextAction.nextAction.nextAction.children[0].settings.input.spreadsheet_id='configured-fixture-sheet';
  const {flow,version}=fixture(graph);updateFlowMetadata(flow.id,{keep:'metadata'});setSampleDataEntry(version.id,'trigger',{orderId:'sample'});
  const run=createFlowRun({flowId:flow.id,flowVersionId:version.id,status:'SUCCEEDED'}),before=getFlowVersion(version.id)!,v=await read(flow.id);
  await call(args(flow.id,v,[{op:'replace',path:'/nextAction/displayName',value:'Configure order mapping'}]));
  const after=getFlowVersion(version.id)!;expect(after.trigger.nextAction!.settings).toEqual(before.trigger.nextAction!.settings);
  expect(after.trigger.nextAction!.nextAction).toEqual(before.trigger.nextAction!.nextAction);expect(after.sampleData).toEqual(before.sampleData);
  expect(getFlow(flow.id)!.metadata).toBe(JSON.stringify({keep:'metadata'}));expect(getFlowRun(run.id)).toEqual(run);
  expect(listVersions(flow.id)).toHaveLength(1);expect(getLatestDraft(flow.id)!.id).toBe(version.id);
});

test('structural edits can add and remove steps; no-op retries do not manufacture changes',async()=>{
  const {flow,version}=fixture(),v=await read(flow.id);
  await call(args(flow.id,v,[{op:'add',path:'/nextAction/nextAction',value:{name:'notify',type:'PIECE',settings:{pieceName:'jarvis-notify',actionName:'notify',input:{message:'{{ask}}',channels:['dashboard']}}}}]));
  let current=await read(flow.id);await call(args(flow.id,current,[{op:'remove',path:'/nextAction/nextAction'}]));
  current=await read(flow.id);const output=await call({...args(flow.id,current,[]),name:'Renamed'});expect(output.changed).toBe(true);
  current=await read(flow.id);const before=getFlowVersion(version.id);expect((await call(args(flow.id,current,[]))).changed).toBe(false);expect(getFlowVersion(version.id)).toEqual(before);
});

test('a stale revision rejects editor changes and concurrent repairs atomically',async()=>{
  const {flow,version}=fixture(),v=await read(flow.id);
  updateDraftVersion(version.id,{displayName:'Newer editor change'});
  await expect(call(args(flow.id,v,[{op:'replace',path:'/displayName',value:'stale'}]))).rejects.toThrow('changed since readback');
  const current=await read(flow.id),patch=[{op:'replace',path:'/nextAction/settings/input/prompt',value:'fixed'}];
  const results=await Promise.allSettled([call(args(flow.id,current,patch)),call(args(flow.id,current,patch))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(getFlowVersion(version.id)!.displayName).toBe('Newer editor change');
});

test('invalid patches and graphs never partially apply',async()=>{
  const {flow,version}=fixture(),v=await read(flow.id),before=getFlowVersion(version.id);
  for(const patches of [
    [{op:'replace',path:'/nextAction/settings/pieceName',value:'invented'}],
    [{op:'replace',path:'/nextAction/settings/input/prompt',value:'{{missing.output}}'}],
    [{op:'replace',path:'/displayName',value:'first'},{op:'remove',path:'/missing'}],
    [{op:'replace',path:'',value:{name:'trigger',type:'ROUTER',settings:{}}}],
  ]){
    await expect(call(args(flow.id,v,patches))).rejects.toThrow();expect(getFlowVersion(version.id)).toEqual(before);
  }
});

test('project/version ownership and current draft selection are mandatory',async()=>{
  const a=fixture(),b=fixture(),v=await read(a.flow.id);
  await expect(call({...args(a.flow.id,v,[]),version_id:b.version.id})).rejects.toThrow('version not found');
  await expect(createManageWorkflowTool({pieceRegistry:catalog,callerProjectId:()=> 'foreign'}).execute(args(a.flow.id,v,[]))).rejects.toThrow('not found');
  const clock=spyOn(Date,'now').mockReturnValue(Date.now()+10);
  try { createDraftVersion({flowId:a.flow.id,displayName:'New selected draft',trigger:a.version.trigger}); } finally { clock.mockRestore(); }
  await expect(call(args(a.flow.id,v,[]))).rejects.toThrow('selection changed');
  expect(getFlowVersion(a.version.id)).toEqual(a.version);
});

test('locked versions and live unpublished drafts are refused; a separate draft never changes the publication',async()=>{
  const {flow,version}=fixture({name:'trigger',type:'EMPTY',settings:{}}),v=await read(flow.id);
  updateFlowStatus(flow.id,'ENABLED');await expect(call(args(flow.id,v,[]))).rejects.toThrow('live');
  updateFlowStatus(flow.id,'DISABLED');lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');
  await expect(call(args(flow.id,v,[]))).rejects.toThrow('LOCKED');
  const published=getFlowVersion(version.id),draft=createDraftVersion({flowId:flow.id,displayName:'Editable draft',trigger:version.trigger});
  const current=await read(flow.id);await call({...args(flow.id,current,[]),name:'Repaired draft'});
  expect(getFlowVersion(version.id)).toEqual(published);expect(getFlow(flow.id)).toMatchObject({status:'ENABLED',published_version_id:version.id});expect(getLatestDraft(flow.id)!.id).toBe(draft.id);
});

test('removed workflows cannot be edited or restored implicitly',async()=>{
  const {flow,version}=fixture(),v=await read(flow.id),service=new WorkflowRemoval(getWorkflowDb(),DEFAULT_IDS.project,Date.now,()=>true);
  service.start({refresh:async()=>{}});
  const item=service.read().data.items.find(i=>i.flowId===flow.id)!;
  const result=service.change({scopeId:DEFAULT_IDS.project,flowId:flow.id,versionId:version.id,expectedRevision:item.revision,requestId:crypto.randomUUID(),action:'remove'});
  try { expect(result.status).toBe('accepted');await expect(call(args(flow.id,v,[]))).rejects.toThrow('not found');expect(getFlowVersion(version.id)).toEqual(version); } finally { service.stop(); }
});

test('saved job requirements cannot silently disappear during repair',async()=>{
  const {flow}=fixture();const journal=createCompositionJournal({schemaVersion:1,name:'Keep source',description:'Keep the ask action',contract:{sources:[{piece:'jarvis-ask',action:'ask'}]}});
  updateFlowMetadata(flow.id,{compositionRecordId:journal.id});const v=await read(flow.id);
  await expect(call(args(flow.id,v,[{op:'remove',path:'/nextAction'}]))).rejects.toThrow('saved job contract');
  expect(getFlowVersion(v.id)!.trigger).toEqual(v.trigger);
});

test('JSON Pointer escaping and array operations work without prototype traversal',()=>{
  const saved:any={name:'trigger',type:'EMPTY',settings:{input:{'a/b':{'~key':[0,false]}}}};
  const out=patchDraftGraph(saved,[{op:'add',path:'/settings/input/a~1b/~0key/1',value:null},{op:'replace',path:'/settings/input/a~1b/~0key/0',value:1},{op:'remove',path:'/settings/input/a~1b/~0key/2'},{op:'add',path:'/settings/input/a~1b/~0key/-',value:false}]);
  expect(out.settings!.input!['a/b']).toEqual({'~key':[1,null,false]});expect(saved.settings.input['a/b']['~key']).toEqual([0,false]);
  for(const path of ['/__proto__/bad','/settings/constructor/prototype/bad','/settings/~2bad','/settings/input/a~1b/~0key/01','/settings/input/a~1b/~0key/99'])expect(()=>patchDraftGraph(saved,[{op:'add',path,value:true}])).toThrow();
  expect(({} as any).bad).toBeUndefined();
  expect(()=>patchDraftGraph(saved,Array(65).fill({op:'add',path:'/x',value:1}))).toThrow('64');
  expect(()=>patchDraftGraph(saved,[{op:'replace',path:'',value:'bad'}])).toThrow('root');
  expect(()=>patchDraftGraph(saved,[{op:'replace',path:'/settings/input',value:'x'.repeat(256001)}])).toThrow('256 KB');
});

// Exercise the actual model-facing schema, not just direct tool.execute calls.
test('the agent can discover an update with structured patch items in both catalog modes',()=>{
  const schema:any=toolDefToLLMTool(tool).parameters;
  expect(schema.properties.action.enum).toContain('update');
  expect(schema.properties.patches.items).toMatchObject({type:'object',required:['op','path'],properties:{op:{enum:['add','replace','remove']},path:{type:'string'},value:{}}});
  for(const piecesManaged of [false,true]){
    const guide=buildToolGuide({hasSidecars:false,piecesManaged});
    expect(guide).toContain('update { flow, version_id, expected_revision, patches }');
    expect(guide).toContain('Never compose a replacement');
  }
});
