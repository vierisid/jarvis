import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DEFAULT_CONFIG} from '../config/types';
import {trelloStatus,readTrelloConnection} from './trello-connection';
import {trelloOptions} from './trello-options';
import {JarvisTrelloConnectionSource} from '../workflows/credentials/trello-source';
import {CredentialResolver} from '../workflows/credentials/adapter';
let dir:string;
const doc=()=>({version:1,provider:'trello',status:'connected',generation:randomUUID(),access_token:'PRIVATE',settings:{api_key:'PUBLIC'},account:{id:'a'.repeat(24),label:'Owner'},workspaces:[],connected_at:new Date().toISOString()});
const write=(value:unknown)=>writeFileSync(join(dir,'connections/trello.json'),JSON.stringify(value));
const config=()=>({...DEFAULT_CONFIG,daemon:{...DEFAULT_CONFIG.daemon,data_dir:dir},usejarvis_integrations:{page_url:'https://app.usejarvis.dev/account'}});
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'trello-connection-'));mkdirSync(join(dir,'connections'));write(doc());});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
test('read-through BASIC_AUTH credentials bind reconnect and disconnect; status reveals no credentials',async()=>{
  const source=new JarvisTrelloConnectionSource(dir),resolver=new CredentialResolver();resolver.register(source);
  expect(trelloStatus(config())).toMatchObject({connected:true,connect_url:'https://app.usejarvis.dev/account?integration=trello'});
  expect(JSON.stringify(trelloStatus(config()))).not.toContain('PRIVATE');
  expect(await source.resolve('jarvis:trello')).toMatchObject({type:'BASIC_AUTH',value:{username:'PUBLIC',password:'PRIVATE',jarvis_managed:'trello'}});
  expect(await resolver.resolve({projectId:'p',pieceName:'@activepieces/piece-clickup',externalId:'jarvis:trello'})).toBeNull();
  const before=source.identity('jarvis:trello');write(doc());expect(source.identity('jarvis:trello')).not.toBe(before);
  write({version:1,provider:'trello',status:'disconnected',generation:randomUUID()});expect(await source.resolve('jarvis:trello')).toBeNull();
});
test('rejects foreign, malformed and oversized documents',()=>{
  for(const v of [null,{}, {...doc(),provider:'clickup'},{...doc(),settings:{api_key:''}},{...doc(),settings:undefined},{...doc(),settings:undefined,api_key:'PUBLIC'},{...doc(),account:{id:'bad',label:'Owner'}}]){write(v);expect(readTrelloConnection(dir)).toBeNull();}
  writeFileSync(join(dir,'connections/trello.json'),'x'.repeat(65537));expect(readTrelloConnection(dir)).toBeNull();
});
test('board/list pickers use fixed read endpoints and reject stale account selections',async()=>{
  const request=(async(url:string|URL|Request,init?:RequestInit)=>{expect(String(url)).toBe('https://api.trello.com/1/members/me/boards?filter=open');expect(init?.redirect).toBe('error');return Response.json([{id:'b'.repeat(24),name:'Sandbox'}]);}) as unknown as typeof fetch;
  const result=await trelloOptions(config(),new URLSearchParams(),request);expect(result.options).toEqual([{value:'b'.repeat(24),label:'Sandbox'}]);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  await expect(trelloOptions(config(),new URLSearchParams({board:'../evil'}),request)).rejects.toMatchObject({status:400});
  write(doc());await expect(trelloOptions(config(),new URLSearchParams({board:'b'.repeat(24),generation:result.generation}),request)).rejects.toMatchObject({status:409});
});
for(const [status,expected] of [[401,409],[403,409],[429,429],[500,502]])test('actionable provider failure '+status,async()=>{
  try{await trelloOptions(config(),new URLSearchParams(),(async()=>new Response('SENSITIVE',{status})) as unknown as typeof fetch);throw Error('expected rejection');}
  catch(e){expect(e).toMatchObject({status:expected});expect(String(e)).not.toContain('SENSITIVE');}
});
