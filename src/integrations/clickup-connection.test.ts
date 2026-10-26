import {afterEach, beforeEach, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULT_CONFIG} from '../config/types';
import {clickUpStatus, clickUpConnectUrl, readClickUpConnection, CLICKUP_CONNECTION, CLICKUP_PIECE} from './clickup-connection';
import {JarvisClickUpConnectionSource} from '../workflows/credentials/clickup-source';
import {CredentialResolver} from '../workflows/credentials/adapter';
import {metadataToCatalogEntry} from '../workflows/runtime/piece-catalog';
import {resolveGovernedPieceAction, tracksPieceCompletion} from '../workflows/runtime/piece-effects';
let dir: string;
beforeEach(() => {dir = mkdtempSync(join(tmpdir(), 'clickup-credentials-')); mkdirSync(join(dir,'connections'));});
afterEach(() => rmSync(dir, {recursive:true, force:true}));
const doc = () => ({version: 1, provider:'clickup', status:'connected', generation:randomUUID(), access_token:'INSTANCE_SECRET', account:{id:'7',label:'owner@example.test'}, workspaces:[{id:'8',name:'Sandbox'}], connected_at:new Date().toISOString()});
const write = (v: unknown) => writeFileSync(join(dir,'connections/clickup.json'),JSON.stringify(v));
test('metadata contains no credential; reconnect changes bindings and disconnect removes resolution immediately', async () => {
 const config={...DEFAULT_CONFIG,daemon:{...DEFAULT_CONFIG.daemon,data_dir:dir},usejarvis_integrations:{page_url:'https://app.usejarvis.dev/account'}};
 const source=new JarvisClickUpConnectionSource(dir), resolver=new CredentialResolver(); resolver.register(source);
 expect(clickUpStatus(config).connected).toBe(false); write(doc());
 expect(clickUpStatus(config)).toMatchObject({connected:true,connect_url:'https://app.usejarvis.dev/account?integration=clickup',account:{id:'7'}});
 expect(JSON.stringify(clickUpStatus(config))).not.toContain('INSTANCE_SECRET');
 const first=source.identity(CLICKUP_CONNECTION);
 expect(await resolver.resolve({projectId:'p',pieceName:CLICKUP_PIECE,externalId:CLICKUP_CONNECTION})).toMatchObject({type:'OAUTH2',value:{access_token:'INSTANCE_SECRET'}});
 expect(await resolver.resolve({projectId:'p',pieceName:'@activepieces/piece-slack',externalId:CLICKUP_CONNECTION})).toBeNull();
 write(doc()); expect(source.identity(CLICKUP_CONNECTION)).not.toBe(first);
 write({version:1,provider:'clickup',status:'disconnected',generation:randomUUID()});
 expect(source.identity(CLICKUP_CONNECTION)).toBeNull(); expect(await source.resolve(CLICKUP_CONNECTION)).toBeNull();
 expect(clickUpStatus(config).connected).toBe(false);
});
test('malformed, foreign, oversized files and unsafe setup URLs fail closed', () => {
 for(const value of [null,{}, {...doc(),provider:'slack'}, {...doc(),workspaces:[]}, {...doc(),access_token:1}]) {write(value);expect(readClickUpConnection(dir)).toBeNull();}
 writeFileSync(join(dir,'connections/clickup.json'),'x'.repeat(65537));expect(readClickUpConnection(dir)).toBeNull();
 for(const page_url of ['http://app.usejarvis.dev','javascript:alert(1)','https://user:password@example.test','invalid']) expect(clickUpConnectUrl({...DEFAULT_CONFIG,usejarvis_integrations:{page_url}})).toBeNull();
});
test('scoped task actions expose usable outputs and permission categories without a blanket verified badge', () => {
 const actions=Object.fromEntries(['create_task','get_list_task','get_task_by_name','update_task','delete_task'].map(name=>[name,{name,displayName:name,props:{}}]));
 const catalog=metadataToCatalogEntry({name:CLICKUP_PIECE,auth:{type:'OAUTH2'},actions});
 for(const name of ['create_task','get_list_task','get_task_by_name','update_task']) expect(catalog.actions[name]!.outputSample).toMatchObject({id:'task_example',status:{status:'to do'}});
 expect(catalog.actions.delete_task!.outputSample).toBeUndefined();
 expect(resolveGovernedPieceAction(CLICKUP_PIECE,'get_list_task')?.category).toBe('read_data');
 expect(resolveGovernedPieceAction(CLICKUP_PIECE,'create_task')?.category).toBe('write_data');
 expect(resolveGovernedPieceAction(CLICKUP_PIECE,'custom_api_call')).toMatchObject({category:'modify_settings',known:false});
 expect(tracksPieceCompletion(CLICKUP_PIECE,'create_task')).toBe(true);
});
