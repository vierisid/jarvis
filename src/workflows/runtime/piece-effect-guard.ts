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

import {managedTodoistInput, runManagedTodoistAction} from './managed-todoist';
import {managedAsanaInput, runManagedAsanaAction} from './managed-asana';
import {managedDropboxInput, runManagedDropboxAction} from './managed-dropbox';
import { HTTP_PIECE, isGovernedPiece, sanitizePieceInput, tracksPieceCompletion } from './piece-effects';
import { documentInput, applyDocument, documentFields, type DecisionDocument } from './decision-document';
import {managedMailchimpInput, managedMailchimpIssue, runManagedMailchimpAction} from './managed-mailchimp';
import {managedGitHubInput, managedGitHubIssue, runManagedGitHubAction} from './managed-github';
import {managedTrelloInput, managedTrelloIssue, runManagedTrelloAction} from './managed-trello';
import {managedSlackInput, managedSlackIssue, sendManagedSlackMessage} from './managed-slack';

export const PIECE_AUTHORIZE_PATH = '/v1/jarvis/pieces/authorize';
export const PIECE_RECEIPT_PATH = '/v1/jarvis/pieces/receipt';
/** Largest receipt body the daemon's receipt route reads; past it the dispatch stays uncertain. */
export const PIECE_RECEIPT_MAX_BYTES = 262_144;

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
  credentialDigest?: string;
  /** F-14: `input` is a whole supported decision document, not the bounded projection. */
  documentProtocol?: 1;
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
  /** Set when the step is held with no approval: Jarvis is paused (Q-08), or, with `code`, its flow's cards are at the budget (#1039). */
  hold?: string;
  code?: 'APPROVALS_WAITING';
}

export type PieceAuthorizeResponse =
  /** No adapter for this piece: it runs as it always has. */
  | { governed: false }
  /** No adapter, and Jarvis is paused: the step parks on this waitpoint until Resume (Q-08). */
  | { governed: false; dispatch: 'held'; approval: PieceAuthorizePending }
  /** Authority allowed the dispatch; the effect is recorded and claimed. */
  | { governed: true; dispatch: 'authorized'; effectId?: string; document?: DecisionDocument }
  | { governed: true; dispatch: 'completed'; result: unknown }
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
  /** Already-censored run history. Only approved editable fields may replace it. */
  recordedInput?: Record<string, unknown>;
  /** Injectable for tests; defaults to the ambient fetch. */
  fetchImpl?: typeof fetch;
}

export async function authorizePieceDispatch(params: AuthorizePieceDispatchParams): Promise<PieceAuthorizeResponse> {
  const mailchimp = params.piece === '@activepieces/piece-mailchimp' && managedMailchimpInput(params.input);
  if (mailchimp) {
    const issue = managedMailchimpIssue(params.action, mailchimp);
    if (issue) throw new Error(issue);
  }
  const github = params.piece === '@activepieces/piece-github' && managedGitHubInput(params.input);
  if (github) {
    const issue = managedGitHubIssue(params.action, github);
    if (issue) throw new Error(issue);
  }
  const trello = params.piece === '@activepieces/piece-trello' && managedTrelloInput(params.input);
  if (trello) {
    const issue = managedTrelloIssue(params.action, trello);
    if (issue) throw new Error(issue);
  }
  const slack = params.piece === '@activepieces/piece-slack' && managedSlackInput(params.input);
  if (slack) {
    const issue = managedSlackIssue(params.action, slack);
    if (issue) throw new Error(issue);
  }
  const governed = isGovernedPiece(params.piece) && typeof params.action === 'string' && params.action.length > 0;
  const url = `${params.apiUrl.replace(/\/+$/u, '')}${PIECE_AUTHORIZE_PATH}`;
  const editable = documentInput(params.piece, params.action, params.input);
  const body: PieceAuthorizeRequest = {
    piece: typeof params.piece === 'string' && params.piece ? params.piece : 'unknown',
    action: typeof params.action === 'string' && params.action ? params.action : 'unknown',
    // Only a governed piece's input is reviewed; nothing else's leaves the subprocess.
    input: governed ? editable ?? sanitizePieceInput(params.input, params.piece) : {},
    ...(governed ? { inputDigest: await pieceInputDigest(params.input) } : {}),
    // F-14: a supported document travels whole, so a reviewer can revise it.
    ...(governed && editable ? { documentProtocol: 1 as const } : {}),
  };
  // What a refusal names: a governed piece is authorized; any other step, a
  // community piece or a CODE step, is only admitted (Q-08).
  const refused = governed
    ? `Governed piece ${body.piece}/${body.action} was not authorized`
    : body.piece === CODE_STEP_PIECE ? 'CODE step was not admitted' : `Piece step ${body.piece}/${body.action} was not admitted`;
  // Read from what the daemon will read: the projection it is sent. A wide
  // input can lose a prop to the projection's 40-key cut, and both sides
  // must then take the same worst case.
  const tracked = tracksPieceCompletion(params.piece, params.action, governed ? body.input : params.input);
  if (tracked) {
    const auth = (params.input as { auth?: { access_token?: unknown; type?: unknown } } | null)?.auth;
    const token = trello ? JSON.stringify((trello.auth as {username:string;password:string}))
      : mailchimp ? JSON.stringify((mailchimp.auth as {access_token:string;server_prefix:string})) : auth?.access_token;
    if (auth?.type !== 'CUSTOM_AUTH' && typeof token === 'string') {
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(token))));
      body.credentialDigest = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  }
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
    throw new Error(`${refused}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${refused}: daemon responded ${response.status}: ${text.slice(0, 500)}`);
  }
  const reply = await response.json().catch(() => null) as PieceAuthorizeResponse | null;
  if (!reply || typeof reply !== 'object') {
    throw new Error(`${refused}: malformed authorization reply`);
  }
  if (reply.governed === false) {
    if (tracked) throw new Error('Completion receipt protocol unavailable; send refused');
    if ('dispatch' in reply && reply.dispatch === 'held') {
      if (reply.approval?.waitpointId) return reply;
      throw new Error(`${refused}: malformed hold reply`);
    }
    // The daemon owns the adapter table. If it says this action is ungoverned
    // while the engine thought otherwise, the engine's copy is the stale one.
    return { governed: false };
  }
  if (reply.dispatch === 'approval_required' && reply.approval?.waitpointId) return reply;
  if (reply.dispatch === 'completed' && tracked) return reply;
  if (reply.dispatch === 'authorized') {
    if (tracked && !reply.effectId) throw new Error('Completion receipt protocol unavailable; send refused');
    if (reply.document !== undefined) {
      if (!editable) throw new Error('Document authorization requires a compatible engine input');
      // The caller runs the action AFTER this await, on this same input object.
      // Apply only typed editable fields; keep auth and every read-only option.
      Object.assign(params.input as Record<string, unknown>, applyDocument(body.piece, body.action, editable, reply.document));
      if (params.recordedInput) Object.assign(params.recordedInput, documentFields(reply.document));
    }
    return reply;
  }
  throw new Error(`${refused}: malformed authorization reply`);
}

/** Persist completion before handing the result back to the engine's run log.
 * A transport loss leaves dispatching behind. Reauthorization cannot resend. */
export async function executeAuthorizedPiece(params: AuthorizePieceDispatchParams, governance: PieceAuthorizeResponse, execute: () => Promise<unknown>): Promise<unknown> {
  if ('dispatch' in governance && governance.dispatch === 'completed') return governance.result;
  if ('dispatch' in governance && (governance.dispatch === 'held' || governance.dispatch === 'approval_required')) throw new Error('Piece is waiting for authorization');
  const mailchimp = params.piece === '@activepieces/piece-mailchimp' && managedMailchimpInput(params.input);
  if (mailchimp) {
    // Recheck after an approval document has applied edits.
    const issue = managedMailchimpIssue(params.action, mailchimp);
    if (issue) throw new Error(issue);
  }
  const github = params.piece === '@activepieces/piece-github' && managedGitHubInput(params.input);
  if (github) {
    // Recheck after an approval document has applied edits.
    const issue = managedGitHubIssue(params.action, github);
    if (issue) throw new Error(issue);
  }
  const trello = params.piece === '@activepieces/piece-trello' && managedTrelloInput(params.input);
  if (trello) {
    // Recheck after an approval document has applied edits.
    const issue = managedTrelloIssue(params.action, trello);
    if (issue) throw new Error(issue);
  }
  const todoist = params.piece === "@activepieces/piece-todoist" ? managedTodoistInput(params.input) : null;
  const asana = params.piece === "@activepieces/piece-asana" ? managedAsanaInput(params.input) : null;
  const dropbox = params.piece === '@activepieces/piece-dropbox' ? managedDropboxInput(params.input) : null;
  const slack = params.piece === '@activepieces/piece-slack' && managedSlackInput(params.input);
  if (slack) {
    // Recheck after an approval document has applied edits.
    const issue = managedSlackIssue(params.action, slack);
    if (issue) throw new Error(issue);
  }
  let raw: unknown;
  if (trello) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Trello dispatch was not authorized');
    raw = await runManagedTrelloAction(String(params.action), trello);
  } else if (mailchimp) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Mailchimp dispatch was not authorized');
    raw = await runManagedMailchimpAction(String(params.action), mailchimp);
  } else if (github) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('GitHub dispatch was not authorized');
    raw = await runManagedGitHubAction(String(params.action), github);
  } else if (todoist) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Todoist dispatch was not authorized');
    raw = await runManagedTodoistAction(String(params.action), todoist);
  } else if (asana) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Asana dispatch was not authorized');
    raw = await runManagedAsanaAction(String(params.action), asana);
  } else if (dropbox) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Dropbox dispatch was not authorized');
    raw = await runManagedDropboxAction(String(params.action), dropbox);
  } else if (slack) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Slack dispatch was not authorized');
    if (params.action === 'slack_post_message' || params.action === 'send_channel_message') raw = await sendManagedSlackMessage(slack);
    else {
      // SDK transport errors can carry the original authenticated request.
      try { raw = await execute(); }
      catch { throw new Error('Could not read Slack channel details. Check channel access or reconnect Slack.'); }
    }
  } else raw = await execute();
  // Gmail 0.17 returns a Gaxios response, including transport configuration.
  // Keep its data envelope for expressions, but never persist request headers
  // (which can contain the OAuth bearer) as a completion receipt or step output.
  const response = raw as { data?: unknown; status?: unknown; statusText?: unknown } | null;
  const result = tracksPieceCompletion(params.piece, params.action, params.input) && params.piece === '@activepieces/piece-gmail' && response?.data !== undefined
    ? { data: response.data, ...(typeof response.status === 'number' ? { status: response.status } : {}),
      ...(typeof response.statusText === 'string' ? { statusText: response.statusText } : {}) }
    : raw;
  if (governance.governed && governance.dispatch === 'authorized' && governance.effectId) {
    const response = await (params.fetchImpl ?? fetch)(`${params.apiUrl.replace(/\/+$/u, '')}${PIECE_RECEIPT_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.engineToken}`,
        'X-Jarvis-Step-Name': params.stepName, 'X-Jarvis-Execution-Path': JSON.stringify(params.executionPath) },
      body: receiptBody(params.piece, governance.effectId, result), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Provider completion could not be recorded (${response.status}); automatic replay is blocked`);
  }
  return result;
}

/**
 * The receipt the daemon stores for a tracked send. An HTTP response is
 * whatever the server returned, and one past the route's cap would leave a
 * request that WAS sent recorded as uncertain and fail its step (#961). So an
 * HTTP receipt that does not fit keeps the status and headers and says how
 * large the body was; the step still returns the whole response to the flow.
 * Only a retry of a step whose receipt is recorded reads the stored copy.
 */
export function receiptBody(piece: unknown, effectId: string, result: unknown): string {
  if (piece !== HTTP_PIECE) return JSON.stringify({ effectId, result: result ?? null });
  const response = result !== null && typeof result === 'object' ? result as { status?: unknown; headers?: unknown; body?: unknown } : {};
  // A session cookie the server set is a credential, and the receipt is durable.
  const stored = result !== null && typeof result === 'object' && !Array.isArray(result) && 'headers' in result
    ? { ...(result as Record<string, unknown>), headers: withoutCookies(response.headers) } : result;
  const whole = JSON.stringify({ effectId, result: stored ?? null });
  if (new TextEncoder().encode(whole).byteLength <= PIECE_RECEIPT_MAX_BYTES) return whole;
  const bodyBytes = new TextEncoder().encode(JSON.stringify(response.body ?? null)).byteLength;
  const reduced = JSON.stringify({ effectId, result: { status: response.status ?? null, headers: withoutCookies(response.headers), body: null, receiptOmittedBodyBytes: bodyBytes } });
  if (new TextEncoder().encode(reduced).byteLength <= PIECE_RECEIPT_MAX_BYTES) return reduced;
  return JSON.stringify({ effectId, result: { status: response.status ?? null, headers: null, body: null, receiptOmittedBodyBytes: bodyBytes } });
}

/** Response headers without `set-cookie`, in any letter case. */
function withoutCookies(headers: unknown): unknown {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return headers ?? null;
  return Object.fromEntries(Object.entries(headers as Record<string, unknown>).filter(([name]) => name.toLowerCase() !== 'set-cookie'));
}
