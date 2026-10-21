/**
 * Which workflow piece steps reach Authority, and which run without it (#955).
 *
 * `pieceAuthorize` (service-backends.ts) sends a verified piece's action
 * through the effect boundary, and every one of Jarvis's own pieces passes the
 * boundary per effect. Everything else is admitted by `admitUngovernedStep`:
 * it obeys Pause and Kill but never asks for approval. Among those, a
 * community piece leaves an audit row for each dispatch; the built-in steps
 * vendored with the engine leave none.
 *
 * The dashboard is told the same thing (`/api/workflows/pieces`), so the
 * editor's "Not approval-gated" badge and the daemon's admission cannot drift.
 */

import { GOVERNED_PIECE_ADAPTERS } from './piece-effects';

/** Jarvis's own pieces: each of their effects passes the boundary and is audited there. */
export const JARVIS_PIECE_PREFIX = '@jarvispieces/';

/** The built-in steps vendored with the engine (`scripts/sync-activepieces.ts`); never audited as steps. */
export const BUILT_IN_STEP_PIECES: ReadonlySet<string> = new Set([
  '@activepieces/piece-approval', '@activepieces/piece-delay', '@activepieces/piece-file-helper',
  '@activepieces/piece-http', '@activepieces/piece-schedule', '@activepieces/piece-store', '@activepieces/piece-webhook',
]);

const VERIFIED_PIECE_NAMES: ReadonlySet<string> = new Set(GOVERNED_PIECE_ADAPTERS.map((adapter) => adapter.pieceName));

/**
 * A community piece: no governed adapter, not one of Jarvis's own pieces and
 * not a built-in step. Its actions run without approval, whatever the governed
 * categories say; each dispatch is audited and obeys Pause and Kill.
 */
export function isCommunityPiece(pieceName: string): boolean {
  return !VERIFIED_PIECE_NAMES.has(pieceName) && !pieceName.startsWith(JARVIS_PIECE_PREFIX) && !BUILT_IN_STEP_PIECES.has(pieceName);
}
