/**
 * Engine-side half of the governed-piece adapter.
 *
 * `piece-executor.ts` calls `authorizePieceDispatch` after the step's props
 * are resolved and before the piece's `run` method touches the network. A
 * governed piece must hear "authorized" from the daemon first; an ungoverned
 * piece is not asked about at all and runs exactly as it does today.
 *
 * Failure is closed, and only for governed pieces: any transport error, any
 * non-2xx, any reply the daemon did not shape correctly aborts the step. A
 * missing or unreachable authorize route must not become a way to run a vetted
 * piece ungoverned.
 *
 * The resolved connection is stripped before the input leaves the subprocess.
 * The daemon strips it again on arrival.
 *
 * Imported BY THE ENGINE BUNDLE: keep it pure. `fetch` only, no node built-ins.
 */

import { isGovernedPiece, sanitizePieceInput } from './piece-effects';

export const PIECE_AUTHORIZE_PATH = '/v1/jarvis/pieces/authorize';

export interface PieceAuthorizeRequest {
  piece: string;
  action: string;
  input: Record<string, unknown>;
}

export interface PieceAuthorizePending {
  effectId: string;
  approvalId: string;
  waitpointId: string;
}

export type PieceAuthorizeResponse =
  /** No adapter for this piece: it runs as it always has. */
  | { governed: false }
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
  if (!isGovernedPiece(params.piece) || typeof params.action !== 'string' || params.action.length === 0) {
    return { governed: false };
  }
  const url = `${params.apiUrl.replace(/\/+$/u, '')}${PIECE_AUTHORIZE_PATH}`;
  const body: PieceAuthorizeRequest = {
    piece: params.piece as string,
    action: params.action,
    input: sanitizePieceInput(params.input),
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
    // The daemon owns the adapter table. If it says this action is ungoverned
    // while the engine thought otherwise, the engine's copy is the stale one.
    return { governed: false };
  }
  if (reply.dispatch === 'approval_required' && reply.approval?.waitpointId) return reply;
  if (reply.dispatch === 'authorized') return reply;
  throw new Error(`Governed piece ${body.piece}/${body.action} was not authorized: malformed authorization reply`);
}
