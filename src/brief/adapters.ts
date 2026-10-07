import type { BriefCapabilities, BriefCapabilityId } from './capabilities.ts';
import type { BriefReadResult, BriefGoal, BriefWorkflowRef } from './contracts.ts';
import type { BriefReadProvider } from './providers.ts';
import type { Goal } from '../goals/types.ts';
import type { FlowRow } from '../workflows/db/repos/flow.ts';
import type { FlowVersion } from '../workflows/db/repos/flow-version.ts';

/** Missing modules compile, fail closed and never manufacture empty/success data. */
export async function readBriefProvider<Query, Data>(
  capabilities: BriefCapabilities,
  id: BriefCapabilityId,
  provider: BriefReadProvider<Query, Data> | undefined,
  query: Query,
): Promise<BriefReadResult<Data>> {
  if (!provider || !capabilities.hasProvider(id, provider)) return { state: 'unsupported' };
  const capability = capabilities.snapshot().capabilities[id];
  if (capability.state === 'loading') return { state: 'loading' };
  if (!capability.enabled) return {
    state: 'unavailable',
    reason: capability.reason === 'disabled' || capability.reason === 'dependency_not_ready'
      ? capability.reason : 'provider_unavailable',
  };
  try { return await provider.read(query); }
  catch { return { state: 'unavailable', reason: 'provider_unavailable' }; }
}

/** Legacy-only projection. Measurement-aware readers use projectMeasuredGoal. */
export function projectLegacyGoal(goal: Goal): BriefGoal {
  return {
    goalId: goal.id, revision: String(goal.updated_at), status: goal.status,
    health: goal.health, score: goal.score, measurement: null,
  };
}

/** No new writer or interpretation of ENABLED/DISABLED versus DRAFT/LOCKED. */
export function projectWorkflowRef(flow: Pick<FlowRow, 'id' | 'status'>, version: Pick<FlowVersion, 'id' | 'flowId' | 'state'>): BriefWorkflowRef {
  if (version.flowId !== flow.id) throw new Error('Workflow version belongs to a different flow');
  return { flowId: flow.id, versionId: version.id, activation: flow.status, versionState: version.state };
}
