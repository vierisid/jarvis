import {getWorkflowDb} from '../index';
import type {RefundState,RefundStore} from '../../runtime/refund';
export function acquireRefund(key:string,config:string,owner:string,runId:string,clock:()=>number):{store:RefundStore;release():void}|{busyUntil:number}{
  const db=getWorkflowDb();const busy=db.transaction(()=>{
    const row=db.query('SELECT * FROM workflow_refund WHERE identity=?').get(key) as {config:string;lease_until:number}|null;
    if(row&&row.config!==config)throw Error('Refund request changed; the original immutable request requires review');
    if(row&&row.lease_until>clock())return {busyUntil:row.lease_until};
    if(!row)db.run('INSERT INTO workflow_refund(identity,config,owner,lease_until,state) VALUES(?,?,?,?,?)',[key,config,owner,clock()+60_000,JSON.stringify({originRun:runId,state:'new'})]);
    else db.run('UPDATE workflow_refund SET owner=?,lease_until=? WHERE identity=?',[owner,clock()+60_000,key]);return null;
  })();if(busy)return busy;
  const check=()=>{if(db.run('UPDATE workflow_refund SET lease_until=? WHERE identity=? AND owner=? AND lease_until>?',[clock()+60_000,key,owner,clock()]).changes!==1)throw Error('Refund ownership changed; dispatch stopped');};
  return {store:{check,load(){check();return JSON.parse((db.query('SELECT state FROM workflow_refund WHERE identity=?').get(key) as {state:string}).state);},save(state){check();db.run('UPDATE workflow_refund SET state=? WHERE identity=? AND owner=?',[JSON.stringify(state),key,owner]);}},release(){db.run('UPDATE workflow_refund SET lease_until=0 WHERE identity=? AND owner=?',[key,owner]);}};
}
export function reserveRefundPayment(payment:string,request:string){const db=getWorkflowDb();db.run('INSERT OR IGNORE INTO workflow_refund_payment(payment,request) VALUES(?,?)',[payment,request]);return (db.query('SELECT request FROM workflow_refund_payment WHERE payment=?').get(payment) as {request:string}).request===request;}
