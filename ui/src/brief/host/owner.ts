import type { BriefRoute, BriefRoomRegistry, BriefShellPort } from '../contracts';
import { BRIEF_ROOM_IDS } from '../contracts';
import { isBriefCapabilityEnabled } from '../../../../src/brief/capabilities';
import { BriefReconciliationClient } from '../reconciliation/client';
import { BriefConversationClient } from '../chat/client';
import { conversationApi } from '../chat/api';
import { attachmentApi } from '../chat/attachments';
import { NavigationCompatibility, destinationPort } from '../navigation/controller';
import { browserNavigationHost } from '../navigation/browser-host';
import { deviceNavigation } from '../navigation/devices';
import { createHostTransport } from './http';
import { createWorkflowRooms } from './workflow-rooms';
import { createAccountRooms } from './account-rooms';
import { createDataRooms } from './data-rooms';
import { OnboardingDraft, onboardingComposition, sessionOnboardingStorage } from '../onboarding/draft';
import { openLegacyConnectionSetup } from '../connections/legacy-setup';
import { DESTINATIONS } from '../navigation/destinations';
import type { SidecarInfo } from '../../v2/rooms/settings/useSettingsData';

export interface HostDescriptor { schemaVersion: 1; scopeId: string; generation: string; installMode: 'self' | 'hosted'; capabilities: unknown }
export function readHost(value: unknown): HostDescriptor {
  const v = value as HostDescriptor;
  if (!v || v.schemaVersion !== 1 || typeof v.scopeId !== 'string' || !v.scopeId || typeof v.generation !== 'string' || !v.generation
    || !['self', 'hosted'].includes(v.installMode) || (v.capabilities as any)?.contractVersion !== 1) throw Error('Dashboard host unavailable');
  return v;
}
export function createDashboardOwner(initial: HostDescriptor, ports: {
  storage: Storage; fetch?: typeof fetch; changed(): void; unauthorized(): void; explain(message: string): void;
  confirm(message: string): Promise<boolean>; runInput(): Promise<Record<string, unknown> | null>;
  revealConversationItem(id: string): void; replayTutorial(): Promise<{ state: 'replayed' | 'unknown' | 'unavailable' }>;
}) {
  let descriptor = initial, retired = false, devices: SidecarInfo[] | null = null;
  const dirty = new Set<string>();
  const transport = createHostTransport(ports.fetch, () => { retire(); ports.unauthorized(); });
  const capabilities = () => retired ? undefined : descriptor.capabilities;
  let rooms: BriefRoomRegistry = {}, account: ReturnType<typeof createAccountRooms>;
  const available = (room: BriefRoute['room']) => !retired && !!rooms[room]?.Body;
  const canLeave = async (signal: AbortSignal) => {
    if (retired || signal.aborted || !await account.profile.requestLeave()) return false;
    const settings = account.settings.snapshot();
    if (settings.phase === 'saving') { ports.explain('Wait for your settings to finish saving.'); return false; }
    if (settings.draft !== null && !await ports.confirm('Leave Settings with your unsaved voice choice? It will stay in this session.')) return false;
    if (!data.detail.canLeave()) { ports.explain('Save or cancel your memory edit before leaving.'); return false; }
    if (dirty.size) { ports.explain('Save or discard your workflow edits before leaving.'); return false; }
    return !retired && !signal.aborted;
  };
  const navigation = new NavigationCompatibility(browserNavigationHost({ roomAvailable: available, canLeave,
    explain: ports.explain, revealConversationItem: ports.revealConversationItem }));
  const device = deviceNavigation(navigation, () => devices);
  const reconciliation = new BriefReconciliationClient({ capabilities: async signal => {
    const next = readHost(await transport.json('/api/brief/host', { signal }));
    if (next.scopeId !== initial.scopeId || next.generation !== initial.generation) { retire(); ports.unauthorized(); throw Error('Dashboard ownership changed'); }
    descriptor = next; navigation.setAccess(next.capabilities);
    account.profile.setAccess(isBriefCapabilityEnabled(next.capabilities, 'profileSettings')); ports.changed(); return next.capabilities;
  } });
  const chat = new BriefConversationClient(conversationApi(transport.request), ports.storage, attachmentApi(transport.request));
  const workflow = createWorkflowRooms({ scopeId: initial.scopeId, transport, capabilities, storage: ports.storage,
    dirty: (key, value) => { if (value) dirty.add(key); else dirty.delete(key); }, runInput: ports.runInput });
  account = createAccountRooms({ scopeId: initial.scopeId, transport, capabilities, storage: ports.storage,
    navigate: destinationPort(navigation).navigate, replayTutorial: ports.replayTutorial, ...device,
    openSetup(action, rowId) {
      // F22 invokes this only after its durable setup ticket. Preserve its exact
      // target, while switching the existing router into its maintenance owner.
      if (retired) throw Error('Dashboard unavailable');
      const url = new URL(window.location.href); url.searchParams.set('brief', '0'); url.searchParams.set('briefMaintenance', '1');
      window.history.replaceState(window.history.state, '', url);
      openLegacyConnectionSetup(action, rowId);
    },
  });
  account.profile.setAccess(isBriefCapabilityEnabled(initial.capabilities, 'profileSettings'));
  const data = createDataRooms({ scopeId: initial.scopeId, transport, capabilities, storage: ports.storage, reconciliation,
    createGoal: () => { void navigation.open(() => ({ target: { kind: 'legacy', hash: '#/_room_goals' }, message: 'Opening goal creation.' })); } });
  rooms = { ...workflow.rooms, ...data.rooms, ...account.rooms };
  if (BRIEF_ROOM_IDS.some(id => !rooms[id]?.Body)) throw Error('Incomplete dashboard composition');
  navigation.setAccess(initial.capabilities);
  const onboarding = new OnboardingDraft(initial.scopeId, sessionOnboardingStorage(initial.scopeId, ports.storage), {
    capabilities, roomAvailable: available, canLeave, commit: route => navigationHostCommit(route),
  }, onboardingComposition(transport.request));
  const navigationHostCommit = (route: BriefRoute) => browserNavigationHost({ roomAvailable: available, canLeave,
    explain: ports.explain, revealConversationItem: ports.revealConversationItem }).commit({ kind: 'brief', route });
  // One refresh source shares F27's socket/focus/poll owner. It performs reads
  // only; controllers retain their pending commands and unsaved buffers.
  const refresh = reconciliation.projection({ domains: ['today', 'decisions', 'opportunities', 'goals', 'memory', 'workflows', 'runs'],
    read: async signal => {
      await Promise.allSettled([account.profile.refresh(), account.settings.refresh(), account.connections.refresh(), account.authority.refresh(),
        data.goals.refresh(), data.decisions.refresh(), data.opportunities.refresh(), data.memory.refresh(), workflow.management.refresh(),
        transport.json('/api/sidecars', { signal }).then(value => { devices = Array.isArray(value) ? value : Array.isArray(value.sidecars) ? value.sidecars : null; }).catch(() => { devices = null; })]);
      signal.throwIfAborted(); return { data: true, empty: false, asOf: Date.now() };
    } });
  function retire() {
    if (retired) return; retired = true; transport.stop(); navigation.retire(); chat.stop(); reconciliation.stop();
    workflow.retire(); data.retire(); account.retire(); onboarding.dispose(); devices = null; dirty.clear();
  }
  return { scopeId: initial.scopeId, transport, capabilities, descriptor: () => descriptor, rooms, available, canLeave,
    navigation, chat, reconciliation, workflow, account, data, onboarding, refresh, retire,
    guardShell(shell: BriefShellPort) { return account.guardShell({ ...shell, navigate: route => { void navigation.open(() => ({ target: { kind: 'brief', route }, message: null })); } }); },
    hasUnsaved: () => data.detail.unsaved() || data.detail.snapshot().phase === 'pending' || dirty.size > 0 || account.profile.hasEdits() || account.settings.snapshot().draft !== null,
    setWorkflowDirty: (key: string, value: boolean) => { if (value) dirty.add(key); else { const existed = dirty.delete(key); if (existed && !dirty.size) ports.explain(''); } },
    active: () => !retired,
    devices: () => devices?.filter(device => device.connected) ?? [],
  };
}
export type DashboardOwner = ReturnType<typeof createDashboardOwner>;
