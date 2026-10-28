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
import {MANAGED_PIECE_ADAPTERS, resolveGovernedPieceAction} from '../workflows/runtime/piece-effects';
/** Every action of the installed @activepieces/piece-trello 0.8.1 bundle (0.7.1 has the same set), read
 * statically from its `actions:` array (custom_api_call is added by the framework and stays unmapped).
 * The engine test checks the installed package against the adapter too. */
const TRELLO_081_ACTIONS = [
  'add_card_attachment', 'add_card_attachment_from_url', 'add_checklist_item', 'add_checklist_to_card',
  'add_comment_to_card', 'add_label_to_card', 'add_member_to_card', 'add_reaction_to_comment',
  'archive_all_cards_in_list', 'archive_board', 'archive_card', 'archive_list', 'copy_card', 'create_board',
  'create_board_custom_field', 'create_board_label', 'create_card', 'create_card_ai', 'create_custom_field_option',
  'create_list', 'delete_board', 'delete_card', 'delete_card_ai', 'delete_card_attachment', 'delete_checklist',
  'delete_checklist_item', 'delete_comment', 'delete_custom_field', 'delete_label', 'get_board', 'get_card',
  'get_card_ai', 'get_card_attachment', 'get_card_attachments', 'get_custom_field', 'get_list', 'get_member',
  'get_my_member', 'list_board_custom_fields', 'list_board_labels', 'list_board_memberships', 'list_board_members',
  'list_boards', 'list_card_activity', 'list_card_attachments_ai', 'list_card_checklists', 'list_card_comments',
  'list_card_custom_field_values', 'list_card_members', 'list_cards_in_board', 'list_cards_in_list',
  'list_card_votes', 'list_custom_field_options', 'list_lists', 'list_organization_boards', 'move_all_cards_in_list',
  'move_card', 'move_list_to_board', 'remove_card_vote', 'remove_label_from_card', 'remove_member_from_card',
  'rename_list', 'search_cards', 'search_members', 'set_card_custom_field_value', 'set_checklist_item_state',
  'update_board', 'update_card', 'update_card_ai', 'update_checklist', 'update_checklist_item', 'update_comment',
  'update_label', 'vote_on_card',
];
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
  // Which steps may use it is enforced by readiness and the credential route (managed-connection-scope.test.ts).
  expect(source.pieceNames).toEqual(['@activepieces/piece-trello']); expect(source.pieceDetails['@activepieces/piece-trello']!.apiHosts).toEqual(['api.trello.com']);
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
test('the Trello adapter names every action of the installed bundle, and nothing else', () => {
  const adapter=MANAGED_PIECE_ADAPTERS.find(a=>a.pieceName==='@activepieces/piece-trello')!;
  const mapped=Object.values(adapter.categories).flat() as string[];
  expect(TRELLO_081_ACTIONS).toHaveLength(74);
  expect([...mapped].sort()).toEqual([...TRELLO_081_ACTIONS].sort());
  for(const name of TRELLO_081_ACTIONS.filter(name=>/^(delete|archive)_/.test(name)))expect(resolveGovernedPieceAction('@activepieces/piece-trello',name)!.category).toBe('delete_data');
  for(const name of ['list_boards','get_card','search_cards'])expect(resolveGovernedPieceAction('@activepieces/piece-trello',name)!.category).toBe('read_data');
  expect(resolveGovernedPieceAction('@activepieces/piece-trello','add_comment_to_card')!.category).toBe('send_message');
  expect(resolveGovernedPieceAction('@activepieces/piece-trello','custom_api_call')).toMatchObject({category:'modify_settings',known:false});
});
