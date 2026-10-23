import React from 'react';
import type { BriefRoomRegistry, BriefShellPort } from '../contracts';
import { BRIEF_ROOMS } from '../rooms/registry';
import { ProfileController } from '../account/profile/controller';
import { ProfileWorkspace } from '../account/profile/ProfileWorkspace';
import { guardProfileNavigation } from '../account/profile/navigation';
import { createProfilePort } from '../account/profile/adapter';
import { SettingsController } from '../account/settings/controller';
import { SettingsWorkspace } from '../account/settings/SettingsWorkspace';
import { createSettingsPort } from '../account/settings/adapter';
import { DESTINATIONS, type SettingsDestination } from '../account/settings/model';
import { AuthorityController } from '../authority/controller';
import { AuthorityWorkspace } from '../authority/AuthorityWorkspace';
import { createAuthorityPort } from '../authority/adapter';
import { ConnectionsController } from '../connections/controller';
import { ConnectedWorkspace } from '../connections/ConnectedWorkspace';
import { createF22ConnectionsPort, type F22Action } from '../connections/f22-adapter';
import { ConnectionSetup } from '../connections/setup';
import type { DestinationId } from '../navigation/destinations';
import type { BriefConnection } from '../../../../src/brief/contracts';
import type { HostTransport } from './http';

export interface AccountHost {
  scopeId: string; transport: HostTransport; capabilities(): unknown;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  navigate(destination: DestinationId, signal?: AbortSignal): Promise<{ state: 'opened' | 'unavailable' }>;
  replayTutorial(): Promise<{ state: 'replayed' | 'unknown' | 'unavailable' }>;
  openSetup(action: F22Action, rowId: string | null): void;
  manageDevice(identity: BriefConnection, action: 'inspect' | 'update' | 'revoke', signal: AbortSignal): Promise<{ state: 'opened' | 'unavailable' }>;
  deviceDetails(identity: BriefConnection): import('../connections/model').ConnectionItem['device'];
}
export function createAccountRooms(host: AccountHost) {
  const { scopeId, transport } = host;
  // #1136's F-23 adapters own the Profile and Settings wire contract.
  const destination = (id: SettingsDestination) => async () => {
    if ((await host.navigate(id)).state !== 'opened') throw new Error('Destination unavailable');
  };
  const profile = new ProfileController(createProfilePort(scopeId, { request: transport.request, canWrite: true }));
  const settings = new SettingsController(createSettingsPort(scopeId, { request: transport.request, canWrite: true,
    destinations: Object.fromEntries(DESTINATIONS.map(id => [id, destination(id)])), replayTutorial: host.replayTutorial }));
  const authority = new AuthorityController(createAuthorityPort(scopeId, { request: transport.request, canWrite: true,
    destinations: { 'advanced-authority': true, 'emergency-controls': true }, navigate: host.navigate }));
  const connections = new ConnectionsController(createF22ConnectionsPort(scopeId, {
    read: () => transport.json('/api/brief/connections'), storage: host.storage,
    createSetup: (scope, ports) => new ConnectionSetup(scope, ports), openSetup: host.openSetup,
    manageDevice: host.manageDevice, addDevice: signal => host.navigate('devices', signal), deviceDetails: host.deviceDetails,
  }));
  const base = () => ({ source: 'live' as const, scopeId, capabilities: host.capabilities() });
  const rooms: BriefRoomRegistry = {
    profile: { ...BRIEF_ROOMS.profile, Body: ({ shell }) => <ProfileWorkspace shell={shell} binding={{ ...base(), controller: profile }} /> },
    settings: { ...BRIEF_ROOMS.settings, Body: ({ shell }) => <SettingsWorkspace shell={shell} binding={{ ...base(), controller: settings }} /> },
    authority: { ...BRIEF_ROOMS.authority, Body: ({ shell }) => <AuthorityWorkspace shell={shell} binding={{ ...base(), controller: authority }} /> },
    'connected-workspace': { ...BRIEF_ROOMS['connected-workspace'], Body: ({ shell }) => <ConnectedWorkspace shell={shell} binding={{ ...base(), controller: connections }} /> },
    billing: BRIEF_ROOMS.billing,
  };
  return { rooms, profile, settings, authority, connections, guardShell: (shell: BriefShellPort) => guardProfileNavigation(shell, profile),
    retire() { profile.retire(); settings.retire(); authority.retire(); connections.retire(); } };
}
