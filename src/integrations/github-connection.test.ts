import {afterEach,beforeEach,expect,test} from 'bun:test';
import {closeSync,constants,mkdtempSync,mkdirSync,openSync,writeFileSync,writeSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DEFAULT_CONFIG} from '../config/types';
import {githubStatus,readGitHubConnection} from './github-connection';
import {githubOptions} from './github-options';
import {JarvisGitHubConnectionSource} from '../workflows/credentials/github-source';
import {CredentialResolver} from '../workflows/credentials/adapter';
let dir:string;
const doc=()=>({version:1,provider:'github',status:'connected',generation:randomUUID(),access_token:'PRIVATE',account:{id:'a'.repeat(24),label:'Owner'},workspaces:[],connected_at:new Date().toISOString()});
const write=(value:unknown)=>writeFileSync(join(dir,'connections/github.json'),JSON.stringify(value));
const config=()=>({...DEFAULT_CONFIG,daemon:{...DEFAULT_CONFIG.daemon,data_dir:dir},usejarvis_integrations:{page_url:'https://app.usejarvis.dev/account'}});
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'github-connection-'));mkdirSync(join(dir,'connections'));write(doc());});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
test('read-through OAUTH2 credentials bind reconnect and disconnect; status reveals no credentials',async()=>{
  const source=new JarvisGitHubConnectionSource(dir),resolver=new CredentialResolver();resolver.register(source);
  expect(githubStatus(config())).toMatchObject({connected:true,connect_url:'https://app.usejarvis.dev/account?integration=github'});
  expect(JSON.stringify(githubStatus(config()))).not.toContain('PRIVATE');
  expect(await source.resolve('jarvis:github')).toMatchObject({type:'OAUTH2',value:{access_token:'PRIVATE',jarvis_managed:'github'}});
  // Which steps may name it is the credential route's check (managed-connection-scope.test.ts).
  expect(source.pieceNames).toEqual(['@activepieces/piece-github']); expect(source.pieceDetails['@activepieces/piece-github']!.apiHosts).toEqual(['api.github.com']);
  const before=source.identity('jarvis:github');write(doc());expect(source.identity('jarvis:github')).not.toBe(before);
  write({version:1,provider:'github',status:'disconnected',generation:randomUUID()});expect(await source.resolve('jarvis:github')).toBeNull();
});
test('rejects foreign, malformed and oversized documents',()=>{
  for(const v of [null,{}, {...doc(),provider:'clickup'},{...doc(),account:{id:'',label:'Owner'}}]){write(v);expect(readGitHubConnection(dir)).toBeNull();}
  writeFileSync(join(dir,'connections/github.json'),'x'.repeat(65537));expect(readGitHubConnection(dir)).toBeNull();
});
test('repository choices use fixed endpoints, filter archived/disabled repositories and reject stale accounts',async()=>{
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{expect(String(url)).toBe('https://api.github.com/user/repos?per_page=100&sort=updated&direction=desc'); expect(init?.redirect).toBe('error'); return Response.json([{owner:{login:'octocat'},name:'Sandbox',has_issues:true,archived:false},{owner:{login:'octocat'},name:'Old',has_issues:true,archived:true}]);}) as unknown as typeof fetch;
 const result=await githubOptions(config(),new URLSearchParams(),request);
 expect(result.options).toEqual([{value:{owner:'octocat',repo:'Sandbox'},label:'octocat/Sandbox'}]); expect(result.has_more).toBe(false);
 expect(JSON.stringify(result)).not.toContain('PRIVATE');
 write(doc());await expect(githubOptions(config(),new URLSearchParams({generation:result.generation}),request)).rejects.toMatchObject({status:409});
});
test('repository choices reject malformed IDs and account changes during retrieval',async()=>{
 for(const owner of [undefined,null,123,true,'../evil']) await expect(githubOptions(config(),new URLSearchParams(),(async()=>Response.json([{owner:{login:owner},name:'repo',has_issues:true,archived:false}])) as unknown as typeof fetch)).rejects.toMatchObject({status:502});
 await expect(githubOptions(config(),new URLSearchParams(),(async()=>{write(doc());return Response.json([]);}) as unknown as typeof fetch)).rejects.toMatchObject({status:409});
});
for(const [status,expected] of [[401,409],[403,409],[429,429],[500,502]])test('safe provider failure '+status,async()=>{
 try{await githubOptions(config(),new URLSearchParams(),(async()=>new Response('SENSITIVE',{status})) as unknown as typeof fetch);throw Error('expected rejection');}
 catch(e){expect(e).toMatchObject({status:expected});expect(String(e)).not.toContain('SENSITIVE');}
});
test.skipIf(process.platform === 'win32')('a FIFO at the connection path is refused without blocking the daemon', () => {
  const path=join(dir,'connections/github.json');
  rmSync(path); expect(spawnSync('mkfifo', [path]).status).toBe(0);
  expect(readGitHubConnection(dir)).toBeNull();
  // A FIFO holding a valid document and then EOF reads like the file itself, so only the regular-file check refuses it.
  const keep=openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const writer=openSync(path, constants.O_WRONLY);
    writeSync(writer, JSON.stringify(doc())); closeSync(writer);
    expect(readGitHubConnection(dir)).toBeNull();
  } finally { closeSync(keep); }
});
test('a file at exactly the cap is read, one byte over is refused', () => {
  const body=JSON.stringify(doc());
  writeFileSync(join(dir,'connections/github.json'), body + ' '.repeat(65536 - body.length)); expect(readGitHubConnection(dir)).not.toBeNull();
  writeFileSync(join(dir,'connections/github.json'), body + ' '.repeat(65537 - body.length)); expect(readGitHubConnection(dir)).toBeNull();
});
