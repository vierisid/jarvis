/**
 * Which workflow piece steps reach Authority, and which run without it (#955, #961).
 *
 * `pieceAuthorize` (service-backends.ts) sends a governed piece's action
 * through the effect boundary: a verified catalog piece, or a vendored core
 * piece that acts outside Jarvis, such as the HTTP request (#961). Every one of
 * Jarvis's own pieces passes the boundary per effect. Everything else is
 * admitted by `admitUngovernedStep`: it obeys Pause and Kill but never asks for
 * approval. Among those, a community piece leaves an audit row for each
 * dispatch; the in-run core steps below leave none.
 *
 * The dashboard is told the same thing (`/api/workflows/pieces`), so the
 * editor's "Not approval-gated" badge and the daemon's admission cannot drift.
 */

import { isGovernedPiece } from './piece-effects';

/** Jarvis's own pieces: each of their effects passes the boundary and is audited there. */
export const JARVIS_PIECE_PREFIX = '@jarvispieces/';

/**
 * The vendored core pieces whose actions act only inside the run and Jarvis's
 * own workflow storage, so there is nothing outside Jarvis for Authority to
 * judge (#961). They are not audited one by one and obey Pause and Kill:
 *   approval     waits for a click on a resume link it makes; sends nothing.
 *   delay        waits.
 *   file-helper  reads, converts, zips and unzips the run's own files.
 *   schedule     a trigger only; no actions.
 *   store        reads and writes the workflow's own key-value store.
 * A core piece that reaches outside Jarvis is governed instead
 * (`CORE_PIECE_ADAPTERS` in piece-effects.ts), and `core-pieces.test.ts` holds
 * every vendored core piece, and every action of each one here, to exactly one
 * of the two.
 */
export const IN_RUN_STEP_PIECES: ReadonlySet<string> = new Set([
  '@activepieces/piece-approval', '@activepieces/piece-delay', '@activepieces/piece-file-helper',
  '@activepieces/piece-schedule', '@activepieces/piece-store',
]);

/**
 * A community piece: no governed adapter, not one of Jarvis's own pieces and
 * not an in-run core step. Its actions run without approval, whatever the
 * governed categories say; each dispatch is audited and obeys Pause and Kill.
 */
export function isCommunityPiece(pieceName: string): boolean {
  return !isGovernedPiece(pieceName) && !pieceName.startsWith(JARVIS_PIECE_PREFIX) && !IN_RUN_STEP_PIECES.has(pieceName);
}
