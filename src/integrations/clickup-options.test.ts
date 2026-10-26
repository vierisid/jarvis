import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DEFAULT_CONFIG,type JarvisConfig} from '../config/types';
import {clickUpOptions} from './clickup-options';
let dir:string,config:JarvisConfig;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'clickup-options-'));mkdirSync(join(dir,'connections'));config={...DEFAULT_CONFIG,daemon:{...DEFAULT_CONFIG.daemon,data_dir:dir}};writeFileSync(join(dir,'connections/clickup.json'),JSON.stringify({version:1,provider:'clickup',status:'connected',generation:randomUUID(),access_token:'ONLY_PROVIDER_SECRET',account:{id:'7',label:'owner'},workspaces:[{id:'8',name:'Sandbox'}],connected_at:new Date().toISOString()}));});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
test('fixed read-only endpoints list spaces and both folderless and nested lists',async()=>{
 const paths:string[]=[];
 const request=(async(url:any,init:any)=>{paths.push(String(url));expect(init.headers.Authorization).toBe('Bearer ONLY_PROVIDER_SECRET');expect(init.redirect).toBe('error');return Response.json(String(url).includes('/folder?')?{folders:[{name:'Projects',lists:[{id:'nested',name:'Sprint'}]}]}:String(url).includes('/list?')?{lists:[{id:'free',name:'Inbox'}]}:{spaces:[{id:'space1',name:'Team'}]});}) as unknown as typeof fetch;
 expect(await clickUpOptions(config,new URLSearchParams({kind:'spaces',id:'8'}),request)).toEqual([{value:'space1',label:'Team'}]);
 expect(await clickUpOptions(config,new URLSearchParams({kind:'lists',id:'space1'}),request)).toEqual([{value:'free',label:'Inbox'},{value:'nested',label:'Projects / Sprint'}]);
 expect(paths).toHaveLength(3);expect(paths.every(p=>p.startsWith('https://api.clickup.com/api/v2/'))).toBe(true);
 await expect(clickUpOptions(config,new URLSearchParams({kind:'spaces',id:'other'}),request)).rejects.toThrow('not connected');
 await expect(clickUpOptions(config,new URLSearchParams({kind:'lists',id:'../oauth/token'}),request)).rejects.toThrow('Choose');
 expect(paths).toHaveLength(3);
});
for(const status of [401,403,429,500])test('provider '+status+' returns recoverable text without its body or token',async()=>{
 const request=(async()=>Response.json({error:'PRIVATE_PROVIDER_DATA'},{status})) as unknown as typeof fetch;
 try{await clickUpOptions(config,new URLSearchParams({kind:'spaces',id:'8'}),request);throw Error('expected failure');}catch(e){expect(String(e)).not.toContain('PRIVATE_PROVIDER_DATA');expect(String(e)).not.toContain('ONLY_PROVIDER_SECRET');expect(String(e)).toContain('ClickUp');}
});
