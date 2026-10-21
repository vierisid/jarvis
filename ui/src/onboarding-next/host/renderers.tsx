import React, { useEffect, useMemo, useRef, useState } from 'react';
import { WorkflowEditor } from '../../v2/rooms/workflows/WorkflowEditor';
import { WorkflowEditorEnvironment } from '../../v2/rooms/workflows/WorkflowEditorEnvironment';
import { versionBoundRequest } from '../../brief/workflows/canvas/request';
import type { ResultCanvasProps } from '../views/result';
import type { HostTransport } from '../../brief/host/http';
import type { TourRoomRenderer, TourRoomRequest } from '../views/tour';
import type { PebbleTourSurfaceProps } from '../views/pebble-tour';
import type { BriefShellPort } from '../../brief/contracts';
import { NavigationShell } from '../../brief/shell/navigation/NavigationShell';
import { UNKNOWN_NAVIGATION } from '../../brief/shell/navigation/model';
import { BRIEF_ROOMS } from '../../brief/rooms/registry';
import { BriefButton } from '../../brief/components/controls';
import '../../brief/workflows/canvas/canvas.css';
import './renderers.css';
import { TodayLayout } from '../../brief/today/layout/TodayLayout';
import { samplePaper } from '../../brief/today/preview/fixtures';
import { GoalsRoom } from '../../brief/goals/GoalsRoom';
import { makeGoalsFixture, GOALS_SCOPE } from '../../brief/goals/fixtures';
import { DecisionsRoom } from '../../brief/decisions/DecisionsRoom';
import { makeDecisionsFixture, DECISIONS_SCOPE } from '../../brief/decisions/fixtures';
import { OpportunitiesRoom } from '../../brief/opportunities/OpportunitiesRoom';
import { makeOpportunitiesFixture, OPPORTUNITIES_SCOPE } from '../../brief/opportunities/fixtures';
import { MemoryStreamRoom } from '../../brief/memory/stream/MemoryStreamRoom';
import { makeMemoryFixture, MEMORY_SCOPE } from '../../brief/memory/stream/fixtures';
import { ProfileWorkspace } from '../../brief/account/profile/ProfileWorkspace';
import { makeProfileFixture, PROFILE_SCOPE } from '../../brief/account/profile/fixtures';
import { guardProfileNavigation } from '../../brief/account/profile/navigation';
import { SettingsWorkspace } from '../../brief/account/settings/SettingsWorkspace';
import { makeSettingsFixture, SETTINGS_SCOPE } from '../../brief/account/settings/fixtures';
import { AuthorityWorkspace } from '../../brief/authority/AuthorityWorkspace';
import { makeAuthorityFixture, AUTHORITY_SCOPE } from '../../brief/authority/fixtures';
import { ConnectedWorkspace } from '../../brief/connections/ConnectedWorkspace';
import { makeConnectionsFixture, CONNECTION_SCOPE } from '../../brief/connections/fixtures';
import { BillingWorkspace } from '../../brief/account/billing/BillingWorkspace';
import { makeBillingFixture } from '../../brief/account/billing/fixtures';
import { WorkflowCreationRoom } from '../../brief/workflows/create/WorkflowCreationRoom';
import { WorkflowCreationController } from '../../brief/workflows/create/controller';
import { OnboardingWizard } from '../../v2/onboarding/OnboardingWizard';
import { useOnboardingStatus } from '../../v2/onboarding/useOnboardingStatus';

const noop = () => {};
const shellFor = (request: Pick<TourRoomRequest, 'theme' | 'sidebar'>, room: BriefShellPort['route']['room']): BriefShellPort => ({
  mode: 'preview', theme: request.theme, sidebar: request.sidebar, route: { room, selection: {} }, chatOpen: false,
  navigate: noop, setTheme: noop, setSidebar: noop, setChatOpen: noop,
});
/** Tutorial-only controllers cannot reach a network, writer, storage or live navigation. */
function TutorialRoom({ request }: { request: TourRoomRequest }) {
  const [sample] = useState(() => ({ goals: makeGoalsFixture(), decisions: makeDecisionsFixture(), opportunities: makeOpportunitiesFixture(),
    memory: makeMemoryFixture(), profile: makeProfileFixture('read-only'), settings: makeSettingsFixture('read-only'),
    authority: makeAuthorityFixture('read-only'), connections: makeConnectionsFixture('read-only'),
    workflow: new WorkflowCreationController({ submit: async () => { throw Error('Tutorial'); }, read: async () => { throw Error('Tutorial'); }, recover: async () => null },
      { read: () => null, write: noop }, { source: 'fixture', scopeId: 'tutorial-workflow' }) }));
  useEffect(() => () => { for (const value of Object.values(sample)) { if ('controller' in value) value.controller.retire(); } sample.workflow.dispose(); }, [sample]);
  const id = request.step.id, room = id === 'pebble' ? 'today' : id;
  let shell = shellFor(request, room), body: React.ReactNode;
  const bind = (scopeId: string, controller: any) => ({ source: 'fixture' as const, scopeId, controller });
  switch (room) {
    case 'today': body = <TodayLayout shell={shell} greeting="Start with what matters." dateLabel="Sample workspace" dateTime="2026-10-20" decision={{ source: 'fixture', state: { status: 'ready', data: samplePaper('follow-up', false) } }} />; break;
    case 'workflows': body = <WorkflowCreationRoom shell={shell} binding={{ controller: sample.workflow, capabilities: { contractVersion: 1, capabilities: { workflowComposition: { supported: true, ready: true, enabled: true, state: 'ready', reason: null } } }, recent: { source: 'fixture', state: { status: 'empty' } } }} />; break;
    case 'goals': body = <GoalsRoom shell={shell} binding={bind(GOALS_SCOPE, sample.goals.controller)} />; break;
    case 'needs-you': body = <DecisionsRoom shell={shell} binding={bind(DECISIONS_SCOPE, sample.decisions.controller)} />; break;
    case 'opportunities': body = <OpportunitiesRoom shell={shell} binding={bind(OPPORTUNITIES_SCOPE, sample.opportunities.controller)} />; break;
    case 'memory': body = <MemoryStreamRoom shell={shell} binding={bind(MEMORY_SCOPE, sample.memory.controller)} />; break;
    case 'profile': shell = guardProfileNavigation(shell, sample.profile.controller); body = <ProfileWorkspace shell={shell} binding={bind(PROFILE_SCOPE, sample.profile.controller)} />; break;
    case 'settings': body = <SettingsWorkspace shell={shell} binding={bind(SETTINGS_SCOPE, sample.settings.controller)} />; break;
    case 'authority': body = <AuthorityWorkspace shell={shell} binding={bind(AUTHORITY_SCOPE, sample.authority.controller)} />; break;
    case 'connected-workspace': body = <ConnectedWorkspace shell={shell} binding={bind(CONNECTION_SCOPE, sample.connections.controller)} />; break;
    case 'billing': body = <BillingWorkspace shell={shell} fixture={makeBillingFixture('active', () => false)} />; break;
  }
  return <div className="brief-root on-host-tutorial-surface" data-brief-theme={request.theme}><NavigationShell shell={shell} rooms={BRIEF_ROOMS}
    binding={{ capabilities: null, view: { source: 'fixture', state: { status: 'ready', data: { ...UNKNOWN_NAVIGATION, workspaceName: 'Sample workspace' } } } }}>{body}</NavigationShell></div>;
}
export const tutorialRenderer: TourRoomRenderer = { isolation: 'fixture-only', renderRoom(request) {
  return request.mode === 'tutorial' && request.effects === 'disabled' ? { status: 'ready', content: <TutorialRoom key={request.step.id} request={request} /> } : { status: 'unsupported' };
} };
export function TutorialPebble({ open, onOpenChange, reducedMotion }: PebbleTourSurfaceProps) {
  const shell = { ...shellFor({ theme: 'light', sidebar: 'expanded' }, 'today'), chatOpen: open, setChatOpen: onOpenChange };
  return <div className="brief-root on-host-tutorial-surface"><NavigationShell shell={shell} rooms={BRIEF_ROOMS} reducedMotion={reducedMotion}
    binding={{ capabilities: null, view: { source: 'fixture', state: { status: 'ready', data: { ...UNKNOWN_NAVIGATION, workspaceName: 'Sample workspace' } } } }}
    conversation={{ source: 'fixture', content: <div><h2>Talk beside your work</h2><p>This sample conversation cannot send messages.</p></div> }}>
    <TodayLayout shell={shell} greeting="Your workspace" dateLabel="Sample workspace" dateTime="2026-10-20" decision={{ source: 'fixture', state: { status: 'empty' } }} />
  </NavigationShell></div>;
}
/** Existing provider credential/setup UI, returning before its old interview/tour. */
export function ProviderSetup(props: Record<string, unknown>) {
  const { status } = useOnboardingStatus();
  return (props.model as { setup?: { ready?: boolean } })?.setup?.ready || status?.setup_completed ? <button onClick={() => void (props.onComplete as () => Promise<void>)()}>Continue to your workspace</button> : status ? <OnboardingWizard status={status} setupOnly onComplete={props.onComplete as () => Promise<void>} /> : <p role="status">Loading provider setup…</p>;
}
export function createResultCanvas(http: HostTransport) {
  return function ResultCanvas({ draft, onDirtyChange, onUnavailable }: ResultCanvasProps) {
    const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null), samples = useRef(new Map<string, string>());
    const invalid = useRef(onUnavailable); invalid.current = onUnavailable;
    const environment = useMemo(() => {
      const bound = versionBoundRequest(http.request, draft.flowId, draft.versionId);
      return { workspace: true, sampleDrafts: samples.current, request: async (input: RequestInfo | URL, init?: RequestInit) => {
        try { const response = await bound(input, init); if ([401, 404, 409, 410].includes(response.status)) invalid.current(); return response; }
        catch (error) { invalid.current(); throw error; }
      } };
    }, [draft.scopeId, draft.flowId, draft.versionId]);
    return <div className="brief-workflow-canvas"><WorkflowEditorEnvironment.Provider value={{ ...environment, portalHost }}>
      <WorkflowEditor workspace flowId={draft.flowId} onClose={noop} onDirtyChange={onDirtyChange} renderHeader={c => <div className="brief-canvas-tools">
        <BriefButton size="sm" disabled={!c.editor.dirty || c.saving} onClick={() => void c.save()}>Save changes</BriefButton>
        <BriefButton size="sm" disabled={!c.editor.dirty || c.saving} onClick={c.discard}>Discard changes</BriefButton>
        <span role="status">{c.message?.text ?? (c.editor.dirty ? 'Unsaved changes' : 'Saved draft')}</span>
      </div>} /><div className="brief-workflow-portals" ref={setPortalHost} />
    </WorkflowEditorEnvironment.Provider></div>;
  };
}
