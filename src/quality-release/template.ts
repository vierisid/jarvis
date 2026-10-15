import { CONDITIONS, JOURNEYS, type ReleaseRecord, type Runtime } from './contract';
import { hash } from './assessment';
export const PROPOSED_SUPPLEMENT = { schemaVersion: 1, status: 'proposed', frozenAt: null, approvedBy: [],
  minUsefulOpportunityRate: .8, maxNegativeProposalRate: .05, minQualifiedRecallRate: .95, maxInventedInputs: 0 };
/** Missing profiles are explicit placeholders; no model ID or deployed revision
 * is inferred from repository aliases. No existing measurement is promoted. */
export function releaseTemplate(candidate: string, q01Hash: string, source: Pick<Runtime, 'schema' | 'prompt' | 'catalog' | 'environment'>): ReleaseRecord {
  return { schemaVersion: 1, candidate,
    rubric: { q01Hash, supplementHash: hash(PROPOSED_SUPPLEMENT), status: 'proposed', frozenAt: null, approved: false, budgetsAgreed: false },
    prerequisites: [], profiles: (['local', 'hosted'] as const).map(deployment => ({ id: deployment + '-unresolved', deployment,
      runtime: { brain: candidate, hosting: null, sidecar: null, model: null, profileRevision: null, policy: 'baseline-v1', ...source },
      journeys: JOURNEYS.flatMap(journey => CONDITIONS.map(condition => ({ journey, condition, disposition: 'not_run' as const, proof: null, safety: null }))),
      jobs: [], quality: [], liveConnector: { disposition: 'not_run', proof: null } })) };
}
