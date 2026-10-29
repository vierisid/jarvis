import { workflowSafeguards } from './workflow-safeguards';
import { beforeEach, afterEach, test, expect } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb } from '../db';
import { claimIdentity, completeIdentity } from '../db/repos/effect-identity';
import { HubspotNotStartedError, hubspotContactInput, upsertHubspotContact } from './hubspot-contact';
import { isGovernedPiece, tracksPieceCompletion } from './piece-effects';

beforeEach(() => initWorkflowDb(':memory:'));
afterEach(() => closeWorkflowDb());
test('HubSpot contact upsert is governed and receipt protected', () => {
  expect(isGovernedPiece('@activepieces/piece-hubspot')).toBe(true);
  expect(tracksPieceCompletion('@activepieces/piece-hubspot', 'create-or-update-contact')).toBe(true);
});
test('normalize email, preserve partial properties, reject alternate email and malformed values', () => {
  expect(hubspotContactInput({email:' ALICE@EXAMPLE.COM ',objectProperties:{firstname:'Alice',tags:['a','b']}})).toEqual({email:'alice@example.com',objectProperties:{firstname:'Alice',tags:'a;b'}});
  for (const input of [{email:'bad'}, {email:'a@b.com',objectProperties:{email:'other@b.com'}}, {email:'a@b.com',objectProperties:{x:{a:1}}}]) expect(() => hubspotContactInput(input)).toThrow();
});
test('identity claim is atomic; only completed contact writes admit subsequent updates', () => {
  expect(claimIdentity('contact','one',false)).toBe('claimed');
  expect(() => claimIdentity('contact','two',false)).toThrow('unresolved');
  expect(() => claimIdentity('contact','one',false)).toThrow('unresolved');
  completeIdentity('contact','one');
  expect(claimIdentity('contact','two',false)).toBe('claimed');
  expect(() => completeIdentity('contact','one')).toThrow();
});
test('notification identity remains consumed on new submissions', () => {
  claimIdentity('notification','one',true); completeIdentity('notification','one');
  expect(claimIdentity('notification','two',true)).toBe('duplicate');
  expect(claimIdentity('different-flow','two',true)).toBe('claimed');
});
function fixture(statuses: number[]) {
  const calls: Array<{url:string,method:string,body:any}> = [];
  const fetchImpl = (async (url:any, init:any) => {
    calls.push({url:String(url),method:init.method,body:init.body ? JSON.parse(init.body) : null});
    const status = statuses.shift()!;
    return Response.json(status >= 400 ? {} : {id:'42',properties:{email:'alice@example.com',firstname:'Alice'}},{status});
  }) as typeof fetch;
  return {calls,fetchImpl};
}
test('updates by unique email without search or overwriting omitted properties', async () => {
  const f=fixture([200]);
  const result=await upsertHubspotContact({email:'alice@example.com',objectProperties:{firstname:'Alice'}},'synthetic',()=>{},f.fetchImpl);
  expect(result.id).toBe('42'); expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.method).toBe('PATCH'); expect(f.calls[0]!.url).toContain('idProperty=email');
  expect(f.calls[0]!.body).toEqual({properties:{firstname:'Alice'}});
});
test('only definite absence creates; provider email conflict updates the existing contact', async () => {
  const f=fixture([404,409,200]);
  expect((await upsertHubspotContact({email:'alice@example.com',objectProperties:{firstname:'Alice'}},'synthetic',()=>{},f.fetchImpl)).id).toBe('42');
  expect(f.calls.map(c=>c.method)).toEqual(['PATCH','POST','PATCH']);
  expect(f.calls[1]!.body.properties.email).toBe('alice@example.com');
});
test('lost write response reconciles desired fields using a read, never blindly retries', async () => {
  const f=fixture([404,500,200]);
  expect((await upsertHubspotContact({email:'alice@example.com',objectProperties:{firstname:'Alice'}},'synthetic',()=>{},f.fetchImpl)).id).toBe('42');
  expect(f.calls.map(c=>c.method)).toEqual(['PATCH','POST','GET']);
});
for (const status of [401,403,429]) test('HTTP '+status+' never falls through to create', async () => {
  const f=fixture([status]);
  await expect(upsertHubspotContact({email:'alice@example.com',objectProperties:{firstname:'Alice'}},'synthetic',()=>{},f.fetchImpl)).rejects.toThrow();
  expect(f.calls.map(c=>c.method)).toEqual(['PATCH']);
});
test('unconfirmed write fails closed', async () => {
  const f=fixture([404,500,404]);
  await expect(upsertHubspotContact({email:'alice@example.com',objectProperties:{firstname:'Alice'}},'synthetic',()=>{},f.fetchImpl)).rejects.toThrow('unconfirmed');
  expect(f.calls.map(c=>c.method)).toEqual(['PATCH','POST','GET']);
});

test('unmatched readback cannot confirm an uncertain write', async () => {
  const f=fixture([404,500,200]);
  await expect(upsertHubspotContact({email:'alice@example.com',objectProperties:{firstname:'Different'}},'synthetic',()=>{},f.fetchImpl)).rejects.toThrow('unconfirmed');
});
test('empty properties read the existing contact without a destructive empty upsert', async () => {
  const f=fixture([200]);await upsertHubspotContact({email:'alice@example.com',objectProperties:{}},'synthetic',()=>{},f.fetchImpl);
  expect(f.calls.map(c=>c.method)).toEqual(['GET']);
});
test('a killed operation cannot reach the provider', async () => {
  const f=fixture([]);
  await expect(upsertHubspotContact({email:'alice@example.com',objectProperties:{firstname:'Alice'}},'synthetic',()=>{throw Error('Stopped');},f.fetchImpl)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
test('a checkpoint refusal after a definite 404 is not started: no POST, no reconciling read', async () => {
  const f=fixture([404]);let n=0;const refusal=Error('run is STOPPED');
  const error=await upsertHubspotContact({email:'alice@example.com',objectProperties:{firstname:'Alice'}},'synthetic',()=>{if(n++>0)throw refusal;},f.fetchImpl).catch(e=>e);
  expect(error).toBeInstanceOf(HubspotNotStartedError);expect(error.refusal).toBe(refusal);
  expect(f.calls.map(c=>c.method)).toEqual(['PATCH']);
});
test('a checkpoint refusal after a 409 create conflict is not started', async () => {
  const f=fixture([404,409]);let n=0;
  await expect(upsertHubspotContact({email:'alice@example.com',objectProperties:{firstname:'Alice'}},'synthetic',()=>{if(n++>1)throw Error('Stopped');},f.fetchImpl)).rejects.toBeInstanceOf(HubspotNotStartedError);
  expect(f.calls.map(c=>c.method)).toEqual(['PATCH','POST']);
});
test('a checkpoint refusal after an uncertain write stays unconfirmed', async () => {
  const f=fixture([404,500]);let n=0;
  const error=await upsertHubspotContact({email:'alice@example.com',objectProperties:{firstname:'Alice'}},'synthetic',()=>{if(n++>1)throw Error('Stopped');},f.fetchImpl).catch(e=>e);
  expect(error).not.toBeInstanceOf(HubspotNotStartedError);expect(error.message).toContain('unconfirmed');
  expect(f.calls.map(c=>c.method)).toEqual(['PATCH','POST']);
});
test('a failed read-only lookup is not started, whatever the failure', async () => {
  const reset=(async()=>{throw Object.assign(Error('socket hang up'),{code:'ECONNRESET'});}) as unknown as typeof fetch;
  const bad=(async()=>new Response('not json',{status:200})) as unknown as typeof fetch;
  for (const fetchImpl of [reset, bad, fixture([500]).fetchImpl, fixture([404,409,503]).fetchImpl])
    await expect(upsertHubspotContact({email:'alice@example.com',objectProperties:{}},'synthetic',()=>{},fetchImpl)).rejects.toBeInstanceOf(HubspotNotStartedError);
  const f=fixture([404,500,404]);
  await expect(upsertHubspotContact({email:'alice@example.com',objectProperties:{}},'synthetic',()=>{},f.fetchImpl)).rejects.toThrow('unconfirmed');
  expect(f.calls.map(c=>c.method)).toEqual(['GET','POST','GET']);
});

test('readback reports actual invoice admission and write coverage with limits',()=>{
  const report=workflowSafeguards({name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:'@activepieces/piece-gmail',triggerName:'new_attachment',input:{}},nextAction:{name:'upload',type:'PIECE',settings:{pieceName:'@activepieces/piece-google-drive',actionName:'drive_upload_file',input:{}}}});
  expect(report.safeguards.map(s=>s.kind)).toEqual(['attachment-admission','effect-receipt']);
  expect(report.safeguards[0]!.limits).toContain('Different PDF bytes');
  expect(workflowSafeguards({name:'bad',type:'PIECE',settings:{pieceName:'webhook',input:'invalid'}}).safeguards).toEqual([]);
});
