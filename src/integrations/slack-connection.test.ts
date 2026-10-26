import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DEFAULT_CONFIG} from '../config/types';
import {slackStatus,readSlackConnection} from './slack-connection';
import {slackOptions} from './slack-options';
import {JarvisSlackConnectionSource} from '../workflows/credentials/slack-source';
import {CredentialResolver} from '../workflows/credentials/adapter';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'slack-connection-'));mkdirSync(join(dir,'connections'));write(doc());});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
const doc=()=>({version:1,provider:'slack',status:'connected',generation:randomUUID(),access_token:'PRIVATE',account:{id:'U123',label:'Jarvis bot'},workspaces:[{id:'T123',name:'Sandbox'}],scopes:['channels:read','groups:read','chat:write'],connected_at:new Date().toISOString()});
const write=(v:unknown)=>writeFileSync(join(dir,'connections/slack.json'),JSON.stringify(v));
const config=()=>({...DEFAULT_CONFIG,daemon:{...DEFAULT_CONFIG.daemon,data_dir:dir},usejarvis_integrations:{page_url:'https://app.usejarvis.dev/account'}});
test('read-through credentials bind reconnect and disconnect; public metadata has no token',async()=>{
 const source=new JarvisSlackConnectionSource(dir),resolver=new CredentialResolver();resolver.register(source);
 expect(slackStatus(config())).toMatchObject({connected:true,connect_url:'https://app.usejarvis.dev/account?integration=slack'});
 expect(JSON.stringify(slackStatus(config()))).not.toContain('PRIVATE');
 expect(await source.resolve('jarvis:slack')).toMatchObject({type:'OAUTH2',value:{access_token:'PRIVATE',data:{team:{id:'T123'},jarvis_managed:'slack'}}});
 expect(await resolver.resolve({projectId:'p',pieceName:'@activepieces/piece-clickup',externalId:'jarvis:slack'})).toBeNull();
 const before=source.identity('jarvis:slack');write(doc());expect(source.identity('jarvis:slack')).not.toBe(before);
 write({version:1,provider:'slack',status:'disconnected',generation:randomUUID()});
 expect(await source.resolve('jarvis:slack')).toBeNull();expect(slackStatus(config()).connected).toBe(false);
});
test('rejects foreign, malformed, oversized and over-scoped documents',()=>{
 for(const v of [null,{}, {...doc(),provider:'clickup'},{...doc(),workspaces:[]},{...doc(),scopes:['chat:write']},{...doc(),account:{id:'bad',label:'Bot'}}]) {write(v);expect(readSlackConnection(dir)).toBeNull();}
 writeFileSync(join(dir,'connections/slack.json'),'x'.repeat(65537));expect(readSlackConnection(dir)).toBeNull();
});
test('channel chooser follows one bounded page, lists joined channels only and forwards no token',async()=>{
 let calls=0;
 const request=(async(url: string|URL|Request,init?:RequestInit)=>{
  calls++;expect(String(url)).toContain('https://slack.com/api/conversations.list?');
  expect(new URL(String(url)).searchParams.get('cursor')).toBe('next=');expect(init?.redirect).toBe('error');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer PRIVATE');
  return Response.json({ok:true,channels:[{id:'C1',name:'joined',is_member:true,is_archived:false},{id:'C2',name:'not-joined',is_member:false,is_archived:false},{id:'C3',name:'old',is_member:true,is_archived:true}],response_metadata:{next_cursor:'page2='}});
 }) as unknown as typeof fetch;
 const result=await slackOptions(config(),new URLSearchParams({cursor:'next='}),request);
 expect(calls).toBe(1);expect(result).toMatchObject({options:[{value:'C1',label:'#joined'}],next_cursor:'page2='});expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
for(const [body,status,expected] of [[{ok:false,error:'token_revoked'},200,409],[{ok:false,error:'missing_scope'},200,409],[{private:'SENSITIVE'},429,429],[{ok:false,error:'SENSITIVE'},200,502]] as const)
 test('channel errors are actionable and redacted '+status+JSON.stringify(body),async()=>{
  try {await slackOptions(config(),new URLSearchParams(),(async()=>Response.json(body,{status})) as unknown as typeof fetch);throw Error('expected rejection');}
  catch(e) {expect(e).toMatchObject({status:expected});expect(String(e)).not.toContain('SENSITIVE');}
 });
