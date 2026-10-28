import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initWorkflowDb,closeWorkflowDb} from '../db';
import {acquireBatch} from '../db/repos/lead-batch';
import {batchSetup,batchInput,batchSlice,batchTransport,leadUpdate,finalizeBatch} from './lead-batch';
import {batchFixturePayload,batchFixtureSetup,batchFixtureProvider,memoryBatchStore,validateBatchFixtures} from './batch-fixtures';
import {batchTestGraph} from './batch-test-data';
const setup=batchSetup(batchFixtureSetup);let dir:string|undefined;
afterEach(()=>{if(dir){closeWorkflowDb();rmSync(dir,{recursive:true,force:true});dir=undefined;}});
test('actual supported component fixture shape covers mixed, empty, failed, interrupted and replay',async()=>{
 const result=await validateBatchFixtures(batchTestGraph());expect(result.passed).toBe(true);expect(result.cases).toHaveLength(5);expect(result.externalActions).toBe(0);
});
test('invalid configuration and identity mutations are refused',()=>{
 for(const changes of [{submissionIdPath:'constructor.name'},{propertyMapping:{email:'email'}},{propertyMapping:{}},{hubspotPortalId:'../bad'},{contactKeyType:'upsert'}])expect(()=>batchSetup({...setup,...changes})).toThrow();
 for(const payload of [{leads:[]},{submission_id:'',leads:[]},{submission_id:'x',leads:{}},{submission_id:'x',leads:Array(1001).fill({})}])expect(()=>batchInput(setup,payload)).toThrow();
});
test('mapped values are required; zero and false are valid; strings are preserved',()=>{
 const s=batchSetup({...setup,propertyMapping:{firstname:'name',score:'score',flag:'flag'}});
 expect(leadUpdate(s,{contact_id:'123',name:' A ',score:0,flag:false}).properties).toEqual({firstname:' A ',score:'0',flag:'false'});
 for(const lead of [{contact_id:1,name:'x'},{contact_id:'1'},{contact_id:'1',name:{}},{contact_id:'1',name:NaN}])expect(()=>leadUpdate(setup,lead)).toThrow();
});
test('email identity normalization uses PATCH only and never creates a missing contact',async()=>{
 const s=batchSetup({...setup,contactKeyType:'email'}),provider=batchFixtureProvider();provider.modes['a@example.invalid']='fail';
 const lead=leadUpdate(s,{contact_id:' A@EXAMPLE.INVALID ',name:'A'});
 expect((await batchTransport(s,'synthetic',()=>{},provider.fetchImpl)(lead)).status).toBe('failed');expect(provider.calls).toEqual(['a@example.invalid']);expect(provider.writes).toHaveLength(0);
});
test('provider status and invalid successful receipts cannot produce false updates',async()=>{
 const lead=leadUpdate(setup,{contact_id:'1',name:'A'});
 for(const [status,expected]of [[404,'failed'],[429,'failed'],[500,'uncertain'],[408,'uncertain'],[302,'uncertain']] as const){const fetchImpl=(async()=>new Response(null,{status})) as unknown as typeof fetch;expect((await batchTransport(setup,'synthetic',()=>{},fetchImpl)(lead)).status).toBe(expected);}
 for(const body of [{id:'2',properties:{firstname:'A'}},{id:'1',properties:{firstname:'wrong'}},{id:'1',properties:{firstname:'A'},archived:true}])expect((await batchTransport(setup,'synthetic',()=>{},(async()=>Response.json(body)) as unknown as typeof fetch)(lead)).status).toBe('uncertain');
});
test('governance check fails outside network uncertainty catch',async()=>{
 let calls=0;const fetchImpl=(async()=>{calls++;return Response.json({});}) as unknown as typeof fetch;
 await expect(batchTransport(setup,'synthetic',()=>{throw Error('Revoked');},fetchImpl)({key:'1',properties:{firstname:'A'}})).rejects.toThrow('Revoked');expect(calls).toBe(0);
});
test('SQLite lease, completed receipts and interrupted dispatch survive reopen',async()=>{
 dir=mkdtempSync(join(tmpdir(),'lead-batch-store-'));const db=join(dir,'fixture.db');initWorkflowDb(db);let now=1000;
 const input=batchInput(setup,batchFixturePayload(setup)),first=acquireBatch('identity','config',input,'first',()=>now);if('busyUntil'in first)throw Error();
 expect(acquireBatch('identity','config',input,'second',()=>now)).toEqual({busyUntil:46000});
 const p=first.store.load();p.outcomes[0]={index:0,reference:'r0',status:'updated',contactId:'1'};p.outcomes[1]={index:1,reference:'r1',status:'dispatching'};first.store.save(p);
 closeWorkflowDb();initWorkflowDb(db);now=47000;
 const next=acquireBatch('identity','config',input,'next',()=>now);if('busyUntil'in next)throw Error();expect(()=>first.store.check()).toThrow();
 const provider=batchFixtureProvider();const result=await batchSlice(setup,next.store,batchTransport(setup,'synthetic',()=>{},provider.fetchImpl),'identity',()=>now);
 expect(result.complete).toBe(true);if(!result.complete)throw Error();expect(result.counts).toEqual({updated:4,rejected:0,failed:0,uncertain:1});expect(provider.calls).toEqual(['3','4','5']);
 next.release();expect(()=>acquireBatch('identity','changed',input,'new',()=>now)).toThrow('changed');
});
test('terminal outcomes and notification identity remain stable on replay',async()=>{
 const input=batchInput(setup,batchFixturePayload(setup,1)),store=memoryBatchStore({input,outcomes:{}}),provider=batchFixtureProvider();provider.modes['1']='unknown';
 const write=batchTransport(setup,'synthetic',()=>{},provider.fetchImpl),first=await batchSlice(setup,store,write,'same');provider.modes['1']='ok';
 expect(await batchSlice(setup,store,write,'same')).toEqual(first);expect(provider.calls).toEqual(['1']);expect(()=>finalizeBatch(first)).toThrow('uncertain');
});
test('finalizer refuses fabricated success flags and inconsistent totals',()=>{
 const partial={complete:true,total:1,fullySuccessful:true,records:[{status:'failed'}],counts:{updated:0,rejected:0,failed:1,uncertain:0}};
 expect(()=>finalizeBatch(partial)).toThrow('completed with issues');expect(()=>finalizeBatch({...partial,counts:{...partial.counts,failed:0}})).toThrow('counts');
});
