import {beforeEach,afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initWorkflowDb,closeWorkflowDb,getWorkflowDb} from '../db';
import {acquireImport} from '../db/repos/contact-import';
import {importSlice,importSetup,importDigest,retryDeadline,sameImportValue,ImportRefusal,ImportStop,MAX_IMPORT_PAGES_PER_RUN,MAX_RETRY_AFTER_MS,type ImportAccounts,type ImportRequest} from './contact-import';
import {publicImportAddress} from './import-transport';
import {importFixtureSetup as setup,importFixtureProvider} from './import-fixtures';
let dir:string,now:number,seq:number;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'jarvis-import-'));initWorkflowDb(join(dir,'db'));now=Date.parse('2026-10-26T08:00:00Z');seq=0;live.clear();});
afterEach(()=>{closeWorkflowDb();rmSync(dir,{recursive:true,force:true});});
const reopen=()=>{closeWorkflowDb();initWorkflowDb(join(dir,'db'));};
/** Runs whose flow run is still live; the real store reads flow_run. */
const live=new Set<string>();
async function tick(request:ImportRequest,run?:string){const acquired=acquireImport('job',importDigest(setup),'owner-'+(++seq),()=>now);if('busyUntil'in acquired)throw Error('Busy fixture');try{return await importSlice(setup,{...acquired.store,runLive:r=>live.has(r)},request,now,()=>now,run);}finally{acquired.release();}}
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
test('Retry-After HTTP dates are GMT whatever the machine zone, and zone-less dates are refused',()=>{
 const zone=process.env.TZ;process.env.TZ='America/New_York';
 try{
  expect(retryDeadline('Mon Oct 26 08:02:00 2026',now,1)).toBe(now+120_000);
  expect(retryDeadline('Monday, 26-Oct-26 08:02:00 GMT',now,1)).toBe(now+120_000);
  for(const v of ['Mon, 26 Oct 2026 08:02:00','2026-10-26 08:02:00','2026-10-26T08:02:00'])expect(()=>retryDeadline(v,now,1)).toThrow('Invalid');
 }finally{if(zone===undefined)delete process.env.TZ;else process.env.TZ=zone;}
});

const progress=()=>JSON.parse((getWorkflowDb().query('SELECT progress FROM workflow_contact_import').get() as {progress:string}).progress);
test('a Retry-After beyond 24 hours stops the run without using a retry; a new run resumes from the checkpoint',async()=>{
 expect(MAX_RETRY_AFTER_MS).toBe(86_400_000);
 const f=importFixtureProvider();await tick(f.request,'run-1');
 const far=async()=>({status:429,retryAfter:'172800',body:null});
 const stop=await tick(far,'run-1').catch(e=>e);expect(stop).toBeInstanceOf(ImportStop);expect(stop.code).toBe('IMPORT_RETRY_AFTER_TOO_LONG');expect(stop.unexecuted).toBe(true);
 expect(stop.message).toContain(new Date(now+172_800_000).toISOString());
 expect(progress()).toMatchObject({retries:0,notBefore:0,cursor:null,page:null,phase:'page'});
 await expect(tick(f.request,'run-1')).rejects.toThrow('more than 24 hours');
 // An HTTP-date two days out stops the same way, once the first deadline has passed.
 now+=172_800_000;await expect(tick(async()=>({status:429,retryAfter:new Date(now+2*86_400_000).toUTCString(),body:null}),'run-2')).rejects.toThrow('more than 24 hours');expect(progress().retries).toBe(0);
 reopen();now+=2*86_400_000;expect(await finish(f.request,'run-3')).toMatchObject({complete:true,pages:2,contacts:2});expect(f.creates).toBe(2);
});
test('a far Retry-After on an uncertain write stops, then the new run reconciles instead of writing again',async()=>{
 const f=importFixtureProvider();let far=false;
 const request:ImportRequest=async(provider,url,method,body)=>{const r=await f.request(provider,url,method,body);if(method==='POST'&&!far){far=true;return {status:503,retryAfter:'172800',body:null};}return r;};
 const err=await finish(request,'run-1').catch(e=>e);expect(err).toBeInstanceOf(ImportStop);expect(err.unexecuted).toBe(false);expect(f.creates).toBe(1);
 expect(progress()).toMatchObject({retries:0,phase:'reconcile'});
 now+=172_800_000;expect((await finish(f.request,'run-2')).contacts).toBe(2);expect(f.creates).toBe(2);expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(2);
});
test('a Retry-After within 24 hours still parks the run until then',async()=>{
 const f=importFixtureProvider();await tick(f.request,'run-1');
 const r=await tick(async()=>({status:429,retryAfter:'86400',body:null}),'run-1');expect(r.resumeAt).toBe(now+86_400_000);expect(progress().retries).toBe(1);
 now=r.resumeAt!;expect((await finish(f.request,'run-1')).complete).toBe(true);
});
test('a run stops after the page cap; the count survives restart and a new run resumes from the checkpoint',async()=>{
 expect(MAX_IMPORT_PAGES_PER_RUN).toBe(1000);
 const total=1500,fetched:string[]=[];const f=importFixtureProvider();
 const request:ImportRequest=async(provider,url,method,body)=>{
  if(provider!=='source')return f.request(provider,url,method,body);
  const cursor=new URL(url).searchParams.get('cursor')??'0';fetched.push(cursor);const n=Number(cursor)+1;
  return {status:200,body:{items:[],next_cursor:n<total?String(n):null}};
 };
 const drive=async(run:string,limit:number)=>{for(let i=0;i<limit;i++){const r=await tick(request,run);if(r.complete)return r;now=Math.max(now+1,r.resumeAt??now+1);}return null;};
 expect(await drive('run-1',1201)).toBeNull();expect(progress()).toMatchObject({pages:600,runPages:600,pageRun:'run-1'});
 reopen();
 const stop=await drive('run-1',4000).catch(e=>e);expect(stop).toBeInstanceOf(ImportStop);expect(stop.code).toBe('IMPORT_PAGE_LIMIT');
 expect(stop.message).toContain('stopped after 1000 pages');expect(progress()).toMatchObject({pages:1000,cursor:'1000',page:null});expect(fetched).toHaveLength(1000);
 await expect(tick(request,'run-1')).rejects.toThrow('stopped after 1000 pages');expect(fetched).toHaveLength(1000);
 expect(await drive('run-2',4000)).toMatchObject({complete:true,pages:total});expect(fetched).toHaveLength(total);expect(new Set(fetched).size).toBe(total);
},60_000);
test('one run owns an import until it ends or stops; an overlapping run is refused without touching progress',async()=>{
 const total=3000,fetched:string[]=[];const f=importFixtureProvider();
 const request:ImportRequest=async(provider,url,method,body)=>{
  if(provider!=='source')return f.request(provider,url,method,body);
  const cursor=new URL(url).searchParams.get('cursor')??'0';fetched.push(cursor);const n=Number(cursor)+1;
  return {status:200,body:{items:[],next_cursor:n<total?String(n):null}};
 };
 live.add('run-A');live.add('run-B');
 await tick(request,'run-A');const before=progress();
 const refused=await tick(request,'run-B').catch(e=>e);expect(refused).toBeInstanceOf(ImportStop);expect(refused.code).toBe('IMPORT_RUN_ACTIVE');expect(refused.unexecuted).toBe(true);
 expect(refused.message).toContain('run-A');expect(progress()).toEqual(before);
 // Alternating slices: B never advances or resets A's page budget, so A still stops at the cap.
 let stop:unknown;
 for(let i=0;i<6000&&!stop;i++){
  await expect(tick(request,'run-B')).rejects.toThrow('another run');
  try{const r=await tick(request,'run-A');now=Math.max(now+1,r.resumeAt??now+1);}catch(e){stop=e;}
 }
 expect(stop).toBeInstanceOf(ImportStop);expect((stop as ImportStop).code).toBe('IMPORT_PAGE_LIMIT');expect(fetched).toHaveLength(1000);
 // A stopped, so B may resume although A's flow run has not ended yet.
 stop=undefined;for(let i=0;i<4000&&!stop;i++){try{const r=await tick(request,'run-B');now=Math.max(now+1,r.resumeAt??now+1);}catch(e){stop=e;}}
 expect((stop as ImportStop).code).toBe('IMPORT_PAGE_LIMIT');expect(progress()).toMatchObject({pages:2000,runPages:1000,pageRun:'run-B'});
 // An ended owner releases the import too.
 live.delete('run-B');live.add('run-C');let done=null;for(let i=0;i<4000&&!done;i++){const r=await tick(request,'run-C');if(r.complete)done=r;else now=Math.max(now+1,r.resumeAt??now+1);}
 expect(done).toMatchObject({complete:true,pages:total});expect(new Set(fetched).size).toBe(total);
},60_000);
test('a new run before a far Retry-After deadline refuses without a request, a retry or a park',async()=>{
 const f=importFixtureProvider();await tick(f.request,'run-1');
 await expect(tick(async()=>({status:429,retryAfter:'172800',body:null}),'run-1')).rejects.toThrow('more than 24 hours');
 const at=new Date(now+172_800_000).toISOString(),before=progress(),calls=f.calls.length;
 now+=86_400_000;
 const early=await tick(f.request,'run-2').catch(e=>e);expect(early).toBeInstanceOf(ImportStop);expect(early.code).toBe('IMPORT_RETRY_AFTER_PENDING');expect(early.unexecuted).toBe(true);
 expect(early.message).toContain(at);expect(f.calls).toHaveLength(calls);expect(progress()).toEqual(before);
 now=Date.parse(at)-1;await expect(tick(f.request,'run-3')).rejects.toThrow(at);expect(f.calls).toHaveLength(calls);
 now=Date.parse(at);expect(await finish(f.request,'run-4')).toMatchObject({complete:true,pages:2,contacts:2});
});
test('a far Retry-After after three retries is the typed stop, not an exhausted budget',async()=>{
 const f=importFixtureProvider();await tick(f.request,'run-1');
 for(let i=0;i<3;i++){const r=await tick(async()=>({status:429,retryAfter:'1',body:null}),'run-1');now=r.resumeAt!;}
 expect(progress().retries).toBe(3);
 const stop=await tick(async()=>({status:429,retryAfter:'172800',body:null}),'run-1').catch(e=>e);
 expect(stop).toBeInstanceOf(ImportStop);expect(stop.code).toBe('IMPORT_RETRY_AFTER_TOO_LONG');expect(stop.unexecuted).toBe(true);expect(progress().retries).toBe(3);
});

const stored=()=>JSON.parse((getWorkflowDb().query('SELECT progress FROM workflow_contact_import').get() as any).progress);
test('each deterministic stop names its reason',async()=>{
 const cases=[['cursorCycle','Source cursor cycle detected'],['missingCursor','explicitly return next_cursor'],['changedIdentity','Source identity changed']] as const;
 for(const [option,message] of cases){for(const t of ['workflow_contact_import','workflow_import_contact','workflow_import_cursor'])getWorkflowDb().run('DELETE FROM '+t);
  const f=importFixtureProvider();f.options[option]=true;
  if(option==='changedIdentity'){f.options.changedIdentity=false;await finish(f.request);for(const t of ['workflow_contact_import','workflow_import_cursor'])getWorkflowDb().run('DELETE FROM '+t);f.options.changedIdentity=true;}
  await expect(finish(f.request)).rejects.toThrow(message);}
});
test('a stop left in the write phase reconciles by lookup in a new run before any write',async()=>{
 const f=importFixtureProvider();let refuse=true;
 const request:ImportRequest=async(provider,url,method,body)=>method==='POST'&&refuse?{status:401,body:null}:f.request(provider,url,method,body);
 for(let i=0;i<3;i++)await tick(request,'r1');
 await expect(tick(request,'r1')).rejects.toThrow('HTTP 401');expect(stored()).toMatchObject({phase:'write',method:'POST'});
 refuse=false;const before=f.calls.length;await tick(request,'r2');
 expect(f.calls.slice(before)).toEqual([{provider:'hubspot',url:expect.stringContaining('idProperty=email'),method:'GET'}]);
 expect((await finish(request,'r2')).contacts).toBe(2);expect(f.creates).toBe(2);
});
test('HubSpot normalizing the values it stores still confirms an update by contact ID, without a write loop',async()=>{
 const f=importFixtureProvider();f.contacts.set('alice@example.com',{id:'99',properties:{email:'alice@example.com',firstname:'Old'}});
 // HubSpot's reply: values in its own spelling, and an update reply without the email.
 const request:ImportRequest=async(provider,url,method,body)=>{
  const r=await f.request(provider,url,method,body);if(provider!=='hubspot'||!r.body||!(r.body as any).properties)return r;
  const {email,...rest}=(r.body as any).properties;const properties=Object.fromEntries(Object.entries(rest).map(([k,v])=>[k,String(v).toUpperCase()+' ']));
  return {...r,body:{...(r.body as any),properties:method==='PATCH'?properties:{...properties,email}}};
 };
 expect((await finish(request)).contacts).toBe(2);expect(f.calls.filter(c=>c.method==='PATCH')).toHaveLength(1);expect(f.creates).toBe(1);
});
test('an update reply naming another contact is not confirmed; the lookup confirms the right one',async()=>{
 const f=importFixtureProvider();f.contacts.set('alice@example.com',{id:'99',properties:{email:'alice@example.com',firstname:'Old'}});
 const request:ImportRequest=async(provider,url,method,body)=>{const r=await f.request(provider,url,method,body);return method==='PATCH'?{...r,body:{...(r.body as any),id:'100'}}:r;};
 expect((await finish(request)).contacts).toBe(2);
 expect((getWorkflowDb().query("SELECT contact_id FROM workflow_import_contact WHERE source_id='1'").get() as any).contact_id).toBe('99');
});
test('a refused request or oversized reply is a typed stop that clears the reservation and resumes in a new run',async()=>{
 const f=importFixtureProvider();let refuse:'source'|'write'|null='source';
 const request:ImportRequest=async(provider,url,method,body)=>{
  if(refuse==='source'&&provider==='source')throw new ImportRefusal('Import source must resolve to a public HTTPS address',true);
  if(refuse==='write'&&method==='POST'){await f.request(provider,url,method,body);throw new ImportRefusal('Import provider response exceeds 2 MiB',false);}
  return f.request(provider,url,method,body);
 };
 await tick(request,'r1');const stop=await tick(request,'r1').then(()=>null,e=>e);
 expect(stop).toBeInstanceOf(ImportStop);expect(stop).toMatchObject({code:'IMPORT_REFUSED',unexecuted:true});expect(stored()).toMatchObject({inFlight:false,error:'Import source must resolve to a public HTTPS address',stoppedRun:'r1'});
 refuse='write';await tick(request,'r2');await tick(request,'r2');const write=await tick(request,'r2').then(()=>null,e=>e);
 expect(write).toMatchObject({code:'IMPORT_REFUSED',unexecuted:false});expect(stored()).toMatchObject({inFlight:false,phase:'reconcile'});expect(f.creates).toBe(1);
 refuse=null;expect((await finish(request,'r3')).contacts).toBe(2);expect(f.creates).toBe(2);expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(2);
});
/** One slice of run r1 with these account identities. */
const sliceWith=(request:ImportRequest,hubspot:string,source='source-a')=>{const a=acquireImport('job',importDigest(setup),'owner-'+(++seq),()=>now);if('busyUntil'in a)throw Error('Busy');
 return importSlice(setup,{...a.store,runLive:()=>false},request,now,()=>now,'r1',{hubspot,source} satisfies ImportAccounts).finally(()=>a.release());};
test('a HubSpot reconnect re-verifies the portal and keeps the cursor; another portal stops',async()=>{
 const f=importFixtureProvider();
 for(let i=0;i<5;i++)await sliceWith(f.request,'gen-1');expect(f.creates).toBe(1);const before=stored();expect(before.cursor).toBe('page2');
 const accountCalls=()=>f.calls.filter(c=>c.url.includes('account-info')).length;expect(accountCalls()).toBe(1);
 await sliceWith(f.request,'gen-2');expect(accountCalls()).toBe(2);
 expect(stored()).toMatchObject({contacts:1,hubspotAccount:'gen-2',sourceAccount:'source-a',cursor:'page2',pages:before.pages,phase:before.phase});expect(stored().resume).toBeUndefined();
 for(let i=0;i<40&&!(stored().complete);i++)await sliceWith(f.request,'gen-2');expect(f.creates).toBe(2);expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(2);
 expect(f.calls.filter(c=>c.provider==='source'&&!c.url.includes('cursor='))).toHaveLength(1);
 const other:ImportRequest=async(provider,url,method,body)=>url.includes('account-info')?{status:200,body:{portalId:43}}:f.request(provider,url,method,body);
 for(const t2 of ['workflow_contact_import','workflow_import_contact','workflow_import_cursor'])getWorkflowDb().run('DELETE FROM '+t2);
 for(let i=0;i<5;i++)await sliceWith(f.request,'gen-1');const n=f.calls.length;
 await expect(sliceWith(other,'gen-3')).rejects.toThrow('portal verification failed');expect(f.calls).toHaveLength(n);
});
test('a write interrupted before a HubSpot reconnect is reconciled after the portal check, with its retry count kept',async()=>{
 const f=importFixtureProvider();f.options.crashWrite=true;
 await sliceWith(f.request,'gen-1');await sliceWith(f.request,'gen-1');await sliceWith(f.request,'gen-1');await expect(sliceWith(f.request,'gen-1')).rejects.toThrow('process died');expect(f.creates).toBe(1);
 now+=30_001;await sliceWith(f.request,'gen-2');expect(f.calls.at(-1)!.url).toContain('account-info');
 expect(stored()).toMatchObject({phase:'reconcile',retries:1});
 const n=f.calls.length;await sliceWith(f.request,'gen-2');expect(f.calls[n]).toMatchObject({provider:'hubspot',method:'GET'});
 for(let i=0;i<40&&!(stored().complete);i++)await sliceWith(f.request,'gen-2');expect(f.creates).toBe(2);expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(2);
});
/** Another tenant of the same source API: alice with the same content under the same ID, and dave under bob's ID. */
const tenantB=(f:ReturnType<typeof importFixtureProvider>):ImportRequest=>async(provider,url,method,body)=>{
 if(provider!=='source')return f.request(provider,url,method,body);
 f.calls.push({provider,url,method});const cursor=new URL(url).searchParams.get('cursor');
 return {status:200,body:cursor===null?{items:[{id:'1',email:'alice@example.com',name:'Alice'}],next_cursor:'b2'}:{items:[{id:'2',email:'dave@example.com',name:'Dave'}],next_cursor:null}};
};
test('a different source account restarts from the first page, skipping contacts confirmed with the same content',async()=>{
 const f=importFixtureProvider();
 for(let i=0;i<5;i++)await sliceWith(f.request,'gen-1');expect(stored()).toMatchObject({cursor:'page2',pages:1});expect(f.creates).toBe(1);
 expect(getWorkflowDb().query('SELECT COUNT(*) AS n FROM workflow_import_cursor').get()).toEqual({n:1});
 // A confirmed receipt for ID 2 from the old source (bob), which tenant B uses for dave.
 getWorkflowDb().run("INSERT INTO workflow_import_contact(identity,source_id,hash,contact_id,source) VALUES('job','2','bob-hash','55','source-a')");
 const n=f.calls.length;await sliceWith(tenantB(f),'gen-1','source-b');
 expect(f.calls.slice(n)).toEqual([{provider:'source',url:setup.sourceUrl,method:'GET'}]);expect(stored()).toMatchObject({sourceAccount:'source-b',pages:0});
 for(let i=0;i<40&&!(stored().complete);i++)await sliceWith(tenantB(f),'gen-1','source-b');
 const after=f.calls.slice(n);
 // alice: skipped by her receipt, no HubSpot call; dave: imported although bob's receipt holds ID 2; bob is never read.
 expect(after.some(c=>c.provider==='hubspot'&&c.url.includes('alice'))).toBe(false);expect(f.contacts.has('dave@example.com')).toBe(true);expect(f.contacts.has('bob@example.com')).toBe(false);
 expect(f.creates).toBe(2);expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(2);
 expect(getWorkflowDb().query("SELECT source FROM workflow_import_contact WHERE source_id='2'").get()).toEqual({source:'source-b'});
});
test('under the same source account a confirmed record with other content still stops',async()=>{
 const f=importFixtureProvider();
 for(let i=0;i<5;i++)await sliceWith(f.request,'gen-1');for(let i=0;i<40&&!(stored().complete);i++)await sliceWith(f.request,'gen-1');
 getWorkflowDb().run("UPDATE workflow_contact_import SET progress=json_set(progress,'$.complete',json('false'),'$.cursor',NULL,'$.page',NULL,'$.pages',0)");getWorkflowDb().run('DELETE FROM workflow_import_cursor');
 f.options.changedIdentity=true;await expect((async()=>{for(let i=0;i<10;i++)await sliceWith(f.request,'gen-1');})()).rejects.toThrow('Source identity changed');
});
test('a source change waits for an uncertain write of the old page to be settled first',async()=>{
 const f=importFixtureProvider();f.options.loseWrite=true;
 for(let i=0;i<4;i++)await sliceWith(f.request,'gen-1');expect(stored()).toMatchObject({phase:'reconcile'});expect(f.creates).toBe(1);
 now+=10_000;const n=f.calls.length;await sliceWith(tenantB(f),'gen-1','source-b');
 expect(f.calls[n]).toMatchObject({provider:'hubspot',method:'GET'});expect(stored().sourceAccount).toBe('source-a');
 const m=f.calls.length;await sliceWith(tenantB(f),'gen-1','source-b');expect(stored()).toMatchObject({sourceAccount:'source-b',cursor:null,next:'b2',pages:0});
 expect(f.calls.slice(m)).toEqual([{provider:'source',url:setup.sourceUrl,method:'GET'}]);
 expect(getWorkflowDb().query("SELECT contact_id FROM workflow_import_contact WHERE source_id='1'").get()).toEqual({contact_id:'1'});
});
test('a write decided before a HubSpot reconnect is looked up again after the portal check',async()=>{
 const f=importFixtureProvider();
 for(let i=0;i<3;i++)await sliceWith(f.request,'gen-1');expect(stored()).toMatchObject({phase:'write',method:'POST',inFlight:false});
 await sliceWith(f.request,'gen-2');expect(f.calls.at(-1)!.url).toContain('account-info');expect(stored().phase).toBe('reconcile');
 const n=f.calls.length;await sliceWith(f.request,'gen-2');expect(f.calls[n]).toMatchObject({provider:'hubspot',method:'GET'});
});
test('a lookup matches only the exact value: a dropped leading zero, a missing plus sign or a case correction is updated',async()=>{
 for(const [sent,held] of [['02134','2134'],['+15551234567','15551234567'],['McDonald','mcdonald'],['1000','1e3']] as const){
  for(const t of ['workflow_contact_import','workflow_import_contact','workflow_import_cursor'])getWorkflowDb().run('DELETE FROM '+t);
  const f=importFixtureProvider();f.contacts.set('z@example.com',{id:'7',properties:{email:'z@example.com',firstname:held}});
  const request:ImportRequest=async(provider,url,method,body)=>provider==='source'?{status:200,body:{items:[{id:'z',email:'z@example.com',name:sent}],next_cursor:null}}:f.request(provider,url,method,body);
  expect((await finish(request)).contacts).toBe(1);expect(f.calls.filter(c=>c.method==='PATCH')).toHaveLength(1);expect(f.contacts.get('z@example.com')!.properties.firstname).toBe(sent);
 }
 expect(sameImportValue(' Alice ','Alice')).toBe(true);expect(sameImportValue(null,'')).toBe(false);
 const f=importFixtureProvider();f.contacts.set('alice@example.com',{id:'9',properties:{email:'alice@example.com',firstname:'Alice'}});
 for(const t of ['workflow_contact_import','workflow_import_contact','workflow_import_cursor'])getWorkflowDb().run('DELETE FROM '+t);
 await finish(f.request);expect(f.calls.filter(c=>c.method==='PATCH'&&c.url.includes('alice'))).toHaveLength(0);
});
test('a create reply for another email is not confirmed; the lookup confirms the created contact',async()=>{
 const f=importFixtureProvider();let once=true;
 const request:ImportRequest=async(provider,url,method,body)=>{const r=await f.request(provider,url,method,body);if(method==='POST'&&once){once=false;return {...r,body:{id:'777',properties:{email:'someone@else.example'}}};}return r;};
 expect((await finish(request)).contacts).toBe(2);expect(f.creates).toBe(2);
 expect((getWorkflowDb().query("SELECT contact_id FROM workflow_import_contact WHERE source_id='1'").get() as any).contact_id).toBe('1');
});
