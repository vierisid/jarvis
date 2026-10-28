import {parseOutputSchema,validateOutput} from './llm-output-contract';

export const SUBFLOW_PIECE='@jarvispieces/piece-jarvis-subflow';
export const MAX_CHILD_RESULT_BYTES=32_768;
export type ChildResult={status:'succeeded'|'failed'|'invalid_output'|'timeout'|'uncertain';runId:string;output?:unknown;code?:string};
export function boundedJson(value:unknown):string {
 const text=JSON.stringify(value);
 if(text===undefined||new TextEncoder().encode(text).length>MAX_CHILD_RESULT_BYTES)throw Error('Child payload/result must be JSON, at most 32 KiB');
 return text;
}
export function childCallInput(input:Record<string,unknown>){
 if(typeof input.flow!=='string'||!input.flow.trim())throw Error('Select the reusable child workflow');
 if(typeof input.invocationKey!=='string'||!input.invocationKey.trim()||input.invocationKey.length>256)throw Error('Configure a stable invocation key (1-256 characters) from the request identity');
 if(!input.payload||typeof input.payload!=='object'||Array.isArray(input.payload))throw Error('Child payload must be a JSON object');
 boundedJson(input.payload);
 if(!Number.isInteger(input.timeoutSeconds)||Number(input.timeoutSeconds)<1||Number(input.timeoutSeconds)>86400)throw Error('Child timeout must be 1-86400 seconds');
 const outputSchema=parseOutputSchema(input.outputSchema);
 return {flow:input.flow.trim(),invocationKey:input.invocationKey.trim(),payload:input.payload,outputSchema,timeoutSeconds:Number(input.timeoutSeconds)};
}
export function completedChild(runId:string,status:string,result:{present:boolean;value?:unknown},schema:unknown):ChildResult {
 if(status==='MISSING'||status==='STOPPED'||status==='INTERNAL_ERROR')return {status:'uncertain',runId,code:'CHILD_OUTCOME_UNCERTAIN'};
 if(status!=='SUCCEEDED')return {status:'failed',runId,code:'CHILD_FAILED'};
 if(!result.present)return {status:'invalid_output',runId,code:'CHILD_RESULT_MISSING'};
 try {boundedJson(result.value);if(validateOutput(result.value,parseOutputSchema(schema)).length)throw Error('schema mismatch');}
 catch {return {status:'invalid_output',runId,code:'CHILD_RESULT_INVALID'};}
 return {status:'succeeded',runId,output:result.value};
}
export function requireChildSuccess(value:unknown){
 const result=value as ChildResult;
 if(!result||result.status!=='succeeded'||!('output'in result))throw Error('Reusable child did not succeed: '+(result?.status??'invalid result')+' ('+(result?.code??'CHILD_RESULT_INVALID')+')');
 return result.output;
}
export const CUSTOMER_SCHEMA={type:'object',additionalProperties:false,required:['valid','customer','issues'],properties:{valid:{type:'boolean'},customer:{type:'object',additionalProperties:false,required:['id','name','email'],properties:{id:{type:'string'},name:{type:'string'},email:{type:'string'}}},issues:{type:'array',items:{type:'string'}}}};
function field(payload:unknown,path:unknown):unknown {
 if(typeof path!=='string'||!path.trim()||!path.split('.').every(p=>/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p)&&!['__proto__','prototype','constructor'].includes(p)))throw Error('Configure customer field paths before running');
 return path.split('.').reduce<unknown>((v,k)=>v&&typeof v==='object'&&Object.hasOwn(v,k)?(v as any)[k]:undefined,payload);
}
export function normalizeCustomer(input:Record<string,unknown>){
 const customer={id:'',name:'',email:''},issues:string[]=[];
 for(const key of ['id','name','email'] as const){const value=field(input.customer,input[key+'Path']);if(typeof value!=='string'||!value.trim())issues.push(key+' is required');else customer[key]=value.trim();}
 customer.email=customer.email.toLowerCase();
 if(customer.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email))issues.push('email is invalid');
 return {valid:issues.length===0,customer,issues};
}
