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

export interface GovernedPieceAdapter {
  /** Catalog id, as in `pieces-library/catalog-overrides.ts` `VERIFIED`. */
  catalogId: string;
  /** npm package name, as it appears in a `FlowVersion` step's `pieceName`. */
  pieceName: string;
  /**
   * Category for any action this adapter does not name. Must be the most
   * severe category the piece can reach, so an action added upstream after
   * this table was written is over-gated rather than under-gated.
   */
  unknownActionCategory: ActionCategory;
  /** Action names per category. Complete for the vetted version below. */
  categories: Partial<Record<ActionCategory, readonly string[]>>;
  /**
   * Input props that identify what the action will act on, in the order they
   * should read on an approval card. Values are copied from the resolved step
   * input; absent props are omitted.
   */
  targetProps: readonly string[];
  /** Piece version the action table was read from. */
  vettedVersion: string;
}

/**
 * The verified ten. Action tables were read from the exact versions named in
 * `vettedVersion`, which are the versions `pieces-library/catalog.ts` installs
 * for a verified piece.
 */
export const GOVERNED_PIECE_ADAPTERS: readonly GovernedPieceAdapter[] = [
  {
    catalogId: 'gmail',
    pieceName: '@activepieces/piece-gmail',
    vettedVersion: '0.15.0',
    // Gmail spans read through send to permanent deletion, so no single
    // category describes it. `gmail_delete_draft` deletes permanently and
    // `gmail_stop_watch` changes a mailbox setting; both sit at level 9, so an
    // unmapped Gmail action is gated as a deletion.
    unknownActionCategory: 'delete_data',
    targetProps: ['receiver', 'cc', 'bcc', 'subject', 'reply_to', 'from', 'to',
      'message_id', 'thread_id', 'draft_id', 'label', 'url', 'method'],
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
        'gmail_archive_email'],
      // Mail leaves the account under the user's own address, including the
      // approval-request action, which is a send that then waits.
      send_email: ['send_email', 'gmail_send_email', 'reply_to_email', 'gmail_reply_to_thread',
        'gmail_send_draft', 'gmail_forward_message', 'request_approval_in_mail'],
      delete_data: ['gmail_delete_draft', 'custom_api_call'],
      // Stops push notifications on the mailbox: a mailbox-level setting, and
      // silently disabling it would stop every watch-driven flow.
      modify_settings: ['gmail_stop_watch'],
    },
  },
  {
    catalogId: 'slack',
    pieceName: '@activepieces/piece-slack',
    vettedVersion: '0.17.10',
    unknownActionCategory: 'delete_data',
    targetProps: ['channel', 'user', 'userId', 'username', 'email', 'handle', 'ts', 'threadTs',
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
        'slack_send_ephemeral_message', 'updateMessage', 'slack_update_message'],
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
    vettedVersion: '0.6.10',
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
    vettedVersion: '0.10.5',
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
    vettedVersion: '0.4.12',
    // Only `custom_api_call` reaches this today, and through it the API key
    // reaches every Anthropic endpoint, files and batches included.
    unknownActionCategory: 'delete_data',
    targetProps: ['model', 'prompt', 'systemPrompt', 'text', 'mode', 'url', 'method'],
    categories: {
      write_data: ['ask_claude', 'extract-structured-data'],
      delete_data: ['custom_api_call'],
    },
  },
  {
    catalogId: 'github',
    pieceName: '@activepieces/piece-github',
    vettedVersion: '0.7.3',
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
    vettedVersion: '0.10.3',
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
    vettedVersion: '0.9.1',
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
    vettedVersion: '0.5.7',
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
    vettedVersion: '0.5.7',
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

interface ResolvedPieceAction {
  adapter: GovernedPieceAdapter;
  action: string;
  category: ActionCategory;
  /** False when the action is not in the table and took the worst-case fallback. */
  known: boolean;
}

const BY_PIECE_NAME = new Map<string, GovernedPieceAdapter>();
const ACTION_CATEGORY = new Map<string, Map<string, ActionCategory>>();
for (const adapter of GOVERNED_PIECE_ADAPTERS) {
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

/** The adapter decision for one step, or null when the piece is ungoverned. */
export function resolveGovernedPieceAction(pieceName: unknown, actionName: unknown): ResolvedPieceAction | null {
  if (typeof pieceName !== 'string' || typeof actionName !== 'string') return null;
  const adapter = BY_PIECE_NAME.get(pieceName);
  if (!adapter) return null;
  const mapped = ACTION_CATEGORY.get(pieceName)!.get(actionName);
  return { adapter, action: actionName, category: mapped ?? adapter.unknownActionCategory, known: mapped !== undefined };
}

/** Stable identity for the audit row and the approval card. Cannot collide
 * with a `ToolRegistry` tool name, which is always a bare identifier. */
export function governedPieceToolName(catalogId: string, action: string): string {
  return `piece:${catalogId}/${action}`;
}

const MAX_STRING = 512;
const MAX_ARRAY = 25;
const MAX_KEYS = 40;
const MAX_DEPTH = 5;

/**
 * Bound one value for review. Deterministic: the same input always produces
 * the same projection, so the digest the approval was granted against still
 * matches when the step re-authorizes on resume.
 */
function bound(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}... [${value.length - MAX_STRING} more characters]`;
  }
  if (value === null || typeof value !== 'object') return value;
  // A file attachment is bytes, not fields. Rendering it key by key would put
  // 40 array indices on the approval card and nothing a reviewer can use.
  if (ArrayBuffer.isView(value)) return `[binary, ${(value as ArrayBufferView).byteLength} bytes]`;
  if (value instanceof ArrayBuffer) return `[binary, ${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[nested value omitted]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map(item => bound(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more items]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const key of keys.slice(0, MAX_KEYS)) {
    if (key === PIECE_AUTH_PROPERTY) continue;
    out[key] = bound((value as Record<string, unknown>)[key], depth + 1);
  }
  // Never drop fields silently: a reviewer has to see that the card is
  // showing less than the step will send.
  if (keys.length > MAX_KEYS) out.omittedFields = keys.length - MAX_KEYS;
  return out;
}

/**
 * Strip the resolved connection and bound the rest. Called on the engine side
 * before the input leaves the subprocess AND again on the daemon side, so a
 * credential cannot reach the authorize route, the durable effect record or
 * the approval card by either path.
 */
export function sanitizePieceInput(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  return bound(input, 0) as Record<string, unknown>;
}

/**
 * What the step will act on, in terms a person can judge: the piece, the
 * action, and the input props that name the recipient, message, file or
 * endpoint. Never includes the credential.
 */
export function governedPieceTarget(resolved: ResolvedPieceAction, input: Record<string, unknown>): Record<string, unknown> {
  const target: Record<string, unknown> = { piece: resolved.adapter.catalogId, action: resolved.action };
  if (!resolved.known) target.unmappedAction = true;
  for (const prop of resolved.adapter.targetProps) {
    const value = input[prop];
    if (value === undefined || value === null || value === '') continue;
    target[prop] = bound(value, MAX_DEPTH - 2);
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
