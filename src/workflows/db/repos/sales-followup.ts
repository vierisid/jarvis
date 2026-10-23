import { getWorkflowDb } from '../index';
import type { SalesLedger, SalesResult } from '../../runtime/sales-followups';

/** No expiry or cascading run deletion: an uncertain draft must not be blindly repeated. */
export function salesLedger(owner: string): SalesLedger {
  return {
    claim(identity) {
      return getWorkflowDb().transaction(()=>{
        const row=getWorkflowDb().query('SELECT state FROM workflow_sales_followup WHERE identity=?').get(identity) as {state:string}|null;
        if(row)return ['claimed','unknown'].includes(row.state)?'unresolved':'completed';
        getWorkflowDb().run('INSERT INTO workflow_sales_followup(identity,owner,state,created) VALUES(?,?,?,?)',[identity,owner,'claimed',Date.now()]);
        return 'claimed';
      })();
    },
    finish(identity,result: SalesResult) {
      if(getWorkflowDb().run("UPDATE workflow_sales_followup SET state=?,result=? WHERE identity=? AND owner=? AND state='claimed'",
        [result.status,JSON.stringify(result),identity,owner]).changes!==1)throw Error('Daily draft claim ownership changed');
    },
  };
}
