import {afterEach,beforeEach,expect,test} from 'bun:test';
import {closeSync,constants,mkdtempSync,mkdirSync,openSync,writeFileSync,writeSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
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
const doc=()=>({version:1,provider:'slack',status:'connected',generation:randomUUID(),access_token:'PRIVATE',account:{id:'U123',label:'Jarvis bot'},workspaces:[{id:'T123',name:'Sandbox'}],settings:{scopes:'channels:read,chat:write,groups:read'},connected_at:new Date().toISOString()});
const write=(v:unknown)=>writeFileSync(join(dir,'connections/slack.json'),JSON.stringify(v));
const config=()=>({...DEFAULT_CONFIG,daemon:{...DEFAULT_CONFIG.daemon,data_dir:dir},usejarvis_integrations:{page_url:'https://app.usejarvis.dev/account'}});
test('read-through credentials bind reconnect and disconnect; public metadata has no token',async()=>{
 const source=new JarvisSlackConnectionSource(dir),resolver=new CredentialResolver();resolver.register(source);
 expect(slackStatus(config())).toMatchObject({connected:true,connect_url:'https://app.usejarvis.dev/account?integration=slack'});
 expect(JSON.stringify(slackStatus(config()))).not.toContain('PRIVATE');
 expect(await source.resolve('jarvis:slack')).toMatchObject({type:'OAUTH2',value:{access_token:'PRIVATE',scope:'channels:read,chat:write,groups:read',data:{team:{id:'T123'},jarvis_managed:'slack'}}});
 // Which steps may use it is enforced by readiness and the credential route (managed-connection-scope.test.ts).
 expect(source.pieceNames).toEqual(['@activepieces/piece-slack']); expect(source.pieceDetails['@activepieces/piece-slack']!.apiHosts).toEqual(['slack.com']);
 const before=source.identity('jarvis:slack');write(doc());expect(source.identity('jarvis:slack')).not.toBe(before);
 write({version:1,provider:'slack',status:'disconnected',generation:randomUUID()});
 expect(await source.resolve('jarvis:slack')).toBeNull();expect(slackStatus(config()).connected).toBe(false);
});
test('rejects foreign, malformed, oversized and over-scoped documents',()=>{
 for(const v of [null,{}, {...doc(),provider:'clickup'},{...doc(),workspaces:[]},{...doc(),settings:{scopes:'chat:write'}},{...doc(),settings:{scopes:['channels:read','groups:read','chat:write']}},{...doc(),settings:undefined},{...doc(),settings:undefined,scopes:['channels:read','groups:read','chat:write']},{...doc(),account:{id:'bad',label:'Bot'}}]) {write(v);expect(readSlackConnection(dir)).toBeNull();}
 writeFileSync(join(dir,'connections/slack.json'),'x'.repeat(65537));expect(readSlackConnection(dir)).toBeNull();
});
test.skipIf(process.platform === 'win32')('a FIFO at the connection path is refused without blocking the daemon',()=>{
 const path=join(dir,'connections/slack.json');rmSync(path);
 expect(spawnSync('mkfifo',[path]).status).toBe(0);
 expect(readSlackConnection(dir)).toBeNull();
 // A FIFO holding a valid document reads like the file, so only the regular-file check refuses it.
 const keep=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK);
 try {const writer=openSync(path,constants.O_WRONLY);writeSync(writer,JSON.stringify(doc()));closeSync(writer);expect(readSlackConnection(dir)).toBeNull();}
 finally {closeSync(keep);}
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
