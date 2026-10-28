import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb } from '../db';
import { acquireOnboarding } from '../db/repos/customer-onboarding';
import { onboardCustomer, onboardingCustomer, onboardingSetup, onboardingTransport } from './customer-onboarding';
import { memoryOnboardingStore, onboardingFixturePayload, onboardingFixtureProvider, onboardingFixtureSetup, validateOnboardingFixtures } from './onboarding-fixtures';
import { onboardingTestGraph } from './onboarding-test-data';
let dir: string;
beforeEach(() => { dir=mkdtempSync(join(tmpdir(),'onboarding-fixture-')); initWorkflowDb(join(dir,'fixture.db')); });
afterEach(() => { closeWorkflowDb(); rmSync(dir,{recursive:true,force:true}); });
const setup=onboardingSetup(onboardingFixtureSetup), customer=onboardingCustomer(setup,onboardingFixturePayload);
test('supported graph component suite covers partial and ambiguous outcomes without external effects',async()=>{
  const result=await validateOnboardingFixtures(onboardingTestGraph());
  expect(result.passed).toBe(true);expect(result.cases).toHaveLength(8);expect(result.externalActions).toBe(0);
});
test('both branches begin before either completes; waits for both',async()=>{
  const started:string[]=[], release:Record<string,()=>void>={};let finished=false;
  const pending=onboardCustomer(memoryOnboardingStore(),async(branch,dispatch)=>{dispatch();started.push(branch);await new Promise<void>(r=>release[branch]=r);return {status:branch==='drive'?'failed':'succeeded',detail:branch};},'parallel').then(r=>{finished=true;return r;});
  await Promise.resolve();expect(started).toEqual(['clickup','drive']);release.clickup!();await Promise.resolve();expect(finished).toBe(false);release.drive!();
  const r=await pending;expect(r.outcomes.clickup.status).toBe('succeeded');expect(r.outcomes.drive.status).toBe('failed');
});
test('persistent partial retry reuses confirmed resource across database reopen',async()=>{
  const f=onboardingFixtureProvider();f.modes.drive='fail';
  const create=onboardingTransport(setup,customer,async()=>'synthetic',()=>{},f.fetchImpl);
  let lease=acquireOnboarding('customer','config','run-1');
  const first=await onboardCustomer(lease.store,create,'customer');lease.release();
  expect(first.outcomes.drive.status).toBe('failed');
  closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));f.modes.drive='ok';
  lease=acquireOnboarding('customer','config','run-2');const second=await onboardCustomer(lease.store,create,'customer');lease.release();
  expect(f.calls).toEqual(['clickup','drive','drive']);expect(second.outcomes.clickup.id).toBe(first.outcomes.clickup.id);
  lease=acquireOnboarding('customer','config','run-3');expect(await onboardCustomer(lease.store,create,'customer')).toEqual(second);lease.release();expect(f.calls).toHaveLength(3);
});
test('atomic ownership refuses concurrent callers; expired dispatch stays uncertain',async()=>{
  let now=1000;const clock=()=>now,first=acquireOnboarding('customer','config','first',clock);
  first.store.save('drive',{status:'dispatching'});
  expect(()=>acquireOnboarding('customer','config','second',clock)).toThrow('already running');
  now+=90_001;const second=acquireOnboarding('customer','config','second',clock);
  expect(()=>first.store.save('drive',{status:'failed',detail:'stale'})).toThrow('ownership');
  const f=onboardingFixtureProvider(),result=await onboardCustomer(second.store,onboardingTransport(setup,customer,async()=>'synthetic',()=>{},f.fetchImpl),'customer');second.release();
  expect(result.outcomes.drive.status).toBe('unknown');expect(f.calls).toEqual(['clickup']);
  expect(()=>acquireOnboarding('customer','different-config','third',clock)).toThrow('configuration changed');
});
test('unknown provider commits remain fenced after restart',async()=>{
  const f=onboardingFixtureProvider();f.modes.clickup='unknown';
  const create=onboardingTransport(setup,customer,async()=>'synthetic',()=>{},f.fetchImpl);
  let lease=acquireOnboarding('unknown','config','first');const first=await onboardCustomer(lease.store,create,'unknown');lease.release();
  closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));f.modes.clickup='ok';
  lease=acquireOnboarding('unknown','config','second');const second=await onboardCustomer(lease.store,create,'unknown');lease.release();
  expect(second).toEqual(first);expect(f.resources).toEqual(['clickup','drive']);
});
test('credential failure is isolated without a false dispatched claim',async()=>{
  const f=onboardingFixtureProvider();const store=memoryOnboardingStore();
  const r=await onboardCustomer(store,onboardingTransport(setup,customer,async b=>{if(b==='clickup')throw Error('secret must not leak');return 'synthetic';},()=>{},f.fetchImpl),'auth');
  expect(r.outcomes.clickup.status).toBe('failed');expect(r.outcomes.drive.status).toBe('succeeded');expect(JSON.stringify(r)).not.toContain('secret');expect(f.calls).toEqual(['drive']);
});
test('HTTP ambiguous failures and malformed successes never invite automatic retries',async()=>{
  for(const status of [408,409,429,500,502,503,302]){
    let calls=0;const fetchImpl=(async()=>{calls++;return new Response('',{status});}) as unknown as typeof fetch;
    const store=memoryOnboardingStore(),create=onboardingTransport(setup,customer,async()=>'synthetic',()=>{},fetchImpl);
    expect((await onboardCustomer(store,create,'http')).outcomes.drive.status).toBe('unknown');await onboardCustomer(store,create,'http');expect(calls).toBe(2);
  }
});
test('invalid customer identity and unsafe mappings fail before network access',()=>{
  for(const id of [undefined,null,'',false,{},Number.MAX_SAFE_INTEGER+1])expect(()=>onboardingCustomer(setup,{customer:{id,name:'Name'}})).toThrow();
  for(const customerIdPath of ['__proto__.id','constructor','a[0]','a..b'])expect(()=>onboardingSetup({...setup,customerIdPath})).toThrow();
  expect(()=>onboardingSetup({...setup,clickupListId:'../../user'})).toThrow();
});
test('fixture suite refuses unsupported graph semantics',async()=>{
  const graph=onboardingTestGraph();graph.settings.input={request_id_field:'id'};
  await expect(validateOnboardingFixtures(graph)).rejects.toThrow('exactly webhook');
});
