import {getWorkflowDb} from '../index';
import type {BatchInput,BatchProgress,BatchStore} from '../../runtime/lead-batch';
/** Submission receipts survive history cleanup and version changes. Same ID with
 * changed payload/setup is rejected; lease ownership fences every checkpoint. */
export function acquireBatch(identity:string,config:string,input:BatchInput,owner:string,now=Date.now):{store:BatchStore;release():void}|{busyUntil:number} {
 const db=getWorkflowDb(),leaseMs=45_000;
 const busy=db.transaction(()=>{
   const row=db.query('SELECT config,lease_until FROM workflow_lead_batch WHERE identity=?').get(identity) as {config:string;lease_until:number}|null;
   if(row&&row.config!==config)throw Error('Submission ID was reused with changed data, mapping or account; review the original batch');
   if(row&&row.lease_until>now())return row.lease_until;
   if(!row)db.run('INSERT INTO workflow_lead_batch(identity,config,owner,lease_until,progress) VALUES(?,?,?,?,?)',[identity,config,owner,now()+leaseMs,JSON.stringify({input,outcomes:{}})]);
   else db.run('UPDATE workflow_lead_batch SET owner=?,lease_until=? WHERE identity=?',[owner,now()+leaseMs,identity]);
   return null;
 })();
 if(busy!==null)return {busyUntil:busy};
 const check=()=>{if(db.run('UPDATE workflow_lead_batch SET lease_until=? WHERE identity=? AND owner=? AND lease_until>?',[now()+leaseMs,identity,owner,now()]).changes!==1)throw Error('Batch ownership expired; stop before further dispatch');};
 return {store:{check,load(){check();return JSON.parse((db.query('SELECT progress FROM workflow_lead_batch WHERE identity=?').get(identity) as {progress:string}).progress) as BatchProgress;},save(progress){db.transaction(()=>{check();db.run('UPDATE workflow_lead_batch SET progress=? WHERE identity=? AND owner=?',[JSON.stringify(progress),identity,owner]);})();}},release(){db.run('UPDATE workflow_lead_batch SET lease_until=0 WHERE identity=? AND owner=?',[identity,owner]);}};
}
