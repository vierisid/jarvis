import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DEFAULT_CONFIG} from '../config/types';
import {mailchimpStatus,readMailchimpConnection} from './mailchimp-connection';
import {mailchimpOptions} from './mailchimp-options';
import {JarvisMailchimpConnectionSource} from '../workflows/credentials/mailchimp-source';
import {CredentialResolver} from '../workflows/credentials/adapter';
let dir:string;
const doc=()=>({version:1,provider:'mailchimp',status:'connected',generation:randomUUID(),access_token:'PRIVATE',settings:{server_prefix:'us1'},account:{id:'a'.repeat(24),label:'Owner'},workspaces:[],connected_at:new Date().toISOString()});
const write=(value:unknown)=>writeFileSync(join(dir,'connections/mailchimp.json'),JSON.stringify(value));
const config=()=>({...DEFAULT_CONFIG,daemon:{...DEFAULT_CONFIG.daemon,data_dir:dir},usejarvis_integrations:{page_url:'https://app.usejarvis.dev/account'}});
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'mailchimp-connection-'));mkdirSync(join(dir,'connections'));write(doc());});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
test('read-through OAUTH2 credentials bind reconnect and disconnect; status reveals no credentials',async()=>{
  const source=new JarvisMailchimpConnectionSource(dir),resolver=new CredentialResolver();resolver.register(source);
  expect(mailchimpStatus(config())).toMatchObject({connected:true,connect_url:'https://app.usejarvis.dev/account?integration=mailchimp'});
  expect(JSON.stringify(mailchimpStatus(config()))).not.toContain('PRIVATE');
  expect(await source.resolve('jarvis:mailchimp')).toMatchObject({type:'OAUTH2',value:{access_token:'PRIVATE',server_prefix:'us1',jarvis_managed:'mailchimp'}});
  // Which steps may use it is enforced by readiness and the credential route (managed-connection-scope.test.ts).
  expect(source.pieceNames).toEqual(['@activepieces/piece-mailchimp']); expect(source.pieceDetails['@activepieces/piece-mailchimp']!.apiHosts).toEqual([]);
  const before=source.identity('jarvis:mailchimp');write(doc());expect(source.identity('jarvis:mailchimp')).not.toBe(before);
  write({version:1,provider:'mailchimp',status:'disconnected',generation:randomUUID()});expect(await source.resolve('jarvis:mailchimp')).toBeNull();
});
test('rejects foreign, malformed and oversized documents',()=>{
  for(const v of [null,{}, {...doc(),provider:'clickup'},{...doc(),settings:{server_prefix:'us1.evil.test'}},{...doc(),settings:undefined},{...doc(),settings:undefined,server_prefix:'us1'},{...doc(),account:{id:'',label:'Owner'}}]){write(v);expect(readMailchimpConnection(dir)).toBeNull();}
  writeFileSync(join(dir,'connections/mailchimp.json'),'x'.repeat(65537));expect(readMailchimpConnection(dir)).toBeNull();
});
test('audience/campaign pickers use fixed read endpoints and reject stale account selections',async()=>{
  const request=(async(url:string|URL|Request,init?:RequestInit)=>{expect(String(url)).toBe('https://us1.api.mailchimp.com/3.0/lists?count=100&fields=lists.id,lists.name,total_items');expect(init?.redirect).toBe('error');return Response.json({lists:[{id:'b'.repeat(24),name:'Sandbox'}],total_items:101});}) as unknown as typeof fetch;
  const result=await mailchimpOptions(config(),new URLSearchParams({kind:"audiences"}),request);expect(result.options).toEqual([{value:'b'.repeat(24),label:'Sandbox'}]);
  expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(result.has_more).toBe(true);
  await expect(mailchimpOptions(config(),new URLSearchParams({kind:'../evil'}),request)).rejects.toMatchObject({status:400});
  write(doc());await expect(mailchimpOptions(config(),new URLSearchParams({kind:'audiences',generation:result.generation}),request)).rejects.toMatchObject({status:409});
});
test('pickers reject missing and non-string IDs instead of coercing them into choices',async()=>{
  for(const id of [undefined,null,123,true,'../audience']){
    for(const kind of ['audiences','campaigns']){
      const payload=kind==='audiences'?{lists:[{id,name:'Sandbox'}],total_items:1}:{campaigns:[{id,settings:{title:'Newsletter'}}],total_items:1};
      await expect(mailchimpOptions(config(),new URLSearchParams({kind}),(async()=>Response.json(payload)) as unknown as typeof fetch)).rejects.toMatchObject({status:502});
    }
  }
});
for(const [status,expected] of [[401,409],[403,409],[429,429],[500,502]])test('actionable provider failure '+status,async()=>{
  try{await mailchimpOptions(config(),new URLSearchParams({kind:"audiences"}),(async()=>new Response('SENSITIVE',{status})) as unknown as typeof fetch);throw Error('expected rejection');}
  catch(e){expect(e).toMatchObject({status:expected});expect(String(e)).not.toContain('SENSITIVE');}
});
