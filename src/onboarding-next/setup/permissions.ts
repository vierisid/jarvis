import type { PermissionName, PermissionsResult } from '../../daemon/system-permissions.ts';
import type { NativeAccess, NativeAction, SetupPermissions, SetupScope } from './types.ts';

const required: Record<NativeAction, PermissionName> = {
  screen_observation: 'screen', voice_input: 'microphone', desktop_control: 'accessibility', notifications: 'notifications',
};
function actionFrom(input: unknown): NativeAction | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1) return null;
  const action = (input as { action?: unknown }).action;
  return typeof action === 'string' && Object.hasOwn(required, action) ? action as NativeAction : null;
}
function unavailable(reason: string, recovery: NativeAccess['recovery'] = 'check_again'): NativeAccess {
  return { schemaVersion: 1, supported: false, ready: false, reason, observationStarted: false, recovery };
}
function project(report: PermissionsResult, name: PermissionName): NativeAccess {
  if (!report.available) {
    const recovery = report.reason === 'no_sidecar' || report.reason === 'offline' ? 'connect_desktop'
      : report.reason === 'unsupported' ? 'update_desktop' : report.reason === 'ambiguous' ? 'choose_device' : 'check_again';
    return unavailable(report.reason, recovery);
  }
  if (report.platform === 'darwin' && !report.bundled) return unavailable('unbundled', 'use_app_bundle');
  const rows = report.permissions.filter(row => row.name === name);
  if (rows.length !== 1) return unavailable('permission_unknown');
  const row = rows[0]!;
  // `na` means the OS has no per-app grant for this (Windows, Linux). The live
  // Permissions screen shows nothing to do for such rows; only macOS `na` is
  // treated as an unknown, unsupported answer.
  const notRequired = row.status === 'na' && report.platform !== 'darwin';
  const ready = row.status === 'granted' || notRequired;
  return {
    schemaVersion: 1, supported: row.status !== 'na' || notRequired, ready,
    reason: ready ? (row.status === 'na' ? 'not_required' : 'granted') : row.status,
    observationStarted: false, hostId: report.host.id,
    permissions: [{ name, status: row.status }],
    recovery: ready ? 'none' : row.grant === 'pane' ? 'open_settings' : row.grant === 'prompt' ? 'request_access' : 'check_again',
  };
}
export async function checkNativeAccess(scope: SetupScope | null, ports: SetupPermissions | undefined, input: unknown): Promise<NativeAccess> {
  if (!scope) return unavailable('unauthorized');
  const action = actionFrom(input);
  if (!action) return unavailable('invalid_request');
  if (!ports) return unavailable('provider_unavailable');
  try { return project(await ports.read(scope), required[action]); }
  catch { return unavailable('unreachable'); }
}
export async function requestNativeAccess(scope: SetupScope | null, ports: SetupPermissions | undefined, input: unknown): Promise<NativeAccess> {
  if (!scope) return unavailable('unauthorized');
  const action = actionFrom(input);
  if (!action) return unavailable('invalid_request');
  if (!ports) return unavailable('provider_unavailable');
  try {
    const name = required[action];
    const before = await ports.read(scope);
    const access = project(before, name);
    if (!access.supported || access.ready || !before.available) return access;
    const response = await ports.request(scope, name, before.host.id);
    if (!response.available) return project(response, name);
    if (response.host.id !== before.host.id) return unavailable('device_changed');
    const after = await ports.read(scope);
    if (after.available && after.host.id !== before.host.id) return unavailable('device_changed');
    const current = project(after, name);
    if (!current.ready && response.grant === 'pane') {
      if (!response.paneOpened) return { ...current, reason: 'settings_not_opened', recovery: 'open_settings' };
      if (after.available && after.platform === 'darwin' && name === 'screen') {
        return { ...current, recovery: 'restart_may_be_required' };
      }
    }
    return current;
  } catch { return unavailable('unreachable'); }
}
