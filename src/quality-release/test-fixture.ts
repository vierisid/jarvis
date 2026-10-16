import q01Proposed from '../workflows/evaluation/rubric/workflow-release-v1.json';
import { hash, profileHash } from './validation';
import { CONDITIONS, JOURNEYS, PREREQUISITES, QUALITY_CHECKS, type ReleaseRecord, type Proof, type Measurement } from './contract';
import { PROPOSED_SUPPLEMENT } from './template';
export const CANDIDATE = 'a'.repeat(40);
export const NOW = new Date('2026-10-15T12:00:00Z');
/** Positive protocol example for tests only. Never a delivered release receipt. */
export function fixture() {
  const frozenAt = '2026-10-01T00:00:00Z';
  const q01 = { ...structuredClone(q01Proposed), status: 'frozen', frozen: { at: frozenAt, approvedBy: ['fixture-a', 'fixture-b'] },
    budgets: { '*': { maxRequestsPerTask: 10, maxTokensPerTask: 10000, maxP95CompositionMs: 30000 } } };
  const supplement = { ...PROPOSED_SUPPLEMENT, status: 'frozen', frozenAt, approvedBy: ['fixture-a', 'fixture-b'] };
  const artifacts = new Map<string, unknown>([[hash(q01), q01], [hash(supplement), supplement]]);
  const proof = (identity: string, kind: Proof['kind'] = 'deterministic'): Proof => ({ candidate: CANDIDATE, runtimeHash: identity,
    kind, reviewed: true, artifact: '0'.repeat(64), startedAt: '2026-10-10T00:00:00Z', finishedAt: '2026-10-10T01:00:00Z' });
  const record: ReleaseRecord = { schemaVersion: 1, candidate: CANDIDATE,
    rubric: { q01Hash: hash(q01), supplementHash: hash(supplement), status: 'frozen', frozenAt, approved: true, budgetsAgreed: true },
    prerequisites: PREREQUISITES.map(card => ({ card, disposition: 'passed', integratedHead: 'b'.repeat(40), proof: proof(hash({ candidate: CANDIDATE })) })),
    profiles: (['local', 'hosted'] as const).map(deployment => {
      const runtime = { brain: CANDIDATE, hosting: deployment === 'hosted' ? 'c'.repeat(40) : null, sidecar: 'd'.repeat(40),
        model: 'fixture-model', profileRevision: '1'.repeat(64), policy: 'baseline-v1', schema: '2'.repeat(64), prompt: '3'.repeat(64), catalog: '4'.repeat(64), environment: '5'.repeat(64) };
      const jobs = ['invoice-review', 'weekly-update', 'meeting-followup'];
      return { id: deployment + '-fixture', deployment, runtime, jobs,
        journeys: JOURNEYS.flatMap(journey => CONDITIONS.map(condition => ({ journey, condition, disposition: 'passed', proof: proof(profileHash({ id: deployment + '-fixture', deployment, runtime, jobs })),
          safety: { unauthorizedEffects: 0, duplicateEffects: 0, falseVerifiedOutcomes: 0, crossChatLeaks: 0, inventedInputs: 0 } }))),
        quality: QUALITY_CHECKS.map(check => {
          const measurement: Measurement = ['first-intent', 'repaired-intent', 'useful-opportunities', 'qualified-recall', 'negative-proposals'].includes(check)
            ? { kind: 'rate', numerator: check === 'negative-proposals' ? 0 : 40, denominator: check === 'negative-proposals' ? 20 : 40, missedEligible: 0 }
            : check === 'grounded-inputs' ? { kind: 'count', value: 0 }
            : { kind: 'distribution', count: check === 'median-corrections' || check === 'median-correction-time' ? 40 : 60,
              p50: 1, p90: 2, p95: 3, max: 4, timeouts: 0 };
          return { check, disposition: 'passed', proof: proof(profileHash({ id: deployment + '-fixture', deployment, runtime, jobs }), 'heldout'),
            safety: { unauthorizedEffects: 0, duplicateEffects: 0, falseVerifiedOutcomes: 0, crossChatLeaks: 0, inventedInputs: 0 },
            rubricHash: hash({ q01: hash(q01), supplement: hash(supplement) }), scheduled: 60, measured: 60,
            supportedTasks: 40, negativeTasks: 20, taskDispositions: { passed: 60 }, verdict: 'met', measurement };
        }), liveConnector: { disposition: 'not_run', proof: null } };
    }) };
  function seal() {
    for (const row of [...record.prerequisites, ...record.profiles.flatMap(p => [...p.journeys, ...p.quality, p.liveConnector])]) {
      if (!row.proof) continue;
      const { artifact, reviewed, ...identity } = row.proof;
      const { proof: _, ...summary } = row;
      const value = structuredClone({ identity, summary });
      row.proof.artifact = hash(value); artifacts.set(hash(value), value);
    }
  }
  seal(); return { record, artifacts, seal, q01, supplement };
}
