import {getWorkflowDb} from '../index';
import type {ReportReceipt} from '../../runtime/weekly-report';
/** No expiring lease: a lost create reply cannot cause another report document. */
export function reportReceipt(owner:string):ReportReceipt {
  return {
    claim(identity){return getWorkflowDb().transaction(()=>{
      const row=getWorkflowDb().query('SELECT state,result FROM workflow_weekly_report WHERE identity=?').get(identity) as {state:string;result:string}|null;
      if(row)return row.state==='complete'?{state:'complete' as const,result:JSON.parse(row.result)}:{state:'pending' as const};
      getWorkflowDb().run('INSERT INTO workflow_weekly_report(identity,owner,state,created) VALUES(?,?,?,?)',[identity,owner,'pending',Date.now()]);return {state:'new' as const};
    })();},
    created(identity,id){if(getWorkflowDb().run("UPDATE workflow_weekly_report SET document_id=? WHERE identity=? AND owner=? AND state='pending'",[id,identity,owner]).changes!==1)throw Error('Report receipt ownership changed');},
    finish(identity,result){if(getWorkflowDb().run("UPDATE workflow_weekly_report SET state='complete',result=? WHERE identity=? AND owner=? AND state='pending'",[JSON.stringify(result),identity,owner]).changes!==1)throw Error('Report receipt ownership changed');},
  };
}
