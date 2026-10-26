import {expect,test} from 'bun:test';
import {managedSlackIssue,sendManagedSlackMessage} from './managed-slack';
import {authorizePieceDispatch,executeAuthorizedPiece} from './piece-effect-guard';
import {compileWorkflow} from './workflow-readiness';
const input={auth:{access_token:'SECRET',data:{jarvis_managed:'slack'}},channel:'C123',text:'Hello',threadTs:'1710304378.475129'};
test('bot contract refuses unsupported actions, destinations, identity and invalid threads',()=>{
 for(const [action,fields] of [['slack_get_channel_history',{}],['slack_post_message',{channel:'D123'}],['slack_post_message',{sendAsUser:true}],['send_channel_message',{sendAsBot:false}],['slack_post_message',{file:'https://example.test'}],['slack_post_message',{threadTs:'bad'}]] as const) expect(managedSlackIssue(action,{...input,...fields})).not.toBeNull();
 expect(managedSlackIssue('slack_post_message',input)).toBeNull();
});
test('a provider error or lost response produces one attempt and no private error body',async()=>{
 for(const failure of ['network','rate','rejected']) {
  let calls=0;
  const request=(async()=>{calls++;if(failure==='network')throw Error('lost response');return Response.json({ok:false,error:'PRIVATE_UPSTREAM'}, {status:failure==='rate'?429:200});}) as unknown as typeof fetch;
  try {await sendManagedSlackMessage(input,request);throw Error('expected failure');}
  catch(e) {expect(String(e)).not.toContain('PRIVATE_UPSTREAM');}
  expect(calls).toBe(1);
 }
});
test('send binds channel, parent timestamp and bot credential, and returns only message receipt',async()=>{
 const request=(async(url: string|URL|Request,init?:RequestInit)=>{
  expect(url).toBe('https://slack.com/api/chat.postMessage');expect(init?.redirect).toBe('error');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer SECRET');
  expect(JSON.parse(String(init?.body))).toMatchObject({channel:'C123',thread_ts:input.threadTs,text:'Hello'});
  return Response.json({ok:true,channel:'C123',ts:'1710304378.123456',message:{text:'Hello'},private:'SECRET'});
 }) as unknown as typeof fetch;
 expect(await sendManagedSlackMessage(input,request)).toEqual({ok:true,channel:'C123',ts:'1710304378.123456',message:{text:'Hello'}});
});
test('unsupported managed actions fail before authorization or provider dispatch',async()=>{
 const params={apiUrl:'http://unused',engineToken:'test',piece:'@activepieces/piece-slack',action:'custom_api_call',stepName:'send',executionPath:[],input,fetchImpl:(async()=>{throw Error('must not reach authorization');}) as unknown as typeof fetch};
 await expect(authorizePieceDispatch(params)).rejects.toThrow('supports Find Channel');
 await expect(executeAuthorizedPiece(params,{governed:true,dispatch:'approval_required',approval:{effectId:'e',approvalId:'a',waitpointId:'w'}},async()=>{throw Error('must not execute');})).rejects.toThrow('waiting for authorization');
});
test('readiness refuses managed Slack triggers and unsupported actions before activation',()=>{
 const trigger={name:'trigger',type:'PIECE',settings:{pieceName:'@activepieces/piece-slack',triggerName:'new_message',input:{auth:'{{connections.jarvis:slack}}'}}};
 expect(JSON.stringify(compileWorkflow(trigger))).toContain('MANAGED_SLACK');
});
test('managed channel reads redact SDK transport details and completed sends never dispatch twice',async()=>{
 const params={apiUrl:'http://unused',engineToken:'test',piece:'@activepieces/piece-slack',action:'slack_get_channel_info',stepName:'info',executionPath:[],input};
 const execute=async()=>{throw Error('SDK request Authorization Bearer SECRET');};
 await expect(executeAuthorizedPiece(params,{governed:true,dispatch:'authorized'},execute)).rejects.toThrow('Could not read Slack channel details');
 await expect(executeAuthorizedPiece(params,{governed:false},execute)).rejects.toThrow('not authorized');
 expect(await executeAuthorizedPiece({...params,action:'slack_post_message'}, {governed:true,dispatch:'completed',result:{ok:true,ts:'1710304378.123456'}},execute)).toEqual({ok:true,ts:'1710304378.123456'});
});
