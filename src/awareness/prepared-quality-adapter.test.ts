import { expect, test } from 'bun:test';
import { createPreparedQualityAdapter, type PreparedQualityModule } from './prepared-quality-adapter';
import type { PreparedIdentity, PreparedQualification } from './prepared-contracts';

const identity: PreparedIdentity = { proposalId: 'p', revision: 'r', compositionId: 'c', workflow: { flowId: 'f', versionId: 'v', versionDigest: 'digest' },
  specification: { opportunityId: 'o', sourceRevision: 's', kind: 'invoice_review', name: 'Review invoices', description: 'Review invoices',
    expectedOutcome: 'Draft follow-ups', confirmed: true, customConstraints: false, evidence: [{ kind: 'observation', id: 'capture-1', revision: '1' }],
    goal: { goalId: 'g', revision: '2', rationale: 'Support collections' } } };
function module(facts: unknown) {
  let seen: Record<string, unknown> | null = null;
  const result = { qualifier: 'prepared-qualification-v1', verdict: 'blocked', reasons: [], checkedAt: 1,
    snapshot: { proposalId: 'p', revision: 'r', flowId: 'f', versionId: 'v', versionDigest: 'digest', fingerprint: 'a'.repeat(64), bindings: [] } } satisfies PreparedQualification;
  const quality: PreparedQualityModule = { QUALIFIER: 'prepared-qualification-v1', JOB_CONSTRAINTS: { invoice_review: [{ kind: 'review_before_effects' }] },
    liveQualificationServices: () => ({}), observePreparedProposal: () => facts as any,
    briefBindings: values => values.map(v => ({ kind: v.kind, id: v.id, revision: v.revision ?? 'unknown', availability: v.availability })),
    qualifyPreparedProposal: request => { seen = request; return result; }, recheckQualification: () => ({ current: result, stale: false }) };
  return { quality, seen: () => seen! };
}
const options = { authority: null, tool: () => null, targets: () => [] };
test('the adapter pins current bindings, labels simulation honestly and closes its runner', async () => {
  const m = module({ bindings: [{ kind: 'connection', id: 'billing', availability: 'ready', revision: '1' }],
    steps: [{ step: 'draft', role: 'source', decision: 'auto' }, { step: 'send', role: 'effect', decision: 'approval' }], version: { dry: null } });
  let closed = false, ran: unknown[] = [];
  const gate = createPreparedQualityAdapter(m.quality, options, { async run(...args) { ran = args; return { simulated: [{ step: 'send' }], status: 'SUCCEEDED' }; }, async close() { closed = true; } });
  const saved = await gate.prepare(identity);
  expect(ran).toEqual(['f', 'v', { id: 'prepared-empty-v1', payload: {} }]);
  expect(m.seen()).toMatchObject({ evidence: identity.specification.evidence, goal: { goalId: 'g', revision: '2' }, compositionId: 'c', workflow: identity.workflow,
    bindings: [{ kind: 'connection', id: 'billing', availability: 'ready' }],
    preview: { basis: 'sandbox_sample', runId: null, effects: [{ step: 'send', approval: 'asks_first', sample: 'simulated' }] } });
  expect(saved.qualification.verdict).toBe('blocked'); expect(gate.recheck(saved).stale).toBe(false);
  await gate.close!(); expect(closed).toBe(true); expect(gate.readiness()).toBe(false);
  await expect(gate.prepare(identity)).rejects.toThrow('closed');
});

test('unsupported simulation stays illustrative and custom job edits require review', async () => {
  const m = module({ bindings: [], steps: [{ step: 'send', role: 'effect', decision: 'auto' }], version: { dry: 'Community piece cannot be simulated' } });
  let calls = 0;
  const gate = createPreparedQualityAdapter(m.quality, options, { async run() { calls++; return { simulated: [] }; }, async close() {} });
  const saved = await gate.prepare({ ...identity, specification: { ...identity.specification, customConstraints: true } });
  expect(calls).toBe(0); expect(saved.previewBasis).toBe('illustrative_template');
  expect(m.seen()).toMatchObject({ sample: null, preview: { effects: [{ step: 'send', approval: 'runs_automatically', sample: 'none' }] },
    constraints: [{ kind: 'review_before_effects' }, { kind: 'unverified', text: 'Review invoices\nDraft follow-ups' }] });
  expect(m.quality.JOB_CONSTRAINTS.invoice_review).toHaveLength(1);
});
