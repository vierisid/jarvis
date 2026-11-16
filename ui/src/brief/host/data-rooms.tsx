import { useHumanInputCount, useOwnerAttention } from './HumanInputs';
import { EmergencyStatusContext } from './EmergencyStatus';
import React, { useContext, useEffect, useState } from 'react';
import { StoredNoticesContext } from '../navigation/StoredNoticesContext';
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
import { mergeActivity } from '../today/activity/model';
import { recentRunsSource } from '../today/activity/read';
import { GettingStarted, GettingStartedJourney } from '../today/getting-started/GettingStarted';
import { GoalCard } from '../today/goal-card/GoalCard';
import { useGoalHandoff } from '../today/goal-card/useGoalHandoff';
import { OpportunityStack } from '../today/opportunity-stack/OpportunityStack';
import type { DecisionOperation } from '../today/decision-transition/controller';
import { goalCardData, type GoalRecommendation } from '../today/goal-card/model';
import { matchesReceipt as matchesDocument } from '../decisions/model';
import { matchesReceipt as matchesOpportunity, resolvedReceipt } from '../opportunities/model';
import { useBriefProjection } from '../reconciliation/react';
import type { BriefReconciliationClient } from '../reconciliation/client';
import { ReadFailure, type Snapshot, type Source } from '../reconciliation/resource';
import { outcomesSource } from '../reconciliation/sources';
import { createDomainPorts } from './domain-ports';
import type { HostTransport } from './http';
import { post, AWARENESS_OFF_TEXT } from './http';

function view<T, U>(state: Snapshot<T>, map: (data: T) => U): BriefReadState<U> {
  if ((state.state === 'ready' || state.state === 'stale') && state.data !== null)
    return state.state === 'ready' ? { status: 'ready', data: map(state.data) } : { status: 'stale', data: map(state.data), reason: state.reason ?? 'Checking for updates.' };
  if (state.state === 'empty') return { status: 'empty' };
  if (state.state === 'loading') return { status: 'loading' };
  return { status: state.state === 'unsupported' ? 'unsupported' : 'unavailable', reason: state.reason ?? 'This information is unavailable.' };
}
// A background refresh of a previously empty queue does not replace the setup hero.
// Failed reads still use the explicit unavailable state, and real cached decisions stay primary.
export function todayDecisionSnapshot<T>(state: Snapshot<T>): Snapshot<T> {
  return state.state === 'stale' && state.data === null && state.asOf !== null && state.refreshing && state.reason === null
    ? { ...state, state: 'empty' } : state;
}
/** Exported for its test: how a domain port's read becomes a reconciled source. */
export function source<T>(domains: Source<T>['domains'], capability: Source<T>['capability'], read: () => Promise<BriefReadState<T>>): Source<T> {
  return { domains, capability, read: async signal => {
    const value = await read(); signal.throwIfAborted();
    if (value.status === 'empty') return { data: null, empty: true, asOf: Date.now() };
    // Awareness off (#1314): say so, and clear what was shown before rather than keep it as stale.
    if (value.status === 'unavailable' && value.reason === AWARENESS_OFF_TEXT) throw new ReadFailure(AWARENESS_OFF_TEXT, true);
    if (value.status !== 'ready') throw new ReadFailure('source_unavailable');
    return { data: value.data, empty: false, asOf: Date.now() };
  } };
}
/**
 * True when Needs you should drop the document room (and its all-clear) for a
 * plain heading over the permission list. Only a settled document read may be
 * replaced: loading or failed reads keep the room so its own status shows. A
 * permission count of null means unknown (loading or failed) and is never clear.
 */
export function onlyOtherDecisions(all: Pick<Snapshot<readonly DecisionView[]>, 'state' | 'data' | 'refreshing' | 'reason'>, otherCount: number | null): boolean {
  const settled = all.state === 'ready' || all.state === 'empty' || (all.state === 'stale' && all.refreshing && all.reason === null);
  if (!settled || all.data?.some(row => row.actions.length > 0)) return false;
  return otherCount === null || otherCount > 0 || !!all.data?.length;
}
/** Whether the document list may hold the request a link names: only actionable rows are shown there, and an unsettled read may still hold it. */
export function namedInDocuments(all: Pick<Snapshot<readonly DecisionView[]>, 'state' | 'data'>, approvalId: string | undefined): boolean {
  if (!(all.state === 'ready' || all.state === 'empty' || all.state === 'stale')) return true;
  return !!approvalId && !!all.data?.some(row => row.actions.length > 0 && row.paper.decision.approval?.approvalId === approvalId);
}
/**
 * Everything that currently asks something of the owner, counted from the sources Needs you shows: document
 * decisions with an action, the other queued decisions (workflow approvals, permissions, recoveries) and the
 * rest of the attention list (workflow input requests, voice confirmations, live approvals). Each argument is
 * null while its source is unread or failing, and then so is the total: an unknown queue is not an empty one.
 */
export function waitingOnOwner(documents: ReadonlyArray<{ actions: readonly unknown[] }> | null, others: number | null, attention: number | null): number | null {
  return documents === null || others === null || attention === null ? null
    : documents.filter(row => row.actions.length > 0).length + others + attention;
}
/** The document rows Today may count: a settled read (an empty queue is []) or cached rows; otherwise unknown. */
export function settledDocuments<T>(state: Snapshot<readonly T[]>): readonly T[] | null {
  if (state.data) return state.state === 'ready' || state.state === 'stale' ? state.data : null;
  return todayDecisionSnapshot(state).state === 'empty' ? [] : null;
}
function useOtherDecisionCount(read: () => Promise<readonly unknown[]>, enabled: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) { setCount(0); return; }
    let alive = true, reading = false;
    const load = async () => { if (reading) return; reading = true;
      try { const rows = await read(); if (alive) setCount(rows.length); } catch { if (alive) setCount(null); } finally { reading = false; } };
    void load(); const timer = setInterval(() => void load(), 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [read, enabled]);
  return count;
}
export function createDataRooms(host: { scopeId: string; transport: HostTransport; capabilities(): unknown;
  storage: Storage; reconciliation: BriefReconciliationClient; createGoal(): void }) {
  const { scopeId, transport, reconciliation } = host;
  const setup = new GettingStartedJourney(transport, host.storage, scopeId);
  const ports = createDomainPorts(scopeId, transport, host.storage);
  const goals = new GoalsController(ports.goals, () => goalRead.refresh()), decisions = new DecisionsController('live', scopeId, { ...ports.decisions, read: async () => { const result = await ports.decisions.read(); if (result.status !== 'ready') return result; const data = result.data.filter(row => row.actions.length > 0); return data.length ? { status: 'ready', data } : { status: 'empty' }; } }),
    opportunities = new OpportunitiesController('live', scopeId, ports.opportunities), memory = new MemoryController(ports.memory);
  const detail = new MemoryDetailController(ports.detail, () => { void memory.refresh(); });
  const goalRead = reconciliation.projection(source<readonly GoalPath[]>(['goals'], 'goalMeasurements', ports.goals.read));
  const decisionRead = reconciliation.projection(source<readonly DecisionView[]>(['decisions', 'today'], 'decisions', ports.decisions.read));
  const opportunityRead = reconciliation.projection(source<readonly FinishedOpportunity[]>(['opportunities'], 'preparedOpportunities', ports.opportunities.read));
  const initialGoalRead = reconciliation.projection<true>({ domains: ['goals'], capability: 'goalMeasurements', read: async signal => {
    const value = await transport.json('/api/brief/initial-goal', { signal });
    if (value?.state !== 'unplanned' && value?.state !== 'none') throw new ReadFailure('initial_goal_unavailable');
    return { data: value.state === 'unplanned' ? true : null, empty: value.state !== 'unplanned', asOf: Date.now() };
  } });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const outcomes = reconciliation.projection(outcomesSource(timezone, (url, signal) => transport.json(url, { signal })));
  const recentRuns = reconciliation.projection(recentRunsSource((url, signal) => transport.json(url, { signal })));
  const recommendations = reconciliation.projection<any>({ domains: ['goals', 'decisions'], capability: 'recommendations', read: async signal => {
    const value = await transport.json('/api/brief/recommendations', { signal });
    if (value !== null && (typeof value.recommendationId !== 'string' || typeof value.revision !== 'string' || !value.plan)) throw new ReadFailure('recommendation_unavailable');
    return { data: value, empty: value === null, asOf: Date.now() };
  } });
  const base = () => ({ source: 'live' as const, scopeId, capabilities: host.capabilities() });
  function Goal({ shell }: { shell: BriefShellPort }) { return <GoalsRoom shell={shell} binding={{ ...base(), controller: goals, onCreate: host.createGoal }} />; }
  function Memory({ shell }: { shell: BriefShellPort }) { return <><MemoryExperience shell={shell} binding={{ stream: { ...base(), controller: memory }, detail }} /><ForgetMemory detail={detail} http={transport} capabilities={host.capabilities()} scopeId={scopeId} storage={host.storage} changed={() => void memory.refresh()} /></>; }
  function Today({ shell }: { shell: BriefShellPort }) {
    const initialGoal = useBriefProjection(initialGoalRead);
    const g = useBriefProjection(goalRead), d = useBriefProjection(decisionRead), o = useBriefProjection(opportunityRead), outcome = useBriefProjection(outcomes), rec = useBriefProjection(recommendations);
    const decisionSnapshot = todayDecisionSnapshot(d);
    const waiting = waitingOnOwner(settledDocuments(d), useOtherDecisionCount(ports.otherDecisions, isBriefCapabilityEnabled(host.capabilities(), 'decisions')), useOwnerAttention());
    const emergency = useContext(EmergencyStatusContext);
    const [operation, setOperation] = useState<DecisionOperation>();
    const runs = useBriefProjection(recentRuns);
    const caps = host.capabilities(), goal = g.data?.find(row => row.goal.status === 'active')
      ?? g.data?.find(row => row.goal.status === 'draft');
    const selectedRec = goal?.goal.status === 'active' && rec.data?.plan?.outcome === 'recommend' && rec.data.plan.action.goal?.goalId === goal?.goal.goalId ? rec.data : null;
    const recModel: GoalRecommendation | null = selectedRec ? { recommendationId: selectedRec.recommendationId, revision: selectedRec.revision,
      goalId: selectedRec.plan.action.goal.goalId, goalRevision: selectedRec.plan.action.goal.revision, title: selectedRec.plan.action.title,
      rationale: selectedRec.plan.action.rationale.join(' '), evidence: selectedRec.plan.action.evidence, expiresAt: selectedRec.plan.expiresAt,
      state: selectedRec.state, ...(selectedRec.reason ? { reason: selectedRec.reason } : {}) } : null;
    const handoff = useGoalHandoff('live', { source: 'live', capabilities: caps,
      state: goal ? view(g, () => goalCardData(goal)) : g.state === 'ready' || g.state === 'empty' ? { status: 'empty' } : view(g, () => { throw new Error('Goal unavailable'); }),
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
      decision={{ source: 'live', capabilities: caps, state: view(decisionSnapshot, rows => rows[0]!.paper), operation,
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
        gettingStarted: isBriefCapabilityEnabled(caps, 'profileSettings') ? <GettingStarted journey={setup} navigate={shell.navigate} goalId={goal?.goal.goalId} compact={decisionSnapshot.state !== 'empty'} waiting={waiting} held={emergency === 'paused' || emergency === 'killed'} /> : undefined,
        goal: <GoalCard handoff={handoff} onReviewDraft={goal?.goal.status === 'draft' ? () => shell.navigate({ room: 'goals', selection: { goalId: goal.goal.goalId } }) : undefined}
          onPlanUnplanned={initialGoal.data === true ? () => shell.navigate({ room: 'goals', selection: {} }) : undefined} />,
        queueNotice: d.data?.length ? <button onClick={() => shell.navigate({ room: 'needs-you', selection: {} })}>Review {d.data.length} {d.data.length === 1 ? 'request' : 'requests'}</button> : null,
        outcomes: <Outcomes mode="live" binding={{ source: 'live', capabilities: caps, state: view(outcome, data => ({ window: data.window,
          today: data.today, week: data.week, days: data.days.map(day => ({ ...day, label: day.id })),
          chartMaxMinutes: Math.max(60, ...data.days.map(day => day.time?.value ?? 0)), goal: null,
          coverage: data.coverage.complete ? 'complete' : 'partial', basis: data.basis })) }} />,
        activity: <RecentActivity mode="live" onOpen={shell.navigate} binding={{ source: 'live', state: mergeActivity(view(runs, rows => rows),
          isBriefCapabilityEnabled(caps, 'outcomes') && isBriefCapabilityEnabled(caps, 'goalMeasurements') ? view(outcome, data => data.outcomes.map(item => ({
            activityId: item.outcomeId, title: 'Verified outcome', occurredAt: item.result.asOf,
            timeLabel: new Date(item.result.asOf).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: data.window.timezone }),
            detail: `${item.result.value} ${item.result.unit}`, destination: { room: 'needs-you' as const, selection: { workItemId: item.workItemId } },
          }))) : { status: 'unsupported', reason: 'Outcome evidence is not available yet.' }) }} />,
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
    const humanPending = useHumanInputCount();
    const stored = useContext(StoredNoticesContext);
    const [otherCount, setOtherCount] = useState<number | null>(null);
    const onlyOther = onlyOtherDecisions(all, otherCount === null ? null : otherCount + humanPending);
    // A link's request may sit in either list; only when neither has it is it gone.
    const elsewhere = namedInDocuments(all, shell.route.selection.approvalId);
    return <>{onlyOther ? <><header className="brief-decisions-heading"><h1 className="brief-type-room-title">Needs you</h1></header>{stored.list}</> : <DecisionsRoom shell={shell} binding={{ ...base(), controller: decisions }} />}
      <PendingDecisions onCount={setOtherCount} elsewhere={elsewhere} selection={shell.route.selection.approvalId} navigate={shell.navigate} http={transport} read={ports.otherDecisions} enabled={isBriefCapabilityEnabled(host.capabilities(), 'decisions')} changed={() => { decisionRead.refresh(); void decisions.refresh(); }} /></>;
  }
  const rooms: BriefRoomRegistry = {
    today: { ...BRIEF_ROOMS.today, Body: Today }, goals: { ...BRIEF_ROOMS.goals, Body: Goal }, 'completed-goals': { ...BRIEF_ROOMS['completed-goals'], Body: Goal },
    'needs-you': { ...BRIEF_ROOMS['needs-you'], Body: NeedsYou },
    opportunities: { ...BRIEF_ROOMS.opportunities, Body: ({ shell }) => <OpportunitiesRoom shell={shell} binding={{ ...base(), controller: opportunities }} /> },
    memory: { ...BRIEF_ROOMS.memory, Body: Memory }, 'memory-detail': { ...BRIEF_ROOMS['memory-detail'], Body: Memory },
  };
  return { rooms, setup, goals, decisions, opportunities, memory, detail, ports,
    refresh() { goalRead.refresh(); initialGoalRead.refresh(); decisionRead.refresh(); opportunityRead.refresh(); outcomes.refresh(); recentRuns.refresh(); recommendations.refresh(); void goals.refresh(); void decisions.refresh(); void opportunities.refresh(); void memory.refresh(); },
    retire() { setup.retire(); goals.retire(); decisions.retire(); opportunities.retire(); memory.retire(); detail.retire(); } };
}
