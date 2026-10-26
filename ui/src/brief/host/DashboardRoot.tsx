import React, { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { DashboardEntry, BriefHost } from '../entry/DashboardEntry';
import { resolveReleaseEntry } from '../entry/release-route';
import { resolveBriefEntry, briefHash } from '../entry/route';
import { isDevToolsEnabled } from '../../v2/devtools';
import { AppShellV2 } from '../../v2/AppShellV2';
import { OnboardingGate, BriefOnboardingHost } from '../../v2/onboarding/OnboardingGate';
import { RoomActionBusProvider } from '../../v2/rooms/useRoomActionBus';
import { RoomActionBridge } from '../../v2/shell/RoomActionBridge';
import { BriefConversationProvider, useBriefConversation } from '../chat/provider';
import { HostConversation } from './conversation';
import { createDashboardOwner, readHost, type DashboardOwner, type HostDescriptor } from './owner';
import { createHostTransport } from './http';
import { useBriefProjection } from '../reconciliation/react';
import { UNKNOWN_NAVIGATION, planFromBilling } from '../shell/navigation/model';
import { useBilling } from '../../v2/billing/useBilling';
import type { BriefRoute, BriefShellPort } from '../contracts';
import { useNotificationCenter } from '../../hooks/useNotificationCenter';
import { AttentionRoutes } from '../navigation/AttentionRoutes';
import { fromNotificationCenter } from '../navigation/notifications';
import { ViewHost } from '../../onboarding-next/host/ViewHost';
import { createSession, type Session } from '../../onboarding-next/host/session';
import { createTransport } from '../../onboarding-next/host/transport';
import { readProfile } from '../account/profile/model';
import { createLiveOnboardingAdapters } from '../../onboarding-next/host/live-adapters';
import { viewModules } from '../../onboarding-next/host/generated/catalog';
import { createResultCanvas, ProviderSetup, tutorialRenderer, TutorialPebble } from '../../onboarding-next/host/renderers';
import { parseJourney } from '../../onboarding-next/host/policy';
import { openExternal, openedOrHandedOff } from '../../v2/onboarding/external-open';
import { ConfirmHost, confirmDialog } from '../../v2/ui/ConfirmDialog';
import { ClarifierCard } from '../../v2/thread/ClarifierCard';
import { RepeatBackCard } from '../../v2/thread/RepeatBackCard';
import { maintenanceRoom } from './maintenance';
import { getRoomBody } from '../../v2/rooms/RoomBodyRegistry';
import { LiveDataProvider } from '../../v2/shell/LiveDataContext';
import type { RoomKey } from '../../v2/router';
import { InputHost, inputDialog } from './InputDialog';
import './host.css';
import { resolveHostedEntry, useHostedEntry } from './hosted-entry';

/** A distinct local bundle supplies integration=true. URL/storage never supply it. */
export function DashboardRoot({ integration = false }: { integration?: boolean }) {
  const [href, setHref] = useState(() => window.location.href), current = useRef(href);
  const [devtools] = useState(isDevToolsEnabled);
  const internalEntry = resolveReleaseEntry(href, 'off', devtools);
  const reviewing = devtools && internalEntry.kind !== 'legacy';
  // Document-start choice, from the URL the document opened on: navigation must
  // never swap the mounted root (and its socket and drafts) for the loading screen.
  const [needsHostedEntry] = useState(() => !integration && !reviewing && resolveReleaseEntry(href, 'released').kind !== 'legacy');
  const hosted = useHostedEntry(needsHostedEntry);
  const guard = useRef<DashboardOwner | null>(null), epoch = useRef(0);
  useEffect(() => {
    const changed = (event: Event) => {
      const next = window.location.href;
      if (next === current.current) return;
      const mine = ++epoch.current;
      if (event.isTrusted && guard.current?.hasUnsaved()) {
        window.history.replaceState(null, '', current.current);
        void guard.current.canLeave(new AbortController().signal).then(ok => {
          if (ok && mine === epoch.current) { window.history.pushState(null, '', next); current.current = next; setHref(next); }
        });
      } else { current.current = next; setHref(next); }
    };
    const unload = (e: BeforeUnloadEvent) => { if (guard.current?.hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('hashchange', changed); window.addEventListener('popstate', changed); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener('popstate', changed); window.removeEventListener('beforeunload', unload); };
  }, []);
  const initialDescriptor = needsHostedEntry && hosted.state.status === 'ready' ? hosted.state.descriptor : null;
  const entry = integration ? resolveBriefEntry(href) : reviewing ? internalEntry : resolveHostedEntry(href, initialDescriptor);
  const legacy = <AppShellV2 sharedRoomActions />;
  const lastRoute = useRef<BriefRoute>({ room: 'today', selection: {} });
  if (entry.kind === 'brief') lastRoute.current = entry.route;
  const hostedBrief = initialDescriptor?.installMode === 'hosted' && initialDescriptor.dashboard === 'brief';
  // Brief's maintenance links keep the Brief owner mounted, as in local integration.
  const retained = integration || devtools || hostedBrief ? maintenanceRoom(href) : null;
  if (needsHostedEntry && hosted.state.status !== 'ready') return <main className="brief-root brief-foundation">
    <h1>{hosted.state.status === 'unavailable' ? 'Dashboard unavailable' : 'Opening your workspace…'}</h1>
    {hosted.state.status === 'unavailable' && <><p>Your saved work is retained.</p><button onClick={hosted.retry}>Reconnect</button></>}
  </main>;
  if (entry.kind === 'moved' && !reviewing && !integration) return <main className="brief-root brief-foundation">
    <h1>This view is not part of Brief</h1><p>Your saved work is retained.</p><a href="#/brief/today">Open your dashboard</a>
  </main>;
  return <RoomActionBusProvider><ConfirmHost /><InputHost />{entry.kind === 'brief' || retained
    ? <ConnectedDashboard route={entry.kind === 'brief' ? entry.route : lastRoute.current} retained={retained} integration={integration} initialDescriptor={initialDescriptor} legacy={legacy} installGuard={owner => { guard.current = owner; }} />
    : <DashboardEntry legacy={legacy} />}</RoomActionBusProvider>;
}
export function ConnectedDashboard({ route, retained = null, integration = false, initialDescriptor = null, legacy, installGuard = () => {} }: {
  route: BriefRoute; retained?: RoomKey | null; integration?: boolean; initialDescriptor?: HostDescriptor | null; legacy: ReactNode; installGuard?(owner: DashboardOwner | null): void;
}) {
  const [descriptor, setDescriptor] = useState<HostDescriptor | null>(initialDescriptor), [error, setError] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    if (initialDescriptor) return;
    const http = createHostTransport(); setError(false);
    void http.json('/api/brief/host').then(value => { if (!http.signal.aborted) setDescriptor(readHost(value)); }).catch(() => { if (!http.signal.aborted) setError(true); });
    return () => http.stop();
  }, [attempt, initialDescriptor]);
  if (!descriptor) return <main className="brief-root brief-foundation"><h1>{error ? 'Dashboard unavailable' : 'Opening your workspace…'}</h1>
    {error && <><p>Your saved work is retained.</p><button onClick={() => retry(n => n + 1)}>Reconnect</button></>}</main>;
  return <OwnedDashboard key={JSON.stringify([descriptor.scopeId, descriptor.generation])} {...{ descriptor, route, retained, integration, legacy, installGuard }} />;
}
function OwnedDashboard({ descriptor, route, retained, integration, legacy, installGuard }: {
  descriptor: HostDescriptor; route: BriefRoute; retained: RoomKey | null; integration: boolean; legacy: ReactNode; installGuard(owner: DashboardOwner | null): void;
}) {
  const [, changed] = useState(0), [revoked, revoke] = useState(false), [message, explain] = useState(''), [open, setOpen] = useState(false);
  const session = useRef<Session | null>(null), shell = useRef<BriefShellPort | null>(null), reveal = useRef<(id: string) => void>(() => { throw Error('Conversation unavailable'); });
  const [host] = useState(() => createDashboardOwner(descriptor, { storage: window.localStorage, changed: () => changed(n => n + 1),
    unauthorized: () => revoke(true), explain, confirm: text => confirmDialog(text),
    runInput: async () => { const raw = await inputDialog('Input for this manual run (JSON object)', '{}'); if (raw === null) return null;
      try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
      catch { explain('Enter a valid JSON object. No run was started.'); return null; } },
    revealConversationItem: id => reveal.current(id), replayTutorial: async () => {
      if (!session.current) return { state: 'unavailable' };
      try {
        const transport = createTransport(host.transport.request);
        const signal = host.transport.signal, journey = parseJourney(await transport.call('journey.read', {}, signal));
        const result = await transport.call('tour.command', { type: 'replay', sessionId: journey.journeyId, revision: journey.revision, requestId: crypto.randomUUID() }, signal) as any;
        if (result.availability !== 'ready' || result.snapshot?.active !== true) return { state: 'unknown' };
        await session.current.refresh(); return { state: 'replayed' };
      } catch { return { state: 'unknown' }; }
    },
  }));
  useEffect(() => { installGuard(host); return () => { installGuard(null); host.retire(); }; }, [host]);
  const [onboarding] = useState(() => {
    if (!integration) return null;
    const transport = createTransport(host.transport.request);
    return createSession({ enabled: true, integration: true, modules: viewModules, transport,
      adapters: createLiveOnboardingAdapters({ transport, storage: window.localStorage, available: host.active,
        readInterviewFacts: async signal => {
          const value = await host.transport.json('/api/brief/profile-settings', { signal });
          if (value.status !== 'ready' || value.data?.contractVersion !== 1) throw Error('Profile unavailable');
          const profile = readProfile(value.data.profile);
          if (!profile) throw Error('Profile unavailable');
          return profile.interviewFacts ?? [];
        },
        workspace: () => ({ roomId: shell.current?.route.room ?? route.room, selectedObject: null,
          theme: shell.current?.theme ?? (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'), sidebar: shell.current?.sidebar ?? 'expanded',
          chat: { open: shell.current?.chatOpen ?? false, conversationId: host.chat.store.getSnapshot().activeId } }),
        tour: { renderer: tutorialRenderer, pebble: { isolation: 'tutorial-sandbox', Surface: TutorialPebble } },
        Canvas: createResultCanvas(host.transport, dirty => host.setWorkflowDirty('onboarding-result', dirty)), Setup: ProviderSetup,
        openGoogle: value => { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) throw Error('Invalid Google destination');
          if (!openedOrHandedOff(openExternal(url.href))) throw Error('Could not open Google'); },
        openWorkflow: async (selection, room = 'workflow-draft') => { const result = await host.navigation.open(() => ({ target: { kind: 'brief', route: { room, selection } }, message: null })); if (result.state !== 'opened') throw Error('Workflow unavailable'); },
      }) });
  });
  useEffect(() => { session.current = onboarding; if (onboarding) void onboarding.start(); return () => { session.current = null; onboarding?.dispose(); }; }, [onboarding]);
  useEffect(() => { explain(''); }, [route.room, route.selection.factId, route.selection.flowId]);
  if (revoked) return <main className="brief-root brief-foundation"><h1>Reconnect to your workspace</h1><p>Your session or workspace changed. Reload after signing in.</p><button onClick={() => window.location.reload()}>Reload</button></main>;
  const content = (result: ReactNode | null = null) => <BriefConversationProvider enabled chatVisible={open} client={host.chat} reconciliation={host.reconciliation}>
    <Workspace host={host} route={result && onboarding?.state().journey?.draft ? { room: 'workflow-draft', selection: onboarding.state().journey!.draft! } : route}
      retained={retained} open={open} setOpen={setOpen} reveal={reveal} shellRef={shell} message={message}
      beforeNavigate={result ? async () => {
        if (!onboarding || !await host.canLeave(host.transport.signal)) return false;
        const state = onboarding.state(), journey = state.journey;
        if (state.busy || state.blocked || !journey) return false;
        await onboarding.act(onboarding.key(), 'finish', { scopeId: journey.scopeId, journeyId: journey.journeyId, jobId: journey.jobId });
        return onboarding.state().mode === 'complete';
      } : undefined}>{result}</Workspace>
  </BriefConversationProvider>;
  return <div className="jarvis-v2-root"><BriefOnboardingHost>{onboarding
    ? <ViewHost session={onboarding} renderWorkspace={content} legacy={integration ? <main><h1>Local onboarding is unavailable</h1><p>Inspect the local integration diagnostics, then reload.</p></main> : legacy} />
    : <OnboardingGate brief={host.onboarding}>{content()}</OnboardingGate>}</BriefOnboardingHost></div>;
}
function Workspace({ host, route, retained, open, setOpen, reveal, shellRef, message, children, beforeNavigate }: { host: DashboardOwner; route: BriefRoute; retained: RoomKey | null; open: boolean; setOpen(value: boolean): void;
  reveal: React.MutableRefObject<(id: string) => void>; shellRef: React.MutableRefObject<BriefShellPort | null>; message: string; children?: ReactNode; beforeNavigate?(): Promise<boolean> }) {
  const owner = useBriefConversation(), billing = useBilling({ refreshOnMount: false }); useBriefProjection(host.refresh);
  const profile = useSyncExternalStore(host.account.profile.subscribe, host.account.profile.snapshot, host.account.profile.snapshot);
  const notices = useNotificationCenter(owner);
  const [attentionMessage, setAttentionMessage] = useState('');
  const resolveAttention = async (kind: 'clarifier' | 'repeat-back', id: string, decision: 'confirm' | 'cancel') => {
    try {
      const response = await host.transport.request(`/api/voice/${kind}/${encodeURIComponent(id)}/${decision}`, { method: 'POST' });
      if (!response.ok) throw Error();
      setAttentionMessage('Response received. Waiting for the updated confirmation status.');
    } catch { setAttentionMessage('The response could not be confirmed. Reconnect to check its status before trying again.'); }
  };
  reveal.current = id => {
    if (![...owner.clarifiers, ...owner.repeatBacks].some(item => item.id === id)) throw Error('Conversation item unavailable');
    void host.navigation.open(() => ({ target: { kind: 'brief', route: { room: 'needs-you', selection: {} } }, message: null }));
  };
  useEffect(() => {
    if (owner.roomNavRequest && !owner.roomActionRequests.some(request => request.ts === owner.roomNavRequest?.ts))
      void host.navigation.intent(owner.roomNavRequest.key, false);
  }, [owner.roomNavRequest?.ts]);
  const attention = <><AttentionRoutes snapshot={owner.isConnected ? { status: 'ready', items: fromNotificationCenter(notices.items) } : { status: 'unavailable' }}
    navigation={host.navigation} roomAvailable={host.available} markRead={identity => notices.markRead(identity.id)} />
    <section aria-label="Voice confirmations">{owner.clarifiers.map(item => <ClarifierCard key={item.id} {...item}
      onConfirm={() => void resolveAttention('clarifier', item.id, 'confirm')} onCancel={() => void resolveAttention('clarifier', item.id, 'cancel')} />)}
      {owner.repeatBacks.map(item => <RepeatBackCard key={item.id} {...item}
        onConfirm={() => void resolveAttention('repeat-back', item.id, 'confirm')} onCancel={() => void resolveAttention('repeat-back', item.id, 'cancel')} />)}
      {attentionMessage && <p role="status">{attentionMessage}</p>}
    </section></>;
  // Stable wrapper type retains the selected decision while attention changes.
  const latest = useRef(attention); latest.current = attention;
  const rooms = useMemo(() => { const Body = host.rooms['needs-you']!.Body!;
    return { ...host.rooms, 'needs-you': { ...host.rooms['needs-you']!, Body: ({ shell }: { shell: BriefShellPort }) => <>{latest.current}<Body shell={shell} /></> } };
  }, [host]);
  const RetainedBody = retained ? getRoomBody(retained) : null;
  return <><RoomActionBridge requests={owner.roomActionRequests} ack={owner.ackRoomActionRequests}
    forceIdle={() => {}} wsRef={owner.wsRef} beforeDispatch={async request => {
      if (!host.active()) return false;
      const result = await host.navigation.intent(request.room, true);
      return result.state === 'opened' && host.active();
    }} />{message && <p className="brief-host-notice" role="status">{message}</p>}
    <BriefHost route={route} rooms={rooms} visibility={{ open, setOpen }} guardShell={base => { shellRef.current = base;
      const guarded = host.guardShell(base);
      return beforeNavigate ? { ...guarded, navigate: next => { void beforeNavigate().then(ok => { if (ok) guarded.navigate(next); }); } } : guarded;
    }}
      navigation={{ capabilities: host.capabilities(), view: { source: 'live', state: { status: 'ready', data: {
        ...UNKNOWN_NAVIGATION, workspaceName: null, hosting: host.descriptor().installMode,
        connection: owner.isConnected ? 'connected' : owner.status.mode === 'loading' ? 'reconnecting' : 'offline',
        account: { name: profile.base?.answers.preferred_name ?? null, plan: planFromBilling(billing) },
        badges: { 'needs-you': notices.items.length || undefined },
      } } } }} conversation={{ source: 'live', content: <HostConversation host={host} /> }}>
      {children ?? (RetainedBody && <LiveDataProvider value={{ approvals: owner.approvals, clarifiers: owner.clarifiers, repeatBacks: owner.repeatBacks,
        notices: owner.notices, taskEvents: owner.taskEvents, contentEvents: owner.contentEvents, agentActivity: owner.agentActivity,
        settingsEvents: owner.settingsEvents, latestAssistantReply: null }}>
        <section className="brief-maintenance"><button onClick={() => void host.navigation.open(() => ({ target: { kind: 'brief', route }, message: null }))}>Back to workspace</button>
          <RetainedBody key={retained} mode="expanded" />
        </section>
      </LiveDataProvider>)}
    </BriefHost>
  </>;
}
