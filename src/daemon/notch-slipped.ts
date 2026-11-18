/**
 * What was promised for today and was not kept, for the notch's evening line
 * (src/notch/day.ts): "1 thing slipped today: ... Move it to tomorrow at
 * 9:00?".
 *
 * A promise is a commitment with a due time (vault/commitments.ts). One that
 * was due and is closed as failed has slipped: the person cancelled it inside
 * its window, or it could not be kept. Moving it is what the dashboard and
 * the commitments tool already do: it is opened again with another due time,
 * and the executor keeps it then.
 *
 * Two kinds are not offered, and are not moved even when asked by id:
 *
 *   - One a restart interrupted. It may have partly run, and the executor
 *     closed it so that it is not run again. The evening does not undo that.
 *   - Linked work, which has its own contract for deciding and running.
 */
import { findCommitments, getCommitment, isWorkItemCommitment, updateCommitmentDue, updateCommitmentStatus, type Commitment } from '../vault/commitments.ts';
import { INTERRUPTED_RESULT } from './commitment-executor.ts';

/** Whether a promise that was not kept may be opened again from the notch. */
const mayReopen = (commitment: Commitment): boolean =>
  commitment.status === 'failed' && commitment.result !== INTERRUPTED_RESULT && !isWorkItemCommitment(commitment.id);

/** The promises that were due between two moments and were not kept, the earliest first. */
export function notchSlipped(since: number, until: number): { id: string; what: string }[] {
  return findCommitments({ status: 'failed' })
    .filter((commitment) => commitment.when_due !== null && commitment.when_due >= since && commitment.when_due <= until && mayReopen(commitment))
    .sort((a, b) => (a.when_due ?? 0) - (b.when_due ?? 0))
    .map((commitment) => ({ id: commitment.id, what: commitment.what }));
}

/**
 * Opens promises again, due at a moment that is ahead. How many were moved:
 * one that is no longer there, is not one that slipped, or may not be opened
 * again is left as it is.
 */
export function notchMoveSlipped(ids: readonly string[], at: number, now: number = Date.now()): number {
  if (!Number.isFinite(at) || at <= now) return 0;
  let moved = 0;
  for (const id of ids) {
    const commitment = getCommitment(id);
    if (!commitment || !mayReopen(commitment)) continue;
    if (!updateCommitmentDue(id, at)) continue;
    // Open again: whatever run it had is behind it, and it runs when it is due.
    if (updateCommitmentStatus(id, 'pending')) moved++;
  }
  return moved;
}
