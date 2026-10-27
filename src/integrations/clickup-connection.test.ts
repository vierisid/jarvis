import {afterEach, beforeEach, expect, test} from 'bun:test';
import {closeSync, constants, mkdtempSync, mkdirSync, openSync, writeFileSync, writeSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULT_CONFIG} from '../config/types';
import {clickUpStatus, clickUpConnectUrl, readClickUpConnection, CLICKUP_CONNECTION, CLICKUP_PIECE} from './clickup-connection';
import {JarvisClickUpConnectionSource} from '../workflows/credentials/clickup-source';
import {CredentialResolver} from '../workflows/credentials/adapter';
import {metadataToCatalogEntry} from '../workflows/runtime/piece-catalog';
import {MANAGED_PIECE_ADAPTERS, resolveGovernedPieceAction, tracksPieceCompletion} from '../workflows/runtime/piece-effects';
/** Every action of the pinned @activepieces/piece-clickup 0.9.1 bundle (0.10.0 has the same set), read
 * statically from its `actions:` array (custom_api_call is added by the framework and stays unmapped).
 * The engine test checks the installed package against the adapter too. */
const CLICKUP_091_ACTIONS = [
  'create_task', 'create_task_from_template', 'create_folderless_list', 'create_task_comments', 'create_subtask',
  'create_channel', 'create_channel_in_space_folder_list', 'create_message', 'create_message_reaction',
  'create_message_reply', 'get_list', 'get_list_task', 'get_task_by_name', 'get_space', 'get_spaces',
  'get_task_comments', 'get_channel', 'get_channels', 'get_channel_messages', 'get_message_reactions',
  'get_message_replies', 'list_workspace_tasks', 'list_workspace_time_entries', 'update_task', 'update_message',
  'delete_message', 'delete_message_reaction', 'delete_task', 'get_accessible_custom_fields',
  'set_custom_fields_value', 'clickup_create_checklist_item', 'clickup_create_checklist',
  'clickup_delete_checklist_item', 'clickup_delete_checklist', 'clickup_update_checklist_item',
  'clickup_update_checklist', 'clickup_create_task_comment', 'clickup_delete_comment', 'clickup_get_task_comments',
  'clickup_update_comment', 'clickup_get_accessible_custom_fields', 'clickup_create_folder', 'clickup_delete_folder',
  'clickup_get_folders', 'clickup_get_folder', 'clickup_update_folder', 'clickup_create_folderless_list',
  'clickup_create_list', 'clickup_delete_list', 'clickup_get_folderless_lists', 'clickup_get_folder_lists',
  'clickup_get_list_members', 'clickup_get_list', 'clickup_update_list', 'clickup_list_workspace_members',
  'clickup_create_space', 'clickup_delete_space', 'clickup_get_spaces', 'clickup_get_space', 'clickup_update_space',
  'clickup_create_space_tag', 'clickup_delete_space_tag', 'clickup_get_space_tags', 'clickup_update_space_tag',
  'clickup_add_tag_to_task', 'clickup_add_task_dependency', 'clickup_create_task', 'clickup_delete_task_dependency',
  'clickup_delete_task', 'clickup_get_bulk_tasks_time_in_status', 'clickup_get_task_members', 'clickup_get_task',
  'clickup_link_tasks', 'clickup_list_list_tasks', 'clickup_list_tasks', 'clickup_move_task_to_list',
  'clickup_remove_tag_from_task', 'clickup_remove_task_from_list', 'clickup_set_task_status', 'clickup_unlink_tasks',
  'clickup_update_task', 'clickup_create_time_entry', 'clickup_delete_time_entry', 'clickup_get_running_time_entry',
  'clickup_get_time_entry', 'clickup_list_time_entries', 'clickup_start_time_entry', 'clickup_stop_time_entry',
  'clickup_update_time_entry',
];
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
 // Which steps may use it is enforced by readiness and the credential route (managed-connection-scope.test.ts).
 expect(source.pieceNames).toEqual([CLICKUP_PIECE]); expect(source.pieceDetails[CLICKUP_PIECE]!.apiHosts).toEqual(['api.clickup.com']);
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
test.skipIf(process.platform === 'win32')('a FIFO at the connection path is refused without blocking the daemon', () => {
 const path=join(dir,'connections/clickup.json');
 expect(spawnSync('mkfifo', [path]).status).toBe(0);
 expect(readClickUpConnection(dir)).toBeNull();
 // A FIFO holding a valid document and then EOF reads like the file itself,
 // so only the regular-file check refuses it. A reader of ours keeps the pipe
 // (and the bytes) alive once the writer has written and closed.
 const keep=openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
 try {
  const writer=openSync(path, constants.O_WRONLY);
  writeSync(writer, JSON.stringify(doc())); closeSync(writer);
  expect(readClickUpConnection(dir)).toBeNull();
 } finally { closeSync(keep); }
});
test('a file at exactly the cap is read, one byte over is refused', () => {
 const body = JSON.stringify(doc());
 writeFileSync(join(dir,'connections/clickup.json'), body + ' '.repeat(65536 - body.length)); expect(readClickUpConnection(dir)).not.toBeNull();
 writeFileSync(join(dir,'connections/clickup.json'), body + ' '.repeat(65537 - body.length)); expect(readClickUpConnection(dir)).toBeNull();
});
test('the ClickUp adapter names every action of the pinned bundle, and nothing else', () => {
 const adapter=MANAGED_PIECE_ADAPTERS.find(a=>a.pieceName===CLICKUP_PIECE)!;
 const mapped=Object.values(adapter.categories).flat() as string[];
 expect(CLICKUP_091_ACTIONS).toHaveLength(89);
 expect([...mapped].sort()).toEqual([...CLICKUP_091_ACTIONS].sort());
 expect(CLICKUP_091_ACTIONS.filter(name=>!resolveGovernedPieceAction(CLICKUP_PIECE,name)!.known)).toEqual([]);
 expect(resolveGovernedPieceAction(CLICKUP_PIECE,'custom_api_call')).toMatchObject({category:'modify_settings',known:false});
});
