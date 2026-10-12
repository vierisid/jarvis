import { uuid } from '../../lib/uuid';
import type { ConnectedWorkspaceSnapshot, ConnectionSetupAction, ConnectedRow } from '../../../../src/brief/connected-workspace-contracts';

export interface ConnectedPosition { search: string; anchorId: string | null; scrollTop: number }
export interface SetupAttempt {
  version: 1; scopeId: string; nonce: string; actionId: string; rowId: string | null;
  position: ConnectedPosition; expiresAt: number; phase: 'pending' | 'returned' | 'canceled' | 'expired';
}
export interface SetupPorts {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  read: () => Promise<ConnectedWorkspaceSnapshot>;
  open: (action: ConnectionSetupAction, rowId: string | null) => void;
  now?: () => number;
  nonce?: () => string;
}
const TTL = 10 * 60_000;
const id = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 600;
function validPosition(p: ConnectedPosition): boolean {
  return !!p && typeof p.search === 'string' && p.search.length <= 300 && (p.anchorId === null || id(p.anchorId)) &&
    Number.isFinite(p.scrollTop) && p.scrollTop >= 0 && p.scrollTop <= 10_000_000;
}

/** Headless F-22 adapter. D-27 owns rendering; current setup surfaces own secrets and their own state/PKCE/nonce. */
export class ConnectionSetup {
  private readonly key: string;
  private attempt: SetupAttempt | null = null;
  private generation = 0;
  private readonly now: () => number;
  constructor(private readonly scopeId: string, private readonly ports: SetupPorts) {
    this.key = `jarvis:brief:connection-setup:v1:${scopeId}`; this.now = ports.now ?? Date.now;
    try {
      const raw = ports.storage.getItem(this.key);
      if (!raw || raw.length > 4096) return;
      const a = JSON.parse(raw) as SetupAttempt;
      if (a.version !== 1 || a.scopeId !== scopeId || !id(a.nonce) || !id(a.actionId) || (a.rowId !== null && !id(a.rowId)) ||
        !validPosition(a.position) || !Number.isFinite(a.expiresAt) || a.expiresAt > this.now() + TTL ||
        !['pending','returned','canceled','expired'].includes(a.phase)) return;
      // A restored attempt never reopens a popup, retries enrollment or trusts a prior status result.
      this.attempt = { version: 1, scopeId, nonce: a.nonce, actionId: a.actionId, rowId: a.rowId,
        position: { search: a.position.search, anchorId: a.position.anchorId, scrollTop: a.position.scrollTop }, expiresAt: a.expiresAt,
        phase: a.phase === 'canceled' ? 'canceled' : a.expiresAt <= this.now() ? 'expired' : 'returned' };
    } catch { /* Unavailable persistence must prevent launch, but not crash the room. */ }
  }
  current(): SetupAttempt | null {
    if (this.attempt && this.attempt.phase !== 'canceled' && this.attempt.expiresAt <= this.now()) this.attempt.phase = 'expired';
    return this.attempt ? structuredClone(this.attempt) : null;
  }
  private save(attempt: SetupAttempt) {
    // Persist before leaving. If storage fails, no external setup is launched.
    this.ports.storage.setItem(this.key, JSON.stringify(attempt)); this.attempt = attempt;
  }
  private async snapshot(): Promise<ConnectedWorkspaceSnapshot> {
    const result = await this.ports.read();
    if (result.contractVersion !== 1 || result.scopeId !== this.scopeId || !Array.isArray(result.rows) || !Array.isArray(result.setup)) throw new Error('Connected workspace unavailable');
    return result;
  }
  async begin(actionId: string, position: ConnectedPosition, rowId: string | null = null): Promise<SetupAttempt | null> {
    if (!id(actionId) || !validPosition(position)) throw new Error('Invalid setup selection');
    const generation = ++this.generation, snapshot = await this.snapshot();
    if (generation !== this.generation) return null;
    const action = snapshot.setup.find(a => a.id === actionId);
    if (!action) throw new Error('Setup unavailable');
    const row = rowId ? snapshot.rows.find(r => r.sourceId === rowId) : null;
    if (rowId && (!row || row.setupActionId !== action.id || row.kind !== action.verifies.kind || row.serviceId !== action.verifies.serviceId)) throw new Error('Setup target changed');
    const attempt: SetupAttempt = { version: 1, scopeId: this.scopeId, nonce: this.ports.nonce?.() ?? uuid(),
      actionId, rowId, position: structuredClone(position), expiresAt: this.now() + TTL, phase: 'pending' };
    this.save(attempt);
    try { this.ports.open(action, rowId); } catch { this.save({ ...attempt, phase: 'returned' }); throw new Error('Setup could not open'); }
    return this.current();
  }
  cancel(): ConnectedPosition | null {
    this.generation++;
    if (!this.attempt) return null;
    this.save({ ...this.attempt, phase: 'canceled' }); return structuredClone(this.attempt.position);
  }
  /** Local handoff nonce, NOT an OAuth credential. A popup message alone never changes a row. */
  returned(nonce: string): ConnectedPosition | null {
    const a = this.current();
    if (!a || a.nonce !== nonce || ['expired','canceled'].includes(a.phase)) return null;
    this.save({ ...a, phase: 'returned' }); return structuredClone(a.position);
  }
  async verify(nonce: string, selectedRowId?: string): Promise<{ row: ConnectedRow; result: 'connected' | 'configured' | 'not_connected' } | null> {
    const a = this.current(), generation = ++this.generation;
    if (!a || a.nonce !== nonce || ['expired','canceled'].includes(a.phase)) return null;
    const snapshot = await this.snapshot();
    if (generation !== this.generation || this.current()?.phase === 'expired') return null;
    const action = snapshot.setup.find(s => s.id === a.actionId);
    const targetId = a.rowId ?? selectedRowId;
    if (!action || !targetId || a.rowId && selectedRowId && selectedRowId !== a.rowId) return null;
    const row = snapshot.rows.find(r => r.sourceId === targetId);
    if (!row || row.kind !== action.verifies.kind || row.serviceId !== action.verifies.serviceId) return null;
    this.save({ ...a, phase: 'returned' });
    return { row, result: row.status === 'connected' && row.authenticated === true ? 'connected' : row.status === 'configured' ? 'configured' : 'not_connected' };
  }
}
