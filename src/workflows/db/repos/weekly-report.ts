import {getWorkflowDb} from '../index';
import type {ReceiptRow,ReportReceipt} from '../../runtime/weekly-report';
type Row={state:string;result:string|null;document_id:string|null};
const row=(identity:string)=>getWorkflowDb().query('SELECT state,result,document_id FROM workflow_weekly_report WHERE identity=?').get(identity) as Row|null;
const view=(r:Row|null):ReceiptRow=>!r?{state:'none'}:r.state==='complete'?{state:'complete',result:JSON.parse(r.result!)}:{state:'pending',...r.document_id?{documentId:r.document_id}:{}};
/** No expiring lease: a lost create reply cannot cause another report document. */
export function reportReceipt(owner:string):ReportReceipt {
  return {
    peek(identity){return view(row(identity));},
    claim(identity){return getWorkflowDb().transaction(()=>{
      const existing=row(identity);
      if(existing){const v=view(existing);return v.state==='complete'?{state:'complete' as const,result:v.result}:{state:'pending' as const,documentId:v.documentId};}
      getWorkflowDb().run('INSERT INTO workflow_weekly_report(identity,owner,state,created) VALUES(?,?,?,?)',[identity,owner,'pending',Date.now()]);return {state:'new' as const};
    })();},
    created(identity,id){if(getWorkflowDb().run("UPDATE workflow_weekly_report SET document_id=? WHERE identity=? AND owner=? AND state='pending'",[id,identity,owner]).changes!==1)throw Error('Report receipt ownership changed');},
    adopt(identity,id){if(getWorkflowDb().run("UPDATE workflow_weekly_report SET document_id=?,owner=? WHERE identity=? AND state='pending' AND document_id IS NULL",[id,owner,identity]).changes!==1)throw Error('Report receipt changed while recovering its document');},
    release(identity){getWorkflowDb().run("DELETE FROM workflow_weekly_report WHERE identity=? AND owner=? AND state='pending' AND document_id IS NULL",[identity,owner]);},
    finish(identity,result){if(getWorkflowDb().run("UPDATE workflow_weekly_report SET state='complete',result=? WHERE identity=? AND owner=? AND state='pending'",[JSON.stringify(result),identity,owner]).changes!==1)throw Error('Report receipt ownership changed');},
  };
}
