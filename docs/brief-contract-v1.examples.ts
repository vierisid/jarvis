/** Synthetic wire examples, never registered as a production data provider. */
import { BRIEF_CONTRACT_VERSION } from '../src/brief/contracts.ts';
import type {
  BriefReadResult, BriefConversation, BriefPage, BriefCancelTurn, BriefChatEvent,
  BriefDecision, BriefPreparedOpportunity, BriefGoal, BriefOutcome, BriefMemory, BriefConnection,
} from '../src/brief/contracts.ts';

const asOf = 1791194400000;
const workflow = { flowId: 'flow-1', versionId: 'version-3', activation: 'DISABLED', versionState: 'LOCKED' } as const;
const turn = { conversationId: 'conversation-1', turnId: 'turn-2', requestId: 'request-3' };
const conversation: BriefConversation = {
  conversationId: turn.conversationId, workspaceId: 'workspace-1', title: 'Weekly report',
  revision: 'r2', tab: { open: false, order: 0 }, lastMessageAt: asOf,
};

export const briefContractExamples = {
  contractVersion: BRIEF_CONTRACT_VERSION,
  conversation,
  reads: [
    { state: 'loading' },
    { state: 'ready', data: { items: [conversation], nextCursor: null }, asOf },
    { state: 'empty', asOf },
    { state: 'stale', data: { items: [conversation], nextCursor: 'opaque-next-page' }, asOf },
    { state: 'unavailable', reason: 'provider_unavailable' },
    { state: 'unsupported' },
  ] satisfies BriefReadResult<BriefPage<BriefConversation>>[],
  cancel: turn satisfies BriefCancelTurn,
  event: {
    ...turn, eventId: 'event-4', sequence: 4, payload: { kind: 'terminal', state: 'cancelled' },
  } satisfies BriefChatEvent,
  decision: {
    decisionId: 'decision-1', revision: 'r1',
    approval: { approvalId: 'approval-1', status: 'approved', executionMode: 'workflow', executionOutcome: null },
    workItemId: 'commitment-1', workStatus: 'ready', workflow,
    run: { ...workflow, runId: 'run-1', status: 'QUEUED' }, actions: ['inspect'],
  } satisfies BriefDecision,
  preparedOpportunity: {
    proposalId: 'proposal-1', revision: 'r3',
    evidence: [{ kind: 'observation', id: 'observation-1', revision: 'r1' }],
    goal: { goalId: 'goal-1', revision: 'r2', rationale: 'Prepare the recurring report' },
    compositionId: 'composition-1', workflow,
    bindings: [{ kind: 'connection', id: 'connection-1', revision: 'r1', availability: 'ready' }],
    previewBasis: 'sandbox_sample', state: 'ready', readiness: { state: 'ready', checkedAt: asOf },
  } satisfies BriefPreparedOpportunity,
  goal: {
    goalId: 'goal-1', revision: 'r2', status: 'active', health: 'on_track', score: 0.6, measurement: null,
  } satisfies BriefGoal,
  outcome: {
    outcomeId: 'outcome-1', workItemId: 'commitment-1', runId: 'run-1', goalIds: ['goal-1'],
    window: { start: asOf - 86400000, end: asOf, timezone: 'Europe/Berlin' },
    result: { value: 1, unit: 'reviewed report', baseline: 0, target: 1, asOf,
      provenance: [{ kind: 'receipt', id: 'receipt-1', revision: 'r1' }], qualification: 'user_reported' },
    timeBack: null,
  } satisfies BriefOutcome,
  memory: {
    factId: 'fact-1', sourceId: 'source-1', sentence: 'Reports are reviewed on Monday.',
    basis: 'reported', status: 'active', provenance: [{ kind: 'source', id: 'source-1', revision: 'r1' }],
    uses: [{ useId: 'use-1', factId: 'fact-1', sourceRevision: 'r1', stage: 'supplied', turn, runId: null, at: asOf }],
    permissions: { canRead: true, canCorrect: true, canForget: false },
  } satisfies BriefMemory,
  connection: {
    sourceId: 'library-piece-1', kind: 'library_piece', accountId: null, availability: 'ready',
    permissions: { canInspect: true, canConnect: false, canRevoke: false }, authenticated: null,
  } satisfies BriefConnection,
};
