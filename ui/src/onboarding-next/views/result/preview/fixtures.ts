import type { SavedResult, ResultModel } from '../model';
export const EXAMPLES = ['Meeting follow-ups', 'Weekly investor update', 'Competitor brief'] as const;
export function example(index = 0): SavedResult {
  const title = EXAMPLES[index] ?? EXAMPLES[0];
  const labels = index === 1 ? ['Every Friday', 'Gather weekly progress', 'Draft the investor update', 'Review the update', 'Save the reviewed update']
    : index === 2 ? ['Every Monday', 'Read competitor updates', 'Write a competitor brief', 'Review the brief', 'Save the reviewed brief']
    : ['Meeting ends', 'Read meeting notes', 'Draft the follow-up', 'Review before sending', 'Send through Gmail'];
  const nodes = labels.map((displayName, i) => ({ name: ['trigger', 'notes', 'draft', 'review', 'send'][i]!, type: i === 0 ? 'EMPTY' : 'PIECE', displayName,
    settings: i === 0 ? {} : { pieceName: 'fixture-tools', actionName: 'prepare', input: { instructions: 'Illustrative draft. Review the output and confirm any missing details.' } } }));
  for (let i = nodes.length - 2; i >= 0; i--) Object.assign(nodes[i]!, { nextAction: nodes[i + 1] });
  const jobId = `job-${index}`, requestId = `request-${index}`, compositionRecordId = `composition-${index}`, flowId = `flow-${index}`, versionId = `version-${index}`;
  return { availability: 'ready', state: 'saved', schemaVersion: 1, scopeId: 'fixture-scope', journeyId: 'fixture-journey', jobId, requestId,
    compositionRecordId, flowId, versionId, contentRevision: 'content-1', title, graph: nodes[0]!, selectedNodeId: null,
    activation: 'disabled', versionState: 'DRAFT', reference: { jobId, requestId, compositionRecordId, flowId, versionId, readiness: 'ready', activation: 'disabled' },
    readiness: { ready: true, issues: [], runtimeChecks: [] }, missingBindings: [],
    recovery: { operation: 'result.read', input: { schemaVersion: 1, jobId, expected: { compositionRecordId, flowId, versionId } } },
    workflow: { room: 'workflow', selection: { flowId, versionId } }, journey: { sync: 'settled', completion: 'active' },
    continuation: { operation: 'journey.transition', input: { journeyId: 'fixture-journey', expectedRevision: 4, requestId: 'result-finish:fixture', command: { type: 'finish' } } } };
}
export function modelFor(result = example(), revision = 1): ResultModel {
  return { scopeId: result.scopeId, journeyId: result.journeyId, jobId: result.jobId, requestId: result.requestId, theme: 'light', revision,
    expected: { compositionRecordId: result.compositionRecordId, flowId: result.flowId, versionId: result.versionId }, result };
}
