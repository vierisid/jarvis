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
 *   - A piece named in `GOVERNED_PIECES` has every ACTION governed. Unknown
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

/** Piece names with a governed adapter. Read by the engine-side guard so an
 * ungoverned piece costs no round trip. */
export const GOVERNED_PIECE_NAMES: ReadonlySet<string> = new Set(BY_PIECE_NAME.keys());

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
  if (depth >= MAX_DEPTH) return '[nested value omitted]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map(item => bound(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more items]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort().slice(0, MAX_KEYS)) {
    if (key === PIECE_AUTH_PROPERTY) continue;
    out[key] = bound((value as Record<string, unknown>)[key], depth + 1);
  }
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
