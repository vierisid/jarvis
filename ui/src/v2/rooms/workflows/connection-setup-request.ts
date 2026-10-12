import { uuid } from '../../../lib/uuid';
import type { ConnectionSetupTarget } from '../../../../../src/brief/connected-workspace-contracts';
export type PieceSetupRequest = Extract<ConnectionSetupTarget, { kind: 'piece_credentials' }> & { rowId: string | null; requestId: string };
export const CONNECTION_SETUP_EVENT = 'jarvis:connection-setup';
let pending: PieceSetupRequest | null = null;
export function requestPieceSetup(request: Omit<PieceSetupRequest, 'requestId'>): void {
  pending = { ...request, requestId: uuid() };
  window.dispatchEvent(new CustomEvent(CONNECTION_SETUP_EVENT));
}
export function hasPieceSetup(): boolean { return pending !== null; }
export function takePieceSetup(): PieceSetupRequest | null { const result = pending; pending = null; return result; }
