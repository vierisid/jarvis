import {getWorkflowDb} from '../index';
import {initialImportProgress,type ImportProgress,type ImportStore} from '../../runtime/contact-import';
export function acquireImport(key:string,config:string,owner:string,clock:()=>number):{store:ImportStore;release:()=>void}|{busyUntil:number}{
  const db=getWorkflowDb();
  const acquired=db.transaction(()=>{
    const row=db.query('SELECT config,owner,lease_until FROM workflow_contact_import WHERE identity=?').get(key) as {config:string;owner:string;lease_until:number}|null;
    if(row&&row.config!==config)throw Error('Import configuration changed. Restore it to resume, or choose a new import ID for a different import.');
    if(row&&row.lease_until>clock())return {busyUntil:row.lease_until};
    if(!row)db.run('INSERT INTO workflow_contact_import(identity,config,owner,lease_until,progress) VALUES(?,?,?,?,?)',[key,config,owner,clock()+45_000,JSON.stringify(initialImportProgress())]);
    else db.run('UPDATE workflow_contact_import SET owner=?,lease_until=? WHERE identity=?',[owner,clock()+45_000,key]);
    return null;
  })();
  if(acquired)return acquired;
  const check=()=>{if(db.run('UPDATE workflow_contact_import SET lease_until=? WHERE identity=? AND owner=? AND lease_until>?',[clock()+45_000,key,owner,clock()]).changes!==1)throw Error('Import ownership changed; stopped before further dispatch');};
  const save=(p:ImportProgress)=>{check();db.run('UPDATE workflow_contact_import SET progress=? WHERE identity=? AND owner=?',[JSON.stringify(p),key,owner]);};
  return {store:{check,load(){check();return JSON.parse((db.query('SELECT progress FROM workflow_contact_import WHERE identity=?').get(key) as {progress:string}).progress);},save,
    runLive(run){const row=db.query('SELECT status FROM flow_run WHERE id=?').get(run) as {status:string}|null;return !!row&&['QUEUED','RUNNING','PAUSED'].includes(row.status);},
    seenCursor(cursor){return !!db.query('SELECT 1 FROM workflow_import_cursor WHERE identity=? AND cursor=?').get(key,JSON.stringify(cursor));},
    savePage(p){db.transaction(()=>{save(p);db.run('INSERT INTO workflow_import_cursor(identity,cursor) VALUES(?,?)',[key,JSON.stringify(p.cursor)]);})();},
    record(id){return db.query('SELECT hash,contact_id AS contactId FROM workflow_import_contact WHERE identity=? AND source_id=?').get(key,id) as {hash:string;contactId:string}|null;},
    finishContact(p,c,id){db.transaction(()=>{save(p);db.run('INSERT INTO workflow_import_contact(identity,source_id,hash,contact_id) VALUES(?,?,?,?)',[key,c.id,c.hash,id]);})();}},
    release(){db.run('UPDATE workflow_contact_import SET lease_until=0 WHERE identity=? AND owner=?',[key,owner]);}};
}
