/**
 * Typed governed adapters for the verified installable pieces.
 *
 * A community piece runs INSIDE the engine subprocess and makes its own
 * outbound call with the user's stored connection. Nothing it does reaches the
 * daemon's tool surface, so the `/v1/jarvis/*` Authority boundary from #459
 * never sees it. This module is the declaration half of the fix: for a vetted
 * piece it names, every action resolves to an Authority category and a target
 * resolver, exactly the `ToolDefinition.workflowEffect` shape the daemon
 * already understands. `runtime/piece-effect-guard.ts` carries the engine-side
 * call and `sandbox-api/routes/jarvis-pieces.ts` the daemon-side dispatch,
 * which runs through the same `WorkflowEffectBoundary` as every other effect.
 *
 * WHAT IS GOVERNED, AND WHAT IS NOT
 *   - A piece named in `GOVERNED_PIECE_ADAPTERS` has every ACTION governed. Unknown
 *     action names (an upstream release adds one, a composed flow invents one)
 *     resolve to that piece's `unknownActionCategory`, which is the most
 *     severe category the piece can reach. An unmapped action never lands on
 *     `read_data`.
 *   - Every other piece is UNGOVERNED and runs exactly as it does today. The
 *     catalogue stays open: no piece is refused, no install is blocked. The
 *     verified set expands by landing an adapter here, not by closing the door
 *     on everything else.
 *   - Triggers are not covered. This governs the action path in
 *     `piece-executor.ts`; polling triggers run through `trigger-helper.ts`
 *     and keep their present behaviour.
 *
 * CATEGORY RULES. Categories are assigned by what the action does to the
 * remote account, never by what it is called:
 *   read_data       retrieves only; changes nothing on the service.
 *   write_data      creates or changes content under the user's own account,
 *                   visible to whoever already had access.
 *   send_message    delivers content to other people through a messaging
 *                   service (channel, DM, chat).
 *   send_email      delivers email.
 *   delete_data     destroys content, or hides it irreversibly.
 *   modify_settings changes access, permissions, membership or configuration.
 * Every value is an existing `ActionCategory`; no category is invented here.
 *
 * `custom_api_call` exists on every piece and can reach any endpoint of that
 * API with the user's credential. It is always mapped to the piece's
 * `unknownActionCategory`, because a category label cannot bound it.
 *
 * This file is imported BY THE ENGINE BUNDLE (see `PATCHED_VENDOR_SOURCES` in
 * `runner/engine-runtime/build.ts`). Keep it pure: type-only imports, and
 * value imports only of other registered sources (`engine-bundle-purity.test.ts`);
 * no daemon singletons. `./http-egress` is one (the egress guard and the #1153
 * read-host scope, whose only state is that per-process scope).
 */

import { isHubspotContact, HUBSPOT_PIECE, HUBSPOT_UPSERT } from './hubspot-contact';
import { readHostKey } from './http-egress';
import type { ActionCategory } from '../../roles/authority';
import type { ToolDefinition } from '../../actions/tools/registry';

/** Prop name the engine stores the resolved connection under. Mirrors
 * `AUTHENTICATION_PROPERTY_NAME` in `@activepieces/shared`; duplicated as a
 * literal so this module keeps no runtime dependency on the vendored tree. */
export const PIECE_AUTH_PROPERTY = 'auth';

/** `toolCategory` recorded for every governed piece effect. */
export const PIECE_TOOL_CATEGORY = 'workflow-piece';

/**
 * Gmail actions that send mail and return once sent. Every Gmail `send_email`
 * action but `request_approval_in_mail`, which sends and then parks the flow:
 * its step re-runs on resume to read the decision, so a stored completion
 * would hand back the first run's result instead (`governed-pieces.test.ts`
 * pins this list against the adapter table).
 */
const GMAIL_TRACKED_SENDS: ReadonlySet<unknown> = new Set(['send_email', 'gmail_send_email', 'reply_to_email',
  'gmail_reply_to_thread', 'gmail_send_draft', 'gmail_forward_message']);

/** True for a Gmail action that sends mail and returns once sent (its result is a sent message). */
export function isGmailTrackedSend(action: unknown): boolean {
  return GMAIL_TRACKED_SENDS.has(action);
}

/**
 * Q-07's bounded completion-receipt protocol. These actions never park
 * themselves. Every Gmail send that returns once sent is tracked, and so is
 * adding a label to a message, so an engine retry of either whose outcome is
 * unknown is refused instead of repeated (#953 made these reachable at the
 * default level). Only the sends have a provider readback: a label change
 * returns the labeled (incoming) message, which is not a send receipt.
 */
export function tracksPieceCompletion(piece: unknown, action: unknown, input?: unknown): boolean {
  return (piece === '@activepieces/piece-airtable' && ['create_record_ai','update_record_ai'].includes(String(action)))
    || (piece === NOTION_PIECE && notionTracked(action))
    || isHubspotContact(piece, action) || (piece === '@activepieces/piece-github' && ['github_create_issue', 'update_issue', 'createCommentOnAIssue'].includes(String(action)))
    || (piece === DROPBOX_PIECE && dropboxTracked(action))
    || (piece === '@activepieces/piece-trello' && (action === 'create_card' || action === 'move_card'))
    || ((piece === CLICKUP_PIECE || piece === MAILCHIMP_PIECE || piece === ASANA_PIECE || piece === INTERCOM_PIECE || piece === CALENDLY_PIECE || piece === TYPEFORM_PIECE || piece === LINEAR_PIECE || piece === TODOIST_PIECE || piece === MONDAY_PIECE || piece === WRIKE_PIECE || piece === FIGMA_PIECE || piece === WEBFLOW_PIECE || piece === PIPEDRIVE_PIECE || piece === ZOOM_PIECE || piece === HELP_SCOUT_PIECE || piece === GITLAB_PIECE) && managedPieceChanges(piece, action))
    // A Webflow refund moves money and is not idempotent: never repeat one whose outcome is unknown.
    || (piece === WEBFLOW_PIECE && action === 'refund_order')
    || (piece === '@activepieces/piece-gmail' && (GMAIL_TRACKED_SENDS.has(action) || action === 'gmail_add_label_to_email'))
    || (piece === '@activepieces/piece-google-drive' && ['upload_gdrive_file', 'drive_upload_file', 'drive_upload_from_url'].includes(String(action)))
    || (piece === '@activepieces/piece-google-sheets' && ['insert_row', 'sheets_append_values', 'sheets_add_row'].includes(String(action)))
    || (piece === '@activepieces/piece-slack' && (action === 'send_channel_message' || action === 'slack_post_message'))
    // #961: an HTTP request that is not a read is a send whose outcome the
    // server alone knows, so a retry after a lost or failed request is
    // refused rather than repeated. Without the input it is assumed a send.
    || (piece === HTTP_PIECE && action === 'send_request' && !httpRequestIsRead(ruleInput(input) ?? {}))
    // #961: a GraphQL request always carries a body, and an email is sent at
    // most once: neither is repeated after an attempt whose outcome is unknown.
    || (piece === GRAPHQL_PIECE && action === 'send_request')
    || (piece === SMTP_PIECE && action === 'send-email');
}

const CLICKUP_PIECE = '@activepieces/piece-clickup';
const MAILCHIMP_PIECE = '@activepieces/piece-mailchimp';
const ASANA_PIECE = '@activepieces/piece-asana';
const TODOIST_PIECE = '@activepieces/piece-todoist';
const CALENDLY_PIECE = '@activepieces/piece-calendly';
const INTERCOM_PIECE = '@activepieces/piece-intercom';
const TYPEFORM_PIECE = '@activepieces/piece-typeform';
const LINEAR_PIECE = '@activepieces/piece-linear';
const WRIKE_PIECE = '@activepieces/piece-wrike';
const MONDAY_PIECE = '@activepieces/piece-monday';
const ZOOM_PIECE = "@activepieces/piece-zoom";
const HELP_SCOUT_PIECE = "@activepieces/piece-help-scout";
const GITLAB_PIECE = "@activepieces/piece-gitlab";
const FIGMA_PIECE = '@activepieces/piece-figma';
const PIPEDRIVE_PIECE = '@activepieces/piece-pipedrive';
/** Owner/visibility changes and marketing consent require access-level authority. */
export function pipedrivePersonCategory(input: Record<string, unknown>): ActionCategory {
  if (present(input.ownerId) || present(input.visibleTo) || present(input.marketing_status)) return 'modify_settings';
  return 'write_data';
}
/** A deal: upstream 0.10.3 `status` includes `deleted`, the worst case, so it is
 * checked first (and any value outside open/won/lost counts as it); otherwise
 * as a person. Managed connections offer only
 * open/won/lost (`managed-pipedrive-inputs.ts`). */
export function pipedriveRecordCategory(input: Record<string, unknown>): ActionCategory {
  // Fail closed: any status other than open/won/lost is taken as the delete.
  if (present(input.status) && !['open', 'won', 'lost'].includes(input.status as string)) return 'delete_data';
  return pipedrivePersonCategory(input);
}
const WEBFLOW_PIECE = '@activepieces/piece-webflow';
/** Every ClickUp, Mailchimp, Asana, Intercom, Calendly, Typeform, Linear, Todoist, monday.com, Wrike, Figma or Webflow action that changes the account (write,
 * send, email, delete or an access change). None parks its flow, so each one
 * can be tracked; a read never is. A category the adapter does not map tracks
 * nothing, so ClickUp (no send_email or modify_settings names) and Mailchimp
 * (no modify_settings names) track exactly what they did on their own. */
function managedPieceChanges(pieceName: string, action: unknown): boolean {
  const categories = MANAGED_PIECE_ADAPTERS.find(a => a.pieceName === pieceName)!.categories;
  return typeof action === 'string' && (['write_data', 'send_message', 'send_email', 'delete_data', 'modify_settings'] as const)
    .some(category => categories[category]?.includes(action));
}

const present = (value: unknown) => value !== undefined && value !== null && value !== '';

/**
 * Asana `update_project`: a privacy or owner change decides who can see the
 * project, and archiving hides it (as a Trello archive, gated as a deletion).
 * A plain field edit is a write. `archived: false` restores, a write too.
 */
export function asanaUpdateProjectCategory(input: Record<string, unknown>): ActionCategory {
  if (present(input.privacy_setting) || present(input.owner)) return 'modify_settings';
  if (present(input.archived) && input.archived !== false) return 'delete_data';
  return 'write_data';
}

/**
 * Linear `linear_project_update` (AI): `team_ids` replaces the teams the
 * project belongs to, so adding one shows the project to that team's members.
 * Without it the update is a plain edit.
 */
export function linearProjectUpdateCategory(input: Record<string, unknown>): ActionCategory {
  return present(input.team_ids) ? 'modify_settings' : 'write_data';
}

/** Asana `update_team`: visibility or endorsement is a team setting; a rename or description is a write. */
export function asanaUpdateTeamCategory(input: Record<string, unknown>): ActionCategory {
  return present(input.visibility) || present(input.endorsed) ? 'modify_settings' : 'write_data';
}

/**
 * Asana `create_project`: the new project is shared with a team, and a
 * privacy setting other than private opens it to the workspace. Without
 * either it is a private project of the caller's, a write. Anything else, a
 * templated value included, is the worst case. An absent privacy setting is
 * the workspace default; this treats it as a write.
 */
export function asanaCreateProjectCategory(input: Record<string, unknown>): ActionCategory {
  if (present(input.team)) return 'modify_settings';
  return !present(input.privacy_setting) || input.privacy_setting === 'private' ? 'write_data' : 'modify_settings';
}

/**
 * Asana `instantiate_project_template`: the new project always lands in a
 * team (a left-out team is the template's own, upstream's "Leave empty to use
 * the template's team"), so with no privacy setting, or any but private, it
 * is shared with that team; template roles put people on it. Only an
 * explicitly private project with no requested roles (left out or an empty
 * list) is the caller's alone, a write. Anything else, a templated value
 * included, is the worst case.
 */
export function asanaInstantiateProjectTemplateCategory(input: Record<string, unknown>): ActionCategory {
  const roles = input.requested_roles;
  const noRoles = !present(roles) || (Array.isArray(roles) && roles.length === 0);
  return input.privacy_setting === 'private' && noRoles ? 'write_data' : 'modify_settings';
}

/** Asana `create_team`: a secret team is visible only to its members (the
 * caller); any other visibility, a templated one included, lets the
 * organization see or join it. Absent is Asana's default, treated as a write. */
export function asanaCreateTeamCategory(input: Record<string, unknown>): ActionCategory {
  return !present(input.visibility) || input.visibility === 'secret' ? 'write_data' : 'modify_settings';
}

/** `duplicate_project` parts that copy only content, never who has access. */
const ASANA_DUPLICATE_CONTENT_PARTS: ReadonlySet<unknown> = new Set(['notes', 'forms', 'allocations', 'task_assignee',
  'task_attachments', 'task_dates', 'task_dependencies', 'task_followers', 'task_notes', 'task_projects',
  'task_subtasks', 'task_tags', 'task_templates', 'task_type_default']);

/** Asana `duplicate_project`: copying `members` or `permissions` grants the
 * original's people access to the copy. A list of content parts only is a
 * write; anything else (those two, an unknown part, a templated value or a
 * non-list) is the worst case. */
export function asanaDuplicateProjectCategory(input: Record<string, unknown>): ActionCategory {
  if (!present(input.include)) return 'write_data';
  return Array.isArray(input.include) && input.include.every(part => ASANA_DUPLICATE_CONTENT_PARTS.has(part))
    ? 'write_data' : 'modify_settings';
}

/**
 * Webflow `fulfill_order`: with `send_order_fulfilled_email` on, Webflow emails
 * the customer. Off or absent, it only marks the order fulfilled. Any other
 * value, a templated one included, is the worst case.
 */
export function webflowFulfillOrderCategory(input: Record<string, unknown>): ActionCategory {
  return !present(input.send_order_fulfilled_email) || input.send_order_fulfilled_email === false ? 'write_data' : 'send_email';
}

const GITLAB_MANAGED_AUTH: readonly string[] = ['{{connections.jarvis:gitlab}}', "{{connections['jarvis:gitlab']}}"];
/** The non-secret projection marker of a step that runs on the managed GitLab connection. */
export const GITLAB_MANAGED_MARKER = 'jarvis_managed';
/**
 * The engine pass (`sanitizePieceInput`) sees the resolved credential: it drops
 * any `jarvis_managed` the workflow input carries and sets it only when the
 * credential is the managed one, the same test (`jarvis_managed: "gitlab"` on
 * the auth object) piece-effect-guard uses to send the step to
 * `runManagedGitLabAction`. The daemon's pass (`projected`) keeps what the
 * engine set, since `bound()` has already stripped the credential.
 */
export function redactGitLabInput(input: Record<string, unknown>, projected: boolean): Record<string, unknown> {
  if (projected) return input;
  const { [GITLAB_MANAGED_MARKER]: _forged, ...out } = input;
  const auth = inputObject(input.auth);
  return auth?.jarvis_managed === 'gitlab' ? { ...out, [GITLAB_MANAGED_MARKER]: 'gitlab' } : out;
}
/**
 * GitLab quick actions (slash-command lines) in an issue description can move,
 * close or change permissions on the issue, so such a description is a
 * settings change, including through manually configured accounts.
 *
 * On the managed `jarvis:gitlab` connection any other description is a write,
 * templated or long, because `runManagedGitLabAction` refuses a resolved
 * description with a slash command before anything is sent (owner decisions,
 * #1268). Managed means: in the configured step input (design time, `auth`
 * present) the exact managed reference; in the run-time projection (`auth`
 * stripped) the marker `redactGitLabInput` derived from the resolved
 * credential. Neither is one of the rule's `props`: a templated `auth` never
 * narrows, and workflow input cannot set the marker.
 *
 * On a manual account a templated description (only known at run time) and a
 * description the projection cut at 512 characters (which may hide a quick
 * action past the cut) take the worst case.
 */
export function gitlabIssueCategory(input:Record<string,unknown>):ActionCategory {
 const d=input.description;
 if (d==null || d==='') return 'write_data';
 if (typeof d!=='string' || /(?:^|[\r\n])\s*\//.test(d)) return 'modify_settings';
 const managed = Object.hasOwn(input,'auth')
   ? typeof input.auth==='string' && GITLAB_MANAGED_AUTH.includes(input.auth)
   : input[GITLAB_MANAGED_MARKER]==='gitlab';
 if (managed) return 'write_data';
 return d.includes('{{') || CUT_NOTE.test(d) ? 'modify_settings' : 'write_data';
}

/** Assignment can share a task with another person. Unresolved assignments use the safer category. */
export function wrikeTaskCategory(input: Record<string, unknown>): ActionCategory {
  return present(input.assignees) && !(Array.isArray(input.assignees) && input.assignees.length === 0) ? 'modify_settings' : 'write_data';
}

/**
 * monday.com `create_board`: a public board is visible to the whole account,
 * a shareable one can take guests, and owners or subscribers are people given
 * the board. Only a private board with no owners or subscribers is the
 * caller's alone, a write. Anything else, a templated value included, is the
 * worst case.
 */
export function mondayCreateBoardCategory(input: Record<string, unknown>): ActionCategory {
  const none = (v: unknown) => !present(v) || (Array.isArray(v) && v.length === 0);
  return input.board_kind === 'private' && none(input.board_owner_ids) && none(input.board_subscriber_ids)
    ? 'write_data' : 'modify_settings';
}

/** monday.com `create_workspace`: an open workspace is visible to everyone in
 * the account; only an explicitly closed one is the caller's alone. */
export function mondayCreateWorkspaceCategory(input: Record<string, unknown>): ActionCategory {
  return input.kind === 'closed' ? 'write_data' : 'modify_settings';
}

/** monday.com `update_workspace`: its kind (open or closed) or account product
 * decides who can see it; a rename or description is a write. */
export function mondayUpdateWorkspaceCategory(input: Record<string, unknown>): ActionCategory {
  return present(input.kind) || present(input.account_product_id) ? 'modify_settings' : 'write_data';
}

/** monday.com `update_board_hierarchy` and `update_folder`: moving a board or
 * folder to another workspace or account product changes who can see it; a
 * folder change or rename inside the same workspace is a write. */
export function mondayMoveAcrossWorkspacesCategory(input: Record<string, unknown>): ActionCategory {
  return present(input.workspace_id) || present(input.account_product_id) ? 'modify_settings' : 'write_data';
}

/** monday.com `duplicate_board`: keeping subscribers gives the original's
 * people the copy. Without them (upstream's default) it is a write. */
export function mondayDuplicateBoardCategory(input: Record<string, unknown>): ActionCategory {
  return !present(input.keep_subscribers) || input.keep_subscribers === false ? 'write_data' : 'modify_settings';
}

const NOTION_PIECE = '@activepieces/piece-notion';
/** Every Notion action that changes the workspace (write, send or delete),
 * on the managed connection or the user's own. None parks its flow, so each
 * one can be tracked. `custom_api_call` is left out: it may be a read. */
function notionTracked(action: unknown): boolean {
  const categories = GOVERNED_PIECE_ADAPTERS.find(a => a.pieceName === NOTION_PIECE)!.categories;
  return typeof action === 'string' && action !== 'custom_api_call' && (['write_data', 'send_message', 'delete_data'] as const)
    .some(category => categories[category]?.includes(action));
}
/** Notion `notion_archive_page` sets `archived`: false restores the page (a
 * write); true, or anything not literally false, trashes it. */
function notionArchivePageCategory(input: Record<string, unknown>): ActionCategory {
  return input.archived === false ? 'write_data' : 'delete_data';
}

const DROPBOX_PIECE = '@activepieces/piece-dropbox';
/** Every Dropbox action that changes the account or hands out access (write,
 * send or delete). None parks its flow, so each one can be tracked. */
function dropboxTracked(action: unknown): boolean {
  const categories = MANAGED_PIECE_ADAPTERS.find(a => a.pieceName === DROPBOX_PIECE)!.categories;
  return typeof action === 'string' && (['write_data', 'send_message', 'delete_data'] as const)
    .some(category => categories[category]?.includes(action));
}

/** The vendored core GraphQL piece (#961). */
export const GRAPHQL_PIECE = '@activepieces/piece-graphql';
/** The vendored core SMTP piece (#961). */
export const SMTP_PIECE = '@activepieces/piece-smtp';
/**
 * The pieces whose egress refusals were each checked to come before anything
 * is sent (#1153): their tracked send refused so is recorded as not sent. Any
 * other piece's refusal stays uncertain, since it may have made an earlier call.
 */
export const NOT_SENT_PIECES: ReadonlySet<string> = new Set(['@activepieces/piece-http', '@activepieces/piece-graphql', SMTP_PIECE]);
/** The vendored core FTP/SFTP piece (#961). */
export const SFTP_PIECE = '@activepieces/piece-sftp';

/** The vendored core HTTP piece (#961). */
export const HTTP_PIECE = '@activepieces/piece-http';

/**
 * True for an HTTP method that only reads: GET and HEAD, in any letter case
 * (axios upper-cases the method it sends). Anything else, including a method
 * with surrounding space or one that is not a string, is not a read. A request
 * is a read only when `httpRequestIsRead` also finds no body. The category,
 * the completion tracking, the in-piece retry and the redirect rule all ask
 * that one function, but not of the same value: the daemon and the engine ask
 * of the bounded projection, the piece of its raw props. They agree because a
 * cut can only take a request away from being a read (see `httpRequestIsRead`
 * and `ruleInput`), never make one.
 */
export function httpMethodIsRead(method: unknown): boolean {
  return typeof method === 'string' && /^(get|head)$/iu.test(method);
}

/**
 * True for an HTTP request that only reads: a GET or HEAD that carries no
 * body. The piece sends `body.data` whatever the method (axios puts a body on
 * a GET too, measured), so a GET with one is content leaving for the host,
 * not a read (#961 security review).
 *
 * A cut never makes a request read as body-less. A cut string or array is
 * still a non-empty value. A `body` object cut at 40 keys can have lost
 * `data` to keys that sort before it (`{a00..a39, data}` projects as
 * `{a00..a39, omittedFields: 1}`), so a body object carrying the bare marker,
 * or over 40 keys as the piece's raw props, is never a read. The top-level
 * cut is `ruleInput`'s, which callers apply before asking.
 */
export function httpRequestIsRead(input: Record<string, unknown>): boolean {
  if (!httpMethodIsRead(input.method)) return false;
  const body = input.body;
  if (body === undefined || body === null || body === '') return true;
  const fields = inputObject(body);
  if (fields && (Object.hasOwn(fields, OMITTED_FIELDS) || Object.keys(fields).length > MAX_KEYS)) return false;
  const data = fields ? fields.data : body;
  return data === undefined || data === null || data === '';
}

/**
 * The host an HTTP step's URL names, in `readHostKey` form, or null when it
 * cannot be told for certain: not a string, not http(s), not a URL, or cut
 * by the projection's bound (a cut can end inside the host, and a URL that
 * long is better asked about anyway).
 */
export function httpRequestHost(url: unknown): string | null {
  if (typeof url !== 'string' || /\.\.\. \[\d+ more characters\]$/u.test(url)) return null;
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return readHostKey(parsed.hostname.includes(':') && !parsed.hostname.startsWith('[') ? `[${parsed.hostname}]` : parsed.hostname);
}

/**
 * #1153 (owner decision): an HTTP read runs without asking only when the
 * flow's read list names its URL's host. A body-less GET still carries
 * whatever its URL and headers hold to the host it names, so to any other
 * host it is a send. `hosts` is the flow's list, already in `readHostKey` form.
 */
export function httpReadHostListed(input: Record<string, unknown>, hosts: readonly string[]): boolean {
  const host = httpRequestHost(input.url);
  return host !== null && hosts.includes(host);
}

function inputObject(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

/**
 * The input a `categoryFromInput` rule may read, or null when it must take the
 * table's worst case. A rule reads the projection, and a projection cut at 40
 * keys (sorted) has lost fields the piece still receives: the engine passes
 * the piece the whole resolved input and nothing rejects an unknown prop, so
 * 40 padding keys that sort first (`a00`...) would push the rule's props out
 * of the projection, and a rule that reads an absent prop as the narrow case
 * (a Trello update with no `closed`) would be defeated. So a cut object -- one
 * carrying the bare `omittedFields` count, which a real field can never spell
 * (`escapeMarkerSpelling`), or one over 40 keys that was never projected -- is
 * not read at all. The engine and the daemon both ask this, so the category
 * and the completion tracking agree on either side.
 *
 * WHAT THIS MOVED. `bound()` is untouched, so every projection, and with it
 * every `requestDigest`, is byte-exact as before. What changed is the category
 * and the tracking read FROM a cut projection, and only for an input whose
 * top-level object (or HTTP `body` object, `httpRequestIsRead`) has over 40
 * keys:
 *   - A padded Trello card update (or any rule that read an absent prop as the
 *     narrow case) recorded or approved as `write_data` now resolves to the
 *     blind `delete_data`. When it re-authorizes (a resume, an engine retry),
 *     the recorded `actionCategory` no longer matches, so `effect-boundary.ts`
 *     fails it with "Workflow effect changed since it was recorded; start a
 *     new run ..." and the new run asks at the real category.
 *   - A padded HTTP GET (method kept, or a body whose `data` was cut) that was
 *     recorded as an untracked read is now a tracked send. A legacy record
 *     still `pending` under the untracked route is blocked with
 *     `WORKFLOW_UPGRADED` (`service-backends.ts`, the legacy branch of
 *     `pieceAuthorize`) rather than moved to the tracked identity.
 *   - Completion receipts are unaffected: a step already tracked stays tracked.
 * This file is in `PATCHED_VENDOR_SOURCES`, so the edit rebuilds every cached
 * engine bundle.
 */
function ruleInput(input: unknown): Record<string, unknown> | null {
  const fields = inputObject(input);
  if (!fields) return null;
  return Object.hasOwn(fields, OMITTED_FIELDS) || Object.keys(fields).length > MAX_KEYS ? null : fields;
}

/**
 * #953 (owner decision): a verified piece action whose category is above the
 * workflow's level asks for approval instead of being denied, but only for
 * these categories and only while the owner governs them, and only when the
 * workflow clears this floor on its own. Deletes, settings changes and
 * installs stay denied by level; an override, a context rule or a profile
 * deny still denies, since only a pure level shortfall is ever substituted.
 */
export const PIECE_ABOVE_LEVEL_ASKS: readonly ActionCategory[] = ['send_email', 'send_message', 'make_payment'];
export const PIECE_ABOVE_LEVEL_FLOOR: ActionCategory = 'write_data';

/** How an action's category is read from its input (`categoryFromInput`). */
export interface InputCategoryRule {
  /** The input props the rule reads, so a reviewer can tell whether they are fixed. */
  props: readonly string[];
  category: (input: Record<string, unknown>) => ActionCategory;
}

export interface GovernedPieceAdapter {
  /**
   * Catalog id, as in `pieces-library/catalog-overrides.ts` `VERIFIED`. For a
   * vendored core piece (`CORE_PIECE_ADAPTERS`) it is the vendored directory
   * name under `packages/pieces/core`.
   */
  catalogId: string;
  /** npm package name, as it appears in a `FlowVersion` step's `pieceName`. */
  pieceName: string;
  /**
   * Category for any action this adapter does not name. Must be the most
   * severe category the piece can reach, so an action added upstream after
   * this table was written is over-gated rather than under-gated.
   */
  unknownActionCategory: ActionCategory;
  /**
   * Action names per category. Complete for the version the catalog installs:
   * `governed-pieces.test.ts` checks every action in that version's manifest
   * (`pieces-library/verified-manifests-generated.ts`) is named here.
   */
  categories: Partial<Record<ActionCategory, readonly string[]>>;
  /**
   * Input props that identify what the action will act on, in the order they
   * should read on an approval card. Values are copied from the resolved step
   * input; absent props are omitted.
   */
  targetProps: readonly string[];
  /**
   * Actions whose category is decided by an input value (#961): an HTTP
   * request's method. `categories` names each such action at the worst case
   * its input can reach, which is what a caller that cannot see the input (a
   * job contract, a stored provenance) is told. The rule may only narrow that
   * (`governed-pieces.test.ts` pins it), and it reads the projected input,
   * whose whole original the engine's `inputDigest` binds. A projection cut at
   * 40 keys is never read: the action takes the worst case (`ruleInput`).
   */
  categoryFromInput?: Readonly<Record<string, InputCategoryRule>>;
  /**
   * Hide inline credentials a piece takes as ordinary props before the input
   * is bounded for the card and the effect record. Must be deterministic and
   * idempotent: the daemon applies it again to what the engine sent
   * (`projected` true on that pass).
   */
  redactInput?: (input: Record<string, unknown>, projected: boolean) => Record<string, unknown>;
}

/**
 * The verified ten. Each table covers every action of the version
 * `pieces-library/catalog.ts` installs; the catalog sync only moves a verified
 * piece to a version this table still covers (`scripts/lib/verified-upgrade.ts`).
 */
export const GOVERNED_PIECE_ADAPTERS: readonly GovernedPieceAdapter[] = [
  {
    catalogId: 'gmail',
    pieceName: '@activepieces/piece-gmail',
    // Gmail spans read through send to permanent deletion, so no single
    // category describes it. `gmail_delete_draft` deletes permanently and
    // `gmail_stop_watch` changes a mailbox setting; both sit at level 9, so an
    // unmapped Gmail action is gated as a deletion.
    unknownActionCategory: 'delete_data',
    targetProps: ['receiver', 'cc', 'bcc', 'subject', 'reply_to', 'from', 'to',
      'message_id', 'message_ids', 'thread_id', 'draft_id', 'label', 'label_id', 'name',
      'add_label_ids', 'remove_label_ids', 'url', 'method'],
    categories: {
      read_data: ['gmail_get_mail', 'gmail_search_mail', 'gmail_get_message', 'gmail_search_email',
        'gmail_get_thread', 'gmail_get_draft', 'gmail_list_drafts', 'gmail_list_threads',
        'gmail_get_attachment', 'gmail_list_labels', 'gmail_get_label', 'gmail_get_profile',
        'gmail_list_history'],
      // Drafts, labels and archiving change the mailbox but send nothing and
      // destroy nothing: a draft can be edited, a label re-applied, an
      // archived message is still in All Mail.
      write_data: ['create_draft_reply', 'gmail_create_draft', 'gmail_update_draft',
        'gmail_create_label', 'gmail_add_label_to_email', 'gmail_remove_label_from_email',
        'gmail_archive_email', 'gmail_archive_message', 'gmail_get_or_create_label',
        'gmail_update_label', 'gmail_untrash_message'],
      // Mail leaves the account under the user's own address, including the
      // approval-request action, which is a send that then waits.
      send_email: ['send_email', 'gmail_send_email', 'reply_to_email', 'gmail_reply_to_thread',
        'gmail_send_draft', 'gmail_forward_message', 'request_approval_in_mail'],
      // Trash is recoverable for 30 days and then Gmail deletes it with no
      // further action, so it is a deletion on a timer, not an archive. The
      // two batch label actions take arbitrary label ids, and adding TRASH or
      // SPAM through them trashes up to 1000 messages, or a whole thread, in
      // one call. A category is per action, not per input, so they sit at
      // their worst case. Upstream marks all three WRITE.
      delete_data: ['gmail_delete_draft', 'gmail_trash_message', 'gmail_modify_labels',
        'gmail_modify_thread_labels', 'custom_api_call'],
      // Stops push notifications on the mailbox: a mailbox-level setting, and
      // silently disabling it would stop every watch-driven flow.
      modify_settings: ['gmail_stop_watch'],
    },
  },
  {
    catalogId: 'slack',
    pieceName: '@activepieces/piece-slack',
    unknownActionCategory: 'delete_data',
    targetProps: ['channel', 'user', 'userId', 'recipients', 'username', 'email', 'handle', 'ts', 'threadTs',
      'text', 'file', 'reaction', 'name', 'query', 'url', 'method'],
    categories: {
      read_data: ['get-file', 'searchMessages', 'slack-find-user-by-email', 'slack-find-user-by-handle',
        'find-user-by-id', 'listUsers', 'getChannelHistory', 'retrieveThreadMessages', 'get-message',
        'get_group_by_handle', 'slack_list_scheduled_messages', 'slack_get_message_permalink',
        'slack_get_channel_history', 'slack_get_thread_replies', 'slack_search_messages', 'slack_search_all',
        'find_user_by_email', 'get_user', 'list_users', 'find_user_by_handle', 'slack_find_channel',
        'slack_get_channel_info', 'slack_get_file', 'slack_get_reactions', 'slack_list_channel_members',
        'slack_list_channels', 'slack_list_custom_emoji', 'slack_list_files', 'slack_list_user_conversations',
        'list_user_groups', 'slack_list_user_reactions',
        // Pure local text conversion; it never calls Slack at all.
        'markdownToSlackFormat'],
      // Anything whose content lands in front of other people, including an
      // edit: replacing a posted message publishes new text to the channel.
      send_message: ['send_direct_message', 'send_channel_message', 'request_approval_direct_message',
        'request_approval_message', 'request_action_direct_message', 'request_action_message',
        'slack_post_message', 'slack_send_direct_message', 'slack_schedule_message',
        'slack_send_ephemeral_message', 'updateMessage', 'slack_update_message',
        'send_message_to_multiple_users'],
      // Workspace content and the bot's own membership: reversible, and
      // scoped to what the caller already has.
      write_data: ['slack-add-reaction-to-message', 'slack_add_reaction', 'slack_remove_reaction',
        'uploadFile', 'slack_mark_conversation_read', 'slack_join_channel', 'slack_leave_channel',
        'slack_close_dm', 'slack-create-channel', 'slack_create_channel', 'slack_rename_channel',
        'set-channel-topic', 'slack_set_channel_topic', 'slack_set_channel_purpose',
        'slack-set-user-status', 'set_user_status', 'slack_unarchive_channel'],
      // Who can read what: channel membership, user groups, and a profile
      // update that can rewrite the account's email address.
      modify_settings: ['invite-user-to-channel', 'slack_invite_users_to_channel',
        'slack_remove_user_from_channel', 'update_group_users', 'slack-update-profile', 'update_profile'],
      // Archiving takes an active channel away from everyone in it. The
      // restore direction is a plain write above.
      delete_data: ['delete-message', 'slack_delete_message', 'slack_delete_scheduled_message',
        'slack_archive_channel', 'custom_api_call'],
    },
  },
  {
    catalogId: 'notion',
    pieceName: '@activepieces/piece-notion',
    unknownActionCategory: 'delete_data',
    targetProps: ['database_id', 'page_id', 'pageId', 'block_id', 'item_id', 'database_item_id',
      'archived_item_id', 'parent_page_id', 'new_parent_page_id', 'archived', 'title', 'content', 'comment_text', 'url', 'method'],
    categories: {
      read_data: ['list_databases', 'notion-find-database-item', 'list_database_pages',
        'getPageOrBlockChildren', 'retrieve_database', 'get_page_comments', 'find_page', 'notion_get_page',
        'notion_get_block_children', 'notion_get_page_comments', 'notion_search', 'notion_list_users',
        'notion_get_user', 'notion_get_database', 'notion_query_database', 'notion_find_database_item'],
      write_data: ['create_database_item', 'update_database_item', 'createPage', 'append_to_page',
        'restore_database_item', 'add_comment', 'notion_create_page',
        'notion_append_to_page', 'notion_add_comment', 'notion_update_block', 'notion_create_database',
        'notion_create_database_item', 'notion_update_database_item',
        'notion_restore_database_item'],
      // A Notion archive moves the page to the trash, where it ages out --
      // unlike a Gmail archive, which only takes a label off. A move takes the
      // page out of its old parent and gives it the new parent's sharing, and a
      // schema update can drop a property with its values (upstream labels it
      // DESTRUCTIVE). Every action of the pinned 0.8.3 bundle is named
      // (`managed-notion.test.ts` pins the list, the engine test checks it
      // against the installed package).
      delete_data: ['archive_database_item', 'notion_archive_page', 'notion_delete_block',
        'notion_archive_database_item', 'notion_move_page', 'notion_update_database_schema', 'custom_api_call'],
    },
    // `archived: false` restores instead of trashing (`notionArchivePageCategory`).
    categoryFromInput: { notion_archive_page: { props: ['archived'], category: notionArchivePageCategory } },
  },
  {
    catalogId: 'openai',
    pieceName: '@activepieces/piece-openai',
    unknownActionCategory: 'delete_data',
    targetProps: ['model', 'prompt', 'text', 'input', 'query', 'fileName', 'purpose', 'url', 'method'],
    categories: {
      read_data: ['list_files', 'find_file', 'list_models'],
      // A completion is not a read: the prompt leaves the device to a third
      // party and the call creates a billable artifact on the user's account.
      write_data: ['ask_chatgpt', 'ask_assistant', 'vision_prompt', 'extract-structured-data',
        'classify_text', 'analyze_sentiment', 'create_embedding', 'search_embeddings', 'generate_image',
        'edit_image', 'text_to_speech', 'transcribe', 'translate', 'upload_file'],
      delete_data: ['delete_file', 'custom_api_call'],
    },
  },
  {
    catalogId: 'claude',
    pieceName: '@activepieces/piece-claude',
    // Only `custom_api_call` reaches this today, and through it the API key
    // reaches every Anthropic endpoint, files and batches included.
    unknownActionCategory: 'delete_data',
    targetProps: ['model', 'modelId', 'prompt', 'systemPrompt', 'text', 'mode', 'requests',
      'messageBatchId', 'url', 'method'],
    categories: {
      read_data: ['list_models', 'get_model', 'get_message_batch', 'list_message_batches',
        'get_message_batch_results'],
      // Same line as openai's: the prompt leaves the device to a third party,
      // so even a token count is not a read. A batch is also billable.
      write_data: ['ask_claude', 'extract-structured-data', 'create_message_batch', 'count_tokens'],
      // Deleting a batch removes its results for good. Cancelling one stops
      // in-flight work irreversibly, possibly another workload's on the same
      // key, which is the reason slack's archive sits here too.
      delete_data: ['cancel_message_batch', 'delete_message_batch', 'custom_api_call'],
    },
  },
  {
    catalogId: 'github',
    pieceName: '@activepieces/piece-github',
    unknownActionCategory: 'delete_data',
    targetProps: ['repository', 'issue_number', 'pull_number', 'discussion_number', 'commit_id',
      'branch', 'source_branch', 'new_branch_name', 'title', 'filename', 'public', 'path', 'username',
      'url', 'method'],
    categories: {
      read_data: ['getIssueInformation', 'find_branch', 'find_issue', 'find_user'],
      write_data: ['github_create_issue', 'createCommentOnAIssue',
        'github_create_pull_request_review_comment', 'github_create_commit_comment',
        'github_create_discussion_comment', 'add_labels_to_issue', 'create_branch', 'update_issue',
        // Locking an issue is reversible moderation on one thread, not an
        // account-wide permission change.
        'lockIssue', 'unlockIssue'],
      // A gist can be public, so this publishes content to anyone, not only
      // to people who already had access to the repository.
      send_message: ['github_create_gist'],
      // `rawGraphqlQuery` accepts mutations, so it reaches as far as the
      // token does -- the same reason custom_api_call sits here.
      delete_data: ['delete_branch', 'rawGraphqlQuery', 'custom_api_call'],
    },
  },
  {
    catalogId: 'google-calendar',
    pieceName: '@activepieces/piece-google-calendar',
    unknownActionCategory: 'delete_data',
    targetProps: ['calendar_id', 'calendar_ids', 'event_id', 'eventId', 'title', 'attendees',
      'start_date_time', 'end_date_time', 'start_date', 'end_date', 'location', 'send_updates',
      'send_notifications', 'url', 'method'],
    categories: {
      read_data: ['google_calendar_get_events', 'google_calendar_find_busy_free_periods',
        'google_calendar_get_event_by_id', 'google_calendar_search_events_all_calendars',
        'google_calendar_find_free_slots', 'google_calendar_list_recurring_event_instances',
        'google_calendar_get_event', 'google_calendar_list_events', 'google_calendar_find_busy_periods',
        'google_calendar_list_calendars', 'google_calendar_get_calendar', 'google_calendar_get_colors',
        'google_calendar_list_settings'],
      write_data: ['create_quick_event', 'create_google_calendar_event', 'update_event',
        'google_calendar_move_event', 'google_calendar_create_event', 'google_calendar_update_event',
        'google_calendar_import_event'],
      // Changing the guest list makes Google mail those people on the user's
      // behalf, so it reaches further than the calendar itself.
      send_message: ['google-calendar-add-attendees', 'google_calendar_remove_attendee'],
      delete_data: ['delete_event', 'google_calendar_delete_event', 'custom_api_call'],
    },
  },
  {
    catalogId: 'google-drive',
    pieceName: '@activepieces/piece-google-drive',
    unknownActionCategory: 'delete_data',
    targetProps: ['file_id', 'fileId', 'fileName', 'file_name', 'name', 'folderId', 'folder_id',
      'parent_folder_id', 'parentFolder', 'drive_id', 'user_email', 'role', 'type', 'permission_name',
      'send_invitation_email', 'comment_id', 'reply_id', 'url', 'method'],
    categories: {
      read_data: ['read-file', 'get-file-or-folder-by-id', 'list-files', 'search-folder',
        'drive_export_folder_as_zip', 'drive_download_file', 'drive_export_workspace_file',
        'drive_get_file', 'drive_list_files', 'drive_search_files', 'drive_list_permissions',
        'drive_list_shared_drives', 'drive_get_shared_drive', 'drive_list_comments', 'drive_get_reply',
        'drive_list_replies', 'drive_get_about'],
      write_data: ['create_new_gdrive_folder', 'create_new_gdrive_file', 'upload_gdrive_file',
        'duplicate_file', 'save_file_as_pdf', 'google-drive-move-file', 'drive_create_folder',
        'drive_create_file_from_text', 'drive_upload_file', 'drive_upload_from_url',
        'drive_replace_file_content', 'drive_copy_file', 'drive_move_file', 'drive_update_file_metadata',
        'drive_save_file_as_pdf', 'drive_untrash_file', 'drive_create_shared_drive',
        'drive_update_shared_drive', 'drive_create_comment', 'drive_create_reply', 'drive_update_reply'],
      // Sharing is the action that hands a file to someone who could not read
      // it a moment ago, public access most of all.
      modify_settings: ['update_permissions', 'delete_permissions', 'set_public_access',
        'drive_share_file', 'drive_set_public_access', 'drive_update_permission', 'drive_remove_permission'],
      delete_data: ['delete_gdrive_file', 'trash_gdrive_file', 'drive_trash_file', 'drive_delete_file',
        'drive_empty_trash', 'drive_delete_shared_drive', 'drive_delete_reply', 'custom_api_call'],
    },
  },
  {
    catalogId: 'discord',
    pieceName: '@activepieces/piece-discord',
    unknownActionCategory: 'delete_data',
    targetProps: ['guild_id', 'channel_id', 'user_id', 'role_id', 'message_id', 'name', 'content',
      'message', 'reason', 'emoji', 'webhook_url', 'url', 'method'],
    categories: {
      read_data: ['list_guild_members', 'find_channel', 'discord_find_channel', 'discord_find_member',
        'discord_list_messages', 'discord_list_pinned_messages', 'discord_list_reactions',
        'discord_list_active_threads', 'discord_list_archived_threads', 'discord_list_channels',
        'discord_get_channel', 'discord_get_member', 'discord_list_bans', 'discord_list_roles',
        'discord_get_guild', 'discord_list_emojis', 'discord_list_scheduled_events',
        'discord_list_invites', 'discord_get_user'],
      send_message: ['sendMessageWithBot', 'send_message_webhook', 'request_approval_message',
        'discord_send_message', 'discord_edit_message'],
      write_data: ['rename_channel', 'create_channel', 'discord_create_channel', 'discord_rename_channel',
        'discord_pin_message', 'discord_unpin_message', 'discord_add_reaction', 'discord_remove_reaction',
        'discord_create_thread_from_message', 'discord_create_thread', 'discord_join_thread',
        'discord_leave_thread', 'discord_create_scheduled_event', 'discord_update_scheduled_event',
        'discord_create_dm'],
      // Roles, bans, guild membership and invites decide who can see and do
      // what in the server.
      modify_settings: ['add_role_to_member', 'remove_role_from_member', 'remove_member_from_guild',
        'remove_ban_from_user', 'createGuildRole', 'deleteGuildRole', 'ban_guild_member',
        'discord_add_role', 'discord_remove_role', 'discord_create_role', 'discord_delete_role',
        'discord_update_role', 'discord_add_thread_member', 'discord_revoke_invite'],
      // Deleting other people's messages and reactions, and channels whole.
      delete_data: ['delete_channel', 'discord_delete_channel', 'discord_delete_message',
        'discord_bulk_delete_messages', 'discord_remove_user_reaction', 'discord_clear_reactions',
        'discord_delete_scheduled_event', 'custom_api_call'],
    },
  },
  {
    catalogId: 'telegram-bot',
    pieceName: '@activepieces/piece-telegram-bot',
    // The piece exposes seven actions, but the bot token reaches the whole Bot
    // API, which deletes messages and bans members. An action this table does
    // not name is gated accordingly.
    unknownActionCategory: 'delete_data',
    targetProps: ['chat_id', 'user_id', 'message', 'message_thread_id', 'media_type', 'file_id',
      'name', 'expire_date', 'member_limit', 'url', 'method'],
    categories: {
      read_data: ['get_chat_member', 'get_file'],
      send_message: ['send_text_message', 'send_media', 'request_approval_message'],
      // An invite link lets anyone holding it into the chat.
      modify_settings: ['create_invite_link'],
      delete_data: ['custom_api_call'],
    },
  },
];

/**
 * The vendored core pieces that act outside Jarvis (#961). They ship with the
 * engine (`scripts/sync-activepieces.ts`), not from the catalog, so they are
 * not "verified" catalog entries; they pass the same boundary as those do.
 * A core piece that acts only inside the run is listed in
 * `step-admission.ts` (`IN_RUN_STEP_PIECES`) instead, and every vendored core
 * piece is in exactly one of the two (`core-pieces.test.ts`).
 */
export const CORE_PIECE_ADAPTERS: readonly GovernedPieceAdapter[] = [
  {
    catalogId: 'http',
    pieceName: HTTP_PIECE,
    // An action this table does not name could send anywhere with any method.
    unknownActionCategory: 'delete_data',
    // Where the request goes, as the approval card shows it.
    targetProps: ['method', 'url'],
    categories: {
      // Pure string parsing; it never touches the network.
      read_data: ['parse_url'],
      // The worst case of `httpRequestCategory`, for a caller with no input.
      delete_data: ['send_request'],
    },
    categoryFromInput: { send_request: { props: ['method', 'body'], category: httpRequestCategory } },
    redactInput: redactHttpInput,
  },
  {
    catalogId: 'graphql',
    pieceName: GRAPHQL_PIECE,
    unknownActionCategory: 'delete_data',
    targetProps: ['method', 'url'],
    // Its one action always sends the query as a body, whatever the method, so
    // it is an HTTP request with a body: a send for GET, POST, PUT and PATCH,
    // and the worst case for DELETE or anything else (`graphqlRequestCategory`).
    categories: { delete_data: ['send_request'] },
    categoryFromInput: { send_request: { props: ['method'], category: graphqlRequestCategory } },
    // Headers, query parameters and the URL can carry a credential, as on the HTTP step.
    redactInput: redactGraphqlInput,
  },
  {
    catalogId: 'smtp',
    pieceName: SMTP_PIECE,
    unknownActionCategory: 'send_email',
    targetProps: ['from', 'senderName', 'to', 'cc', 'bcc', 'replyTo', 'subject'],
    categories: { send_email: ['send-email'] },
  },
  {
    catalogId: 'sftp',
    pieceName: SFTP_PIECE,
    // Deletes a file or a whole folder tree on the server.
    unknownActionCategory: 'delete_data',
    targetProps: ['filePath', 'fileName', 'directoryPath', 'folderPath', 'oldPath', 'newPath', 'recursive'],
    categories: {
      read_data: ['read_file_content', 'listFolderContents'],
      // Makes a directory; nothing is replaced and nothing leaves the run.
      write_data: ['createFolder'],
      // Puts content on a server the connection names, replacing a file
      // already at that path: as an HTTP PUT, a send. Not tracked: a repeat
      // after an unknown outcome writes the same bytes to the same path.
      send_message: ['upload_file', 'create_file'],
      // A rename replaces whatever is at the new path on servers that allow
      // it (FTP RNTO does), and deletes remove a file or a folder tree.
      delete_data: ['renameFileOrFolder', 'deleteFile', 'deleteFolder'],
    },
  },
];

/**
 * A GraphQL request's category: always an HTTP request with a body (the piece
 * sends `{ query, variables }` whatever the method), so never a read.
 */
export function graphqlRequestCategory(input: Record<string, unknown>): ActionCategory {
  return httpRequestCategory({ method: input.method, body: { data: 'query' } });
}

/**
 * The GraphQL step's inline credentials: as the HTTP step's (headers, query
 * parameters, the URL, the proxy password), plus credential-named fields in
 * its variables (a login mutation's `password`).
 */
export function redactGraphqlInput(input: Record<string, unknown>): Record<string, unknown> {
  const out = redactHttpInput(input);
  return inputObject(out.variables) || Array.isArray(out.variables) ? { ...out, variables: redactNamed(out.variables) } : out;
}

/**
 * An HTTP request's category, by method (owner decision on #961). A GET or a
 * HEAD with no body reads; with a body it sends, as a POST does. POST, PUT and PATCH carry content to an endpoint the flow names,
 * which need not be the user's own account: under the category rules above
 * that is delivering content to someone else, the reason `github_create_gist`
 * is `send_message`, so it asks first while `send_message` is governed (the
 * default). DELETE destroys. Any other value -- an unknown method, a method
 * computed into something unexpected -- is gated as the worst case.
 */
export function httpRequestCategory(input: Record<string, unknown>): ActionCategory {
  const method = input.method;
  if (httpRequestIsRead(input)) return 'read_data';
  // A GET or HEAD that carries a body sends it, as a POST does.
  if (typeof method === 'string' && /^(get|head|post|put|patch)$/iu.test(method)) return 'send_message';
  return 'delete_data';
}

/** Header, query and field names that carry a credential rather than content. */
/**
 * A word in the name that marks a credential. Matched as a whole word, after
 * splitting camelCase, so `X-Api-Key`, `access_token` and `clientSecret`
 * match while `author`, `oauth_callback_url` and `sessionize` do not.
 */
const SECRET_WORD = /(^|[^a-z0-9])(auth|authorization|bearer|token|secret|passwd|password|passphrase|pwd|apikey|cookie|session[-_]?id|sessid|signature|sig|credentials?|key)([^a-z0-9]|$)/iu;
/** Run-together compounds a word match misses (`authtoken`, `PHPSESSID`, `clientsecret`). */
const SECRET_COMPOUND = /token|secret|passw|apikey|privatekey|sessid/iu;
export function isSecretName(name: string): boolean {
  return SECRET_WORD.test(name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2')) || SECRET_COMPOUND.test(name);
}
export const REDACTED = '[redacted]';
/** The note `bound()` appends to a string it cut. */
const CUT_NOTE = /\.\.\. \[\d+ more characters\]$/u;

/**
 * The redacted form of a credential value. A value that is already the marker,
 * or the start of it cut by the engine's bound (`[reda... [N more characters]`),
 * is kept as it is, so a second pass changes nothing and the cut note survives.
 */
function redactValue(value: string): string {
  const note = CUT_NOTE.exec(value)?.[0] ?? '';
  const head = value.slice(0, value.length - note.length);
  // Empty head with a note: the engine's cut fell right after the `=`, so
  // nothing of the value was kept and there is nothing left to hide.
  if (REDACTED.startsWith(head) && (head !== '' || note !== '')) return value;
  return `${REDACTED}${note}`;
}

/** Credential-named fields, at any depth `bound()` keeps, inside objects and arrays. */
/**
 * A value that is a scheme and one token (`Bearer x`, `Basic x`, `SSWS x`),
 * under whatever name it is stored. Prose is told apart by the token's shape:
 * a credential has a digit, mixed case, a symbol inside it, or 20+ characters;
 * "Basic membership", "Token expired." and "Key takeaways" have none.
 */
const SCHEMED_PREFIX = /^\s*(?:bearer|basic|token|digest|apikey|api-key|ssws|oauth|key)\s+([A-Za-z0-9._~+/=:-]{8,})\s*$/iu;
const SCHEMED_CREDENTIAL = {
  test(value: string): boolean {
    const token = SCHEMED_PREFIX.exec(value)?.[1];
    if (!token) return false;
    return /\d/u.test(token) || (/[a-z]/u.test(token) && /[A-Z]/u.test(token))
      || /[._~+/=:-]/u.test(token.slice(0, -1)) || token.length >= 20;
  },
};
/** A value that is a scheme and a credential-shaped token (`Bearer x`), whatever it is stored under. */
export function isSchemedCredential(value: string): boolean {
  return SCHEMED_CREDENTIAL.test(value);
}

function redactNamed(value: unknown, depth = 0): unknown {
  // Past any depth `bound()` keeps; a stored input (#1153) can go deeper, and
  // what lies beyond is hidden whole rather than shown unchecked.
  if (depth > 32) return value === null || value === undefined || typeof value !== 'object' ? value : REDACTED;
  if (typeof value === 'string') return SCHEMED_CREDENTIAL.test(value) ? redactValue(value) : value;
  if (Array.isArray(value)) return value.map((item) => redactNamed(item, depth + 1));
  const fields = inputObject(value);
  if (!fields) return value;
  return Object.fromEntries(Object.entries(fields).map(([key, item]) =>
    [key, isSecretName(key) && item !== null && item !== undefined && item !== ''
      ? (typeof item === 'string' ? redactValue(item) : REDACTED) : redactNamed(item, depth + 1)]));
}

/** A JSON body's credential-named fields, and form fields named like one. */
function redactBody(body: unknown): unknown {
  const fields = inputObject(body);
  if (!fields || !('data' in fields)) return body;
  const data = fields.data;
  if (Array.isArray(data)) {
    return { ...fields, data: data.map((row) => {
      const field = inputObject(row);
      return field && typeof field.fieldName === 'string' && isSecretName(field.fieldName) && 'textFieldValue' in field
        && field.textFieldValue !== '' && field.textFieldValue !== null && field.textFieldValue !== undefined
        ? { ...field, textFieldValue: typeof field.textFieldValue === 'string' ? redactValue(field.textFieldValue) : REDACTED } : row;
    }) };
  }
  if (typeof data === 'string') return { ...fields, data: redactBodyText(data) };
  return { ...fields, data: redactNamed(data) };
}

/**
 * Credential-named fields in a value, at any depth `bound()` keeps, or in a
 * JSON or form-encoded string: a response a durable receipt keeps (#1153).
 */
export function redactCredentials(value: unknown): unknown {
  return typeof value === 'string' ? redactBodyText(value) : redactNamed(value);
}

/**
 * Field and header names a durable receipt never keeps the value of (#1153):
 * tokens, secrets, passwords and API keys by their usual names. Narrower than
 * `isSecretName`, which judges what a reviewer is shown: a receipt is what a
 * replayed step hands the flow, so a `key` (a Jira issue key) or a
 * `token_type` must survive it.
 */
const RECEIPT_SECRET = /^(?:x[-_])?(?:(?:access|refresh|id|auth|subject|csrf|session|bearer|api)[-_]?token|token|client[-_]?secret|secret|password|passwd|api[-_]?key|authorization|private[-_]?key|session(?:[-_]?id)?|sessid|phpsessid)$/iu;
const isReceiptSecret = (name: string) => RECEIPT_SECRET.test(name);

/**
 * A response as a durable receipt keeps it (#1153): every field or header
 * whose name is a token's, at any depth, and token pairs in a JSON or
 * form-encoded string, replaced by `[redacted]`. `redacted` says whether
 * anything was, so the receipt can say so to a replay.
 */
export function redactReceipt(value: unknown): { value: unknown; redacted: boolean } {
  let redacted = false;
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > 64) return item;
    if (typeof item === 'string') {
      const out = redactBodyText(item, isReceiptSecret);
      if (out !== item) redacted = true;
      return out;
    }
    if (Array.isArray(item)) return item.map((entry) => walk(entry, depth + 1));
    const fields = inputObject(item);
    if (!fields) return item;
    return Object.fromEntries(Object.entries(fields).map(([key, entry]) => {
      if (isReceiptSecret(key) && entry !== null && entry !== undefined && entry !== '' && entry !== REDACTED) {
        redacted = true;
        return [key, REDACTED];
      }
      return [key, walk(entry, depth + 1)];
    }));
  };
  const out = walk(value, 0);
  return { value: out, redacted };
}

/** A name as written or percent-decoded (`api%5Fkey` is `api_key`). */
function isSecretParam(raw: string): boolean {
  let decoded = raw;
  try { decoded = decodeURIComponent(raw.replace(/\+/gu, ' ')); } catch { /* not valid percent-encoding: judge it as written */ }
  return isSecretName(raw) || isSecretName(decoded);
}

/**
 * A raw string body (#1153): credential-named JSON string fields and
 * credential-named form-encoded pairs. Text edits only, so a body the engine
 * cut still reads the same and a second pass changes nothing; a JSON value the
 * cut left unterminated is redacted to the end.
 */
function redactBodyText(text: string, secret: (name: string) => boolean = isSecretName): string {
  // A key is at most 128 plain characters, so each quote the scan starts at
  // looks a bounded way ahead: linear on hostile text, where an unbounded key
  // made it quadratic and, past JavaScriptCore's backtrack limit, silently
  // match nothing (#1153 review).
  const json = text.replace(/("([^"\\\n]{1,128})"\s*:\s*")((?:[^"\\]|\\.)*)("|$)/gu, (whole, head: string, name: string, value: string, end: string) =>
    secret(name) && value !== '' ? `${head}${redactValue(value)}${end}` : whole);
  // Form pairs only in text that is form-encoded through and through: in JSON
  // or prose a pair would run on and hide what follows from the card.
  if (!FORM_ENCODED.test(json)) return json;
  return json.replace(/(^|&)([^=&]+=)([^&]*)/gu, (whole, lead: string, name: string, value: string) =>
    (secret === isSecretName ? isSecretParam(name.slice(0, -1)) : secret(name.slice(0, -1))) && value !== '' ? `${lead}${name}${redactValue(value)}` : whole);
}

/** `a=1&b=2`: no whitespace, quotes, braces or angle brackets anywhere (a cut note's tail aside). */
const FORM_ENCODED = /^[^\s"'{}<>=&]+=[^\s"'{}<>&]*(?:&[^\s"'{}<>=&]+=[^\s"'{}<>&]*)*(?:\.\.\. \[\d+ more characters\])?$/u;

/**
 * Webhook URLs whose path is the credential (#1153): a Slack incoming webhook
 * (`hooks.slack.com/services/T/B/<secret>`), a Discord webhook
 * (`/api/webhooks/<id>/<token>`) and a Telegram bot (`/bot<token>/`). Only the
 * secret segment is replaced, so the card still shows where the request goes.
 */
const PATH_SECRETS: readonly RegExp[] = [
  // Scheme, optional userinfo (already redacted by then), host with an optional trailing dot and port, any slashes.
  /^(\s*https?:[\\/]+(?:[^/\\?#@]*@)?hooks\.slack\.com\.?(?::\d+)?[\\/]+(?:services|triggers|workflows|actions|commands)(?:[\\/]+[^/\\?#]+)*[\\/]+)([^/\\?#]+)/iu,
  /^(\s*https?:[\\/]+(?:[^/\\?#@]*@)?(?:[a-z0-9-]+\.)*discord(?:app)?\.com\.?(?::\d+)?[\\/]+api[\\/]+(?:v\d+[\\/]+)?webhooks[\\/]+[^/\\?#]+[\\/]+)([^/\\?#]+)/iu,
  /^(\s*https?:[\\/]+(?:[^/\\?#@]*@)?api\.telegram\.org\.?(?::\d+)?[\\/]+(?:file[\\/]+)?bot)([^/\\?#]+)/iu,
  // Teams incoming webhook: .../webhookb2/<group>@<tenant>/IncomingWebhook/<secret>/<owner>.
  // Zapier catch hook: /hooks/catch/<account>/<hook id>, a short id that may hold no digit.
  /^(\s*https?:[\\/]+(?:[^/\\?#@]*@)?hooks\.zapier\.com\.?(?::\d+)?[\\/]+hooks[\\/]+catch[\\/]+[^/\\?#]+[\\/]+)([^/\\?#]+)/iu,
  /^(\s*https?:[\\/]+(?:[^/\\?#@]*@)?(?:[a-z0-9-]+\.)*webhook\.office\.com\.?(?::\d+)?[\\/]+webhookb2[\\/]+[^/\\?#]+[\\/]+IncomingWebhook[\\/]+)([^/\\?#]+)/iu,
];

/** A segment after which every token-shaped segment is a hook secret: `/hooks/<id>/<token>`, `/webhook-test/<uuid>`. */
const HOOK_MARKER = /^(?:web)?hooks?(?:-test)?$/iu;
/** A segment naming the one segment after it as a credential: `/with/key/<key>`, `/token/<t>`. */
const KEY_MARKER = /^(?:(?:api[-_]?)?key|apikey|token|access[-_]?token|secret|passw(?:or)?d)$/iu;
/** A host whose own name says its paths are hook secrets (`hook.eu1.make.com/<token>`, `hooks.zapier.com/hooks/...`). */
const HOOK_HOST = /^(?:web)?hooks?\./iu;
const TOKEN_CHARS = /^[A-Za-z0-9._~+=:%-]+$/u;
const hasLetterAndDigit = (text: string): boolean => /[A-Za-z]/u.test(text) && /\d/u.test(text);
/** At least two letters and two digits: a random id, not a name with a version (`endpoint1`, `oauth2`). */
const isMixed = (text: string): boolean => (text.match(/[A-Za-z]/gu)?.length ?? 0) >= 2 && (text.match(/\d/gu)?.length ?? 0) >= 2;
/** A number with an optional extension (`123456789.json`) or an env-style name (`MY_SECRET_2024`): content. */
const NAMED_ID = /^\d+(?:\.[a-z]{2,5})?$|^[A-Z][A-Z0-9_]*$/u;
/**
 * A segment that reads as a token once a marker said one follows: letters and
 * digits mixed (8+ characters under a hook, 12+ after a key segment, a UUID),
 * or 20+ characters. Words (`catch`, `messages`), numbers (a GitHub hook id),
 * env-style names and versioned names (`endpoint1`, `/key/oauth2`) are content.
 */
const pathToken = (segment: string, mixedMin: number, cut: boolean): boolean => TOKEN_CHARS.test(segment)
  && (cut || (!NAMED_ID.test(segment) && ((segment.length >= mixedMin && isMixed(segment)) || segment.length >= 20)));
/**
 * A heading anchor: lowercase parts joined by `-`, `_` or `.`, one of them a
 * word no hex string spells (`step-1-install-dependencies`, `section-12-overview`).
 */
const isAnchor = (fragment: string): boolean => {
  const lower = fragment.toLowerCase();
  return /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/u.test(lower)
    && lower.split(/[-_.]/u).some((part) => part.length >= 3 && /^[a-z]*[g-z][a-z]*$/u.test(part));
};
/**
 * A fragment that is itself a token (`#<token>`), told from an anchor
 * (`#section-2`, `#step-1-install-dependencies`) or a route (`#/settings`) by
 * shape and length. A fragment the engine cut is judged on what is left of it.
 */
const fragmentToken = (raw: string, cut: boolean): boolean => {
  // Base64 padding is part of a token, not a `name=value` pair.
  const fragment = raw.replace(/=+$/u, '');
  return TOKEN_CHARS.test(fragment) && !fragment.includes('=') && !isAnchor(fragment)
    && ((cut && fragment.length >= 8) || (fragment.length >= 16 && hasLetterAndDigit(fragment)) || fragment.length >= 32);
};

/**
 * Token-shaped secrets in a URL's path and fragment that no name announces:
 * every token-shaped segment after a hook segment (`/hooks/<token>`,
 * `/rocket/hooks/<id>/<token>`) or on a hook host, the one segment after a key
 * or token segment (`/with/key/<key>`), and a bare fragment that is one token.
 * Ordinary paths keep their words and short plain numbers. A URL a
 * `PATH_SECRETS` pattern already matched (Slack, Discord, Telegram, Teams) is
 * left to it, so its team and channel ids stay readable. Text edits only; a URL
 * the engine cut is judged without its cut note, and the part the cut fell in
 * is hidden on less evidence, since the cut may have shortened it.
 */
function redactUrlTokens(url: string): string {
  const known = PATH_SECRETS.some((pattern) => pattern.test(url));
  const note = CUT_NOTE.exec(url)?.[0] ?? '';
  const text = url.slice(0, url.length - note.length);
  const parts = /^(\s*[a-z][a-z0-9+.-]*:[\\/]+)([^/\\?#]*)([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/iu.exec(text);
  if (!parts) return url;
  const [, scheme, authority, path, query = '', fragment = ''] = parts as unknown as [string, string, string, string, string?, string?];
  let hooked = !known && HOOK_HOST.test(authority.replace(/^.*@/u, ''));
  let keyNext = false;
  const cutInPath = note !== '' && query === '' && fragment === '';
  const segments = path.split(/([\\/]+)/u);
  const lastSegment = segments.length - 1;
  const redactedPath = segments.map((segment, i) => {
    if (known || i % 2 === 1 || segment === '') return segment;
    const underMarker = hooked || keyNext;
    const mixedMin = hooked ? 8 : 12;
    keyNext = false;
    if (underMarker && pathToken(segment, mixedMin, cutInPath && i === lastSegment)) return REDACTED;
    if (HOOK_MARKER.test(segment)) hooked = true;
    else if (KEY_MARKER.test(segment)) keyNext = true;
    return segment;
  }).join('');
  const body = fragment.slice(1);
  const redactedFragment = fragmentToken(body, note !== '' && fragment !== '') ? `#${REDACTED}` : fragment;
  return `${scheme}${authority}${redactedPath}${query}${redactedFragment}${note}`;
}

/**
 * The HTTP piece takes credentials as plain props: Basic or Bearer fields, a
 * proxy password, an `Authorization` header, an `api_key` query parameter, a
 * `password` field in a JSON or form body, or `user:password@` in the URL. None of them may reach the approval card or the
 * effect record (#961). The values are replaced, not dropped, so a reviewer
 * still sees that the request is authenticated. String edits only, never a
 * `URL` re-serialisation, so a value the engine already cut still reads the
 * same and a second pass changes nothing.
 */
export function redactHttpInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  if (inputObject(out.headers)) out.headers = redactNamed(out.headers);
  if (inputObject(out.queryParams)) out.queryParams = redactNamed(out.queryParams);
  if ('body' in out) out.body = redactBody(out.body);
  const auth = inputObject(out.authFields);
  if (auth) out.authFields = { ...auth, ...('password' in auth ? { password: REDACTED } : {}), ...('token' in auth ? { token: REDACTED } : {}) };
  const proxy = inputObject(out.proxy_settings);
  if (proxy && 'proxy_password' in proxy) out.proxy_settings = { ...proxy, proxy_password: REDACTED };
  if (typeof out.url === 'string') {
    out.url = out.url
      // Userinfo runs to the LAST @ before the path, so a password holding an @ goes whole.
      .replace(/^(\s*[a-z][a-z0-9+.-]*:[\\/]*)[^/\\?#]*@/iu, `$1${REDACTED}@`)
      // Query and fragment (`#access_token=` from an implicit OAuth grant), names as written or percent-decoded.
      .replace(/([?&;#][^=&#;]*=)([^&#;]*)/gu, (whole, name: string, value: string) =>
        isSecretParam(name.slice(1, -1)) && value !== '' ? `${name}${redactValue(value)}` : whole);
    for (const pattern of PATH_SECRETS) {
      out.url = (out.url as string).replace(pattern, (whole, head: string, secret: string) => secret !== '' ? `${head}${redactValue(secret)}` : whole);
    }
    out.url = redactUrlTokens(out.url as string);
  }
  return out;
}

interface ResolvedPieceAction {
  adapter: GovernedPieceAdapter;
  action: string;
  category: ActionCategory;
  /** False when the action is not in the table and took the worst-case fallback. */
  known: boolean;
  /**
   * True when the action's category depends on its input (`categoryFromInput`).
   * Resolved without an input it is the table's worst case, and a caller that
   * cannot see the input must treat the step as open.
   */
  byInput: boolean;
  /** The input props the category was read from, when `byInput`. */
  categoryProps?: readonly string[];
}

/**
 * ClickUp, a community piece (its badge stays) whose managed `jarvis:clickup`
 * connection made it governed. Every action of the pinned 0.9.1 bundle is
 * named (0.10.0 has the same set; `clickup-connection.test.ts` pins the list
 * and the engine test checks it against the installed package), so a
 * self-hosted workflow on the user's own connection keeps running at the
 * default level: reads, task and content writes, and comments or chat
 * messages need no more than level 3. Only `custom_api_call` and an action
 * added upstream fall back to `modify_settings`.
 */
export const MANAGED_PIECE_ADAPTERS: readonly GovernedPieceAdapter[] = [{
  // All 12 actions in published Zoom 0.9.2; managed credentials enable five.
  catalogId: 'zoom', pieceName: ZOOM_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['meeting_id','topic','start_time','duration','agenda','occurrence_id','schedule_for','password','require_authentication','auto_recording','audio','host_video','participant_video','join_before_host','waiting_room','mute_upon_entry','clear_agenda'],
  categories: {
    read_data: ['zoom_find_meeting','zoom_get_meeting','zoom_list_meetings','zoom_get_current_user','zoom_list_past_meeting_instances','zoom_list_recordings'],
    modify_settings: ['zoom_create_meeting','zoom_update_meeting','zoom_update_meeting_by_id','custom_api_call'],
    send_email: ['zoom_create_meeting_registrant'], delete_data: ['zoom_delete_meeting'],
  },
}, {
  // Exact npm Pipedrive 0.10.3 action names; managed credentials run only eight contact/deal operations.
  catalogId: 'pipedrive', pieceName: PIPEDRIVE_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['personId','dealId','name','title','term','fields','exactMatch','email','phone','organizationId','pipelineId','stageId','status','dealValue','dealValueCurrency','probability','expectedCloseDate','ownerId','visibleTo','marketing_status','productId','activityId','noteId','leadId','mergeWithId','productAttachmentId','id'],
  categories: {
    read_data: ['get-note', 'find-deals-associated-with-person', 'find-products', 'find-notes', 'get-product', 'find-user', 'get-deal', 'list-deals', 'search-deals', 'list-deal-products', 'get-person', 'list-persons', 'search-persons', 'get-organization', 'list-organizations', 'search-organizations', 'get-activity', 'list-activities', 'get-lead', 'get-lead-conversion-status', 'list-pipelines', 'list-stages', 'list-activity-types', 'list-users', 'get-current-user'],
    write_data: ['create-note', 'update-note', 'add-labels-to-person', 'add-product-to-deal', 'attach-file'],
    // Every action upstream labels DESTRUCTIVE. A deal create/update can set
    // `status: 'deleted'`, so blind it is a delete; its input narrows it. A
    // product create/update sends `is_deleted: !isActive`, so an inactive (or
    // unset) product is soft-deleted.
    delete_data: ['delete-deal', 'delete-person', 'delete-organization', 'delete-activity', 'delete-lead', 'delete-note', 'delete-product', 'merge-deals', 'merge-persons', 'merge-organizations', 'remove-product-from-deal', 'create-deal', 'update-deal', 'create-product', 'update-product'],
    // Upstream legacy Find operations create/delete filters. Managed connections use Search instead.
    modify_settings: ['add-follower', 'create-activity', 'update-activity', 'create-lead', 'update-lead', 'create-organization', 'update-organization', 'create-person', 'update-person', 'find-product', 'find-organization', 'find-person', 'find-deal', 'find-activity', 'find-lead', 'convert-lead-to-deal', 'custom_api_call'],
  },
  categoryFromInput: {
    ...Object.fromEntries(['create-person', 'update-person'].map(action =>
      [action, { props: ['ownerId', 'visibleTo', 'marketing_status'], category: pipedrivePersonCategory }])),
    ...Object.fromEntries(['create-deal', 'update-deal'].map(action =>
      [action, { props: ['ownerId', 'visibleTo', 'marketing_status', 'status'], category: pipedriveRecordCategory }])),
  },
}, {
  // Published Wrike 0.2.0. The managed credential enables only four task/comment actions.
  catalogId: 'wrike', pieceName: WRIKE_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['taskId', 'folderId', 'title', 'description', 'status', 'importance', 'entityType', 'entityId', 'text', 'assignees', 'authors', 'start_date', 'due_date', 'duration', 'customFields', 'plainText', 'fileName', 'file', 'parentFolderId', 'shareds', 'ownerIds', 'projectOwnerId', 'project', 'projectStartDate', 'projectEndDate', 'end_date', 'sortField', 'sortOrder', 'owners', 'parentIds'],
  categories: {
    read_data: ['find_task', 'find_folder'],
    write_data: ['upload_attachment'],
    send_message: ['add_comment'],
    // Task actions take their worst case without inputs; the rule narrows plain edits.
    // Folder/project creation can assign owners and share access.
    modify_settings: ['create_task', 'update_task', 'create_folder', 'create_project', 'custom_api_call'],
  },
  categoryFromInput: {
    create_task: {props:['assignees'],category:wrikeTaskCategory},
    update_task: {props:['assignees'],category:wrikeTaskCategory},
  },
}, {
  // Every action in published Help Scout 0.2.1; managed credentials enable three
  // (MANAGED_HELP_SCOUT_ACTIONS). The rest run only on a manual account. The
  // target carries the recipients (customerEmail, cc, bcc), the sender
  // (fromUser), the message (text, body), the thread type and whether a reply
  // is only a draft, so the approval card for a manual send_reply or
  // create_conversation shows who it reaches; `fields` shows which customer
  // properties an update overwrites.
  catalogId:'help-scout',pieceName:HELP_SCOUT_PIECE,unknownActionCategory:'modify_settings',
  targetProps:['conversationId','mailboxId','number','customerId','email','customerEmail','cc','bcc','fromUser','draft',
    'threadType','subject','text','body','fields','userId','status','assignTo','query'],
  categories:{read_data:['find_customer','find_conversation','find_user'],
    // A note reaches teammates only. Customer records, and the values of a
    // customer's properties (PATCH /customers/{id}/properties, as Intercom's
    // update_contact edits contact attributes), are records under the
    // caller's own access: none changes who can see or do what.
    write_data:['add_note','create_customer','update_customer_properties'],
    // Email to the customer, also when a reply is saved as a draft: the piece
    // sends whatever `draft` holds, so the worst case gates it.
    send_email:['create_conversation','send_reply'],modify_settings:['custom_api_call']},
}, {
  // Published GitLab 0.4.2 inventory. The managed grant enables only create_issue.
  // Quick actions can change access; only a resolved description without commands narrows to a write.
  catalogId:'gitlab',pieceName:GITLAB_PIECE,unknownActionCategory:'modify_settings',
  targetProps:['projectId','title','description'],
  categories:{read_data:[
      "get_branch", "get_commit", "get_commit_refs",
      "get_commit_sequence", "get_current_user", "get_file",
      "get_group", "get_group_member", "get_issue",
      "get_issue_note", "get_issue_time_stats", "get_job",
      "get_job_log", "get_label", "get_merge_request",
      "get_merge_request_approval_state", "get_merge_request_approvals", "get_milestone",
      "get_pipeline", "get_project", "get_project_languages",
      "get_project_member", "get_project_webhook", "get_user",
      "get_user_status", "list_branches", "list_commit_comments",
      "list_commits", "list_group_billable_members", "list_group_members",
      "list_group_pending_members", "list_group_projects", "list_groups",
      "list_issue_notes", "list_issues", "list_labels",
      "list_merge_request_commits", "list_merge_request_diff_versions", "list_merge_request_diffs",
      "list_merge_request_discussions", "list_merge_request_notes", "list_merge_requests",
      "list_milestones", "list_pipeline_jobs", "list_pipelines",
      "list_project_groups", "list_project_invited_groups", "list_project_members",
      "list_project_share_locations", "list_project_transfer_locations", "list_project_users",
      "list_project_webhooks", "list_projects", "list_repository_tree",
      "list_tags", "list_user_projects", "list_users",
    ],
    delete_data:[
      "delete_branch", "delete_file", "delete_group",
      "delete_issue_note", "delete_label", "delete_merge_request",
      "delete_milestone", "delete_pipeline", "delete_project",
      "delete_project_webhook", "erase_job",
    ],
    modify_settings:[
      "add_issue_spent_time", "approve_merge_request", "archive_project",
      "cancel_job", "cancel_pipeline", "create_branch",
      "create_commit", "create_commit_comment", "create_file",
      "create_group", "create_issue", "create_issue_note",
      "create_label", "create_merge_request", "create_merge_request_draft_note",
      "create_milestone", "create_pipeline", "create_project",
      "create_project_issue", "create_project_webhook", "custom_api_call",
      "fork_project", "import_project_members", "merge_merge_request",
      "move_issue", "play_manual_job", "protect_branch",
      "reset_issue_spent_time", "reset_issue_time_estimate", "retry_pipeline",
      "set_issue_time_estimate", "set_user_status", "share_project_with_group",
      "star_project", "unapprove_merge_request", "unarchive_project",
      "unprotect_branch", "unstar_project", "update_file",
      "update_group", "update_issue", "update_issue_note",
      "update_label", "update_merge_request", "update_milestone",
      "update_project_webhook",
    ]},
  categoryFromInput:{create_issue:{props:['description'],category:gitlabIssueCategory}},
  redactInput:redactGitLabInput,
}, {
  // Figma: every action of the pinned 0.6.3 bundle (`figma-engine.test.ts`
  // checks the list against the installed package). A comment is shown to
  // everyone with access to the file. The managed `jarvis:figma` connection runs
  // only MANAGED_FIGMA_ACTIONS; `custom_api_call` and an action added upstream
  // fall back to `modify_settings`.
  catalogId: 'figma', pieceName: FIGMA_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['file_key', 'message'],
  categories: { read_data: ['get_file', 'get_comments'], send_message: ['post_comment'] },
}, {
  // monday.com, a community piece whose managed `jarvis:monday` connection
  // made it governed. Every action of the pinned 0.4.0 bundle is named
  // (`managed-monday.test.ts` pins the list and the engine test checks it
  // against the installed package), so a workflow on the user's own API token
  // keeps its reads and writes at the default level. The managed connection
  // itself is limited to MANAGED_MONDAY_ACTIONS. The bundle has no
  // `custom_api_call`; an action added upstream falls back to `modify_settings`.
  catalogId: 'monday', pieceName: MONDAY_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['workspace_id', 'folder_id', 'board_id', 'source_board_id', 'group_id', 'item_id', 'item_ids',
    'parent_item_id', 'parent_id', 'update_id', 'column_id', 'column_ids', 'doc_id', 'block_id', 'tag_name',
    'user_id', 'user_ids', 'team_ids', 'board_owner_ids', 'board_subscriber_ids', 'kind', 'board_kind',
    'keep_subscribers', 'account_product_id', 'target_type', 'target_id', 'board_name', 'group_title', 'item_name',
    'name', 'title', 'column_values', 'value', 'body', 'text'],
  categories: {
    read_data: ['monday_get_board_values', 'monday_get_item_column_values', 'monday_get_board_activity_logs',
      'monday_list_board_views', 'monday_list_boards', 'monday_get_column_type_schema', 'monday_list_columns',
      'monday_export_doc_as_markdown', 'monday_get_doc_blocks', 'monday_list_docs', 'monday_get_assets',
      'monday_list_folders', 'monday_list_groups', 'monday_get_items', 'monday_list_board_items',
      'monday_list_subitems', 'monday_search_items_by_column_values', 'monday_aggregate_board_data',
      'monday_get_board_mute_settings', 'monday_get_favorites', 'monday_get_form', 'monday_list_notifications',
      'monday_list_tags', 'monday_search', 'monday_list_board_updates', 'monday_list_item_updates',
      'monday_get_account', 'monday_get_me', 'monday_list_teams', 'monday_list_users', 'monday_list_workspaces'],
    // Content that lands in front of other people, including an edit of it: an
    // update (or reply) notifies the item's subscribers and mentioned people,
    // as an Asana comment does; a bell notification goes to the chosen user.
    send_message: ['monday_create_update', 'monday_post_item_update', 'monday_edit_update',
      'monday_send_notification'],
    // Board, item and doc content under the caller's own access. Moving an item
    // to another group or board is a move, as a Trello card move is; none of
    // these changes who can see a board, workspace or folder.
    write_data: ['monday_create_item', 'monday_create_board_item', 'monday_create_subitem', 'monday_duplicate_item',
      'monday_update_item_name', 'monday_rename_item', 'monday_update_column_values_of_item',
      'monday_set_item_column_values', 'monday_change_column_value', 'monday_change_simple_column_value',
      'monday_change_item_position', 'monday_move_item_to_group', 'monday_move_item_to_board',
      'monday_upload_file_to_column', 'monday_upload_file', 'monday_update_assets_on_item', 'monday_create_column',
      'monday_add_board_column', 'monday_update_column', 'monday_create_group', 'monday_add_board_group',
      'monday_duplicate_group', 'monday_update_group', 'monday_update_board', 'monday_create_doc',
      'monday_import_doc_from_html', 'monday_duplicate_doc', 'monday_rename_doc', 'monday_append_markdown_to_doc',
      'monday_create_doc_block', 'monday_update_doc_block', 'monday_create_folder', 'monday_create_or_get_tag',
      'monday_like_update', 'monday_unlike_update', 'monday_pin_update', 'monday_unpin_update'],
    // Every delete and archive, and the removals of people from a board or
    // workspace (as Asana's member removals).
    delete_data: ['monday_delete_item', 'monday_archive_item', 'monday_clear_item_updates', 'monday_delete_update',
      'monday_delete_column', 'monday_delete_group', 'monday_archive_group', 'monday_delete_board',
      'monday_archive_board', 'monday_delete_doc', 'monday_delete_doc_block', 'monday_delete_folder',
      'monday_delete_workspace', 'monday_remove_board_subscribers', 'monday_remove_teams_from_board',
      'monday_delete_users_from_workspace', 'monday_delete_teams_from_workspace'],
    // Who can see or do what: adding people or teams to a board or workspace,
    // the user's own notification settings, and the creates, copies and moves
    // below at their worst case (narrowed by input in `categoryFromInput`).
    modify_settings: ['monday_add_users_to_board', 'monday_add_teams_to_board', 'monday_add_users_to_workspace',
      'monday_add_teams_to_workspace', 'monday_update_board_mute_settings', 'monday_create_board',
      'monday_duplicate_board', 'monday_create_workspace', 'monday_update_workspace',
      'monday_update_board_hierarchy', 'monday_update_folder'],
  },
  categoryFromInput: {
    monday_create_board: { props: ['board_kind', 'board_owner_ids', 'board_subscriber_ids'], category: mondayCreateBoardCategory },
    monday_duplicate_board: { props: ['keep_subscribers'], category: mondayDuplicateBoardCategory },
    monday_create_workspace: { props: ['kind'], category: mondayCreateWorkspaceCategory },
    monday_update_workspace: { props: ['kind', 'account_product_id'], category: mondayUpdateWorkspaceCategory },
    monday_update_board_hierarchy: { props: ['workspace_id', 'account_product_id'], category: mondayMoveAcrossWorkspacesCategory },
    monday_update_folder: { props: ['workspace_id'], category: mondayMoveAcrossWorkspacesCategory },
  },
}, {
  // Todoist: every action of the pinned 0.6.1 bundle (`managed-todoist.test.ts`
  // pins the list and the engine test checks it against the installed
  // package). The managed `jarvis:todoist` connection runs only four of
  // these (`managed-todoist.ts`). Only `custom_api_call` and an action added
  // upstream fall back to `modify_settings`; Todoist 0.6.1 has no action that
  // shares a project or invites a person.
  catalogId: 'todoist', pieceName: TODOIST_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['task_id', 'project_id', 'section_id', 'parent_id', 'label_id', 'comment_id', 'name', 'new_name',
    'content', 'text', 'description', 'labels', 'priority', 'due_date', 'query'],
  categories: {
    read_data: ['find_task', 'todoist_find_task', 'todoist_filter_tasks', 'todoist_get_task',
      'todoist_list_completed_tasks', 'todoist_list_completed_tasks_by_due_date', 'todoist_get_project',
      'todoist_list_projects', 'todoist_search_projects', 'todoist_list_archived_projects', 'todoist_get_section',
      'todoist_list_sections', 'todoist_search_sections', 'todoist_list_archived_sections', 'todoist_get_label',
      'todoist_list_labels', 'todoist_search_labels', 'todoist_list_shared_labels', 'todoist_get_comment',
      'todoist_list_comments', 'todoist_get_current_user', 'todoist_get_productivity_stats',
      'todoist_list_activity_log'],
    // A comment is shown to every collaborator of a shared project.
    send_message: ['todoist_create_task_comment', 'todoist_create_project_comment'],
    write_data: ['create_task', 'update_task', 'mark_task_completed', 'todoist_create_task', 'todoist_update_task',
      'todoist_complete_task', 'todoist_reopen_task', 'todoist_move_task', 'todoist_quick_add_task',
      'todoist_create_project', 'todoist_update_project', 'todoist_unarchive_project', 'todoist_create_section',
      'todoist_update_section', 'todoist_create_label', 'todoist_update_label', 'todoist_rename_shared_label'],
    // Every delete, and removing a shared label from every task that has it.
    delete_data: ['todoist_delete_task', 'todoist_delete_section', 'todoist_delete_label',
      'todoist_remove_shared_label'],
  },
}, {
  // Linear: every action of the pinned 0.9.1 bundle (`linear-connection.test.ts`
  // pins the list and the engine test checks it against the installed
  // package), so a workflow on the user's own Linear key keeps running at the
  // default level. The managed `jarvis:linear` connection is narrower still:
  // `managed-linear.ts` runs only five of these. Only `rawGraphqlQuery` (any
  // query or mutation) and an action added upstream fall back to
  // `modify_settings`.
  catalogId: 'linear', pieceName: LINEAR_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['team_id', 'team_ids', 'issue_id', 'related_issue_id', 'comment_id', 'resolving_comment_id', 'reaction_id',
    'attachment_id', 'project_id', 'project_milestone_id', 'status_update_id', 'label_id', 'label_ids', 'add_label_ids',
    'remove_label_ids', 'labels', 'title', 'name', 'key', 'description', 'body', 'url', 'state_id', 'status_id',
    'priority_id', 'priority', 'assignee_id', 'lead_id', 'cycle_id', 'parent_id', 'template_id', 'due_date',
    'estimate', 'user_id', 'term', 'include_comments', 'include_archived', 'limit', 'cursor'],
  categories: {
    read_data: ['linear_get_issue', 'linear_search_issues', 'linear_issue_get', 'linear_issues_list',
      'linear_issues_search', 'linear_issue_labels_list', 'linear_workflow_states_list', 'linear_teams_list',
      'linear_team_get', 'linear_users_list', 'linear_viewer_get', 'linear_cycles_list', 'linear_comment_get',
      'linear_comments_list', 'linear_attachment_get', 'linear_upload_download', 'linear_projects_list',
      'linear_project_get', 'linear_project_status_update_get', 'linear_project_status_updates_list'],
    // Content that lands in front of other people, including an edit of it: a
    // comment notifies the issue's subscribers, a project update the project's
    // members (as Asana's comments and status updates).
    send_message: ['linear_create_comment', 'linear_comment_create', 'linear_comment_update',
      'linear_create_project_status_update', 'linear_project_status_update_create', 'linear_project_status_update_edit'],
    // Workspace content under the caller's own access; none grants anyone
    // access.
    write_data: ['linear_create_issue', 'linear_update_issue', 'linear_create_project', 'linear_update_project',
      'linear_add_label_to_issue', 'linear_remove_label_from_issue', 'linear_attach_link', 'linear_issue_create',
      'linear_issue_update', 'linear_issue_unarchive', 'linear_issue_relation_create', 'linear_issue_add_label',
      'linear_issue_remove_label', 'linear_issue_label_create', 'linear_comment_resolve', 'linear_comment_unresolve',
      'linear_comment_reaction_create', 'linear_attachment_create', 'linear_project_create',
      'linear_project_unarchive', 'linear_project_milestone_create', 'linear_project_status_update_unarchive'],
    // Every delete, and every archive (hidden from where people find it).
    delete_data: ['linear_delete_issue', 'linear_issue_delete', 'linear_issue_archive', 'linear_reaction_delete',
      'linear_project_delete', 'linear_project_status_update_archive'],
    // Team creation and team settings (cycles, triage, key, timezone). The AI
    // project update sits here at its worst case (`team_ids` shows the
    // project to other teams) and narrows by input.
    modify_settings: ['linear_team_create', 'linear_team_update', 'linear_project_update'],
  },
  categoryFromInput: {
    linear_project_update: { props: ['team_ids'], category: linearProjectUpdateCategory },
  },
}, {
  // Calendly: every action of the pinned 0.7.1 bundle (`managed-calendly.test.ts`
  // pins the list and the engine test checks it against the installed
  // package), so a workflow on the user's own Calendly token keeps running at
  // the default level. The managed `jarvis:calendly` connection is narrower
  // still: `managed-calendly.ts` runs only MANAGED_CALENDLY_ACTIONS. Only
  // `custom_api_call` and an action added upstream fall back to `modify_settings`.
  catalogId: 'calendly', pieceName: CALENDLY_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['scheduledEvent', 'eventType', 'invitee', 'user', 'organization', 'membership', 'schedule', 'owner',
    'host', 'inviteeEmail', 'email', 'status', 'active', 'name', 'duration', 'startDate', 'endDate', 'startTime',
    'endTime', 'minStartTime', 'maxStartTime', 'timezone', 'role', 'reason', 'sort', 'count', 'pageToken'],
  categories: {
    read_data: ['find_invitee_bookings', 'find_user', 'get_event_invitee', 'get_event_type',
      'get_event_type_availability', 'get_organization', 'get_organization_membership', 'get_scheduled_event',
      'get_user', 'get_user_availability_schedule', 'list_available_times', 'list_event_invitees',
      'list_event_type_hosts', 'list_event_types', 'list_organization_memberships', 'list_scheduled_events',
      'list_user_availability_schedules', 'list_user_busy_times', 'list_user_locations'],
    // The user's own scheduling content: event types, their availability and
    // booking links into them. None grants anyone access to the account; a
    // link only lets its holder book a meeting the user already offers.
    write_data: ['create_event_type', 'create_one_off_event_type', 'create_scheduling_link', 'create_share',
      'update_event_type', 'update_event_type_availability'],
    // Cancelling takes a booked meeting away from both sides (Calendly also
    // emails the invitee), so it is gated as a deletion.
    delete_data: ['cancel_scheduled_event'],
  },
}, {
  // Intercom, a community piece whose managed `jarvis:intercom` connection made
  // it governed. Every action of the pinned 0.9.2 bundle is named
  // (`intercom-connection.test.ts` pins the list and the engine test checks it
  // against the installed package), so a workflow on the user's own Intercom
  // connection keeps running at the default level for reads, writes and
  // messages. The managed connection itself is limited to
  // MANAGED_INTERCOM_ACTIONS. Only `custom_api_call` and an action added
  // upstream fall back to `modify_settings`. The piece has no delete action.
  catalogId: 'intercom', pieceName: INTERCOM_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['target', 'recordId', 'contactId', 'conversationId', 'ticketId', 'companyId', 'leadId', 'userId',
    'lookupBy', 'value', 'searchField', 'searchValue', 'email', 'to', 'from', 'tagId', 'tagName', 'untag', 'remove',
    'assigneeId', 'adminId', 'ticketTypeId', 'state', 'isShared', 'messageType', 'message_type', 'subject', 'title',
    'name', 'eventName', 'body', 'closingMessage'],
  categories: {
    read_data: ['find-company', 'find-conversation', 'find-lead', 'find-user', 'get-conversation',
      'get_conversation_by_id', 'get_contact', 'get_ticket', 'get_company', 'list-all-tags', 'search_contacts',
      'list_contact_notes', 'search_conversations', 'search_tickets', 'list_ticket_types', 'list_admins',
      'list_teams', 'list_data_attributes', 'list_companies', 'search_articles', 'list_segments'],
    // Content that lands in front of other people: a reply or a message reaches
    // the customer, a note (contact, conversation or ticket) the team, a new
    // conversation the inbox. A state change can carry a closing message the
    // customer sees, an assignment an assignment note, an article create can
    // publish to the Help Center and a ticket update can share the ticket with
    // its customer, so these sit here whatever their input (send_message and
    // write_data need the same level; no input rule is needed to narrow them).
    send_message: ['add-note-to-user', 'addNoteToConversation', 'add_note_to_contact', 'add_note_to_conversation_by_id',
      'replyToConversation', 'reply_to_conversation_by_id', 'reply_to_ticket', 'create-conversation',
      'create_conversation_from_contact', 'assignConversationAction', 'set_conversation_state', 'create-article',
      'create_help_center_article', 'update_ticket_by_id'],
    // An admin message to a contact, email by default. An in-app message is
    // gated as email too: a rule could only narrow from the piece's worst
    // case (modify_settings), which would over-gate the email default instead.
    send_email: ['send_message', 'send_message_to_contact'],
    // Workspace records under the caller's own access: contacts, companies,
    // tickets, tags and events. None changes who can see or do what. A data
    // event can start a series the owner built, as Mailchimp's custom event does.
    write_data: ['add-or-remove-tag-on-contact', 'add-or-remove-tag-on-company', 'add-or-remove-tag-on-conversation',
      'tag_or_untag_record', 'create_tag', 'create-data-event', 'create-ticket', 'create_ticket_by_type_id',
      'update-ticket', 'convert_conversation_to_ticket', 'create-user', 'create-or-update-company',
      'create-or-update-lead', 'create-or-update-user', 'find-or-create-company', 'find-or-create-lead',
      'update_contact', 'attach_contact_to_company', 'assign_conversation_by_id'],
  },
}, {
  // Webflow, a community piece whose managed `jarvis:webflow` connection made
  // it governed. Every action of the pinned 0.3.0 bundle is named (the engine
  // test checks the list against the installed package), so a workflow on the
  // user's own Webflow connection keeps its reads and draft writes at the
  // default level. The managed connection itself is limited to
  // MANAGED_WEBFLOW_ACTIONS, which only read items and create or update drafts.
  catalogId: 'webflow', pieceName: WEBFLOW_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['site_id', 'collection_id', 'collection_item_id', 'order_id', 'send_order_fulfilled_email'],
  categories: {
    read_data: ['get_collection_item', 'find_collection_item', 'find_order', 'list_sites', 'list_collections'],
    // Publishing puts the item on the live site, in front of its visitors.
    send_message: ['publish_collection_item'],
    // CMS items (managed writes stay drafts) and an order's fulfilment state.
    write_data: ['create_collection_item', 'update_collection_item', 'unfulfill_order'],
    delete_data: ['delete_collection_item'],
    // Moves money back to the customer.
    make_payment: ['refund_order'],
    // Any request with the user's token, and fulfilling an order at its worst
    // case (as every input rule starts): narrowed by input below to an email
    // to the customer or a plain state change.
    modify_settings: ['custom_api_call', 'fulfill_order'],
  },
  categoryFromInput: {
    fulfill_order: { props: ['send_order_fulfilled_email'], category: webflowFulfillOrderCategory },
  },
}, {
  // Asana: every action of the pinned 0.7.2 bundle (`asana-connection.test.ts`
  // pins the list and the engine test checks it against the installed
  // package), so a workflow on the user's own Asana connection keeps running
  // at the default level. The managed `jarvis:asana` connection is narrower
  // still: `managed-asana.ts` runs only five of these. Only `custom_api_call`
  // and an action added upstream fall back to `modify_settings`.
  catalogId: 'asana', pieceName: '@activepieces/piece-asana', unknownActionCategory: 'modify_settings',
  targetProps: ['workspace', 'organization', 'team', 'project', 'section', 'task', 'parent', 'story', 'tag', 'user',
    'member', 'members', 'followers', 'membership', 'status_update', 'project_brief', 'attachment', 'custom_field',
    'enum_option', 'portfolio', 'item', 'goal', 'allocation', 'access_request', 'target', 'project_template',
    'name', 'title', 'notes', 'html_notes', 'assignee', 'due_on', 'due_at', 'start_on', 'completed', 'archived',
    'privacy_setting', 'owner', 'visibility', 'access_level', 'text', 'html_text', 'is_pinned', 'completed_since',
    'include', 'requested_roles', 'limit', 'offset'],
  categories: {
    read_data: ['get_allocation', 'get_attachment', 'get_current_user', 'get_custom_field', 'get_goal', 'get_job',
      'get_membership', 'get_portfolio', 'get_project', 'get_project_brief', 'get_project_task_counts', 'get_section',
      'get_status_update', 'get_story', 'get_tag', 'get_task', 'get_team', 'get_team_membership', 'get_time_period',
      'get_user', 'get_workspace', 'get_workspace_membership', 'list_access_requests', 'list_allocations',
      'list_assigned_tasks', 'list_attachments', 'list_custom_fields', 'list_custom_types', 'list_favorites',
      'list_goal_relationships', 'list_goals', 'list_memberships', 'list_portfolio_items', 'list_portfolios',
      'list_projects', 'list_project_tasks', 'list_project_templates', 'list_reactions', 'list_sections',
      'list_section_tasks', 'list_status_updates', 'list_subtasks', 'list_tags', 'list_tag_tasks',
      'list_task_dependencies', 'list_task_projects', 'list_task_stories', 'list_task_tags', 'list_task_templates',
      'list_team_memberships', 'list_teams', 'list_time_periods', 'list_time_tracking_entries', 'list_users',
      'list_user_teams', 'list_workspace_memberships', 'list_workspaces', 'search_tasks', 'search_workspace_objects'],
    // Content that lands in front of other people, including an edit of it: a
    // comment notifies the task's followers, a status update the project's
    // members, an access request the owner.
    send_message: ['add_task_comment', 'update_comment', 'create_status_update', 'create_access_request'],
    // Workspace content under the caller's own access; none of these grants a
    // person access to a project, team or workspace. Task followers
    // (`add_task_followers`, and `followers` on `create_project_task` and
    // `create_subtask`) only get the task's notifications: a follower who
    // cannot see the project gains that one task, not the project, so these
    // stay writes. Project followers are different (below).
    write_data: ['add_goal_supporting_relationship', 'add_portfolio_item', 'add_tag_to_task',
      'add_task_dependencies', 'add_task_followers', 'add_task_to_project', 'create_allocation', 'create_custom_field',
      'create_custom_field_enum_option', 'create_project_brief', 'create_project_task',
      'create_section', 'create_subtask', 'create_tag', 'create_task',
      'duplicate_task', 'move_section', 'move_task_to_section', 'reject_access_request',
      'remove_portfolio_item', 'remove_project_followers', 'remove_tag_from_task', 'remove_task_dependencies',
      'remove_task_followers', 'remove_task_from_project', 'reorder_custom_field_enum_option', 'set_task_parent',
      'update_allocation', 'update_custom_field', 'update_custom_field_enum_option', 'update_project_brief',
      'update_section', 'update_tag', 'update_task', 'update_user', 'upload_attachment'],
    // Every delete, and the removals upstream labels DESTRUCTIVE.
    // `update_project` sits here at its worst case, an archive, and narrows by input.
    delete_data: ['delete_allocation', 'delete_attachment', 'delete_comment', 'delete_custom_field',
      'delete_membership', 'delete_project', 'delete_project_brief', 'delete_section', 'delete_status_update',
      'delete_tag', 'delete_task', 'remove_project_members', 'remove_user_from_team', 'remove_user_from_workspace',
      'update_project'],
    // Who can see or do what: granting a person access to a project, team or
    // workspace. `add_project_followers` makes a follower who is not yet a
    // member a member (upstream's own description). The project and team
    // creates, `duplicate_project` and `update_team` sit here at their worst
    // case (team, privacy, visibility, copied members or permissions) and
    // narrow by input.
    modify_settings: ['add_project_followers', 'add_project_members', 'add_user_to_team', 'add_user_to_workspace',
      'approve_access_request', 'create_membership', 'create_project', 'create_team', 'duplicate_project',
      'instantiate_project_template', 'update_team'],
  },
  categoryFromInput: {
    create_project: { props: ['team', 'privacy_setting'], category: asanaCreateProjectCategory },
    instantiate_project_template: { props: ['privacy_setting', 'requested_roles'], category: asanaInstantiateProjectTemplateCategory },
    create_team: { props: ['visibility'], category: asanaCreateTeamCategory },
    duplicate_project: { props: ['include'], category: asanaDuplicateProjectCategory },
    update_project: { props: ['privacy_setting', 'owner', 'archived'], category: asanaUpdateProjectCategory },
    update_team: { props: ['visibility', 'endorsed'], category: asanaUpdateTeamCategory },
  },
}, {
  // Dropbox, a community piece whose managed `jarvis:dropbox` connection made
  // it governed. Every action of the pinned 0.9.2 bundle is named
  // (`dropbox-connection.test.ts` pins the list and the engine test checks it
  // against the installed package), so a workflow on the user's own Dropbox
  // connection keeps running at the default level for reads and writes. The
  // managed connection itself is limited to MANAGED_DROPBOX_ACTIONS.
  catalogId: 'dropbox', pieceName: DROPBOX_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['path', 'from_path', 'to_path', 'paths', 'entries', 'query', 'url', 'copy_reference', 'rev',
    'async_job_id', 'recursive', 'limit', 'max_results', 'autorename', 'allow_ownership_transfer', 'mode', 'duration'],
  categories: {
    read_data: ['search_dropbox', 'downloadFile', 'list_dropbox_folder', 'get_dropbox_file_metadata',
      'list_dropbox_file_revisions', 'get_dropbox_file_lock', 'download_dropbox_folder_as_zip',
      'get_dropbox_file_preview', 'get_dropbox_file_thumbnail', 'get_dropbox_thumbnails_batch',
      'get_dropbox_save_url_status', 'get_dropbox_copy_batch_status', 'get_dropbox_move_batch_status',
      'get_dropbox_delete_batch_status', 'get_dropbox_create_folder_batch_status'],
    // Each hands out access to whoever holds the result: a temporary download
    // link, an upload link into the account, or a reference another account
    // can copy the file with. Exposure, so gated like a send.
    send_message: ['get_dropbox_file_link', 'create_dropbox_upload_link', 'create_dropbox_copy_reference'],
    // Adds content or changes it with the earlier state kept (upload is add
    // mode, restore writes a new revision). Nothing here removes an entry.
    write_data: ['create_new_dropbox_text_file', 'upload_dropbox_file', 'create_new_dropbox_folder',
      'copy_dropbox_file', 'copy_dropbox_folder', 'copy_dropbox_entry', 'start_dropbox_copy_batch',
      'start_dropbox_create_folder_batch', 'save_url_to_dropbox', 'save_dropbox_copy_reference',
      'lock_dropbox_file', 'unlock_dropbox_file', 'restore_dropbox_file'],
    // Every delete, and every move: a move takes the entry away from where
    // other people and workflows find it, and may transfer its ownership.
    delete_data: ['delete_dropbox_file', 'delete_dropbox_folder', 'delete_dropbox_entry', 'start_dropbox_delete_batch',
      'move_dropbox_file', 'move_dropbox_folder', 'move_dropbox_entry', 'start_dropbox_move_batch'],
  },
}, {
  // Typeform, a community piece made governed by the managed `jarvis:typeform`
  // connection. Every action of the pinned 0.7.1 bundle is named
  // (`typeform-connection.test.ts` pins the list and the engine test checks it
  // against the installed package), so a workflow on the user's own Typeform
  // connection keeps its reads and writes at the default level. The managed
  // connection itself runs only MANAGED_TYPEFORM_ACTIONS (four reads).
  catalogId: 'typeform', pieceName: TYPEFORM_PIECE, unknownActionCategory: 'modify_settings',
  targetProps: ['form_id', 'workspace', 'accountId', 'themeId', 'imageId', 'field', 'responseIds', 'title', 'name',
    'isPublic', 'search', 'query', 'page', 'pageSize', 'sortBy', 'orderBy', 'since', 'until', 'responseType',
    'includedResponseIds', 'sort', 'before', 'after'],
  categories: {
    read_data: ['get_me', 'list_forms', 'get_form', 'get_form_messages', 'list_responses', 'list_workspaces',
      'get_workspace', 'list_themes', 'get_theme', 'list_images', 'get_image'],
    // Account content under the caller's own access: new forms, workspaces,
    // themes and images, copies, renames and text or option edits.
    write_data: ['create_form', 'duplicate_form', 'update_choice_options', 'update_form_messages', 'create_workspace',
      'update_workspace', 'create_theme', 'update_theme', 'upload_image'],
    // Every delete, and replace_form: a field left out of the definition is
    // deleted together with its answers (upstream labels it DESTRUCTIVE).
    // update_form can move the form to another workspace, so blind it is the
    // move; its input narrows it (`categoryFromInput`).
    delete_data: ['delete_form', 'delete_responses', 'delete_workspace', 'delete_theme', 'delete_image',
      'replace_form', 'update_form'],
  },
  categoryFromInput: {
    update_form: { props: ['workspace', 'isPublic'], category: typeformUpdateFormCategory },
  },
}, {
  catalogId: 'clickup', pieceName: '@activepieces/piece-clickup', unknownActionCategory: 'modify_settings',
  targetProps: ['workspace_id', 'space_id', 'folder_id', 'list_id', 'task_id', 'task_name', 'name', 'status_id',
    'add_assignee', 'rem_assignee', 'destination_list_id', 'channel_id', 'message_id', 'comment_id',
    'checklist_id', 'checklist_item_id', 'timer_id', 'template_id', 'field_id'],
  categories: {
    read_data: ['get_list', 'get_list_task', 'get_task_by_name', 'get_space', 'get_spaces', 'get_task_comments',
      'get_channel', 'get_channels', 'get_channel_messages', 'get_message_reactions', 'get_message_replies',
      'list_workspace_tasks', 'list_workspace_time_entries', 'get_accessible_custom_fields',
      'clickup_get_task_comments', 'clickup_get_accessible_custom_fields', 'clickup_get_folders',
      'clickup_get_folder', 'clickup_get_folderless_lists', 'clickup_get_folder_lists', 'clickup_get_list_members',
      'clickup_get_list', 'clickup_list_workspace_members', 'clickup_get_spaces', 'clickup_get_space',
      'clickup_get_space_tags', 'clickup_get_bulk_tasks_time_in_status', 'clickup_get_task_members',
      'clickup_get_task', 'clickup_list_list_tasks', 'clickup_list_tasks', 'clickup_get_running_time_entry',
      'clickup_get_time_entry', 'clickup_list_time_entries'],
    // Content that lands in front of other people, including an edit of it.
    send_message: ['create_task_comments', 'clickup_create_task_comment', 'clickup_update_comment',
      'create_message', 'create_message_reply', 'update_message'],
    // Workspace content under the caller's own access. None of these changes
    // who can see what (no member, guest or permission action exists here).
    write_data: ['create_task', 'create_task_from_template', 'create_folderless_list', 'create_subtask',
      'create_channel', 'create_channel_in_space_folder_list', 'create_message_reaction', 'update_task',
      'set_custom_fields_value', 'clickup_create_checklist_item', 'clickup_create_checklist',
      'clickup_update_checklist_item', 'clickup_update_checklist', 'clickup_create_folder', 'clickup_update_folder',
      'clickup_create_folderless_list', 'clickup_create_list', 'clickup_update_list', 'clickup_create_space',
      'clickup_update_space', 'clickup_create_space_tag', 'clickup_update_space_tag', 'clickup_add_tag_to_task',
      'clickup_add_task_dependency', 'clickup_create_task', 'clickup_link_tasks', 'clickup_move_task_to_list',
      'clickup_remove_tag_from_task', 'clickup_remove_task_from_list', 'clickup_set_task_status',
      'clickup_unlink_tasks', 'clickup_update_task', 'clickup_create_time_entry', 'clickup_start_time_entry',
      'clickup_stop_time_entry', 'clickup_update_time_entry'],
    // Every delete, including the two upstream labels WRITE (a reaction, a dependency).
    delete_data: ['delete_message', 'delete_message_reaction', 'delete_task', 'clickup_delete_checklist_item',
      'clickup_delete_checklist', 'clickup_delete_comment', 'clickup_delete_folder', 'clickup_delete_list',
      'clickup_delete_space', 'clickup_delete_space_tag', 'clickup_delete_task_dependency', 'clickup_delete_task',
      'clickup_delete_time_entry'],
  },
}, {
  // All actions in Airtable 0.9.2. The managed connection permits only four record actions.
  catalogId:'airtable', pieceName:'@activepieces/piece-airtable', unknownActionCategory:'modify_settings',
  targetProps:['base','tableId','recordId','searchField','searchValue','limitToView','fields','base_id','table_id_or_name','record_id'],
  categories:{
    read_data:['airtable_find_record','airtable_get_record_by_id','airtable_find_base','airtable_find_table_by_id','airtable_find_table','airtable_get_base_schema','get_record','list_records','list_bases','get_base_schema_ai','get_current_user','search_records','list_record_comments'],
    write_data:['airtable_create_record','airtable_update_record','airtable_upload_file_to_column','create_record_ai','update_record_ai','upload_attachment_ai','upsert_records'],
    delete_data:['airtable_clean_record','airtable_delete_record','delete_record_ai','delete_records_batch'],
    send_message:['airtable_add_comment_to_record','add_comment_to_record_ai'],
    modify_settings:['airtable_create_base','airtable_create_table','create_table_ai','create_base_ai','update_table','create_field','update_field'],
  },
}, {
  // Trello: every action of the installed 0.8.1 bundle (0.7.1 has the same
  // set; `trello-connection.test.ts` pins the list and the engine test checks
  // it against the installed package), so a workflow on the user's own Trello
  // connection keeps running at the default level. The managed `jarvis:trello`
  // connection is narrower still: `managed-trello.ts` runs only five of these.
  // Only `custom_api_call` and an action added upstream fall back to `modify_settings`.
  catalogId: 'trello', pieceName: '@activepieces/piece-trello', unknownActionCategory: 'modify_settings',
  targetProps: ['board_id','list_id','destination_list_id','card_id','cardId','source_card_id','checklist_id',
    'checkitem_id','comment_id','action_id','attachment_id','label_id','member_id','custom_field_id','org_id','name',
    'description','position','closed','url'],
  categories: {
    read_data: ['get_board','get_card','get_card_ai','get_card_attachment','get_card_attachments','get_custom_field',
      'get_list','get_member','get_my_member','list_board_custom_fields','list_board_labels','list_board_memberships',
      'list_board_members','list_boards','list_card_activity','list_card_attachments_ai','list_card_checklists',
      'list_card_comments','list_card_custom_field_values','list_card_members','list_cards_in_board',
      'list_cards_in_list','list_card_votes','list_custom_field_options','list_lists','list_organization_boards',
      'search_cards','search_members'],
    // A comment notifies the card's members, like a ClickUp task comment.
    send_message: ['add_comment_to_card','update_comment'],
    // Board content under the caller's own access. Card members are assignees
    // drawn from the board; none of these changes who can see the board.
    write_data: ['add_card_attachment','add_card_attachment_from_url','add_checklist_item','add_checklist_to_card',
      'add_label_to_card','add_member_to_card','add_reaction_to_comment','copy_card','create_board',
      'create_board_custom_field','create_board_label','create_card','create_card_ai','create_custom_field_option',
      'create_list','move_all_cards_in_list','move_card','move_list_to_board','remove_label_from_card',
      'remove_member_from_card','rename_list','set_card_custom_field_value','set_checklist_item_state','update_board',
      'update_checklist','update_checklist_item','update_label','vote_on_card'],
    // Every delete, and the archives upstream labels DESTRUCTIVE (a bulk list archive among them).
    delete_data: ['archive_all_cards_in_list','archive_board','archive_card','archive_list','delete_board',
      'delete_card','delete_card_ai','delete_card_attachment','delete_checklist','delete_checklist_item',
      'delete_comment','delete_custom_field','delete_label','remove_card_vote',
      // An update's `closed` checkbox archives the card, as archive_card does,
      // so blind it is the archive; its input narrows it (`categoryFromInput`).
      'update_card','update_card_ai'],
  },
  categoryFromInput: {
    update_card: { props: ['closed'], category: trelloUpdateCardCategory },
    update_card_ai: { props: ['closed'], category: trelloUpdateCardCategory },
  },
}, {
  // Mailchimp, a community piece made governed by the managed `jarvis:mailchimp`
  // connection. Every action of the pinned 0.5.10 bundle is named (it has no
  // `custom_api_call`; `managed-mailchimp.test.ts` pins the list and the engine
  // test checks it against the installed package), so a workflow on the
  // user's own connection keeps its reads and writes at the default level.
  // The managed connection itself is further limited to MANAGED_MAILCHIMP_ACTIONS.
  catalogId: 'mailchimp', pieceName: '@activepieces/piece-mailchimp', unknownActionCategory: 'modify_settings',
  targetProps: ['list_id', 'email', 'email_address', 'subscriber_hash', 'tag_name', 'campaign_id', 'store_id', 'name', 'query'],
  categories: {
    read_data: ['find_subscriber', 'find_campaign', 'get_campaign_report', 'find_customer', 'find_tag'],
    // Sending a campaign delivers email to a whole audience.
    send_email: ['send_campaign'],
    // Audience, subscriber, tag and draft campaign changes under the account.
    // add_member_to_list with status `pending` makes Mailchimp send the address
    // an opt-in email, and create_custom_event can start a customer journey that
    // emails the contact. Both stay writes: the mail is Mailchimp's own
    // confirmation or a journey the account owner built, and the step names no
    // recipient or content, as a send does (upstream classifies both WRITE).
    write_data: ['add_subscriber_to_tag', 'remove_subscriber_from_tag', 'add_member_to_list', 'add_note_to_subscriber',
      'create_campaign', 'create_audience', 'create_tag', 'create_custom_event'],
    // archive_subscriber is DELETE /lists/{id}/members/{hash}; upstream labels
    // it and unsubscribe_email DESTRUCTIVE. A status update can unsubscribe or
    // clean a member, so blind it is that; its input narrows it (`categoryFromInput`).
    delete_data: ['archive_subscriber', 'unsubscribe_email', 'update_member_in_list'],
  },
  categoryFromInput: {
    update_member_in_list: { props: ['status'], category: mailchimpMemberStatusCategory },
  },
}];

/**
 * A Trello card update archives the card when its `closed` checkbox is on.
 * Left out or off (off restores an archived card) it is an ordinary write;
 * any other value, including a null (upstream forwards it to Trello) or one
 * the projection could not read as a plain false, is gated as the archive.
 */
function trelloUpdateCardCategory(input: Record<string, unknown>): ActionCategory {
  const closed = input.closed;
  return closed === undefined || closed === false ? 'write_data' : 'delete_data';
}

/**
 * A Typeform form update. A `workspace` moves the form to another workspace
 * (out of where its current members find it), and `isPublic` opens or closes
 * it to responses (a form setting). Upstream skips a prop that is null,
 * missing or blank (`isProvided`); only then is it an ordinary write. Any
 * other value, including a non-string, takes the stricter case.
 */
function typeformUpdateFormCategory(input: Record<string, unknown>): ActionCategory {
  const unset = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  if (!unset(input.workspace)) return 'delete_data';
  return unset(input.isPublic) ? 'write_data' : 'modify_settings';
}

/**
 * A Mailchimp member update by its new status. Subscribed, pending and
 * transactional keep the member reachable, an ordinary write; unsubscribed and
 * cleaned remove them from the audience's mail, as unsubscribe_email does. Any
 * other value, an unresolved expression among them, is gated as the removal.
 */
function mailchimpMemberStatusCategory(input: Record<string, unknown>): ActionCategory {
  return input.status === 'subscribed' || input.status === 'pending' || input.status === 'transactional' ? 'write_data' : 'delete_data';
}

/** Every adapter: the verified catalog pieces, the vendored core pieces, then the managed ones. */
export const ALL_PIECE_ADAPTERS: readonly GovernedPieceAdapter[] = [...GOVERNED_PIECE_ADAPTERS, ...CORE_PIECE_ADAPTERS, ...MANAGED_PIECE_ADAPTERS];
// Narrow audited action coverage; this does not promote the entire Sheets
// package to the Library's VERIFIED set or claim coverage of its other actions.
const HUBSPOT_CONTACT_ADAPTER: GovernedPieceAdapter = {
  catalogId: 'hubspot', pieceName: HUBSPOT_PIECE, unknownActionCategory: 'delete_data',
  targetProps: ['email','objectProperties'], categories: { write_data: [HUBSPOT_UPSERT] },
};
const SHEETS_APPEND_ADAPTER: GovernedPieceAdapter = {
  catalogId: 'google-sheets', pieceName: '@activepieces/piece-google-sheets',
  unknownActionCategory: 'delete_data',
  targetProps: ['spreadsheet_id', 'spreadsheetId', 'worksheet_title', 'sheetId', 'sheet_id', 'range', 'values', 'value_input_option', 'as_string'],
  categories: { write_data: ['insert_row', 'sheets_append_values', 'sheets_add_row'] },
};

/**
 * Adapters that govern only some of a piece's actions, outside the verified
 * set. Their other actions resolve to null and stay community steps. Exported
 * for the job contract, which must judge a governed action the way the
 * runtime does.
 */
export const PARTIAL_PIECE_ADAPTERS: readonly GovernedPieceAdapter[] = [SHEETS_APPEND_ADAPTER, HUBSPOT_CONTACT_ADAPTER];

const BY_PIECE_NAME = new Map<string, GovernedPieceAdapter>();
const ACTION_CATEGORY = new Map<string, Map<string, ActionCategory>>();
for (const adapter of ALL_PIECE_ADAPTERS) {
  if (BY_PIECE_NAME.has(adapter.pieceName)) {
    throw new Error(`Duplicate governed piece adapter: ${adapter.pieceName}`);
  }
  const actions = new Map<string, ActionCategory>();
  for (const [category, names] of Object.entries(adapter.categories)) {
    for (const name of names ?? []) {
      // A name in two categories means the lower one could win by declaration
      // order, which is exactly how a send ends up gated as a read.
      if (actions.has(name)) {
        throw new Error(`Governed piece ${adapter.catalogId} maps ${name} to two categories`);
      }
      actions.set(name, category as ActionCategory);
    }
  }
  BY_PIECE_NAME.set(adapter.pieceName, adapter);
  ACTION_CATEGORY.set(adapter.pieceName, actions);
}

/** True for a piece with a governed adapter. The engine-side guard asks this
 * first, so an ungoverned piece costs no round trip at all. */
export function isGovernedPiece(pieceName: unknown): boolean {
  return typeof pieceName === 'string' && (BY_PIECE_NAME.has(pieceName) || pieceName === SHEETS_APPEND_ADAPTER.pieceName || pieceName === HUBSPOT_PIECE);
}

/**
 * The adapter decision for one step, or null when the piece is ungoverned.
 * `input` is the step's projected input; an action whose category depends on
 * it (`categoryFromInput`) is resolved from it, and without it gets the
 * table's worst case.
 */
export function resolveGovernedPieceAction(pieceName: unknown, actionName: unknown, input?: unknown): ResolvedPieceAction | null {
  if (typeof pieceName !== 'string' || typeof actionName !== 'string') return null;
  if (isHubspotContact(pieceName, actionName)) return { adapter: HUBSPOT_CONTACT_ADAPTER, action: actionName, category: 'write_data', known: true, byInput: false };
  if (pieceName === SHEETS_APPEND_ADAPTER.pieceName) {
    return tracksPieceCompletion(pieceName, actionName)
      ? { adapter: SHEETS_APPEND_ADAPTER, action: actionName, category: 'write_data', known: true, byInput: false } : null;
  }
  const adapter = BY_PIECE_NAME.get(pieceName);
  if (!adapter) return null;
  const mapped = ACTION_CATEGORY.get(pieceName)!.get(actionName);
  const rule = mapped !== undefined && Object.hasOwn(adapter.categoryFromInput ?? {}, actionName) ? adapter.categoryFromInput![actionName] : undefined;
  // A cut projection takes the worst case (`ruleInput`), as no input does.
  const fields = ruleInput(input);
  const category = rule && fields ? rule.category(fields) : mapped ?? adapter.unknownActionCategory;
  return { adapter, action: actionName, category, known: mapped !== undefined, byInput: rule !== undefined,
    ...(rule ? { categoryProps: rule.props } : {}) };
}

/** The adapter for a piece, verified or core, or null. */
export function governedPieceAdapter(pieceName: unknown): GovernedPieceAdapter | null {
  return typeof pieceName === 'string' ? BY_PIECE_NAME.get(pieceName) ?? null : null;
}

/** Stable identity for the audit row and the approval card. Cannot collide
 * with a `ToolRegistry` tool name, which is always a bare identifier. */
export function governedPieceToolName(catalogId: string, action: string): string {
  return `piece:${catalogId}/${action}`;
}

/**
 * Longest action name the daemon will put in a `tool_name` (#651).
 *
 * Measured, not picked: the longest of the 329 names in
 * `GOVERNED_PIECE_ADAPTERS` is `google_calendar_list_recurring_event_instances`
 * at 46 characters, and the longest of the 127 distinct action names found in
 * the 1324 cached `@activepieces/piece-*` package versions (660 packages) of a
 * local bun install cache -- the first `name:` literal after each
 * `createAction(` -- is 41. 128 is a little under three times the longest, so
 * an upstream action added after the tables were written still fits, while a
 * name of any length can no longer ride into four durable rows and a chat
 * message.
 */
export const PIECE_ACTION_NAME_MAX_CHARS = 128;

/**
 * Every one of those names uses only `[A-Za-z0-9_-]`, so that is the
 * alphabet, and it is what makes a name inert on the card: no line break to
 * forge a field with, no `<` to open a frame with.
 */
const PIECE_ACTION_NAME = /^[A-Za-z0-9_-]+$/u;

/**
 * True for an action name that can label an approval card as it stands.
 *
 * VALIDATE, NOT TRANSFORM, on purpose. `tool_name` is fenced: a resume compares
 * the recorded `toolName` with the one rebuilt from the request, so rewriting
 * a name would invalidate its in-flight approval. Every name an honest run can
 * reach already passes -- readiness requires an action the catalog names and
 * the engine looks the action up on the piece before it asks -- so refusing
 * the rest changes no recorded `toolName` and invalidates nothing.
 */
export function isWellFormedPieceActionName(action: string): boolean {
  return action.length <= PIECE_ACTION_NAME_MAX_CHARS && PIECE_ACTION_NAME.test(action);
}

const MAX_STRING = 512;
const MAX_ARRAY = 25;
const MAX_KEYS = 40;
const MAX_DEPTH = 5;

/**
 * Bound one value for review. Deterministic: the same input always produces
 * the same projection, so the digest the approval was granted against still
 * matches when the step re-authorizes on resume.
 *
 * The string cut below can land INSIDE a framed `UNTRUSTED_CONTENT` block --
 * `manage_workflow` frames its own return and a `{{ }}` expression can wire
 * that into a governed piece's input -- which would keep the open delimiter and
 * drop the close. That is neutralised by `defangPieceProjection` in
 * `piece-effect-receipt.ts`, applied on the DAEMON side only (#634). It is not
 * done here on purpose: this file is compiled into the engine bundle and must
 * keep type-only imports, and no piece PROJECTION is durable before the
 * daemon's pass, so the daemon is the sufficient place. Doing it in both would
 * also be safe, but only at the cost of registering `roles/untrusted.ts` in
 * `PATCHED_VENDOR_SOURCES`, which would make every edit to that file -- a
 * comment included -- invalidate every cached engine bundle. That file carries
 * the full argument.
 *
 * `slack` is for a value that is ALREADY a projection (#651). The engine
 * projects the resolved input and the daemon projects what the engine sent, and
 * a projection is one slot over each cap -- a string is 512 characters plus its
 * `... [N more characters]` note, an array 25 items plus its `[N more items]`
 * marker, an object 40 keys plus `omittedFields`. Without slack the daemon's
 * pass cut that slot as overflow and re-counted, so every note on the card
 * described the note before it: `[26 more characters]` for a 10,000-character
 * string, `[1 more items]` for 100 items, `omittedFields: 1` for 50 keys (and a
 * real field lost to make room). With slack a value inside that envelope is
 * kept as it stands, so the second pass is the identity on the first pass's
 * output, and a value outside it -- an engine that did not cut -- is cut
 * exactly as the first pass would cut it, with an accurate count of what this
 * pass received. It is a wider envelope, never no envelope.
 *
 * WHAT #694 MOVED. Keys are defined rather than assigned, so an own
 * `__proto__` key is projected like any other instead of being swallowed by
 * the prototype setter. That changes the projection, and so `requestDigest`,
 * for exactly one class of input: one holding an own `__proto__` key (any
 * value -- an object, a string, null) in an object `bound()` walks into, i.e.
 * nested less than five levels deep and among the first 40 keys of its object
 * in code-unit order. Any governed-piece effect of such an input RECORDED
 * before the upgrade was recorded against a projection without the field: an
 * approval still pending, one approved whose run has not resumed yet, or a
 * step an engine retry re-authorizes (even one that already succeeded -- the
 * fence runs before the succeeded early return). When it re-authorizes, the
 * rebuilt engine (this file is in `PATCHED_VENDOR_SOURCES`, so the edit
 * invalidates every cached engine bundle) sends the field, `effect-boundary.ts`
 * recomputes the digest, it does not match, and the step fails with "Workflow
 * effect changed since it was recorded; start a new run for new arguments or
 * version". For a pending approval that failure comes AFTER the person clicks
 * approve. A new run records the field in `workflow_effect.arguments`, in
 * `approval_requests.tool_arguments` and in the digest. Every other input
 * projects byte-exact as before, so its digest and its approvals are untouched.
 *
 * WHAT #722 MOVED, in the same shape. A field spelled like the count marker
 * (`omittedFields`, or that with any number of leading `~`) gains one more
 * leading `~` (`escapeMarkerSpelling`). That changes the projection, and so
 * `requestDigest`, for exactly one class of input: one holding an own key of
 * that spelling in an object `bound()` walks into -- nested less than five
 * levels deep and among the first 40 keys of its object in code-unit order --
 * whatever the object's size. Any governed-piece effect of such an input
 * RECORDED before the upgrade was recorded against a projection carrying the
 * bare key (holding the field's value, or, when the object was also cut, the
 * count that had overwritten it): an approval still pending, one approved whose
 * run has not resumed yet, or a step an engine retry re-authorizes (even one
 * that already succeeded -- the fence runs before the succeeded early return).
 * When it re-authorizes, the rebuilt engine (this file is in
 * `PATCHED_VENDOR_SOURCES`, so the edit invalidates every cached engine bundle)
 * sends the escaped key, `effect-boundary.ts` recomputes the digest, it does
 * not match, and the step fails with "Workflow effect changed since it was
 * recorded; start a new run for new arguments or version". For a pending
 * approval that failure comes AFTER the person clicks approve; the new run's
 * card shows the field as `~omittedFields` with its real value. The daemon's
 * pass (`slack`) leaves a projection's keys as they stand, so an honest
 * engine's output is not escaped twice; an object outside the envelope has
 * its OWN keys escaped and cut as the first pass would, while a value inside
 * it that fits the envelope is kept as sent. So the bare key means the count
 * exactly when the engine ran `sanitizePieceInput`; an engine that skipped it
 * could forge a count anyway. Every other input projects
 * byte-exact as before, so its digest and its approvals are untouched.
 */
function bound(value: unknown, depth: number, slack = false): unknown {
  if (typeof value === 'string') {
    if (value.length <= (slack ? MAX_PROJECTED_STRING : MAX_STRING)) return value;
    return `${value.slice(0, MAX_STRING)}${moreCharacters(value.length - MAX_STRING)}`;
  }
  if (value === null || typeof value !== 'object') return value;
  // A file attachment is bytes, not fields. Rendering it key by key would put
  // 40 array indices on the approval card and nothing a reviewer can use.
  if (ArrayBuffer.isView(value)) return `[binary, ${(value as ArrayBufferView).byteLength} bytes]`;
  if (value instanceof ArrayBuffer) return `[binary, ${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[nested value omitted]';
  if (Array.isArray(value)) {
    if (slack && value.length <= MAX_ARRAY + 1) return value.map(item => bound(item, depth + 1, slack));
    const items = value.slice(0, MAX_ARRAY).map(item => bound(item, depth + 1, slack));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more items]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const asProjected = slack && keys.length <= MAX_KEYS + 1;
  const keep = asProjected ? keys.length : MAX_KEYS;
  for (const key of keys.slice(0, keep)) {
    if (key === PIECE_AUTH_PROPERTY) continue;
    // Defined, not assigned (#694). `JSON.parse` makes `__proto__` an own key,
    // and `out[key] = ...` would call the prototype SETTER for it instead: the
    // field vanished from the card and the digest, with no `omittedFields`,
    // while the piece still received it. A plain prototype is kept, so every
    // other key projects exactly as it did.
    // A field spelled like the marker is escaped (#722) unless this object is
    // already a projection, whose keys were escaped by the pass that made it.
    Object.defineProperty(out, asProjected ? key : escapeMarkerSpelling(key), {
      value: bound((value as Record<string, unknown>)[key], depth + 1, slack),
      enumerable: true, writable: true, configurable: true,
    });
  }
  // Never drop fields silently: a reviewer has to see that the card is
  // showing less than the step will send.
  if (keys.length > keep) out[OMITTED_FIELDS] = keys.length - keep;
  return out;
}

/** The key `bound()` writes the count of an object's dropped fields under. */
const OMITTED_FIELDS = 'omittedFields';
const MARKER_SPELLING = /^~*omittedFields$/u;

/**
 * A real input field named like the marker, made distinguishable from it
 * (#722). Before, `omittedFields` was an ordinary key as well as the marker:
 * a step input holding its own `omittedFields` (in any object, of any size)
 * read on the card as a count of dropped fields, and when the object was also
 * cut and the field among the 40 kept, the count OVERWROTE the field's value.
 *
 * So a field spelled `omittedFields`, `~omittedFields`, `~~omittedFields`, ...
 * gains one more leading `~`. The map is injective and only the bare spelling
 * is ever the marker, so after this pass `omittedFields` always means the count
 * and every field keeps its value under a name that says it is a field. No key
 * is unavailable to an input -- a JSON key can be any string -- so escaping is
 * the only way to make the marker unambiguous without moving the count out of
 * the object.
 */
function escapeMarkerSpelling(key: string): string {
  return MARKER_SPELLING.test(key) ? `~${key}` : key;
}

function moreCharacters(overflow: number): string {
  return `... [${overflow} more characters]`;
}

/**
 * Longest string the first pass can emit: the 512-character prefix plus the
 * longest note. A JavaScript string is under 2^31 code units in every engine
 * this runs on, so the overflow count has at most ten digits.
 */
const MAX_PROJECTED_STRING = MAX_STRING + moreCharacters(2 ** 31).length;

/**
 * Strip the resolved connection and bound the rest. The ENGINE's pass, on the
 * resolved input, before it leaves the subprocess -- so a credential cannot
 * reach the authorize route.
 */
export function sanitizePieceInput(input: unknown, piece?: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  return bound(redactFor(piece, input as Record<string, unknown>), 0) as Record<string, unknown>;
}

/** The piece's own credential redaction (`redactInput`), or the input as it is. */
function redactFor(piece: unknown, input: Record<string, unknown>, projected = false): Record<string, unknown> {
  const redact = governedPieceAdapter(piece)?.redactInput;
  return redact ? redact(input, projected) : input;
}

/**
 * The DAEMON's pass, on what the engine sent: strip the connection again and
 * bound again, so neither the durable effect record nor the approval card can
 * carry a credential or an unbounded value whatever the engine did.
 *
 * Unlike `sanitizePieceInput` it leaves a value inside a projection's envelope
 * as it stands (see `slack` on `bound()`), so for an honest engine
 * `reprojectPieceInput(sanitizePieceInput(x))` deep-equals
 * `sanitizePieceInput(x)` and every count on the card is the engine's (#651).
 *
 * WHAT THIS MOVED, which is the cost #634's own docblock warns about. The
 * daemon's projection used to be `sanitizePieceInput` twice, so it differs from
 * this one exactly where the engine's pass left a count -- an input holding a
 * string over 512 characters at any depth, or an array over 25 items or an
 * object over 40 keys nested less than five levels deep. A governed-piece approval of such an input
 * that is still PENDING at upgrade was granted against the old projection's
 * `requestDigest`; when its run resumes, `effect-boundary.ts` recomputes the
 * digest from this projection, it does not match, and the step fails with
 * "Workflow effect changed since it was recorded; start a new run for new
 * arguments or version". The user starts a new run and gets a card whose
 * counts are right. The same holds for an engine retry, inside one run, of a
 * step whose authorization was recorded before the upgrade. Nothing is executed
 * against a projection nobody approved, and an input with no count in it --
 * the common case -- has the same projection and digest as before. (So do a
 * few inputs WITH a count, where the old second pass happened to reproduce the
 * first: a string exactly 24 characters over, an array of exactly 26 items, a
 * 41-key object whose `omittedFields` sorts last and is 1. Those stay valid.)
 */
export function reprojectPieceInput(input: unknown, piece?: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  return bound(redactFor(piece, input as Record<string, unknown>, true), 0, true) as Record<string, unknown>;
}

/**
 * Target keys the effect boundary owns (`effect-capabilities.ts`): what
 * `validateTarget` digests, what the machine-binding fence reads, and
 * `intent`, which `effect-boundary.ts` takes as the approval's gate sentence.
 * Defined here, the one pure module both sides import, so the engine-bundled
 * copy and the daemon's cannot drift.
 */
export const RESERVED_TARGET_KEYS: ReadonlySet<string> = new Set(['tool', 'capability', 'sidecarId', 'selection', 'machineBinding', 'intent']);

/** The keys `governedPieceTarget` writes itself: which piece and action, and whether it is mapped. */
const PIECE_TARGET_KEYS: ReadonlySet<string> = new Set(['piece', 'action', 'unmappedAction']);

/**
 * What the step will act on, in terms a person can judge: the piece, the
 * action, and the input props that name the recipient, message, file or
 * endpoint. Never includes the credential.
 *
 * A target prop named like a key the boundary owns (`RESERVED_TARGET_KEYS`) or
 * one this function writes is skipped (#793). The props are copied from flow
 * input, so an adapter declaring `intent` would have made flow data the
 * approval card's headline AND the "approved sentence" the deferred executor
 * compares against -- passing its own tamper check -- and one declaring
 * `piece` or `action` would have overwritten which piece the card names. No
 * adapter declares one today (a test pins that); this keeps it so.
 *
 * WHAT #793 MOVED. Nothing, for any adapter in the table: none declares a
 * reserved or own key, so every target, every digest and every pending
 * approval is byte-exact as before. This file is in `PATCHED_VENDOR_SOURCES`
 * (`runner/engine-runtime/build.ts`), so the edit still changes the engine
 * bundle hash and every cached engine bundle and compiled piece is rebuilt on
 * the next run, on every instance and shared root. The function itself runs
 * only in the daemon (`governedPieceToolDefinition`), never in the engine.
 */
export function governedPieceTarget(resolved: ResolvedPieceAction, input: Record<string, unknown>): Record<string, unknown> {
  const target: Record<string, unknown> = { piece: resolved.adapter.catalogId, action: resolved.action };
  if (!resolved.known) target.unmappedAction = true;
  for (const prop of resolved.adapter.targetProps) {
    if (RESERVED_TARGET_KEYS.has(prop) || PIECE_TARGET_KEYS.has(prop)) continue;
    const value = input[prop];
    if (value === undefined || value === null || value === '') continue;
    // With slack: `input` is the daemon's projection, so a count already in it
    // is kept rather than re-counted (#651). The depth start still trims a
    // target to two levels below the prop, which is a choice, not a cap.
    target[prop] = bound(value, MAX_DEPTH - 2, true);
  }
  return target;
}

/**
 * The adapter as the daemon's existing effect machinery wants it: a
 * `ToolDefinition` carrying a `workflowEffect` with an Authority category and
 * a target resolver. `effect-capabilities.ts` resolves it exactly as it
 * resolves a typed adapter on a daemon tool, so piece effects and tool effects
 * cannot drift apart.
 *
 * `execute` throws on purpose. These descriptors are never registered in the
 * `ToolRegistry`: the effect runs in the engine subprocess, and an LLM must
 * not be able to reach a piece action by calling a tool with this name.
 */
export function governedPieceToolDefinition(resolved: ResolvedPieceAction): ToolDefinition {
  return {
    name: governedPieceToolName(resolved.adapter.catalogId, resolved.action),
    description: `Governed ${resolved.adapter.catalogId} piece action ${resolved.action}`,
    category: PIECE_TOOL_CATEGORY,
    parameters: {},
    execute: async () => {
      throw new Error('Governed piece adapters are not directly executable; the piece action runs in the workflow engine');
    },
    workflowEffect: {
      category: resolved.category,
      target: params => governedPieceTarget(resolved, params),
    },
  };
}
