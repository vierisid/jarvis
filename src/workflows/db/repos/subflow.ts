import {getWorkflowDb} from '../index';
import {getFlowRun} from './flow-run';
import {getChildRun} from './child-run';
import {cancelFlowRun} from './run-cancellation';
import {markWaitpointResumed} from './waitpoint';
import {enqueue} from './job-queue';
import {completedChild,type ChildResult} from '../../runtime/subflow-contract';

export interface SubflowCall {id:string;fingerprint:string;child_run_id:string;effect_id:string;version_id:string;version_digest:string;deadline:number;schema_json:string;result_json:string|null}
export const getSubflowCall=(id:string)=>getWorkflowDb().query('SELECT * FROM workflow_subflow_call WHERE id=?').get(id) as SubflowCall|null;
/** A completion receipt survives child run/history removal. No missing evidence dispatches again. */
export function settleSubflow(id:string,now=Date.now()):ChildResult|null {
 const db=getWorkflowDb();return db.transaction(()=>{
  const call=getSubflowCall(id);if(!call)return null;if(call.result_json)return JSON.parse(call.result_json) as ChildResult;
  const run=getFlowRun(call.child_run_id),active=run&&['QUEUED','RUNNING','PAUSED'].includes(run.status);
  let result:ChildResult;
  // A completion that was recorded before the absolute deadline wins, even after daemon downtime.
  if(active&&now<call.deadline)return null;
  if(active||run?.finishTime!=null&&run.finishTime>=call.deadline){
   if(active)cancelFlowRun(run.id);
   result={status:'timeout',runId:call.child_run_id,code:'CHILD_DEADLINE_EXCEEDED'};
  }else{
   const returned=db.query('SELECT value FROM workflow_subflow_result WHERE run_id=?').get(call.child_run_id) as {value:string}|null;
   const uncertain=run?.finishTime==null||getChildRun(call.effect_id)?.outcome?.status==='unknown';
   result=completedChild(call.child_run_id,uncertain?'MISSING':run?.status??'MISSING',{present:!!returned,value:returned?JSON.parse(returned.value):undefined},JSON.parse(call.schema_json));
  }
  db.run('UPDATE workflow_subflow_call SET result_json=? WHERE id=?',[JSON.stringify(result),id]);return result;
 }).immediate();
}
export function resumeSubflowCalls(now=Date.now()):number {
 const db=getWorkflowDb();let count=0;
 for(const row of db.query('SELECT id FROM workflow_subflow_call WHERE result_json IS NULL').all() as {id:string}[])settleSubflow(row.id,now);
 for(const row of db.query(`SELECT w.call_id,w.parent_run_id,w.waitpoint_id FROM workflow_subflow_wait w JOIN workflow_subflow_call c ON c.id=w.call_id JOIN waitpoint p ON p.id=w.waitpoint_id WHERE c.result_json IS NOT NULL AND p.resumed_at IS NULL`).all() as {call_id:string;parent_run_id:string;waitpoint_id:string}[]){
  const resumed=db.transaction(()=>{
   if(getFlowRun(row.parent_run_id)?.status!=='PAUSED'||db.query("SELECT id FROM workflow_job WHERE flow_run_id=? AND status IN ('QUEUED','RUNNING','CANCELED') LIMIT 1").get(row.parent_run_id))return false;
   if(!markWaitpointResumed(row.waitpoint_id))return false;
   enqueue({jobType:'RUN_FLOW',flowRunId:row.parent_run_id,maxAttempts:1,payload:{runId:row.parent_run_id,executionType:'RESUME',resumePayload:{childCompleted:true}}});return true;
  }).immediate();if(resumed)count++;
 }
 return count;
}
