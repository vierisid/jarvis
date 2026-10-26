/** Fetch-only managed adapter: no SDK retries or credential-bearing URLs. */
export const MANAGED_TRELLO_ACTIONS = ['list_boards','list_lists','get_card','create_card','move_card'] as const;
export function managedTrelloInput(input: unknown): Record<string,unknown> | null {
  return (input as {auth?:{jarvis_managed?:unknown}} | null)?.auth?.jarvis_managed === 'trello' ? input as Record<string,unknown> : null;
}
export function managedTrelloIssue(action: unknown, input: Record<string,unknown>, resolved = true): string | null {
  if (!(MANAGED_TRELLO_ACTIONS as readonly unknown[]).includes(action)) return 'This hosted Trello connection supports List Boards, List Lists, Get Card, Create Card and Move Card. Triggers are not enabled.';
  const dynamic = (v: unknown) => !resolved && typeof v === 'string' && v.includes('{{');
  const ids = action === 'create_card' ? ['board_id','list_id'] : action === 'move_card' ? ['card_id','list_id'] : action === 'get_card' ? ['cardId'] : action === 'list_lists' ? ['board_id'] : [];
  for (const key of ids) if (!dynamic(input[key]) && (typeof input[key] !== 'string' || !/^[a-f0-9]{24}$/.test(input[key] as string))) return 'Choose a valid Trello ' + key.replaceAll('_',' ') + ' or a workflow variable.';
  if (action === 'list_boards' && input.member_id && input.member_id !== 'me') return 'This connection lists the connected account’s boards. Leave Member ID empty.';
  if (input.filter && !dynamic(input.filter) && !['open','closed','all'].includes(String(input.filter))) return 'Choose Open, Closed or All.';
  if (action === 'create_card') {
    if (!dynamic(input.name) && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 16384)) return 'Enter a card name (up to 16,384 characters).';
    if (input.description != null && (typeof input.description !== 'string' || input.description.length > 16384)) return 'The card description must be text, up to 16,384 characters.';
    if (input.position && !dynamic(input.position) && !['top','bottom'].includes(String(input.position))) return 'Choose Top or Bottom for the card position.';
    if (input.labels && (!Array.isArray(input.labels) || input.labels.length)) return 'Labels are not supported by this first Trello release.';
  }
  return null;
}
export async function trelloJson(path: string, auth: {username:string;password:string}, init: RequestInit = {}, request: typeof fetch = fetch): Promise<unknown> {
  let response:Response;
  try {response=await request('https://api.trello.com/1/'+path,{...init,redirect:'error',signal:AbortSignal.timeout(15000),headers:{
    'Content-Type':'application/json',Authorization:`OAuth oauth_consumer_key="${encodeURIComponent(auth.username)}", oauth_token="${encodeURIComponent(auth.password)}"`,
  }});} catch {throw new Error('Trello request outcome is unknown. Check the board before trying again.');}
  if(response.status===401 || response.status===403)throw new Error('Trello refused access. Check board permissions or reconnect Trello.');
  if(response.status===429)throw new Error('Trello is rate limiting requests. Wait before trying again.');
  if(!response.ok)throw new Error('Trello did not confirm the request. Check the board before trying again.');
  try {
    const reader=response.body?.getReader();if(!reader)throw new Error('empty');
    const chunks:Uint8Array[]=[];let size=0;
    try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw new Error('large');chunks.push(value);}}
    finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {throw new Error('Trello returned an invalid response. Check the board before trying again.');}
}
function record(value:unknown):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Trello returned an invalid object. Check the board.');
  const raw=value as Record<string,unknown>;
  if(typeof raw.id!=='string' || !/^[a-f0-9]{24}$/.test(raw.id) || typeof raw.name!=='string')throw new Error('Trello returned an invalid object. Check the board.');
  const out:Record<string,unknown>={id:raw.id,name:raw.name};
  for(const key of ['desc','idBoard','idList','idOrganization','closed','pos','due','dueComplete','dateLastActivity']) {
    const v=raw[key];if(v===null || typeof v==='string' || typeof v==='boolean' || typeof v==='number')out[key]=v;
  }
  for(const key of ['url','shortUrl'])if(typeof raw[key]==='string' && /^https:\/\/trello\.com\/[bc]\/[a-zA-Z0-9]+(?:\/[^?#]*)?$/.test(raw[key]))out[key]=raw[key];
  return out;
}
export async function runManagedTrelloAction(action:string,input:Record<string,unknown>,request:typeof fetch=fetch):Promise<unknown> {
  const issue=managedTrelloIssue(action,input);if(issue)throw new Error(issue);
  const auth=input.auth as {username?:unknown;password?:unknown};
  if(typeof auth?.username!=='string' || typeof auth.password!=='string' || !auth.username || !auth.password)throw new Error('Reconnect Trello.');
  const credentials={username:auth.username,password:auth.password};
  if(action==='list_boards' || action==='list_lists') {
    const kind=action==='list_boards'?'boards':'lists',path=kind==='boards'?'members/me/boards':`boards/${input.board_id}/lists`;
    const raw=await trelloJson(path+'?filter='+encodeURIComponent(String(input.filter || 'open')),credentials,{},request);
    if(!Array.isArray(raw) || raw.length>10000)throw new Error('Trello returned an invalid list.');
    const items=raw.map(record);return {[kind]:items,count:items.length};
  }
  if(action==='get_card')return record(await trelloJson(`cards/${input.cardId}`,credentials,{},request));
  if(action==='create_card') {
    const list=await trelloJson(`lists/${input.list_id}?fields=idBoard,closed`,credentials,{},request) as {idBoard?:unknown;closed?:unknown};
    if(list?.idBoard!==input.board_id || list.closed!==false)throw new Error('The selected list no longer belongs to this board or is archived. Choose it again.');
  }
  const path=action==='create_card'?'cards':`cards/${input.card_id}/idList`;
  const body=action==='create_card'?{idList:input.list_id,name:input.name,desc:input.description ?? '',pos:input.position || 'bottom'}:{value:input.list_id};
  const result=record(await trelloJson(path,credentials,{method:action==='create_card'?'POST':'PUT',body:JSON.stringify(body)},request));
  if(result.idList!==input.list_id || (action==='move_card' && result.id!==input.card_id))throw new Error('Trello did not confirm the card’s destination. Check the board before trying again.');
  return result;
}
