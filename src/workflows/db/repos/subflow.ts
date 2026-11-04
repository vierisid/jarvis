import {getWorkflowDb} from '../index';
import {getFlowRun} from './flow-run';
import {getChildRun} from './child-run';
import {cancelFlowRun} from './run-cancellation';
import {getWaitpoint} from './waitpoint';
import {stopTurnedOffRun,turnedOffReason} from './flow-turn-off';
import {claimContinuation} from '../../runtime/continuation';
import {completedChild,type ChildResult} from '../../runtime/subflow-contract';

export interface SubflowCall {id:string;fingerprint:string;child_run_id:string;effect_id:string;version_id:string;version_digest:string;deadline:number;schema_json:string;result_json:string|null}
export const getSubflowCall=(id:string)=>getWorkflowDb().query('SELECT * FROM workflow_subflow_call WHERE id=?').get(id) as SubflowCall|null;
/** A completion receipt survives child run/history removal. No missing evidence dispatches again.
 * `onCardClosed` hears each approval card a deadline stop closed, so the dashboard stops offering it (#1039). */
export function settleSubflow(id:string,now=Date.now(),onCardClosed?:(approvalId:string)=>void):ChildResult|null {
 const db=getWorkflowDb(),closed:string[]=[];
 const settled=db.transaction(()=>{
  const call=getSubflowCall(id);if(!call)return null;if(call.result_json)return JSON.parse(call.result_json) as ChildResult;
  const run=getFlowRun(call.child_run_id),active=run&&['QUEUED','RUNNING','PAUSED'].includes(run.status);
  let result:ChildResult;
  // A completion that was recorded before the absolute deadline wins, even after daemon downtime.
  if(active&&now<call.deadline)return null;
  if(active||run?.finishTime!=null&&run.finishTime>=call.deadline){
   if(active)closed.push(...cancelFlowRun(run.id).closedApprovalIds);
   result={status:'timeout',runId:call.child_run_id,code:'CHILD_DEADLINE_EXCEEDED'};
  }else{
   const returned=db.query('SELECT value FROM workflow_subflow_result WHERE run_id=?').get(call.child_run_id) as {value:string}|null;
   const uncertain=run?.finishTime==null||getChildRun(call.effect_id)?.outcome?.status==='unknown';
   result=completedChild(call.child_run_id,uncertain?'MISSING':run?.status??'MISSING',{present:!!returned,value:returned?JSON.parse(returned.value):undefined},JSON.parse(call.schema_json));
  }
  db.run('UPDATE workflow_subflow_call SET result_json=? WHERE id=?',[JSON.stringify(result),id]);return result;
 }).immediate();
 for(const approvalId of closed){try{onCardClosed?.(approvalId);}catch(error){console.error('[Workflow Authority] closed card update failed:',error);}}
 return settled;
}
/** Settled calls continue their waiting parents through `claimContinuation`, like every other continuation (Q-06, Q-08). */
export function resumeSubflowCalls(now=Date.now(),onCardClosed?:(approvalId:string)=>void):number {
 const db=getWorkflowDb();let count=0;
 for(const row of db.query('SELECT id FROM workflow_subflow_call WHERE result_json IS NULL').all() as {id:string}[])settleSubflow(row.id,now,onCardClosed);
 for(const row of db.query(`SELECT w.call_id,w.parent_run_id,w.waitpoint_id FROM workflow_subflow_wait w JOIN workflow_subflow_call c ON c.id=w.call_id JOIN waitpoint p ON p.id=w.waitpoint_id WHERE c.result_json IS NOT NULL AND p.resumed_at IS NULL`).all() as {call_id:string;parent_run_id:string;waitpoint_id:string}[]){
  const parent=getFlowRun(row.parent_run_id);
  if(parent?.status!=='PAUSED')continue;
  // A workflow turned off since this run began is stopped, not continued (Q-06).
  if(turnedOffReason(parent.id)){stopTurnedOffRun(parent.flowId,parent.id);continue;}
  if(db.query("SELECT id FROM workflow_job WHERE flow_run_id=? AND status IN ('QUEUED','RUNNING','CANCELED') LIMIT 1").get(parent.id))continue;
  const waitpoint=getWaitpoint(row.waitpoint_id);if(!waitpoint)continue;
  if(claimContinuation({runId:parent.id,waitpoint,kind:'child',resumePayload:{childCompleted:true},now})==='resumed')count++;
 }
 return count;
}
