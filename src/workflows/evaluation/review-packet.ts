import { randomBytes } from 'node:crypto';
import { fingerprint } from '../../actions/tools/composition-provenance';
import type { EvaluationRow, QualityTask } from './types';

/**
 * What a reviewer sees: the job, the composed workflow (or why none was
 * composed) and what each scenario did. No planning policy, profile, model,
 * prompts, repair history or automatic verdicts, and the order is shuffled,
 * so a review cannot favour a candidate or anchor on the checks. The key that
 * maps each blinded item back to its exact row is kept apart from the packet.
 */
export function reviewPacket(rows: EvaluationRow[], tasks: QualityTask[]) {
  const byTask = new Map(tasks.map(t => [t.id, t]));
  const used = new Set<string>();
  const blindId = () => { let id: string; do id = 'R-' + randomBytes(4).toString('hex'); while (used.has(id)); used.add(id); return id; };
  const order = rows.map(row => ({ row, blindId: blindId(), sort: randomBytes(8).toString('hex') })).sort((a, b) => a.sort.localeCompare(b.sort));
  const items = order.map(({ row, blindId }) => ({
    blindId,
    job: { name: row.specification.name, description: row.specification.description },
    composed: row.result?.ok === true ? { workflow: row.result.flow }
      : { workflow: null, explicitBlocker: row.result?.ok === false && row.result.blocked === true,
        reasons: row.result?.ok === false ? row.result.errors : ['Composition did not return a result'] },
    scenarios: row.scenarios.map(s => ({ id: s.id, input: byTask.get(row.taskId)?.scenarios.find(x => x.id === s.id)?.payload ?? null,
      runStatus: s.status, effects: s.receipts.map(r => ({ kind: r.kind, input: r.input, outcome: r.outcome ?? null })) })),
  }));
  return {
    packet: { schemaVersion: 1 as const, items },
    key: { schemaVersion: 1 as const, items: order.map(({ row, blindId }) => ({ blindId, rowId: row.id, rowSha256: fingerprint(row) })) },
    template: items.map(item => ({ blindId: item.blindId, reviewer: '', intentCorrect: null, useful: null, fidelity: null,
      elapsedMs: null, edits: null, notes: '' })),
  };
}

/** Maps blinded reviews back to the rows they judged; the hash still binds each review to the exact result. */
export function unblindReviews(reviews: unknown, key: unknown): unknown[] {
  if (!Array.isArray(reviews)) throw new Error('Reviews must be an array');
  const entries = (key as { items?: Array<{ blindId: string; rowId: string; rowSha256: string }> })?.items;
  if (!Array.isArray(entries)) throw new Error('Invalid review key');
  const byBlindId = new Map(entries.map(e => [e.blindId, e]));
  return reviews.map(review => {
    const { blindId, ...rest } = review as { blindId?: string };
    const entry = typeof blindId === 'string' ? byBlindId.get(blindId) : undefined;
    if (!entry) throw new Error('Review names an unknown blinded item');
    return { ...rest, rowId: entry.rowId, rowSha256: entry.rowSha256 };
  });
}
