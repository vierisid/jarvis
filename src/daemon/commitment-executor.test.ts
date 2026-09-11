import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { createCommitment, getCommitment, updateCommitmentStatus } from '../vault/commitments.ts';
import { CommitmentExecutor, parseParkedRequestIds } from './commitment-executor.ts';

type Awaiting = Map<string, { what: string; requestIds: string[] }>;
const awaitingOf = (ex: CommitmentExecutor): Awaiting => (ex as unknown as { awaitingApproval: Awaiting }).awaitingApproval;

describe('CommitmentExecutor.settleAwaitingApprovals', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  function park(ex: CommitmentExecutor, requestIds: string[]): string {
    const c = createCommitment('deploy the thing', { when_due: Date.now() - 1000 });
    // Parked commitments are 'active' with the request ids in the result.
    updateCommitmentStatus(c.id, 'active', `Awaiting user approval [req:${requestIds.join(',')}]: asked`);
    awaitingOf(ex).set(c.id, { what: c.what, requestIds });
    return c.id;
  }

  test('stays parked while any request is pending', () => {
    const ex = new CommitmentExecutor();
    const statuses: Record<string, string> = { r1: 'executed', r2: 'pending' };
    ex.setApprovalLookup((id) => ({ status: statuses[id] ?? 'expired', execution_result: null }));
    const id = park(ex, ['r1', 'r2']);
    ex.settleAwaitingApprovals();
    expect(awaitingOf(ex).has(id)).toBe(true);
    expect(getCommitment(id)?.status).toBe('active');
  });

  test('a commitment the user closed by hand is left alone', () => {
    const ex = new CommitmentExecutor();
    ex.setApprovalLookup(() => ({ status: 'executed', execution_result: 'done' }));
    const id = park(ex, ['r1']);
    updateCommitmentStatus(id, 'failed', 'cancelled by user');
    ex.settleAwaitingApprovals();
    expect(awaitingOf(ex).has(id)).toBe(false);
    expect(getCommitment(id)?.status).toBe('failed');
    expect(getCommitment(id)?.result).toBe('cancelled by user');
  });

  test('completes with the execution result once a request executed', () => {
    const ex = new CommitmentExecutor();
    ex.setApprovalLookup((id) => (id === 'r1' ? { status: 'executed', execution_result: 'deployed v2' } : { status: 'denied', execution_result: null }));
    const id = park(ex, ['r1', 'r2']);
    ex.settleAwaitingApprovals();
    expect(awaitingOf(ex).has(id)).toBe(false);
    const c = getCommitment(id);
    expect(c?.status).toBe('completed');
    expect(c?.result).toContain('deployed v2');
  });

  test('fails when every request was denied, expired, or vanished', () => {
    const ex = new CommitmentExecutor();
    ex.setApprovalLookup((id) => (id === 'r1' ? { status: 'denied', execution_result: null } : null));
    const id = park(ex, ['r1', 'gone']);
    ex.settleAwaitingApprovals();
    expect(getCommitment(id)?.status).toBe('failed');
  });

  test('does nothing without a lookup', () => {
    const ex = new CommitmentExecutor();
    const id = park(ex, ['r1']);
    ex.settleAwaitingApprovals();
    expect(awaitingOf(ex).has(id)).toBe(true);
  });
});

describe('parked commitments survive a restart', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  test('parseParkedRequestIds reads the encoded ids', () => {
    expect(parseParkedRequestIds('Awaiting user approval [req:a1, b2]: I asked to run x')).toEqual(['a1', 'b2']);
    expect(parseParkedRequestIds('Awaiting user approval [req:]: none')).toEqual([]);
    expect(parseParkedRequestIds('Executed successfully')).toBeNull();
    expect(parseParkedRequestIds(null)).toBeNull();
  });

  test('a due commitment whose result carries request ids is rehydrated, not re-run', () => {
    const c = createCommitment('email the report', { when_due: Date.now() - 5_000 });
    updateCommitmentStatus(c.id, 'active', 'Awaiting user approval [req:r9]: I asked to send it');

    const ex = new CommitmentExecutor();
    let announced = 0;
    (ex as unknown as { announceExecution: () => void }).announceExecution = () => { announced += 1; };
    ex.setApprovalLookup((id) => (id === 'r9' ? { status: 'executed', execution_result: 'sent' } : null));

    ex.checkAndAnnounce();            // rehydrates the wait
    expect(announced).toBe(0);
    expect(awaitingOf(ex).get(c.id)?.requestIds).toEqual(['r9']);

    ex.checkAndAnnounce();            // settles from the executed request
    expect(getCommitment(c.id)?.status).toBe('completed');
    expect(announced).toBe(0);
  });
});
