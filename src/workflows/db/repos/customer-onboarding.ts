import { getWorkflowDb } from '../index';
import type { OnboardingStore, ResourceBranch, ResourceState } from '../../runtime/customer-onboarding';

/** Persistent records deliberately survive run-history cleanup. No lease expiry ever
 * makes an interrupted write retryable. Only explicit failed outcomes may retry. */
export function acquireOnboarding(identity: string, config: string, owner: string, now = Date.now): { store: OnboardingStore; release(): void } {
  const db = getWorkflowDb(), leaseMs = 90_000;
  db.transaction(() => {
    const row = db.query('SELECT config,lease_until FROM workflow_customer_onboarding WHERE identity=?').get(identity) as { config: string; lease_until: number } | null;
    if (row && row.config !== config) throw Error('Customer onboarding configuration changed; restore the original settings or review existing resources.');
    if (row && row.lease_until > now()) throw Error('Customer onboarding is already running; wait for both outcomes before retrying.');
    if (!row) db.run('INSERT INTO workflow_customer_onboarding(identity,config,owner,lease_until,results) VALUES(?,?,?,?,?)', [identity,config,owner,now()+leaseMs,'{}']);
    else db.run('UPDATE workflow_customer_onboarding SET owner=?,lease_until=? WHERE identity=?', [owner,now()+leaseMs,identity]);
  })();
  const check = () => {
    if (db.run('UPDATE workflow_customer_onboarding SET lease_until=? WHERE identity=? AND owner=? AND lease_until>?', [now()+leaseMs,identity,owner,now()]).changes !== 1) throw Error('Customer onboarding ownership expired; stopped before further dispatch.');
  };
  const load = (): Partial<Record<ResourceBranch, ResourceState>> => JSON.parse((db.query('SELECT results FROM workflow_customer_onboarding WHERE identity=?').get(identity) as { results: string }).results);
  return { store: { check, read(branch) { check(); return load()[branch]; }, save(branch, result) {
    db.transaction(() => { check(); const results=load(); results[branch]=result;
      db.run('UPDATE workflow_customer_onboarding SET results=? WHERE identity=? AND owner=?',[JSON.stringify(results),identity,owner]); })();
  } }, release() { db.run('UPDATE workflow_customer_onboarding SET lease_until=0 WHERE identity=? AND owner=?',[identity,owner]); } };
}
