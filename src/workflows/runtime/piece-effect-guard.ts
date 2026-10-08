/**
 * Engine-side half of the governed-piece adapter.
 *
 * `piece-executor.ts` calls `authorizePieceDispatch` after the step's props
 * are resolved and before the piece's `run` method touches the network, and
 * `code-executor.ts` calls it before a CODE step runs. A governed piece must
 * hear "authorized" from the daemon first. A step with no adapter -- a
 * community piece, a CODE step -- is asked about too, though only for Pause
 * and Kill (Q-08): it runs as it does today, unless Jarvis is paused (the
 * step parks until Resume) or stopped (it does not run). Its input never
 * leaves the subprocess.
 *
 * Failure is closed: any transport error, any non-2xx, any reply the daemon
 * did not shape correctly aborts the step. A missing or unreachable authorize
 * route must not become a way to run a vetted piece ungoverned, or any step
 * while Jarvis is paused.
 *
 * The resolved connection is stripped before the input leaves the subprocess.
 * The daemon strips it again on arrival.
 *
 * Imported BY THE ENGINE BUNDLE: keep it pure. `fetch` only, no node built-ins.
 */

import { isGovernedPiece, sanitizePieceInput } from './piece-effects';

export const PIECE_AUTHORIZE_PATH = '/v1/jarvis/pieces/authorize';

/** The name a CODE step is admitted under: it has no piece of its own. */
export const CODE_STEP_PIECE = '@jarvis/code-step';

export interface PieceAuthorizeRequest {
  piece: string;
  action: string;
  input: Record<string, unknown>;
  /**
   * SHA-256 of the whole resolved input, connection excluded (Q-08). `input`
   * is a bounded projection for the card: a body past 512 characters or a
   * list past 25 items read the same whatever followed, so an approval could
   * cover a longer message or more recipients than were reviewed.
   */
  inputDigest?: string;
}

/** Stable JSON: sorted keys, so the same input always digests the same. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]])) : item) ?? 'null';
}

/** The digest of a governed step's whole input. Web Crypto: this file is bundled into the engine. */
export async function pieceInputDigest(input: unknown): Promise<string> {
  const { auth: _auth, ...rest } = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : { value: input };
  const bytes = new TextEncoder().encode(canonical(rest));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PieceAuthorizePending {
  effectId: string;
  approvalId: string;
  waitpointId: string;
  /** Set when the step is held because Jarvis is paused (Q-08); no approval is involved. */
  hold?: string;
}

export type PieceAuthorizeResponse =
  /** No adapter for this piece: it runs as it always has. */
  | { governed: false }
  /** No adapter, and Jarvis is paused: the step parks on this waitpoint until Resume (Q-08). */
  | { governed: false; dispatch: 'held'; approval: PieceAuthorizePending }
  /** Authority allowed the dispatch; the effect is recorded and claimed. */
  | { governed: true; dispatch: 'authorized' }
  /** Authority wants a human; the step parks on this waitpoint. */
  | { governed: true; dispatch: 'approval_required'; approval: PieceAuthorizePending };

export interface AuthorizePieceDispatchParams {
  apiUrl: string;
  engineToken: string;
  piece: unknown;
  action: unknown;
  stepName: string;
  executionPath: Array<[string, number]>;
  input: unknown;
  /** Injectable for tests; defaults to the ambient fetch. */
  fetchImpl?: typeof fetch;
}

export async function authorizePieceDispatch(params: AuthorizePieceDispatchParams): Promise<PieceAuthorizeResponse> {
  const governed = isGovernedPiece(params.piece) && typeof params.action === 'string' && params.action.length > 0;
  const url = `${params.apiUrl.replace(/\/+$/u, '')}${PIECE_AUTHORIZE_PATH}`;
  const body: PieceAuthorizeRequest = {
    piece: typeof params.piece === 'string' && params.piece ? params.piece : 'unknown',
    action: typeof params.action === 'string' && params.action ? params.action : 'unknown',
    // Only a governed piece's input is reviewed; nothing else's leaves the subprocess.
    input: governed ? sanitizePieceInput(params.input) : {},
    ...(governed ? { inputDigest: await pieceInputDigest(params.input) } : {}),
  };
  let response: Response;
  try {
    response = await (params.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.engineToken}`,
        'X-Jarvis-Step-Name': params.stepName,
        'X-Jarvis-Execution-Path': JSON.stringify(params.executionPath ?? []),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Governed piece ${body.piece}/${body.action} was not authorized: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Governed piece ${body.piece}/${body.action} was not authorized: daemon responded ${response.status}: ${text.slice(0, 500)}`);
  }
  const reply = await response.json().catch(() => null) as PieceAuthorizeResponse | null;
  if (!reply || typeof reply !== 'object') {
    throw new Error(`Governed piece ${body.piece}/${body.action} was not authorized: malformed authorization reply`);
  }
  if (reply.governed === false) {
    if ('dispatch' in reply && reply.dispatch === 'held') {
      if (reply.approval?.waitpointId) return reply;
      throw new Error(`Piece step ${body.piece}/${body.action} was not admitted: malformed hold reply`);
    }
    // The daemon owns the adapter table. If it says this action is ungoverned
    // while the engine thought otherwise, the engine's copy is the stale one.
    return { governed: false };
  }
  if (reply.dispatch === 'approval_required' && reply.approval?.waitpointId) return reply;
  if (reply.dispatch === 'authorized') return reply;
  throw new Error(`Governed piece ${body.piece}/${body.action} was not authorized: malformed authorization reply`);
}
