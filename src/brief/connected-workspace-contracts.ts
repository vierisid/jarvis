import type { BriefConnection } from './contracts';

/** F-22 adds detail without changing the F-01 identity/permission contract. */
export interface ConnectedRow extends BriefConnection {
  label: string;
  serviceId: string;
  status: 'connected' | 'disconnected' | 'configured' | 'reconnect_required' | 'installed' | 'unavailable' | 'unknown';
  /** Authentication is a source observation, never inferred from installation or saved credentials. */
  evidence: 'live_session' | 'provider_status' | 'stored_grant' | 'saved_credentials' | 'loaded_piece' | 'none';
  pieceVersion: string | null;
  setupActionId: string | null;
}
export type ConnectionSetupTarget =
  | { kind: 'google'; flow: 'oauth' | 'manual_client' | 'hosted_browser' }
  | { kind: 'hosted_integration'; provider: 'clickup' | 'github' | 'trello' | 'mailchimp' | 'asana' }
  | { kind: 'channel'; channel: 'telegram' | 'discord' }
  | { kind: 'device'; flow: 'enrollment' | 'hosted_sign_in' }
  | { kind: 'piece_credentials'; pieceName: string; pieceVersion: string; authType: string };
export interface ConnectionSetupAction {
  id: string;
  label: string;
  target: ConnectionSetupTarget;
  /** Canonical row kind/service to read after returning; callback messages cannot supply status. */
  verifies: { kind: ConnectedRow['kind']; serviceId: string };
}
export interface ConnectedWorkspaceSnapshot {
  contractVersion: 1;
  scopeId: string;
  asOf: number;
  rows: ConnectedRow[];
  setup: ConnectionSetupAction[];
  sources: Record<'devices' | 'google' | 'channels' | 'pieces' | 'accounts', 'ready' | 'unavailable'>;
}
export type ConnectedWorkspaceResult =
  | { status: 'ready'; data: ConnectedWorkspaceSnapshot }
  | { status: 'unavailable' | 'unsupported'; code: string };
