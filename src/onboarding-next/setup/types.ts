import type { PermissionName, PermissionRequestResult, PermissionsResult } from '../../daemon/system-permissions.ts';

/** Local v1 projection. No imports from sibling onboarding modules. */
export type InstallMode = 'unknown' | 'hosted' | 'self';
export interface SetupScope { actorId: string; projectId: string }
export interface SetupState {
  installMode: InstallMode;
  configured: boolean;
  completedAt: number | null;
}
export interface SetupStore {
  read(scope: SetupScope): SetupState | Promise<SetupState>;
  /** Idempotent, credential-free hosted commit; completion is persisted last. */
  completeHosted(scope: SetupScope): number | Promise<number>;
}
export interface SetupServices {
  /** Live readiness, not merely whether a startup promise resolved. */
  read(scope: SetupScope): Promise<'running' | 'stopped' | 'unavailable'>;
  /** Existing idempotent service starter. It must not turn on Awareness. */
  start(scope: SetupScope): Promise<void>;
}
export interface SetupPermissions {
  read(scope: SetupScope): Promise<PermissionsResult>;
  request(scope: SetupScope, name: PermissionName, expectedHostId: string): Promise<PermissionRequestResult>;
}
export interface SetupPorts<Context> {
  /** Must resolve the authenticated actor/project on every operation. */
  authorize(context: Context): SetupScope | null | Promise<SetupScope | null>;
  store?: SetupStore;
  services?: SetupServices;
  permissions?: SetupPermissions;
}
export type SetupReason = 'ready' | 'setup_required' | 'install_mode_unknown'
  | 'hosted_configuration_unavailable' | 'legacy_setup_required' | 'provider_unavailable'
  | 'unauthorized' | 'invalid_request' | 'setup_unavailable' | 'setup_save_failed'
  | 'services_unavailable' | 'services_not_running' | 'services_start_failed';
export interface SetupResult {
  schemaVersion: 1;
  installMode: InstallMode;
  supported: boolean;
  ready: boolean;
  reason: SetupReason;
  completedAt: number | null;
  services: 'not_checked' | 'running' | 'stopped' | 'unavailable';
  next: 'continue' | 'retry' | 'legacy_setup';
}
export type NativeAction = 'screen_observation' | 'voice_input' | 'desktop_control' | 'notifications';
export interface NativeAccess {
  schemaVersion: 1;
  supported: boolean;
  ready: boolean;
  reason: string;
  /** A usable grant is not consent to capture, and this provider never captures. */
  observationStarted: false;
  recovery: 'none' | 'check_again' | 'connect_desktop' | 'update_desktop' | 'choose_device'
    | 'request_access' | 'open_settings' | 'restart_may_be_required' | 'use_app_bundle';
  hostId?: string;
  permissions?: Array<{ name: PermissionName; status: 'granted' | 'denied' | 'undetermined' | 'na' }>;
}
