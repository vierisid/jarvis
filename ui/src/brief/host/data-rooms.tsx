import React, { useState } from 'react';
import { isBriefCapabilityEnabled } from '../../../../src/brief/capabilities';
import { PendingDecisions, ForgetMemory } from './canonical-commands';
import type { BriefRoomRegistry, BriefShellPort, BriefReadState } from '../contracts';
import { BRIEF_ROOMS } from '../rooms/registry';
import { GoalsController } from '../goals/controller';
import { GoalsRoom } from '../goals/GoalsRoom';
import type { GoalPath } from '../goals/model';
import { DecisionsController } from '../decisions/controller';
import { DecisionsRoom } from '../decisions/DecisionsRoom';
import type { DecisionView } from '../decisions/model';
import { OpportunitiesController } from '../opportunities/controller';
import { OpportunitiesRoom } from '../opportunities/OpportunitiesRoom';
import type { FinishedOpportunity } from '../opportunities/model';
import { MemoryController } from '../memory/stream/controller';
import { MemoryDetailController } from '../memory/detail/controller';
import { MemoryExperience } from '../memory/detail/MemoryExperience';
import { TodayLayout } from '../today/layout/TodayLayout';
import { Outcomes } from '../today/outcomes/Outcomes';
import { RecentActivity } from '../today/activity/RecentActivity';
import { GoalCard } from '../today/goal-card/GoalCard';
import { useGoalHandoff } from '../today/goal-card/useGoalHandoff';
import { OpportunityStack } from '../today/opportunity-stack/OpportunityStack';
import type { DecisionOperation } from '../today/decision-transition/controller';
import type { GoalRecommendation } from '../today/goal-card/model';
import { matchesReceipt as matchesDocument } from '../decisions/model';
import { matchesReceipt as matchesOpportunity, resolvedReceipt } from '../opportunities/model';
import { useBriefProjection } from '../reconciliation/react';
import type { BriefReconciliationClient } from '../reconciliation/client';
import { ReadFailure, type Snapshot, type Source } from '../reconciliation/resource';
import { outcomesSource } from '../reconciliation/sources';
import { createDomainPorts } from './domain-ports';
import type { HostTransport } from './http';
import { post } from './http';

function view<T, U>(state: Snapshot<T>, map: (data: T) => U): BriefReadState<U> {
  if ((state.state === 'ready' || state.state === 'stale') && state.data !== null)
    return state.state === 'ready' ? { status: 'ready', data: map(state.data) } : { status: 'stale', data: map(state.data), reason: state.reason ?? 'Checking for updates.' };
  if (state.state === 'empty') return { status: 'empty' };
  if (state.state === 'loading') return { status: 'loading' };
  return { status: state.state === 'unsupported' ? 'unsupported' : 'unavailable', reason: state.reason ?? 'This information is unavailable.' };
}
function source<T>(domains: Source<T>['domains'], capability: Source<T>['capability'], read: () => Promise<BriefReadState<T>>): Source<T> {
  return { domains, capability, read: async signal => {
    const value = await read(); signal.throwIfAborted();
    if (value.status === 'empty') return { data: null, empty: true, asOf: Date.now() };
    if (value.status !== 'ready') throw new ReadFailure('source_unavailable');
    return { data: value.data, empty: false, asOf: Date.now() };
  } };
}
export function createDataRooms(host: { scopeId: string; transport: HostTransport; capabilities(): unknown;
  storage: Pick<Storage, 'setItem'>; reconciliation: BriefReconciliationClient; createGoal(): void }) {
  const { scopeId, transport, reconciliation } = host;
  const ports = createDomainPorts(scopeId, transport, host.storage);
  const goals = new GoalsController(ports.goals), decisions = new DecisionsController('live', scopeId, { ...ports.decisions, read: async () => { const result = await ports.decisions.read(); if (result.status !== 'ready') return result; const data = result.data.filter(row => row.actions.length > 0); return data.length ? { status: 'ready', data } : { status: 'empty' }; } }),
    opportunities = new OpportunitiesController('live', scopeId, ports.opportunities), memory = new MemoryController(ports.memory);
  const detail = new MemoryDetailController(ports.detail, () => { void memory.refresh(); });
  const goalRead = reconciliation.projection(source<readonly GoalPath[]>(['goals'], 'goalMeasurements', ports.goals.read));
  const decisionRead = reconciliation.projection(source<readonly DecisionView[]>(['decisions', 'today'], 'decisions', ports.decisions.read));
  const opportunityRead = reconciliation.projection(source<readonly FinishedOpportunity[]>(['opportunities'], 'preparedOpportunities', ports.opportunities.read));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const outcomes = reconciliation.projection(outcomesSource(timezone, (url, signal) => transport.json(url, { signal })));
  const recommendations = reconciliation.projection<any>({ domains: ['goals', 'decisions'], capability: 'recommendations', read: async signal => {
    const value = await transport.json('/api/brief/recommendations', { signal });
    if (value !== null && (typeof value.recommendationId !== 'string' || typeof value.revision !== 'string' || !value.plan)) throw new ReadFailure('recommendation_unavailable');
    return { data: value, empty: value === null, asOf: Date.now() };
  } });
  const base = () => ({ source: 'live' as const, scopeId, capabilities: host.capabilities() });
  function Goal({ shell }: { shell: BriefShellPort }) { return <GoalsRoom shell={shell} binding={{ ...base(), controller: goals, onCreate: host.createGoal }} />; }
  function Memory({ shell }: { shell: BriefShellPort }) { return <><MemoryExperience shell={shell} binding={{ stream: { ...base(), controller: memory }, detail }} /><ForgetMemory detail={detail} http={transport} capabilities={host.capabilities()} scopeId={scopeId} storage={host.storage} changed={() => void memory.refresh()} /></>; }
  function Today({ shell }: { shell: BriefShellPort }) {
    const g = useBriefProjection(goalRead), d = useBriefProjection(decisionRead), o = useBriefProjection(opportunityRead), outcome = useBriefProjection(outcomes), rec = useBriefProjection(recommendations);
    const [operation, setOperation] = useState<DecisionOperation>();
    const caps = host.capabilities(), goal = g.data?.find(row => row.goal.status === 'active');
    const selectedRec = rec.data?.plan?.outcome === 'recommend' && rec.data.plan.action.goal?.goalId === goal?.goal.goalId ? rec.data : null;
    const recModel: GoalRecommendation | null = selectedRec ? { recommendationId: selectedRec.recommendationId, revision: selectedRec.revision,
      goalId: selectedRec.plan.action.goal.goalId, goalRevision: selectedRec.plan.action.goal.revision, title: selectedRec.plan.action.title,
      rationale: selectedRec.plan.action.rationale.join(' '), evidence: selectedRec.plan.action.evidence, expiresAt: selectedRec.plan.expiresAt,
      state: selectedRec.state, ...(selectedRec.reason ? { reason: selectedRec.reason } : {}) } : null;
    const handoff = useGoalHandoff('live', { source: 'live', capabilities: caps,
      state: goal ? view(g, () => ({ goalId: goal.goal.goalId, revision: goal.goal.revision, title: goal.goal.title, progress: goal.goal.measurement,
        progressLabel: 'Reported progress', change: null, drivers: goal.stages.map(s => ({ goalId: s.goalId, title: s.title, progress: s.measurement })) })) : g.state === 'ready' || g.state === 'empty' ? { status: 'empty' } : view(g, () => { throw new Error('Goal unavailable'); }),
      recommendation: recModel ? view(rec, () => recModel) : rec.state === 'ready' || rec.state === 'empty' ? { status: 'empty' } : view(rec, () => { throw new Error('Recommendation unavailable'); }),
      queue: view(d, rows => rows.filter(row => row.paper.decision.workItemId).map(row => ({ decisionId: row.paper.decision.decisionId, workItemId: row.paper.decision.workItemId!, title: row.paper.title }))),
      onAccept: async request => {
        host.storage.setItem(`brief:recommendation-request:v1:${scopeId}:${request.requestId}`, JSON.stringify(request));
        const value = await transport.json(`/api/brief/recommendations/${encodeURIComponent(request.recommendationId)}/accept`, post({ requestId: request.requestId, revision: request.revision }));
        const receipt = value;
        if (!receipt || receipt.requestId !== request.requestId || receipt.recommendationId !== request.recommendationId || receipt.revision !== request.revision) return { ...request, state: 'unknown' };
        recommendations.refresh(); decisionRead.refresh();
        return { ...request, state: 'confirmed', receiptId: receipt.receiptId, destination: receipt.destination };
      },
    });
    const now = new Date();
    return <TodayLayout shell={shell} greeting="Make room for what matters." dateLabel={now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} dateTime={now.toISOString()}
      decision={{ source: 'live', capabilities: caps, state: view(d, rows => rows[0]!.paper), operation,
        onAction: async (decision, action, requestId = crypto.randomUUID()) => {
          const request = { decisionId: decision.decisionId, revision: decision.revision, requestId, action };
          setOperation({ ...request, state: 'pending' });
          try {
            const receipt = await ports.decisions.act(request);
            if ('state' in receipt || !matchesDocument(request, receipt)) throw new Error('Unconfirmed decision');
            setOperation({ ...request, state: 'confirmed', effect: 'not_started', ...(action === 'approve' ? { result: 'permission_granted' as const } : {}) });
            decisionRead.refresh(); void decisions.refresh();
          } catch { setOperation({ ...request, state: 'unknown', message: 'The decision is not confirmed. Open Needs you to check it.' }); }
        } }} slots={{
        goal: <GoalCard handoff={handoff} />,
        queueNotice: d.data?.length ? <button onClick={() => shell.navigate({ room: 'needs-you', selection: {} })}>Review {d.data.length} pending {d.data.length === 1 ? 'decision' : 'decisions'}</button> : null,
        outcomes: <Outcomes mode="live" binding={{ source: 'live', capabilities: caps, state: view(outcome, data => ({ window: data.window,
          today: data.today, week: data.week, days: data.days.map(day => ({ ...day, label: day.id })),
          chartMaxMinutes: Math.max(60, ...data.days.map(day => day.time?.value ?? 0)), goal: null,
          coverage: data.coverage.complete ? 'complete' : 'partial', basis: data.basis })) }} />,
        activity: <RecentActivity mode="live" onOpen={shell.navigate} binding={{ source: 'live', capabilities: caps, state: view(outcome, data => data.outcomes.map(item => ({
          activityId: item.outcomeId, title: 'Verified outcome', occurredAt: item.result.asOf,
          timeLabel: new Date(item.result.asOf).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: data.window.timezone }),
          detail: `${item.result.value} ${item.result.unit}`, destination: { room: 'needs-you' as const, selection: { workItemId: item.workItemId } },
        }))) }} />,
        opportunities: <OpportunityStack mode="live" binding={{ source: 'live', scopeKey: scopeId, capabilities: caps,
          state: view(o, rows => rows.map(row => ({ proposal: row.proposal, title: row.title, observation: row.observation, automation: row.title, goalTitle: row.goalTitle ?? 'No linked goal', preparationReason: row.blockers[0] }))),
          onAction: async request => {
            const action = { proposalId: request.proposalId, revision: request.revision, decision: request.action === 'approve_enable' ? 'approve' as const : 'dismiss' as const, idempotencyKey: request.requestId };
            const row = o.data?.find(row => row.proposal.proposalId === request.proposalId); if (!row) return { ...request, state: 'conflict' };
            const receipt = await ports.opportunities.act(action);
            if ('state' in receipt || !matchesOpportunity(action, row, receipt) || !resolvedReceipt(receipt)) return { ...request, state: 'unknown' };
            opportunityRead.refresh(); void opportunities.refresh();
            return { ...request, state: 'confirmed', receiptId: receipt.receiptId, outcome: action.decision === 'approve' ? 'enabled' : 'dismissed' };
          } }} />,
      }} />;
  }
  function NeedsYou({ shell }: { shell: BriefShellPort }) {
    const all = useBriefProjection(decisionRead);
    const onlyOther = all.state === 'ready' && !!all.data?.length && !all.data.some(row => row.actions.length > 0);
    return <>{onlyOther ? <h1>Needs you</h1> : <DecisionsRoom shell={shell} binding={{ ...base(), controller: decisions }} />}
      <PendingDecisions http={transport} read={ports.otherDecisions} enabled={isBriefCapabilityEnabled(host.capabilities(), 'decisions')} changed={() => { decisionRead.refresh(); void decisions.refresh(); }} /></>;
  }
  const rooms: BriefRoomRegistry = {
    today: { ...BRIEF_ROOMS.today, Body: Today }, goals: { ...BRIEF_ROOMS.goals, Body: Goal }, 'completed-goals': { ...BRIEF_ROOMS['completed-goals'], Body: Goal },
    'needs-you': { ...BRIEF_ROOMS['needs-you'], Body: NeedsYou },
    opportunities: { ...BRIEF_ROOMS.opportunities, Body: ({ shell }) => <OpportunitiesRoom shell={shell} binding={{ ...base(), controller: opportunities }} /> },
    memory: { ...BRIEF_ROOMS.memory, Body: Memory }, 'memory-detail': { ...BRIEF_ROOMS['memory-detail'], Body: Memory },
  };
  return { rooms, goals, decisions, opportunities, memory, detail, ports,
    refresh() { goalRead.refresh(); decisionRead.refresh(); opportunityRead.refresh(); outcomes.refresh(); recommendations.refresh(); void goals.refresh(); void decisions.refresh(); void opportunities.refresh(); void memory.refresh(); },
    retire() { goals.retire(); decisions.retire(); opportunities.retire(); memory.retire(); detail.retire(); } };
}
