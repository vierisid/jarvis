import {expect,test} from 'bun:test';
import {managedTrelloIssue,runManagedTrelloAction} from './managed-trello';
import {authorizePieceDispatch,executeAuthorizedPiece} from './piece-effect-guard';
import {compileWorkflow} from './workflow-readiness';
const board='a'.repeat(24),list='b'.repeat(24),card='c'.repeat(24);
const input={auth:{username:'PUBLIC',password:'SECRET',jarvis_managed:'trello'},board_id:board,list_id:list,card_id:card,name:'Task'};
test('qualified contract rejects triggers, custom API, archive, bad IDs and unsupported labels',()=>{
  for(const action of ['new_card','custom_api_call','delete_card','update_card'])expect(managedTrelloIssue(action,input)).not.toBeNull();
  expect(managedTrelloIssue('create_card',{...input,labels:['label']})).not.toBeNull();
  expect(managedTrelloIssue('move_card',{...input,list_id:'../evil'})).not.toBeNull();
  expect(managedTrelloIssue('create_card',input)).toBeNull();
  expect(managedTrelloIssue('move_card',{...input,list_id:'{{find.lists[0].id}}'},false)).toBeNull();
});
test('move failures make exactly one attempt and redact provider/network bodies',async()=>{
  for(const failure of ['network','429','401','500','json','large','stream']) {
    let calls=0;
    const request=(async()=>{calls++;if(failure==='network')throw Error('PRIVATE');
      if(failure==='large')return new Response('x'.repeat(1048577));
      if(failure==='stream')return new Response(new ReadableStream({start(c){c.error(Error('PRIVATE'));}}));
      return new Response('PRIVATE',{status:Number(failure)||200});}) as unknown as typeof fetch;
    try {await runManagedTrelloAction('move_card',input,request);throw Error('expected failure');}
    catch(e){expect(String(e)).toContain('Trello');expect(String(e)).not.toContain('PRIVATE');}
    expect(calls).toBe(1);
  }
});
test('create verifies board/list membership and never retries the write',async()=>{
  const requests:string[]=[];
  const request=(async(url:string|URL|Request,init?:RequestInit)=>{requests.push(String(url));expect(String(url)).not.toContain('SECRET');expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toContain('oauth_token="SECRET"');
    if(String(url).includes('/lists/'))return Response.json({idBoard:board,closed:false});
    expect(JSON.parse(String(init?.body))).toEqual({idList:list,name:'Task',desc:'',pos:'bottom'});
    return Response.json({id:card,name:'Task',idBoard:board,idList:list,private:'SECRET'});
  }) as unknown as typeof fetch;
  expect(await runManagedTrelloAction('create_card',input,request)).toEqual({id:card,name:'Task',idBoard:board,idList:list});expect(requests).toHaveLength(2);
  let calls=0;
  await expect(runManagedTrelloAction('create_card',input,(async()=>{calls++;return Response.json({idBoard:'other',closed:false});}) as unknown as typeof fetch)).rejects.toThrow('no longer belongs');
  expect(calls).toBe(1);
});
test('unsupported managed actions fail before authority; reads cannot bypass authorization and receipts prevent repeat writes',async()=>{
  const params={apiUrl:'http://unused',engineToken:'test',piece:'@activepieces/piece-trello',action:'custom_api_call',stepName:'step',executionPath:[],input,fetchImpl:(async()=>{throw Error('must not call');}) as unknown as typeof fetch};
  await expect(authorizePieceDispatch(params)).rejects.toThrow('supports List Boards');
  await expect(executeAuthorizedPiece({...params,action:'list_boards'},{governed:false},async()=>{})).rejects.toThrow('not authorized');
  expect(await executeAuthorizedPiece({...params,action:'create_card'},{governed:true,dispatch:'completed',result:{id:card}},async()=>{throw Error('must not execute');})).toEqual({id:card});
});
test('authority digest binds the Trello key and token without disclosing them',async()=>{
  let sent:any;
  const params={apiUrl:'http://unused',engineToken:'test',piece:'@activepieces/piece-trello',action:'create_card',stepName:'step',executionPath:[],input,
    fetchImpl:(async(_url:string|URL|Request,init?:RequestInit)=>{sent=JSON.parse(String(init?.body));return Response.json({governed:true,dispatch:'authorized',effectId:'effect'});}) as unknown as typeof fetch};
  await authorizePieceDispatch(params);const first=sent.credentialDigest;
  expect(first).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(sent)).not.toContain('SECRET');
  await authorizePieceDispatch({...params,input:{...input,auth:{...input.auth,password:'replacement'}}});expect(sent.credentialDigest).not.toBe(first);
});
test('readiness rejects managed triggers before activation',()=>{
  expect(JSON.stringify(compileWorkflow({name:'trigger',type:'PIECE',settings:{pieceName:'@activepieces/piece-trello',triggerName:'new_card',input:{auth:'{{connections.jarvis:trello}}'}}}))).toContain('MANAGED_TRELLO');
});
