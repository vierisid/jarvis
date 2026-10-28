import {SUBFLOW_PIECE,childCallInput,normalizeCustomer,completedChild,requireChildSuccess,type ChildResult} from './subflow-contract';
import {evaluateWorkflowExpression} from './safe-expression';
import {digest} from './effect-context';
function assert(ok:unknown,message:string):asserts ok {if(!ok)throw Error('Parent/child fixture: '+message);}
const resolve=(value:unknown,scope:Record<string,unknown>):unknown=>typeof value==='string'&&value.startsWith('{{')&&value.endsWith('}}')?evaluateWorkflowExpression(value.slice(2,-2),scope):value;
export function configuredSubflowGraphs(parent:any,child:any){
 const p=structuredClone(parent),c=structuredClone(child),call=p?.nextAction,consume=call?.nextAction,normalize=c?.nextAction,returned=normalize?.nextAction;
 assert(p?.type==='PIECE_TRIGGER'&&p.settings?.pieceName==='webhook'&&Object.values(p.settings.input??{}).every(v=>v===''||v==null),'parent requires a plain webhook without competing admission');
 assert(c?.type==='EMPTY'||c?.type==='PIECE_TRIGGER'&&c.settings?.pieceName==='manual','child requires a manual trigger');
 for(const [node,action]of [[call,'call'],[consume,'require_success'],[normalize,'normalize_customer'],[returned,'return_result']])assert(node?.type==='PIECE'&&node.settings?.pieceName===SUBFLOW_PIECE&&node.settings.actionName===action&&!node.settings.errorHandlingOptions?.continueOnFailure?.value&&!node.settings.errorHandlingOptions?.retryOnFailure?.value,'unsupported graph action or swallowed failure');
 assert(!consume.nextAction&&!returned.nextAction,'additional graph behavior is not covered');
 assert(call.settings.input.payload==='{{trigger}}'&&normalize.settings.input.customer==='{{trigger}}','whole customer payload must reach the child');
 assert(consume.settings.input.result==='{{'+call.name+'}}'&&returned.settings.input.result==='{{'+normalize.name+'}}','parent must consume child output and child must return normalization result');
 for(const[key,value]of Object.entries({idPath:'id',namePath:'name',emailPath:'email'}))if(normalize.settings.input[key]===''||normalize.settings.input[key]==null)normalize.settings.input[key]=value;
 if(call.settings.input.invocationKey===''||call.settings.input.invocationKey==null)call.settings.input.invocationKey='{{trigger.request_id}}';
 return {parent:p,child:c};
}
export async function validateSubflowFixtures(parent:any,child:any){
 const graphs=configuredSubflowGraphs(parent,child),call=graphs.parent.nextAction,consume=call.nextAction,normal=graphs.child.nextAction,returned=normal.nextAction;
 const payload:any={request_id:'fixture-request'};
 const put=(path:string,value:string)=>{let at=payload;const parts=path.split('.');for(const p of parts.slice(0,-1))at=at[p]??={};at[parts.at(-1)!]=value;};
 put(normal.settings.input.idPath,'  customer-1  ');put(normal.settings.input.namePath,'  Fixture Customer  ');put(normal.settings.input.emailPath,'  CUSTOMER@EXAMPLE.INVALID  ');
 const input=Object.fromEntries(Object.entries(call.settings.input).map(([k,v])=>[k,resolve(v,{trigger:payload})]));childCallInput(input);
 const cases=[];
 for(const scenario of ['successful structured output','invalid child output','child failure','timeout','parent restart after child completion']){
  let executions=0;const execute=()=>{executions++;const normalized=normalizeCustomer({...normal.settings.input,customer:resolve(normal.settings.input.customer,{trigger:payload})});return resolve(returned.settings.input.result,{[normal.name]:normalized});};
  let receipt:ChildResult;
  if(scenario==='timeout')receipt={status:'timeout',runId:'fixture-child',code:'CHILD_DEADLINE_EXCEEDED'};
  else receipt=completedChild('fixture-child',scenario==='child failure'?'FAILED':'SUCCEEDED',{present:true,value:scenario==='invalid child output'?{unexpected:true}:execute()},input.outputSchema);
  if(scenario==='parent restart after child completion'){receipt=JSON.parse(JSON.stringify(receipt));assert(executions===1,'completed receipt reused after simulated restart');}
  let output:unknown,parentStatus='SUCCEEDED';try{output=requireChildSuccess(resolve(consume.settings.input.result,{[call.name]:receipt}));}catch{parentStatus='FAILED';}
  const success=scenario==='successful structured output'||scenario==='parent restart after child completion';assert(parentStatus===(success?'SUCCEEDED':'FAILED'),'truthful parent outcome');
  if(success)assert((output as any)?.customer?.email==='customer@example.invalid'&&(output as any)?.customer?.id==='customer-1'&&(output as any)?.valid===true,'consume normalized structured output');
  cases.push({name:scenario,passed:true,childStatus:receipt.status,parentStatus,childExecutions:executions});
 }
 return {passed:true,parentDefinitionDigest:digest(parent),childDefinitionDigest:digest(child),cases,externalActions:0,scope:'Component-only fixtures over both actual saved graphs: normalization, expressions, output schema, explicit failure handling and serialized synthetic completion receipts. Timeout/child failure are injected outcomes. Does not exercise durable SQLite, real child dispatch, worker restart, timers, Authority or external services; repository integration tests cover those separately.',configuration:'Missing setup substituted in memory only; neither saved graph modified, activated or executed'};
}
