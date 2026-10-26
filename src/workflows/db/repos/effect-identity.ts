import { getWorkflowDb } from '../index';

export class IdentityUnresolvedError extends Error {
  constructor(public owner:string) { super('Previous operation for this identity is unresolved; inspect original effect '+owner+' before retrying'); }
}

/** Atomically reserve an identity. Contacts can change after a confirmed write;
 * notifications consume the identity permanently. Unknown writes never expire. */
export function claimIdentity(identity: string, owner: string, once: boolean): 'claimed' | 'duplicate' {
  return getWorkflowDb().transaction(() => {
    const previous = getWorkflowDb().query('SELECT owner, completed FROM workflow_effect_identity WHERE identity=?').get(identity) as {owner:string;completed:number} | null;
    if (previous) {
      if (!previous.completed) throw new IdentityUnresolvedError(previous.owner);
      if (once) return 'duplicate';
      getWorkflowDb().run('UPDATE workflow_effect_identity SET owner=?,completed=0 WHERE identity=?', [owner,identity]);
    } else getWorkflowDb().run('INSERT INTO workflow_effect_identity(identity,owner) VALUES(?,?)',[identity,owner]);
    return 'claimed';
  })();
}
export function completeIdentity(identity: string, owner: string): void {
  if (getWorkflowDb().run('UPDATE workflow_effect_identity SET completed=1 WHERE identity=? AND owner=?',[identity,owner]).changes !== 1)
    throw new Error('Identity completion owner changed');
}
/** Give back a claim whose operation definitely did not happen (a provider
 * refusal, or a notification sent on no channel). Never for an uncertain one. */
export function releaseIdentity(identity: string, owner: string): void {
  getWorkflowDb().run('DELETE FROM workflow_effect_identity WHERE identity=? AND owner=? AND completed=0', [identity, owner]);
}
