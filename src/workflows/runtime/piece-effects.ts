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
 * `runner/engine-runtime/build.ts`). Keep it pure: type-only imports, no node
 * built-ins, no daemon singletons.
 */

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

/**
 * Q-07's bounded completion-receipt protocol. These actions never park
 * themselves. Every Gmail send that returns once sent is tracked, so an engine
 * retry of a send whose outcome is unknown is refused instead of sending again
 * (#953 made these reachable at the default level).
 */
export function tracksPieceCompletion(piece: unknown, action: unknown, input?: unknown): boolean {
  return (piece === '@activepieces/piece-github' && ['github_create_issue', 'update_issue', 'createCommentOnAIssue'].includes(String(action)))
    || (piece === MAILCHIMP_PIECE && managedPieceChanges(MAILCHIMP_PIECE, action))
    || (piece === CLICKUP_PIECE && managedPieceChanges(CLICKUP_PIECE, action))
    || (piece === '@activepieces/piece-gmail' && GMAIL_TRACKED_SENDS.has(action))
    || (piece === '@activepieces/piece-slack' && (action === 'send_channel_message' || action === 'slack_post_message'))
    // #961: an HTTP request that is not a read is a send whose outcome the
    // server alone knows, so a retry after a lost or failed request is
    // refused rather than repeated. Without the input it is assumed a send.
    || (piece === HTTP_PIECE && action === 'send_request' && !httpRequestIsRead(inputObject(input) ?? {}));
}

const CLICKUP_PIECE = '@activepieces/piece-clickup';
const MAILCHIMP_PIECE = '@activepieces/piece-mailchimp';
/** Every ClickUp or Mailchimp action that changes the account (write, send or
 * delete). None parks its flow, so each one can be tracked; a read never is. */
function managedPieceChanges(pieceName: string, action: unknown): boolean {
  const categories = MANAGED_PIECE_ADAPTERS.find(a => a.pieceName === pieceName)!.categories;
  return typeof action === 'string' && (['write_data', 'send_message', 'send_email', 'delete_data'] as const)
    .some(category => categories[category]?.includes(action));
}

/** The vendored core HTTP piece (#961). */
export const HTTP_PIECE = '@activepieces/piece-http';

/**
 * True for an HTTP method that only reads: GET and HEAD, in any letter case
 * (axios upper-cases the method it sends). Anything else, including a method
 * with surrounding space or one that is not a string, is not a read. A request
 * is a read only when `httpRequestIsRead` also finds no body; the category,
 * the completion tracking, the in-piece retry and the redirect rule all ask
 * that one function, so they cannot disagree about a request.
 */
export function httpMethodIsRead(method: unknown): boolean {
  return typeof method === 'string' && /^(get|head)$/iu.test(method);
}

/**
 * True for an HTTP request that only reads: a GET or HEAD that carries no
 * body. The piece sends `body.data` whatever the method (axios puts a body on
 * a GET too, measured), so a GET with one is content leaving for the host,
 * not a read (#961 security review). A projection that cut the body still has
 * a non-empty value there, so it never reads as body-less.
 */
export function httpRequestIsRead(input: Record<string, unknown>): boolean {
  // On a projection cut at 40 keys, `body` sorts before `method`: a body lost
  // to the cut takes the method with it, and a request with no method is
  // never a read. So a cut can never make a request with a body read as one.
  if (!httpMethodIsRead(input.method)) return false;
  const body = input.body;
  if (body === undefined || body === null || body === '') return true;
  const data = inputObject(body) ? (body as Record<string, unknown>).data : body;
  return data === undefined || data === null || data === '';
}

function inputObject(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
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
   * whose whole original the engine's `inputDigest` binds.
   */
  categoryFromInput?: Readonly<Record<string, InputCategoryRule>>;
  /**
   * Hide inline credentials a piece takes as ordinary props before the input
   * is bounded for the card and the effect record. Must be deterministic and
   * idempotent: the daemon applies it again to what the engine sent.
   */
  redactInput?: (input: Record<string, unknown>) => Record<string, unknown>;
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
      'archived_item_id', 'parent_page_id', 'new_parent_page_id', 'title', 'comment_text', 'url', 'method'],
    categories: {
      read_data: ['list_databases', 'notion-find-database-item', 'list_database_pages',
        'getPageOrBlockChildren', 'retrieve_database', 'get_page_comments', 'find_page', 'notion_get_page',
        'notion_get_block_children', 'notion_get_page_comments', 'notion_search', 'notion_list_users',
        'notion_get_user', 'notion_get_database', 'notion_query_database', 'notion_find_database_item'],
      write_data: ['create_database_item', 'update_database_item', 'createPage', 'append_to_page',
        'restore_database_item', 'add_comment', 'notion_create_page', 'notion_move_page',
        'notion_append_to_page', 'notion_update_block', 'notion_add_comment', 'notion_create_database',
        'notion_update_database_schema', 'notion_create_database_item', 'notion_update_database_item',
        'notion_restore_database_item'],
      // A Notion archive moves the page to the trash, where it ages out --
      // unlike a Gmail archive, which only takes a label off.
      delete_data: ['archive_database_item', 'notion_archive_page', 'notion_delete_block',
        'notion_archive_database_item', 'custom_api_call'],
    },
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
];

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
function redactNamed(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
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
  return { ...fields, data: redactNamed(data) };
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
      .replace(/([?&;][^=&#;]*=)([^&#;]*)/gu, (whole, name: string, value: string) =>
        isSecretName(name.slice(1, -1)) && value !== '' ? `${name}${redactValue(value)}` : whole);
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
  return typeof pieceName === 'string' && BY_PIECE_NAME.has(pieceName);
}

/**
 * The adapter decision for one step, or null when the piece is ungoverned.
 * `input` is the step's projected input; an action whose category depends on
 * it (`categoryFromInput`) is resolved from it, and without it gets the
 * table's worst case.
 */
export function resolveGovernedPieceAction(pieceName: unknown, actionName: unknown, input?: unknown): ResolvedPieceAction | null {
  if (typeof pieceName !== 'string' || typeof actionName !== 'string') return null;
  const adapter = BY_PIECE_NAME.get(pieceName);
  if (!adapter) return null;
  const mapped = ACTION_CATEGORY.get(pieceName)!.get(actionName);
  const rule = mapped !== undefined && Object.hasOwn(adapter.categoryFromInput ?? {}, actionName) ? adapter.categoryFromInput![actionName] : undefined;
  const fields = inputObject(input);
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
function redactFor(piece: unknown, input: Record<string, unknown>): Record<string, unknown> {
  const redact = governedPieceAdapter(piece)?.redactInput;
  return redact ? redact(input) : input;
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
  return bound(redactFor(piece, input as Record<string, unknown>), 0, true) as Record<string, unknown>;
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
