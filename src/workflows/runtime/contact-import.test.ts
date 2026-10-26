import {beforeEach,afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initWorkflowDb,closeWorkflowDb,getWorkflowDb} from '../db';
import {acquireImport} from '../db/repos/contact-import';
import {importSlice,importSetup,importDigest,retryDeadline,type ImportRequest} from './contact-import';
import {publicImportAddress} from './import-transport';
import {importFixtureSetup as setup,importFixtureProvider} from './import-fixtures';
let dir:string,now:number,seq:number;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'jarvis-import-'));initWorkflowDb(join(dir,'db'));now=Date.parse('2026-10-26T08:00:00Z');seq=0;});
afterEach(()=>{closeWorkflowDb();rmSync(dir,{recursive:true,force:true});});
const reopen=()=>{closeWorkflowDb();initWorkflowDb(join(dir,'db'));};
async function tick(request:ImportRequest,run?:string){const acquired=acquireImport('job',importDigest(setup),'owner-'+(++seq),()=>now);if('busyUntil'in acquired)throw Error('Busy fixture');try{return await importSlice(setup,acquired.store,request,now,()=>now,run);}finally{acquired.release();}}
async function finish(request:ImportRequest,run?:string){for(let i=0;i<80;i++){const r=await tick(request,run);if(r.complete)return r;now=Math.max(now+1,r.resumeAt??now+1);}throw Error('Import did not finish');}
test('all pages, normalization, duplicate source IDs and full replay preserve two contacts',async()=>{
 const f=importFixtureProvider();expect(await finish(f.request)).toMatchObject({complete:true,pages:2,contacts:2});expect(f.creates).toBe(2);expect(f.contacts.get('alice@example.com')?.properties.firstname).toBe('Alice');
 const n=f.calls.length;reopen();expect((await finish(f.request)).complete).toBe(true);expect(f.calls).toHaveLength(n);
});
test('page cursor advances only after all records and receipts commit',async()=>{
 const f=importFixtureProvider();await tick(f.request);await tick(f.request);
 const progress=()=>JSON.parse((getWorkflowDb().query('SELECT progress FROM workflow_contact_import').get() as any).progress);
 expect(progress()).toMatchObject({cursor:null,pages:0,index:0});await tick(f.request);await tick(f.request);expect(progress()).toMatchObject({cursor:null,pages:0,index:1});
 reopen();await tick(f.request);expect(progress()).toMatchObject({cursor:'page2',pages:1});expect((await finish(f.request)).contacts).toBe(2);expect(f.creates).toBe(2);
});
test('lost write response reconciles without another create',async()=>{const f=importFixtureProvider();f.options.loseWrite=true;expect((await finish(f.request)).complete).toBe(true);expect(f.creates).toBe(2);expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(2);});

test('concurrent creation conflict resolves the existing primary email instead of duplicating it',async()=>{
 const f=importFixtureProvider();let race=true;
 const request:ImportRequest=async(provider,url,method,body)=>{
  if(method==='POST'&&race){race=false;await f.request(provider,url,method,body);return {status:409,body:null};}
  return f.request(provider,url,method,body);
 };
 expect((await finish(request)).contacts).toBe(2);expect(f.creates).toBe(2);expect(f.contacts.size).toBe(2);
});

test('existing contacts are updated, with a confirmed receipt before checkpointing',async()=>{
 const f=importFixtureProvider();f.contacts.set('alice@example.com',{id:'99',properties:{email:'alice@example.com',firstname:'Old'}});
 expect((await finish(f.request)).contacts).toBe(2);expect(f.creates).toBe(1);expect(f.contacts.get('alice@example.com')?.properties.firstname).toBe('Alice');expect(f.calls.filter(c=>c.method==='PATCH')).toHaveLength(1);
});
test('process death after write resumes from SQLite without repeating the write',async()=>{
 const f=importFixtureProvider();f.options.crashWrite=true;await tick(f.request);await tick(f.request);await tick(f.request);await expect(tick(f.request)).rejects.toThrow('process died');
 reopen();now+=46_000;expect((await finish(f.request)).complete).toBe(true);expect(f.creates).toBe(2);expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(2);
});
test('429 deadline and retry count survive restart and cannot be shortened by an early resume',async()=>{
 const f=importFixtureProvider();f.options.throttle=true;await tick(f.request);const r=await tick(f.request);expect(r.resumeAt).toBe(now+60_000);const count=f.calls.length;
 reopen();now+=59_999;await tick(f.request);expect(f.calls).toHaveLength(count);now++;expect((await finish(f.request)).complete).toBe(true);
});
test('HTTP-date Retry-After and network duration are honored relative to response time',async()=>{
 expect(retryDeadline('Mon, 26 Oct 2026 08:02:00 GMT',now,1)).toBe(now+120_000);
 expect(()=>retryDeadline('nonsense',now,1)).toThrow('Invalid');
 const f=importFixtureProvider();await tick(f.request);const start=now;const r=await tick(async()=>{now+=5000;return {status:429,retryAfter:'60',body:null};});expect(r.resumeAt).toBe(start+65_000);
});
test('three retries maximum across database restarts, with no page checkpoint on failure',async()=>{
 const f=importFixtureProvider();f.options.sourceUnavailable=true;await tick(f.request);
 for(let i=0;i<3;i++){const r=await tick(f.request);reopen();now=r.resumeAt!;}
 await expect(tick(f.request)).rejects.toThrow('retry budget');expect(f.calls.filter(c=>c.provider==='source')).toHaveLength(4);
 reopen();now+=100000;await expect(tick(f.request)).rejects.toThrow('retry budget');expect(f.calls.filter(c=>c.provider==='source')).toHaveLength(4);expect(f.creates).toBe(0);
});
test('concurrent owners and expired lease holders cannot both dispatch or overwrite state',()=>{
 const a=acquireImport('x','config','one',()=>now);expect('store'in a).toBe(true);expect(acquireImport('x','config','two',()=>now)).toEqual({busyUntil:now+45_000});
 now+=45_001;const b=acquireImport('x','config','two',()=>now);if(!('store'in a)||!('store'in b))throw Error();expect(()=>a.store.save(a.store.load())).toThrow('ownership');b.release();
});
test('cursor cycles, missing terminal evidence and changed source identities stop explicitly',async()=>{
 for(const option of ['cursorCycle','missingCursor','changedIdentity'] as const){getWorkflowDb().run('DELETE FROM workflow_contact_import');getWorkflowDb().run('DELETE FROM workflow_import_contact');getWorkflowDb().run('DELETE FROM workflow_import_cursor');const f=importFixtureProvider();f.options[option]=true;await expect(finish(f.request)).rejects.toThrow();expect(f.creates).toBeLessThanOrEqual(2);}
});
test('changed setup cannot reuse import progress and permanent errors never retry',async()=>{
 const f=importFixtureProvider();await tick(f.request);expect(()=>acquireImport('job','different','changed',()=>now)).toThrow('configuration changed');
 let n=0;await expect(tick(async()=>{n++;return {status:401,body:null};})).rejects.toThrow('401');reopen();await expect(tick(f.request)).rejects.toThrow('401');expect(n).toBe(1);
});

test('reconciliation failures cannot evade the durable three-retry budget',async()=>{
 const f=importFixtureProvider();let lost=false;let failures=0;
 const request:ImportRequest=async(provider,url,method,body)=>{
  if(lost){failures++;return {status:503,body:null};}
  const response=await f.request(provider,url,method,body);
  if(method==='POST'){lost=true;return {status:503,body:null};}
  return response;
 };
 await expect(finish(request)).rejects.toThrow('retry budget');expect(failures).toBe(3);expect(f.creates).toBe(1);
 reopen();await expect(tick(request)).rejects.toThrow('retry budget');expect(failures).toBe(3);
});
test('setup rejects identity mutation and credentials in endpoints; private DNS addresses are refused',()=>{
 expect(importSetup(setup)).toEqual(setup);expect(()=>importSetup({...setup,sourceUrl:'https://example.com/?token=secret'})).toThrow('credentials');
 expect(()=>importSetup({...setup,propertyMapping:{email:'other'}})).toThrow('mapping');expect(()=>importSetup({...setup,idPath:'__proto__.x'})).toThrow('field path');
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.2','::1','::ffff:127.0.0.1','fd00::1'])expect(publicImportAddress(ip)).toBe(false);
 expect(publicImportAddress('8.8.8.8')).toBe(true);
});

test('a stop is final for its run; a new run resumes from the checkpoint and reconciles before writing',async()=>{
 const f=importFixtureProvider();let n=0;await tick(f.request,'run-1');
 await expect(tick(async()=>{n++;return {status:401,body:null};},'run-1')).rejects.toThrow('401');
 await expect(tick(f.request,'run-1')).rejects.toThrow('401');expect(n).toBe(1);
 reopen();expect((await finish(f.request,'run-2')).complete).toBe(true);expect(f.creates).toBe(2);
 const g=importFixtureProvider();getWorkflowDb().run('DELETE FROM workflow_contact_import');getWorkflowDb().run('DELETE FROM workflow_import_contact');getWorkflowDb().run('DELETE FROM workflow_import_cursor');
 let lost=false;const flaky:ImportRequest=async(provider,url,method,body)=>{if(lost)return {status:503,body:null};const r=await g.request(provider,url,method,body);if(method==='POST'){lost=true;return {status:503,body:null};}return r;};
 await expect(finish(flaky,'run-3')).rejects.toThrow('retry budget');expect(g.creates).toBe(1);
 await expect(tick(g.request,'run-3')).rejects.toThrow('retry budget');
 expect((await finish(g.request,'run-4')).contacts).toBe(2);expect(g.creates).toBe(2);expect(g.calls.filter(c=>c.method==='POST')).toHaveLength(2);
});
