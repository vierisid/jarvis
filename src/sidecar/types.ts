/**
 * Sidecar Types
 *
 * Types for the brain-side sidecar management system.
 */

import type { SidecarUpdateStatus } from './compat.ts';

/** Capabilities a sidecar can advertise */
export type SidecarCapability =
  | 'terminal'
  | 'filesystem'
  | 'desktop'
  | 'browser'
  | 'clipboard'
  | 'screenshot'
  | 'system_info'
  | 'awareness'
  | 'windows'
  | 'pebble'
  | 'sub_pebble';

/** A capability that is enabled in config but unavailable on the system */
export interface UnavailableCapability {
  name: SidecarCapability;
  reason: string;
}

/** Sidecar status in the database */
export type SidecarStatus = 'enrolled' | 'revoked';

/** Sidecar record as stored in the database */
export interface SidecarRecord {
  id: string;
  name: string;
  token_id: string;
  enrolled_at: string;
  last_seen_at: string | null;
  status: SidecarStatus;
  /** Populated after first connection */
  hostname: string | null;
  os: string | null;
  platform: string | null;
  /** JSON-encoded SidecarCapability[] — populated after first connection */
  capabilities: string | null;
  /** Sidecar's own semver, reported on register ("dev" for local builds) */
  version: string | null;
  /** IANA timezone reported on register (null = unknown/old sidecar) */
  timezone: string | null;
}

/** JWT claims for a sidecar enrollment token */
export interface SidecarTokenClaims {
  /** Subject: "sidecar:<id>" */
  sub: string;
  /** Unique token ID (for revocation tracking) */
  jti: string;
  /** Sidecar UUID */
  sid: string;
  /** Human-readable sidecar name */
  name: string;
  /** WebSocket URL for the sidecar to connect to */
  brain: string;
  /** URL to fetch the brain's JWKS public key */
  jwks: string;
  /**
   * Brain's anonymous telemetry id (see src/telemetry/anon-id.ts), so the
   * sidecar can report which brain it belongs to without learning anything
   * identifying. Absent on tokens issued before sidecar telemetry existed —
   * those sidecars simply report no brain correlation until re-enrolled.
   */
  bid?: string;
  /** Issued-at timestamp */
  iat: number;
}

/** Registration message sent by sidecar on WebSocket connect */
export interface SidecarRegistration {
  type: 'register';
  hostname: string;
  os: string;
  platform: string;
  /** Sidecar's own semver ("dev" for unstamped local builds) */
  version?: string;
  capabilities: SidecarCapability[];
  unavailable_capabilities?: UnavailableCapability[];
}

/** Capabilities update message sent by sidecar when config changes */
export interface SidecarCapabilitiesUpdate {
  type: 'capabilities_update';
  capabilities: SidecarCapability[];
  unavailable_capabilities?: UnavailableCapability[];
}

/** A connected sidecar (runtime state, not persisted) */
export interface ConnectedSidecar {
  id: string;
  name: string;
  hostname: string;
  os: string;
  platform: string;
  /** Sidecar's own semver reported on register ("dev" for local builds) */
  version: string;
  /** Compatibility verdict the brain reached at register (never 'blocked' here — blocked sidecars never register) */
  updateStatus: SidecarUpdateStatus;
  capabilities: SidecarCapability[];
  unavailableCapabilities: UnavailableCapability[];
  /** IANA timezone reported on register ("" = unknown) */
  timezone?: string;
  connectedAt: Date;
}

/** Sidecar config as returned by get_config RPC (token excluded) */
export interface SidecarConfig {
  capabilities: SidecarCapability[];
  terminal: { blocked_commands: string[]; default_shell: string; timeout_ms: number };
  filesystem: { blocked_paths: string[]; max_file_size_kb: number };
  browser: { cdp_port: number; profile_dir: string };
  awareness: { screen_interval_ms: number; window_interval_ms: number; min_change_threshold: number; stuck_threshold_ms: number };
}

/** Sidecar info returned by API (DB record + connection state) */
export interface SidecarInfo {
  id: string;
  name: string;
  enrolled_at: string;
  last_seen_at: string | null;
  status: SidecarStatus;
  connected: boolean;
  hostname?: string;
  os?: string;
  platform?: string;
  capabilities?: SidecarCapability[];
  unavailable_capabilities?: UnavailableCapability[];
  /** Sidecar's own semver (from the last connection; persisted) */
  version?: string;
  /** Compatibility verdict (only while connected): 'ok' | 'suggested' | 'dev' */
  update_status?: SidecarUpdateStatus;
}
