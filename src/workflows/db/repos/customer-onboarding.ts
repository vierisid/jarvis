import { getWorkflowDb } from '../index';
import type { OnboardingResolutionRecord, OnboardingStore, ResourceBranch, ResourceOutcome, ResourceState } from '../../runtime/customer-onboarding';

/** Persistent records deliberately survive run-history cleanup. No lease expiry ever
 * makes an interrupted write retryable. Only explicit failed outcomes may retry.
 *
 * `legacyConfigs` gives this configuration in the form an earlier release stored (#1243): a row holding
 * one of them is moved to `config` instead of refused, so records made before the fix keep working. */
export function acquireOnboarding(identity: string, config: string, owner: string, now = Date.now, legacyConfigs: () => readonly string[] = () => []): { store: OnboardingStore; release(): void } {
  const db = getWorkflowDb(), leaseMs = 90_000;
  db.transaction(() => {
    const row = db.query('SELECT config,lease_until FROM workflow_customer_onboarding WHERE identity=?').get(identity) as { config: string; lease_until: number } | null;
    if (row && row.config !== config && !legacyConfigs().includes(row.config))
      throw Error('Customer onboarding configuration changed; restore the original settings or review existing resources.');
    if (row && row.lease_until > now()) throw Error('Customer onboarding is already running; wait for both outcomes before retrying.');
    if (!row) db.run('INSERT INTO workflow_customer_onboarding(identity,config,owner,lease_until,results) VALUES(?,?,?,?,?)', [identity,config,owner,now()+leaseMs,'{}']);
    else db.run('UPDATE workflow_customer_onboarding SET owner=?,lease_until=?,config=? WHERE identity=?', [owner,now()+leaseMs,config,identity]);
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

/**
 * A person's decision about a branch whose outcome is unknown (#1243), after
 * checking the provider: it was created (with the resource they found), or it
 * was not and a later run may create it. Only an unknown branch, or one whose
 * dispatch was interrupted, and never while a run holds the customer.
 */
/** Why a resolution was refused: no such record (404), or not resolvable now (409). */
export class OnboardingRecordError extends Error {
  constructor(message: string, readonly status: 404 | 409) { super(message); this.name = 'OnboardingRecordError'; }
}
/** The customer names earlier onboarding runs of this workflow recorded for this customer ID, for the
 * configuration form an earlier release stored, which included the name (#1243). */
export function recordedCustomerNames(projectId: string, flowId: string, customerId: string): string[] {
  return (getWorkflowDb().query(`SELECT DISTINCT json_extract(e.record,'$.arguments.customer.name') AS name FROM workflow_effect e
    JOIN flow_run r ON r.id = e.run_id WHERE r.flow_id = ? AND json_extract(e.record,'$.route') = 'customer-onboarding'
      AND json_extract(e.record,'$.projectId') = ? AND json_extract(e.record,'$.arguments.customer.id') = ? LIMIT 100`)
    .all(flowId, projectId, customerId) as Array<{ name: unknown }>).flatMap(r => typeof r.name === 'string' ? [r.name] : []);
}
export function resolveOnboardingBranch(identity: string, branch: ResourceBranch,
  decision: { created: { id: string; url: string } } | { created: false }, record: OnboardingResolutionRecord, now = Date.now): ResourceOutcome {
  const db = getWorkflowDb();
  return db.transaction((): ResourceOutcome => {
    const row = db.query('SELECT lease_until,results FROM workflow_customer_onboarding WHERE identity=?').get(identity) as { lease_until: number; results: string } | null;
    if (!row) throw new OnboardingRecordError('No onboarding record for this customer', 404);
    if (row.lease_until > now()) throw new OnboardingRecordError('Customer onboarding is running for this customer; wait for both outcomes before resolving', 409);
    const results = JSON.parse(row.results) as Partial<Record<ResourceBranch, ResourceState>>, prior = results[branch];
    if (prior?.status !== 'unknown' && prior?.status !== 'dispatching')
      throw new OnboardingRecordError(`The ${branch === 'clickup' ? 'ClickUp task' : 'Drive folder'} has no unresolved outcome (it is ${prior?.status ?? 'not recorded'}); nothing to resolve`, 409);
    // The provider detail the person resolved is kept with their decision.
    const resolution = { ...record, ...(prior.status === 'unknown' ? { previous: prior.detail } : {}) };
    const outcome: ResourceOutcome = decision.created
      ? { status: 'succeeded', ...decision.created, detail: 'A person confirmed it was created; the receipt is reused on later runs.', resolution }
      : { status: 'failed', detail: 'A person confirmed it was not created; the next run for this customer creates it.', resolution };
    results[branch] = outcome;
    // The branch outcome is replaced by the next run; the decision itself is kept, newest last.
    const stored = results as Record<string, unknown>, history = Array.isArray(stored.resolutions) ? stored.resolutions : [];
    stored.resolutions = [...history, { branch, status: outcome.status, ...(outcome.id ? { id: outcome.id, url: outcome.url } : {}), ...resolution }].slice(-50);
    db.run('UPDATE workflow_customer_onboarding SET results=? WHERE identity=?', [JSON.stringify(results), identity]);
    return outcome;
  }).immediate();
}
