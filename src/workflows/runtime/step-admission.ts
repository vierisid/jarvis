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

import { isGovernedPiece, resolveGovernedPieceAction } from './piece-effects';
import { isHumanInputStep } from './human-input-contract';

/** Jarvis's own pieces: each of their effects passes the boundary and is audited there. */
export const JARVIS_PIECE_PREFIX = '@jarvispieces/';

/**
 * The vendored core pieces whose actions act only inside the run and Jarvis's
 * own workflow storage, so there is nothing outside Jarvis for Authority to
 * judge (#961). They are not audited one by one and obey Pause and Kill:
 *   approval        creates a request the signed-in user decides in Needs you
 *                   (/api/workflow-inputs); its links only open that page. Sends nothing.
 *   crypto          hashes, signs (HMAC), encrypts (OpenPGP), encodes and makes passwords.
 *   csv, xml        converts between JSON and CSV or XML.
 *   data-mapper     reshapes the step's input.
 *   data-summarizer sums, averages, counts and finds the extremes of a list.
 *   date-helper     date arithmetic and formatting.
 *   delay           waits.
 *   file-helper     reads, converts, zips and unzips the run's own files.
 *   image-helper    reads, resizes, crops, rotates and compresses the run's images.
 *   math-helper     arithmetic.
 *   pdf             reads and builds the run's PDFs (upstream's "Convert to Image",
 *                   which runs pdftoppm in a shell, is not loaded).
 *   qrcode          draws a QR code.
 *   schedule        a trigger only; no actions.
 *   store           reads and writes the workflow's own key-value store.
 *   text-helper     string, HTML and Markdown operations (HTML is parsed, never run).
 * A file one of them is given by URL is fetched by the engine's file download,
 * through the egress guard, as for any piece.
 * A core piece that reaches outside Jarvis is governed instead
 * (`CORE_PIECE_ADAPTERS` in piece-effects.ts), and `core-pieces.test.ts` holds
 * every vendored core piece, and every action of each one here, to exactly one
 * of the two.
 */
export const IN_RUN_STEP_PIECES: ReadonlySet<string> = new Set([
  '@activepieces/piece-approval', '@activepieces/piece-crypto', '@activepieces/piece-csv',
  '@activepieces/piece-data-mapper', '@activepieces/piece-data-summarizer', '@activepieces/piece-date-helper',
  '@activepieces/piece-delay', '@activepieces/piece-file-helper', '@activepieces/piece-image-helper',
  '@activepieces/piece-math-helper', '@activepieces/piece-pdf', '@activepieces/piece-qrcode',
  '@activepieces/piece-schedule', '@activepieces/piece-store', '@activepieces/piece-text-helper',
  '@activepieces/piece-xml',
]);

/**
 * The built-in steps whose "Retry on failure" is honoured: they only compute
 * on data already inside the run, so trying one again repeats nothing that
 * happened outside Jarvis. The rest of `IN_RUN_STEP_PIECES` is left out
 * because a second try would repeat something: approval creates another
 * request, delay waits again, store can append twice, schedule has no actions.
 * Every other step, a CODE step included, may act outside Jarvis and is never
 * retried, so a request is never sent twice (docs/WORKFLOW_AUTOMATION.md).
 */
export const RETRY_SAFE_PIECES: ReadonlySet<string> = new Set([...IN_RUN_STEP_PIECES].filter((name) => ![
  '@activepieces/piece-approval', '@activepieces/piece-delay', '@activepieces/piece-schedule', '@activepieces/piece-store',
].includes(name)));

/** Whether a failed step of this piece may be tried again by "Retry on failure". */
export function canRetryStep(pieceName: unknown): boolean {
  return typeof pieceName === 'string' && RETRY_SAFE_PIECES.has(pieceName);
}

/** What the editor and readiness say when the option is on for a step that cannot honour it. */
export const RETRY_UNAVAILABLE_MESSAGE = 'Retry is not available for steps that act outside Jarvis, so a request is never sent twice.';

/**
 * Whether "Continue on failure" may apply to this step. A step that asks a
 * person (`isHumanInputStep`) fails on a rejection, cancellation or expiry so
 * the steps after it run only once someone said yes; continuing past it would
 * undo that. Wait for Approval offers its own "Continue when rejected" for a
 * flow that branches on the answer. The engine also never continues past a
 * refusal (`continuableFailure` in piece-effect-guard.ts).
 */
export function canContinuePastStep(pieceName: unknown, actionName: unknown): boolean {
  return !isHumanInputStep(pieceName, actionName);
}

/** What the editor and readiness say when "Continue on failure" is on for a step that asks a person. */
export const CONTINUE_UNAVAILABLE_MESSAGE = 'Continue on failure is not available for a step that asks a person, so the steps after it run only after a yes.';

/**
 * A community piece: no governed adapter, not one of Jarvis's own pieces and
 * not an in-run core step. Its actions run without approval, whatever the
 * governed categories say; each dispatch is audited and obeys Pause and Kill.
 */
export function isCommunityPiece(pieceName: string): boolean {
  // A partly governed piece (Sheets append, HubSpot contact upsert) is not a
  // community piece: its ungoverned actions are audited and badged one by one
  // through isCommunityAction below.
  return !isGovernedPiece(pieceName) && !pieceName.startsWith(JARVIS_PIECE_PREFIX) && !IN_RUN_STEP_PIECES.has(pieceName);
}

/**
 * An action that runs as a community piece's would: every action of a
 * community piece, and an action of a partly governed piece (Sheets append,
 * HubSpot contact upsert) that has no adapter. Audited and badged the same way.
 */
export function isCommunityAction(pieceName: string, actionName: unknown): boolean {
  return isCommunityPiece(pieceName) || (isGovernedPiece(pieceName) && !resolveGovernedPieceAction(pieceName, actionName));
}
