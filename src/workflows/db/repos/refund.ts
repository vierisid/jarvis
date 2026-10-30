import {getWorkflowDb} from '../index';
import {getFlowRun} from './flow-run';
import type {RefundState,RefundStore} from '../../runtime/refund';
/** Ended with no refund attempt: nothing can still be dispatched for it. */
const NO_EFFECT_ENDS=new Set(['rejected','expired','needs_review']);
const LIVE_RUN=new Set(['QUEUED','RUNNING','PAUSED']);
/** A request that never reached the pre-dispatch claim moved no money, so a newer run
 * (or changed ticket data) may start it again instead of the key staying consumed.
 * Once `attemptedAt` is recorded the request is at-most-once and never restarts. */
function restartable(state:RefundState,runId:string,changed:boolean){
  if(state.attemptedAt!==undefined||state.originRun===runId)return false;
  if(state.retiredRuns?.includes(runId))return false;
  if(changed||NO_EFFECT_ENDS.has(state.state))return true;
  // 'new'/'approval' belong to the origin run while it can still resume.
  const origin=getFlowRun(state.originRun);return !origin||!LIVE_RUN.has(origin.status);
}
/** `request` is the setup and ticket, `binding` the connection identity. Both replace an unattempted request. An attempted one
 * keeps its request data, but a reconnect only changes who reads it back: the caller is told and it can never POST again. */
export function acquireRefund(key:string,request:string,binding:string,owner:string,runId:string,clock:()=>number):{store:RefundStore;release():void;superseded?:RefundState;bindingChanged?:boolean}|{busyUntil:number}{
  const db=getWorkflowDb(),config=request+':'+binding;let superseded:RefundState|undefined,bindingChanged=false;const busy=db.transaction(()=>{
    const row=db.query('SELECT * FROM workflow_refund WHERE identity=?').get(key) as {config:string;lease_until:number;state:string}|null;
    if(row&&row.lease_until>clock())return {busyUntil:row.lease_until};
    if(row){
      const state=JSON.parse(row.state) as RefundState,changed=row.config!==config;
      if(state.retiredRuns?.includes(runId))throw Error('Refund request was superseded by a newer run; no refund sent');
      if(restartable(state,runId,changed)){
        superseded=state;
        db.run('DELETE FROM workflow_refund_payment WHERE request=?',[key]);
        db.run('UPDATE workflow_refund SET config=?,owner=?,lease_until=?,state=? WHERE identity=?',[config,owner,clock()+60_000,JSON.stringify({originRun:runId,state:'new',retiredRuns:[...(state.retiredRuns??[]),state.originRun]}),key]);
        return null;
      }
      if(changed&&(state.attemptedAt===undefined||!row.config.startsWith(request+':')))throw Error('Refund request changed; the original immutable request requires review');
      if(changed){bindingChanged=true;db.run('UPDATE workflow_refund SET config=? WHERE identity=?',[config,key]);}
    }
    if(!row)db.run('INSERT INTO workflow_refund(identity,config,owner,lease_until,state) VALUES(?,?,?,?,?)',[key,config,owner,clock()+60_000,JSON.stringify({originRun:runId,state:'new'})]);
    else db.run('UPDATE workflow_refund SET owner=?,lease_until=? WHERE identity=?',[owner,clock()+60_000,key]);return null;
  })();if(busy)return busy;
  const check=()=>{if(db.run('UPDATE workflow_refund SET lease_until=? WHERE identity=? AND owner=? AND lease_until>?',[clock()+60_000,key,owner,clock()]).changes!==1)throw Error('Refund ownership changed; dispatch stopped');};
  return {...(superseded?{superseded}:{}),...(bindingChanged?{bindingChanged}:{}),store:{check,load(){check();return JSON.parse((db.query('SELECT state FROM workflow_refund WHERE identity=?').get(key) as {state:string}).state);},save(state){check();db.run('UPDATE workflow_refund SET state=? WHERE identity=? AND owner=?',[JSON.stringify(state),key,owner]);}},release(){db.run('UPDATE workflow_refund SET lease_until=0 WHERE identity=? AND owner=?',[key,owner]);}};
}
export function reserveRefundPayment(payment:string,request:string){const db=getWorkflowDb();db.run('INSERT OR IGNORE INTO workflow_refund_payment(payment,request) VALUES(?,?)',[payment,request]);return (db.query('SELECT request FROM workflow_refund_payment WHERE payment=?').get(payment) as {request:string}).request===request;}
/** Only for a request that ended before its pre-dispatch claim. */
export function releaseRefundPayment(request:string){getWorkflowDb().run('DELETE FROM workflow_refund_payment WHERE request=?',[request]);}
