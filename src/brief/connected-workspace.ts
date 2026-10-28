import type { Database } from 'bun:sqlite';
import { DEFAULT_IDS } from '../workflows/db';
import type { PieceLookup } from '../workflows/runtime/piece-catalog';
import type { SidecarInfo } from '../sidecar/types';
import type { ConnectedRow, ConnectedWorkspaceSnapshot, ConnectionSetupAction } from './connected-workspace-contracts';

export interface ConnectedWorkspaceSources {
  devices?: () => Pick<SidecarInfo, 'id' | 'name' | 'status' | 'connected'>[];
  clickup?: () => { configured: boolean; connected: boolean; account: {id: string; label: string} | null };
  github?: () => { configured: boolean; connected: boolean; account: {id: string; label: string} | null };
  asana?: () => { configured: boolean; connected: boolean; account: {id: string; label: string} | null };
  google?: () => { mode: 'self' | 'managed' | 'none' | 'unavailable'; authenticated: boolean; reconnect: boolean; canSetup: boolean };
  channels?: () => Partial<Record<'telegram' | 'discord', { enabled: boolean; connected: boolean; authentication?: 'verified' | 'rejected' | 'unknown' }>>;
  pieces?: () => PieceLookup | null;
  hosted: () => boolean;
}
export const CONNECTED_LIMIT = 1000;
const safeId = (s: string) => typeof s === 'string' && /^[\w@./:-]{1,256}$/.test(s);
const safeVersion = (s: string) => typeof s === 'string' && /^[a-zA-Z0-9.+_-]{1,256}$/.test(s);
const label = (s: string) => s.replace(/[\x00-\x1f\x7f<>]/g, '').slice(0, 160).trim() || 'Unnamed';
const oauth = (s: string) => ['OAUTH2', 'PLATFORM_OAUTH2', 'CLOUD_OAUTH2'].includes(s);
const authTypes = new Set(['OAUTH2', 'PLATFORM_OAUTH2', 'CLOUD_OAUTH2', 'SECRET_TEXT', 'BASIC_AUTH', 'CUSTOM_AUTH']);
interface AccountMetadata { id: string; display_name: string; piece_name: string; piece_version: string; status: string; type: string }

/** No credential reads, refreshes, enrollment, installs or probe requests. Each read observes current repositories. */
export class ConnectedWorkspace {
  constructor(private readonly db: Database, private readonly sources: ConnectedWorkspaceSources,
    readonly projectId: string = DEFAULT_IDS.project, private readonly ownerId: string = DEFAULT_IDS.user,
    private readonly enabled = () => process.env.JARVIS_BRIEF_CONNECTIONS === '1') {}

  readiness(): 'ready' | 'unavailable' { return this.enabled() ? 'ready' : 'unavailable'; }

  read(): ConnectedWorkspaceSnapshot {
    if (this.readiness() !== 'ready') throw new Error('disabled');
    const rows: ConnectedRow[] = [], setup: ConnectionSetupAction[] = [];
    const states: ConnectedWorkspaceSnapshot['sources'] = { devices: 'unavailable', google: 'unavailable', channels: 'unavailable', pieces: 'unavailable', accounts: 'unavailable' };
    const base = (sourceId: string, kind: ConnectedRow['kind'], serviceId: string, name: string): ConnectedRow => ({
      sourceId, kind, serviceId, label: label(name), accountId: null, availability: 'unknown', authenticated: null,
      permissions: { canInspect: true, canConnect: false, canRevoke: false }, status: 'unknown', evidence: 'none', pieceVersion: null, setupActionId: null,
    });
    const offer = (row: ConnectedRow, action: ConnectionSetupAction) => {
      if (!setup.some(a => a.id === action.id)) setup.push(action);
      row.permissions.canConnect = true; row.setupActionId = action.id;
    };
    // Native services/devices/channels belong to the daemon's account, not every arbitrary project.
    // Legacy setup surfaces also operate in that account. Never route another project's writes there.
    const instanceScope = this.projectId === DEFAULT_IDS.project && this.ownerId === DEFAULT_IDS.user;
    if (instanceScope) {
      try {
        if (!this.sources.devices) throw new Error('absent');
        const devices = this.sources.devices();
        if (devices.length > CONNECTED_LIMIT) throw new Error('capacity');
        const action: ConnectionSetupAction = { id: 'setup:device', label: 'Add a device',
          target: { kind: 'device', flow: this.sources.hosted() ? 'hosted_sign_in' : 'enrollment' }, verifies: { kind: 'device', serviceId: 'sidecar' } };
        const deviceRows = devices.map(d => {
          if (!safeId(d.id)) throw new Error('invalid identity');
          const row = base(`device:${d.id}`, 'device', 'sidecar', d.name);
          row.accountId = d.id;
          row.authenticated = d.status === 'enrolled' && d.connected;
          row.status = row.authenticated ? 'connected' : 'disconnected';
          row.availability = row.authenticated ? 'ready' : 'unavailable';
          row.evidence = row.authenticated ? 'live_session' : 'none';
          row.permissions.canRevoke = d.status === 'enrolled';
          return row;
        });
        rows.push(...deviceRows); setup.push(action); states.devices = 'ready';
      } catch { /* Missing source is not an empty device list. */ }
      const google = base('native:google', 'native_service', 'google', 'Google');
      try {
        if (!this.sources.google) throw new Error('absent');
        const g = this.sources.google();
        if (g.mode === 'unavailable') throw new Error('unavailable');
        google.authenticated = !g.reconnect && g.authenticated;
        google.status = g.reconnect ? 'reconnect_required' : google.authenticated ? 'connected' : 'disconnected';
        google.availability = google.authenticated ? 'ready' : 'unavailable';
        google.evidence = google.authenticated ? 'stored_grant' : 'none';
        google.permissions.canRevoke = g.mode === 'self' && g.authenticated;
        if (g.canSetup) offer(google, { id: 'setup:google', label: 'Google', target: { kind: 'google',
          flow: g.mode === 'managed' ? 'hosted_browser' : g.mode === 'self' ? 'oauth' : 'manual_client' }, verifies: { kind: 'native_service', serviceId: 'google' } });
        states.google = 'ready';
      } catch { google.status = 'unavailable'; }
      rows.push(google);
      if (this.sources.clickup) {
        const row = base('native:clickup', 'native_service', 'clickup', 'ClickUp');
        try {
          const c = this.sources.clickup();
          if (c.configured || c.connected) {
            row.authenticated = c.connected; row.status = c.connected ? 'connected' : 'disconnected';
            row.availability = c.connected ? 'ready' : 'unavailable';
            row.accountId = c.account?.id ?? null;
            row.label = c.account ? label('ClickUp: ' + c.account.label) : 'ClickUp';
            row.evidence = c.connected ? 'stored_grant' : 'none';
            if (c.configured) offer(row, {id: 'setup:clickup', label: 'ClickUp',
              target: {kind: 'hosted_integration', provider: 'clickup'}, verifies: {kind: 'native_service', serviceId: 'clickup'}});
            rows.push(row);
          }
        } catch { row.status = 'unavailable'; rows.push(row); }
      }
      if (this.sources.github) {
        const row = base('native:github', 'native_service', 'github', 'GitHub');
        try {
          const c = this.sources.github();
          if (c.configured || c.connected) {
            row.authenticated = c.connected; row.status = c.connected ? 'connected' : 'disconnected';
            row.availability = c.connected ? 'ready' : 'unavailable';
            row.accountId = c.account?.id ?? null;
            row.label = c.account ? label('GitHub: ' + c.account.label) : 'GitHub';
            row.evidence = c.connected ? 'stored_grant' : 'none';
            if (c.configured) offer(row, {id: 'setup:github', label: 'GitHub',
              target: {kind: 'hosted_integration', provider: 'github'}, verifies: {kind: 'native_service', serviceId: 'github'}});
            rows.push(row);
          }
        } catch { row.status = 'unavailable'; rows.push(row); }
      }
      if (this.sources.asana) {
        const row = base('native:asana', 'native_service', 'asana', 'Asana');
        try {
          const c = this.sources.asana();
          if (c.configured || c.connected) {
            row.authenticated = c.connected; row.status = c.connected ? 'connected' : 'disconnected';
            row.availability = c.connected ? 'ready' : 'unavailable';
            row.accountId = c.account?.id ?? null;
            row.label = c.account ? label('Asana: ' + c.account.label) : 'Asana';
            row.evidence = c.connected ? 'stored_grant' : 'none';
            if (c.configured) offer(row, {id: 'setup:asana', label: 'Asana',
              target: {kind: 'hosted_integration', provider: 'asana'}, verifies: {kind: 'native_service', serviceId: 'asana'}});
            rows.push(row);
          }
        } catch { row.status = 'unavailable'; rows.push(row); }
      }
      try {
        if (!this.sources.channels) throw new Error('absent');
        const channels = this.sources.channels();
        for (const name of ['telegram', 'discord'] as const) {
          const row = base(`channel:${name}`, 'channel', name, name === 'telegram' ? 'Telegram' : 'Discord');
          const c = channels[name];
          if (c) {
            row.authenticated = !c.enabled || c.authentication === 'rejected' ? false : c.connected && c.authentication === 'verified' ? true : null;
            row.status = c.authentication === 'rejected' ? 'reconnect_required' : !c.enabled || !c.connected ? 'disconnected' : row.authenticated ? 'connected' : 'unknown';
            row.availability = row.authenticated ? 'ready' : row.status === 'unknown' ? 'unknown' : 'unavailable';
            row.evidence = row.authenticated ? 'provider_status' : 'none';
            offer(row, { id: `setup:${name}`, label: row.label, target: { kind: 'channel', channel: name }, verifies: { kind: 'channel', serviceId: name } });
          }
          rows.push(row);
        }
        states.channels = 'ready';
      } catch { /* Report source unavailable; do not offer a setup path from unknown config. */ }
    }
    let pieces: ReturnType<PieceLookup['list']> = [];
    try {
      const catalog = this.sources.pieces?.();
      if (!catalog) throw new Error('absent');
      pieces = catalog.list();
      if (pieces.length > CONNECTED_LIMIT || pieces.some(p => !safeId(p.name) || (p.version !== undefined && !safeVersion(p.version)))) throw new Error('invalid catalog');
      for (const p of pieces) {
        const row = base(`piece:${p.name}`, 'library_piece', p.name, p.displayName);
        row.status = 'installed'; row.availability = 'ready'; row.evidence = 'loaded_piece'; row.pieceVersion = p.version ?? null;
        // The current connection form accepts credentials manually, even for OAuth-shaped values.
        // There is no universal piece OAuth broker. Only loaded, versioned auth declarations are offered.
        if (instanceScope && p.version && p.auth && authTypes.has(p.auth.type)) offer(row, {
          id: `setup:piece:${p.name}`, label: p.displayName.slice(0,160),
          target: { kind: 'piece_credentials', pieceName: p.name, pieceVersion: p.version, authType: p.auth.type },
          verifies: { kind: 'workflow_connection', serviceId: p.name },
        });
        rows.push(row);
      }
      states.pieces = 'ready';
    } catch { pieces = []; }
    try {
      // Explicit bounded columns; never select/decrypt value, metadata, externalId, owner or arbitrary error text.
      const accounts = this.db.query<AccountMetadata, [string, string]>(`SELECT substr(id,1,257) AS id, substr(display_name,1,160) AS display_name,
        substr(piece_name,1,257) AS piece_name, substr(piece_version,1,257) AS piece_version, status, type FROM app_connection WHERE project_id = ? AND (owner_id IS NULL OR owner_id = ?)
        ORDER BY id LIMIT ${CONNECTED_LIMIT + 1}`).all(this.projectId, this.ownerId);
      if (accounts.length > CONNECTED_LIMIT || accounts.some(a => !safeId(a.id) || !safeId(a.piece_name) || !safeVersion(a.piece_version))) throw new Error('invalid accounts');
      for (const a of accounts) {
        const row = base(`account:${a.id}`, 'workflow_connection', a.piece_name, a.display_name);
        const piece = pieces.find(p => p.name === a.piece_name);
        const compatible = !!piece?.auth && (piece.auth.type === a.type || oauth(piece.auth.type) && oauth(a.type));
        row.accountId = a.id; row.pieceVersion = a.piece_version;
        row.status = a.status === 'ERROR' ? 'reconnect_required' : a.status === 'MISSING' ? 'disconnected' : a.status === 'ACTIVE' ? 'configured' : 'unknown';
        row.availability = a.status !== 'ACTIVE' || states.pieces === 'ready' && !compatible ? 'unavailable' : 'unknown';
        // ACTIVE is user writable and the credential endpoint only validates shape. It is not authentication proof.
        row.authenticated = a.status === 'ERROR' || a.status === 'MISSING' ? false : null;
        row.evidence = a.status === 'ACTIVE' ? 'saved_credentials' : 'none';
        row.permissions.canRevoke = instanceScope;
        const action = setup.find(s => s.id === `setup:piece:${a.piece_name}`);
        if (action && compatible) offer(row, action);
        rows.push(row);
      }
      states.accounts = 'ready';
    } catch { /* Unreadable is not empty. Other sources remain usable. */ }
    rows.sort((a,b) => a.sourceId.localeCompare(b.sourceId));
    setup.sort((a,b) => a.id.localeCompare(b.id));
    // Duplicate identities can never be reconciled safely by a client.
    if (new Set(rows.map(r => r.sourceId)).size !== rows.length) throw new Error('duplicate identity');
    const result: ConnectedWorkspaceSnapshot = { contractVersion: 1, scopeId: this.projectId, asOf: Date.now(), rows, setup, sources: states };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 2_000_000) throw new Error('capacity');
    return result;
  }
}
