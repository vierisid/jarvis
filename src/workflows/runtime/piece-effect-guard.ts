import {managedAirtableInput, managedAirtableIssue, runManagedAirtableAction} from './managed-airtable';
import { hubspotContactInput, isHubspotContact } from './hubspot-contact';
import { managedNotionInput, managedNotionIssue, runManagedNotionAction } from './managed-notion';
import { managedZoomInput, runManagedZoomAction } from "./managed-zoom";
import { managedGitLabInput, runManagedGitLabAction } from "./managed-gitlab";
import { managedPipedriveInput, runManagedPipedriveAction } from "./managed-pipedrive";
import { managedHelpScoutInput, runManagedHelpScoutAction } from "./managed-help-scout";
import { managedWebflowInput, runManagedWebflowAction } from './managed-webflow';
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

import {managedWrikeInput, runManagedWrikeAction} from './managed-wrike';
import {managedMondayInput, runManagedMondayAction} from './managed-monday';
import {managedLinearInput, runManagedLinearAction} from './managed-linear';
import {managedTypeformInput, runManagedTypeformAction} from './managed-typeform';
import {managedTodoistInput, runManagedTodoistAction} from './managed-todoist';
import {managedFigmaInput, runManagedFigmaAction} from './managed-figma';
import {managedAsanaInput, runManagedAsanaAction} from './managed-asana';
import {managedDropboxInput, runManagedDropboxAction} from './managed-dropbox';
import {managedIntercomInput, runManagedIntercomAction} from './managed-intercom';
import {managedCalendlyInput, runManagedCalendlyAction} from './managed-calendly';
import { refusedBeforeSend, withReadHosts } from './http-egress';
import { GRAPHQL_PIECE, HTTP_PIECE, NOT_SENT_PIECES, isGovernedPiece, redactReceipt, sanitizePieceInput, tracksPieceCompletion } from './piece-effects';
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

/**
 * Whether "Continue on failure" may go on past a step that failed after the
 * dispatch check let it run. A step that asks Jarvis from inside its own run
 * (Jarvis's pieces, and the legacy approval piece through Needs you) hears a
 * refusal by Authority, an approval or Kill, or a person's rejection, there,
 * as a thrown error, not from `authorizePieceDispatch`. Such a step is gone
 * past only when it reports a typed outcome that ran and failed (`error`, or
 * `unknown`: it may have taken effect). A `blocked` outcome (refused, not
 * approved, not started) or an untyped error is never continued past, so a
 * refusal cannot be skipped. Any other step's failure after dispatch is its
 * own (a provider error, a CODE step that threw).
 */
export function continuableFailure(piece: unknown, error: unknown): boolean {
  const asksJarvis = typeof piece === 'string' && (piece.startsWith('@jarvispieces/') || piece === '@activepieces/piece-approval');
  if (!asksJarvis) return true;
  const outcome = error !== null && typeof error === 'object' ? (error as { outcome?: { status?: unknown } }).outcome : undefined;
  return outcome?.status === 'error' || outcome?.status === 'unknown';
}

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
  /**
   * `readHosts` (#1153): an HTTP read that ran without asking because its host
   * is on the flow's read list; the request and every redirect it follows
   * must stay on that list (`withReadHosts`).
   */
  | { governed: true; dispatch: 'authorized'; effectId?: string; document?: DecisionDocument; readHosts?: string[] }
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
  const airtable = params.piece === '@activepieces/piece-airtable' && managedAirtableInput(params.input);
  if (airtable) {const issue=managedAirtableIssue(params.action,airtable);if(issue)throw new Error(issue);}
  const notion = params.piece === '@activepieces/piece-notion' && managedNotionInput(params.input);
  if (notion) {
    const issue = managedNotionIssue(params.action, notion);
    if (issue) throw new Error(issue);
  }
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
  const contact = isHubspotContact(params.piece, params.action) ? hubspotContactInput(params.input) : null;
  if (contact) {
    const auth = (params.input as Record<string,unknown>).auth;
    params.input = { ...contact, auth };
  }
  const editable = documentInput(params.piece, params.action, params.input);
  const body: PieceAuthorizeRequest = {
    piece: typeof params.piece === 'string' && params.piece ? params.piece : 'unknown',
    action: typeof params.action === 'string' && params.action ? params.action : 'unknown',
    // Only a governed piece's input is reviewed; nothing else's leaves the subprocess.
    input: governed ? contact ?? editable ?? sanitizePieceInput(params.input, params.piece) : {},
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
    const auth = (params.input as { auth?: { access_token?: unknown; secret_text?: unknown; type?: unknown } } | null)?.auth;
    const token = trello ? JSON.stringify((trello.auth as {username:string;password:string}))
      : mailchimp ? JSON.stringify((mailchimp.auth as {access_token:string;server_prefix:string})) : airtable ? auth?.secret_text : auth?.access_token;
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
    if (reply.readHosts !== undefined && !(Array.isArray(reply.readHosts) && reply.readHosts.every((h) => typeof h === 'string'))) {
      throw new Error(`${refused}: malformed read list`);
    }
    if (isHubspotContact(params.piece, params.action)) throw new Error('HubSpot contact execution requires the qualified daemon adapter; legacy dispatch refused');
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
  const linear = params.piece === "@activepieces/piece-linear" ? managedLinearInput(params.input) : null;
  const typeform = params.piece === "@activepieces/piece-typeform" ? managedTypeformInput(params.input) : null;
  const airtable = params.piece === '@activepieces/piece-airtable' && managedAirtableInput(params.input);
  if (airtable) {const issue=managedAirtableIssue(params.action,airtable);if(issue)throw new Error(issue);}
  const calendly = params.piece === "@activepieces/piece-calendly" ? managedCalendlyInput(params.input) : null;
  const notion = params.piece === '@activepieces/piece-notion' && managedNotionInput(params.input);
  if (notion) {
    const issue = managedNotionIssue(params.action, notion);
    if (issue) throw new Error(issue);
  }
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
  const wrike = params.piece === "@activepieces/piece-wrike" ? managedWrikeInput(params.input) : null;
  const monday = params.piece === "@activepieces/piece-monday" ? managedMondayInput(params.input) : null;
  const figma = managedFigmaInput(String(params.piece), params.input) ? params.input : null;
  const todoist = params.piece === "@activepieces/piece-todoist" ? managedTodoistInput(params.input) : null;
  const asana = params.piece === "@activepieces/piece-asana" ? managedAsanaInput(params.input) : null;
  const dropbox = params.piece === '@activepieces/piece-dropbox' ? managedDropboxInput(params.input) : null;
  const intercom = params.piece === '@activepieces/piece-intercom' ? managedIntercomInput(params.input) : null;
  const zoom = managedZoomInput(String(params.piece), params.input) ? params.input as Record<string, unknown> : null;
  const gitlab = managedGitLabInput(String(params.piece), params.input) ? params.input as Record<string, unknown> : null;
  const pipedrive = managedPipedriveInput(String(params.piece), params.input) ? params.input as Record<string, unknown> : null;
  const helpScout = managedHelpScoutInput(String(params.piece), params.input) ? params.input as Record<string, unknown> : null;
  const webflow = managedWebflowInput(String(params.piece), params.input) ? params.input as Record<string, unknown> : null;
  const slack = params.piece === '@activepieces/piece-slack' && managedSlackInput(params.input);
  if (slack) {
    // Recheck after an approval document has applied edits.
    const issue = managedSlackIssue(params.action, slack);
    if (issue) throw new Error(issue);
  }
  let raw: unknown;
  if (notion) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Notion dispatch was not authorized');
    raw = await runManagedNotionAction(String(params.action), notion);
  } else if (airtable) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Airtable dispatch was not authorized');
    raw = await runManagedAirtableAction(String(params.action), airtable);
  } else if (zoom) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Zoom dispatch was not authorized');
    raw = await runManagedZoomAction(String(params.action), zoom);
  } else if (gitlab) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('GitLab dispatch was not authorized');
    raw = await runManagedGitLabAction(String(params.action), gitlab);
  } else if (pipedrive) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Pipedrive dispatch was not authorized');
    raw = await runManagedPipedriveAction(String(params.action), pipedrive);
  } else if (helpScout) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Help Scout dispatch was not authorized');
    raw = await runManagedHelpScoutAction(String(params.action), helpScout);
  } else if (webflow) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Webflow dispatch was not authorized');
    raw = await runManagedWebflowAction(String(params.action), webflow);
  } else if (trello) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Trello dispatch was not authorized');
    raw = await runManagedTrelloAction(String(params.action), trello);
  } else if (mailchimp) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Mailchimp dispatch was not authorized');
    raw = await runManagedMailchimpAction(String(params.action), mailchimp);
  } else if (github) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('GitHub dispatch was not authorized');
    raw = await runManagedGitHubAction(String(params.action), github);
  } else if (wrike) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Wrike dispatch was not authorized');
    raw = await runManagedWrikeAction(String(params.action), wrike);
  } else if (monday) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Monday dispatch was not authorized');
    raw = await runManagedMondayAction(String(params.action), monday);
  } else if (figma) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Figma dispatch was not authorized');
    raw = await runManagedFigmaAction(String(params.action), figma);
  } else if (linear) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Linear dispatch was not authorized');
    raw = await runManagedLinearAction(String(params.action), linear);
  } else if (typeform) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Typeform dispatch was not authorized');
    raw = await runManagedTypeformAction(String(params.action), typeform);
  } else if (todoist) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Todoist dispatch was not authorized');
    raw = await runManagedTodoistAction(String(params.action), todoist);
  } else if (asana) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Asana dispatch was not authorized');
    raw = await runManagedAsanaAction(String(params.action), asana);
  } else if (dropbox) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Dropbox dispatch was not authorized');
    raw = await runManagedDropboxAction(String(params.action), dropbox);
  } else if (intercom) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Intercom dispatch was not authorized');
    raw = await runManagedIntercomAction(String(params.action), intercom);
  } else if (calendly) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Calendly dispatch was not authorized');
    raw = await runManagedCalendlyAction(String(params.action), calendly);
  } else if (slack) {
    if (!governance.governed || governance.dispatch !== 'authorized') throw new Error('Slack dispatch was not authorized');
    if (params.action === 'slack_post_message' || params.action === 'send_channel_message') raw = await sendManagedSlackMessage(slack);
    else {
      // SDK transport errors can carry the original authenticated request.
      try { raw = await execute(); }
      catch { throw new Error('Could not read Slack channel details. Check channel access or reconnect Slack.'); }
    }
  } else {
    // #1153: a read the daemon let run without asking stays on the flow's read list.
    const readHosts = governance.governed && governance.dispatch === 'authorized' ? governance.readHosts : undefined;
    try {
      raw = readHosts ? await withReadHosts(readHosts, execute) : await execute();
    } catch (error) {
      // #1153: the egress guard refused the request before it went out (an
      // address outside the policy, a proxy, a host off the read list), so a
      // tracked send is recorded as not sent instead of left uncertain. Best
      // effort: if the note does not arrive the send stays uncertain, the
      // safe reading. A refusal after sending is not one of these.
      if (governance.governed && governance.dispatch === 'authorized' && governance.effectId && NOT_SENT_PIECES.has(String(params.piece)) && refusedBeforeSend(error)) {
        await (params.fetchImpl ?? fetch)(`${params.apiUrl.replace(/\/+$/u, '')}${PIECE_RECEIPT_PATH}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.engineToken}`,
            'X-Jarvis-Step-Name': params.stepName, 'X-Jarvis-Execution-Path': JSON.stringify(params.executionPath) },
          body: JSON.stringify({ effectId: governance.effectId, notSent: { message: String((error as Error).message ?? error).slice(0, 2000) } }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
      }
      throw error;
    }
  }
  // Gmail 0.17 returns a Gaxios response, including transport configuration.
  // Keep its data envelope for expressions, but never persist request headers
  // (which can contain the OAuth bearer) as a completion receipt or step output.
  // #1153: a failure an HTTP or GraphQL step continued past hands later steps
  // `{ response, request: { body } }`, and the body holds whatever the step
  // sent, its credentials included; a later step could carry them into run
  // history or a model prompt. The flow keeps the response, not the body.
  if ((params.piece === HTTP_PIECE || params.piece === GRAPHQL_PIECE) && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const request = (raw as { request?: unknown }).request;
    if (request !== null && typeof request === 'object' && !Array.isArray(request) && 'body' in request) raw = { ...(raw as object), request: { ...request, body: null } };
  }
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
  // The core GraphQL piece (#961) answers with the same HTTP response shape.
  if (piece !== HTTP_PIECE && piece !== GRAPHQL_PIECE) return JSON.stringify({ effectId, result: result ?? null });
  const response = result !== null && typeof result === 'object' ? result as { status?: unknown; headers?: unknown; body?: unknown } : {};
  // A session cookie the server set is a credential, and the receipt is
  // durable; so is a token in the response (an OAuth code exchange, a login),
  // in its headers or body at any depth, #1153. A failure the step continued
  // past (HttpError.errorMessage(): { response, request }) keeps no request
  // body, which can hold the credentials it sent. Only a replay of a recorded
  // step reads this copy, and `receiptRedacted` tells it values were replaced.
  let shaped: unknown = result;
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    const fields = { ...(result as Record<string, unknown>) };
    if ('headers' in fields) fields.headers = withoutCookies(fields.headers);
    const request = fields.request;
    if (request !== null && typeof request === 'object' && !Array.isArray(request) && 'body' in request) fields.request = { ...request, body: null };
    shaped = fields;
  }
  const { value: cleaned, redacted } = redactReceipt(shaped);
  const stored = redacted && cleaned !== null && typeof cleaned === 'object' && !Array.isArray(cleaned)
    ? { ...(cleaned as Record<string, unknown>), receiptRedacted: true } : cleaned;
  const whole = JSON.stringify({ effectId, result: stored ?? null });
  if (new TextEncoder().encode(whole).byteLength <= PIECE_RECEIPT_MAX_BYTES) return whole;
  const bodyBytes = new TextEncoder().encode(JSON.stringify(response.body ?? null)).byteLength;
  const headers = redactReceipt(withoutCookies(response.headers));
  const reduced = JSON.stringify({ effectId, result: { status: response.status ?? null, headers: headers.value, body: null, receiptOmittedBodyBytes: bodyBytes,
    ...(headers.redacted ? { receiptRedacted: true } : {}) } });
  if (new TextEncoder().encode(reduced).byteLength <= PIECE_RECEIPT_MAX_BYTES) return reduced;
  return JSON.stringify({ effectId, result: { status: response.status ?? null, headers: null, body: null, receiptOmittedBodyBytes: bodyBytes } });
}

/** Response headers without `set-cookie`, in any letter case. */
function withoutCookies(headers: unknown): unknown {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return headers ?? null;
  return Object.fromEntries(Object.entries(headers as Record<string, unknown>).filter(([name]) => name.toLowerCase() !== 'set-cookie'));
}
