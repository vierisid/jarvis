import { uuid } from '../../../lib/uuid';
import type { ConnectionSetupTarget } from '../../../../../src/brief/connected-workspace-contracts';
export type PieceSetupRequest = Extract<ConnectionSetupTarget, { kind: 'piece_credentials' }> & { rowId: string | null; requestId: string };
export const CONNECTION_SETUP_EVENT = 'jarvis:connection-setup';
export type ManagedSetupRequest = Extract<ConnectionSetupTarget, { kind: 'hosted_integration' }> & { rowId: null; requestId: string };
let pending: PieceSetupRequest | ManagedSetupRequest | null = null;
export function requestPieceSetup(request: Omit<PieceSetupRequest, 'requestId'>): void {
  pending = { ...request, requestId: uuid() };
  window.dispatchEvent(new CustomEvent(CONNECTION_SETUP_EVENT));
}
export function requestManagedSetup(provider: ManagedSetupRequest['provider']): void {
  pending = { kind: 'hosted_integration', provider, rowId: null, requestId: uuid() };
  window.dispatchEvent(new CustomEvent(CONNECTION_SETUP_EVENT));
}
export function hasPieceSetup(): boolean { return pending !== null; }
export function takePieceSetup(): PieceSetupRequest | ManagedSetupRequest | null { const result = pending; pending = null; return result; }
