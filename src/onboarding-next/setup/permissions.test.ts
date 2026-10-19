import { describe, expect, test } from 'bun:test';
import type { PermissionsSidecarHost, PermissionsUnavailable } from '../../daemon/system-permissions.ts';
import { createDaemonPermissions } from './daemon-adapter.ts';
import { createSetupProvider } from './provider.ts';
import { SidecarRPCError } from '../../sidecar/rpc.ts';

const owner = { actorId: 'fixture-owner', projectId: 'fixture-project' };
const screen = { action: 'screen_observation' };
function fixture(platform = 'darwin', status = 'denied', grant = 'pane') {
  const report = { platform, bundled: true, permissions: [{ name: 'screen', status, grant }] };
  const calls: Array<{ method: string; params: unknown }> = [];
  let paneOpened = true;
  let connected = [{ id: 'desktop-a', name: 'Fixture desktop', hostname: 'fixture' }];
  const sidecars: PermissionsSidecarHost = {
    resolvePanelSession: () => ({ sid: 'desktop-a' }),
    getConnectedSidecars: () => connected,
    dispatchRPC: async (_sid, method, params) => {
      calls.push({ method, params });
      return method === 'system.permissions' ? report : { permissions: report.permissions, grant, pane_opened: paneOpened };
    },
  };
  const permissions = createDaemonPermissions({ owner, sidecars, panelSessionId: () => 'server-session' });
  const provider = createSetupProvider({ authorize: (valid: boolean) => valid ? owner : null, permissions });
  return { provider, permissions, sidecars, report, calls,
    failPane: () => { paneOpened = false; }, disconnect: () => { connected = []; } };
}

describe('native access remains explicit and separate from setup', () => {
  test('read-only screen check cannot open settings or start capture', async () => {
    const f = fixture(); expect(f.calls).toHaveLength(0);
    expect(await f.provider.checkAction(true, screen)).toMatchObject({ ready: false, reason: 'denied', recovery: 'open_settings', observationStarted: false });
    expect(f.calls.map(call => call.method)).toEqual(['system.permissions']);
  });
  test('macOS opened screen pane is not a grant; restart is conditional advice', async () => {
    const f = fixture();
    expect(await f.provider.requestAction(true, screen)).toMatchObject({ ready: false, reason: 'denied', recovery: 'restart_may_be_required', observationStarted: false });
    expect(f.calls.map(call => call.method)).toEqual(['system.permissions', 'system.request_permission', 'system.permissions']);
    expect(f.calls[1]?.params).toEqual({ name: 'screen' });
    f.report.permissions[0]!.status = 'granted';
    expect(await f.provider.checkAction(true, screen)).toMatchObject({ ready: true, reason: 'granted', recovery: 'none', observationStarted: false });
  });
  test('failed settings-pane launch does not show restart advice', async () => {
    const f = fixture(); f.failPane();
    expect(await f.provider.requestAction(true, screen)).toMatchObject({ ready: false, reason: 'settings_not_opened', recovery: 'open_settings' });
  });
  test('Windows reports no OS grant required without claiming granted or observing', async () => {
    const f = fixture('windows', 'na', 'none');
    expect(await f.provider.requestAction(true, screen)).toMatchObject({ ready: true, reason: 'not_required', observationStarted: false, permissions: [{ name: 'screen', status: 'na' }] });
    expect(f.calls).toHaveLength(1);
  });
  test('Linux reports no OS grant required instead of an unrecoverable check-again', async () => {
    const f = fixture('linux', 'na', 'none');
    expect(await f.provider.requestAction(true, screen)).toMatchObject({ ready: true, supported: true, reason: 'not_required', recovery: 'none', observationStarted: false });
    expect(f.calls.map(call => call.method)).toEqual(['system.permissions']);
  });
  test('macOS na is not treated as a grant', async () => {
    const f = fixture('darwin', 'na', 'none');
    expect(await f.provider.checkAction(true, screen)).toMatchObject({ ready: false, supported: false, reason: 'na' });
  });
  test('a missing or duplicate permission row is not a grant', async () => {
    const f = fixture(); f.report.permissions = [];
    expect(await f.provider.requestAction(true, screen)).toMatchObject({ ready: false, reason: 'permission_unknown' });
    f.report.permissions = Array.from({ length: 2 }, () => ({ name: 'screen', status: 'granted', grant: 'pane' }));
    expect(await f.provider.checkAction(true, screen)).toMatchObject({ ready: false, reason: 'permission_unknown' });
  });
  test('unbundled macOS cannot prompt for a different application identity', async () => {
    const f = fixture(); f.report.bundled = false;
    expect(await f.provider.requestAction(true, screen)).toMatchObject({ ready: false, reason: 'unbundled', recovery: 'use_app_bundle' });
    expect(f.calls).toHaveLength(1);
  });
  test('offline panel refuses instead of choosing a different desktop', async () => {
    const f = fixture(); f.disconnect();
    expect(await f.provider.requestAction(true, screen)).toMatchObject({ reason: 'offline', ready: false, recovery: 'connect_desktop' });
    expect(f.calls).toHaveLength(0);
  });
  test.each([
    ['no_sidecar', 'connect_desktop'], ['offline', 'connect_desktop'], ['ambiguous', 'choose_device'],
    ['unsupported', 'update_desktop'], ['refused', 'check_again'], ['unreachable', 'check_again'],
  ] as const)('%s has truthful recovery', async (reason, recovery) => {
    const provider = createSetupProvider({ authorize: () => owner, permissions: {
      read: async () => ({ available: false, reason: reason as PermissionsUnavailable }),
      request: async () => { throw new Error('must not request'); },
    } });
    expect(await provider.requestAction(null, screen)).toMatchObject({ ready: false, reason, recovery });
  });
  test('old, detached and malformed sidecar replies reuse existing fail-closed checks', async () => {
    const f = fixture();
    // The sidecar's typed error, as the manager rejects it (Q-19 reads the code, not the wording).
    f.sidecars.dispatchRPC = async () => { throw new SidecarRPCError('METHOD_NOT_FOUND', 'unknown method system.permissions'); };
    expect(await f.provider.checkAction(true, screen)).toMatchObject({ reason: 'unsupported', ready: false });
    f.sidecars.dispatchRPC = async () => 'detached';
    expect(await f.provider.checkAction(true, screen)).toMatchObject({ reason: 'unreachable', ready: false });
    f.sidecars.dispatchRPC = async () => ({ platform: 'darwin', permissions: [{ name: 'screen', status: 'unknown' }] });
    expect(await f.provider.checkAction(true, screen)).toMatchObject({ reason: 'unreachable', ready: false });
  });
  test('only known action-specific permissions can be requested', async () => {
    const f = fixture();
    for (const action of ['microphone', 'all', '__proto__']) {
      expect(await f.provider.requestAction(true, { action })).toMatchObject({ reason: 'invalid_request' });
    }
    expect(await f.provider.requestAction(true, { ...screen, actorId: 'victim' })).toMatchObject({ reason: 'invalid_request' });
    expect(await f.provider.requestAction(false, screen)).toMatchObject({ reason: 'unauthorized' });
    expect(f.calls).toHaveLength(0);
    expect(() => f.permissions.read({ ...owner, actorId: 'victim' })).toThrow();
  });
  test('microphone and accessibility actions do not request screen access', async () => {
    for (const [action, name] of [['voice_input', 'microphone'], ['desktop_control', 'accessibility'], ['notifications', 'notifications']]) {
      const f = fixture(); f.report.permissions[0]!.name = name!;
      await f.provider.requestAction(true, { action });
      expect(f.calls[1]?.params).toEqual({ name });
    }
  });
  test('switching the only connected desktop between read and request cannot prompt the new device', async () => {
    const f = fixture();
    f.sidecars.resolvePanelSession = () => null;
    f.sidecars.dispatchRPC = async (_id, method) => {
      f.calls.push({ method, params: {} });
      f.sidecars.getConnectedSidecars = () => [{ id: 'desktop-b', name: 'Other', hostname: 'other' }];
      return f.report;
    };
    expect(await f.provider.requestAction(true, screen)).toMatchObject({ ready: false, reason: 'ambiguous', recovery: 'choose_device' });
    expect(f.calls.map(call => call.method)).toEqual(['system.permissions']);
  });
  test('a device switch on the final read cannot turn another desktop grant into readiness', async () => {
    const f = fixture(); let reads = 0;
    const provider = createSetupProvider({ authorize: () => owner, permissions: {
      read: async scope => {
        const response = await f.permissions.read(scope);
        if (++reads > 1 && response.available) {
          response.host.id = 'desktop-b'; response.permissions[0]!.status = 'granted';
        }
        return response;
      },
      request: (...args) => f.permissions.request(...args),
    } });
    expect(await provider.requestAction(null, screen)).toMatchObject({ ready: false, reason: 'device_changed' });
  });
});
