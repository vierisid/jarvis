/**
 * `jarvis-context` piece -- read-only access to Jarvis state. Workflows use
 * these actions to pull the user's vault, recent awareness activity, or
 * pending commitments into a flow run as input data for downstream nodes.
 *
 * Actions:
 *   vault_search       (query?, type?, limit?)
 *   vault_get_entity   (id)
 *   awareness_recent   (limit?, since?)
 *   commitments_list   (status?, limit?)
 *
 * The piece itself only does input validation and dispatch. The real work is
 * in the daemon's `PieceContextProvider` implementation.
 */

import {
  JarvisActionInputError,
  type AwarenessActivitySnapshot,
  type AwarenessRecentInput,
  type CommitmentSnapshot,
  type CommitmentStatus,
  type CommitmentsListInput,
  type JarvisAction,
  type JarvisPiece,
  type JarvisPieceContext,
  type VaultEntitySnapshot,
  type VaultEntityType,
  type VaultSearchInput,
} from "./types";

const VAULT_TYPES = new Set<VaultEntityType>([
  "person",
  "project",
  "tool",
  "place",
  "concept",
  "event",
]);

const COMMITMENT_STATUSES = new Set<CommitmentStatus>([
  "pending",
  "scheduled",
  "in_progress",
  "completed",
  "failed",
]);

function requireContextProvider(ctx: JarvisPieceContext, label: string) {
  const provider = ctx.services.context;
  if (!provider) {
    throw new Error(`jarvis-context.${label}: ctx.services.context is not configured`);
  }
  return provider;
}

function asObject(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new JarvisActionInputError(`${label}: input must be an object`);
  }
  return raw as Record<string, unknown>;
}

function readOptionalInt(r: Record<string, unknown>, key: string, label: string): number | undefined {
  if (r[key] === undefined) return undefined;
  if (typeof r[key] !== "number" || !Number.isFinite(r[key]) || r[key] < 0) {
    throw new JarvisActionInputError(`${label}: ${key} must be a non-negative number`);
  }
  return Math.floor(r[key]);
}

// -------------------------------------------------------- vault_search

export const vaultSearchAction: JarvisAction<VaultSearchInput, VaultEntitySnapshot[]> = {
  name: "vault_search",
  displayName: "Vault: search entities",
  description:
    "Find vault entities by name fragment and/or type. Returns up to `limit` entities ordered by recency.",

  parseInput: (raw) => {
    const r = asObject(raw, "vault_search");
    const out: VaultSearchInput = {};
    if (r.query !== undefined) {
      if (typeof r.query !== "string") {
        throw new JarvisActionInputError("vault_search: query must be a string");
      }
      out.query = r.query;
    }
    if (r.type !== undefined) {
      if (typeof r.type !== "string" || !VAULT_TYPES.has(r.type as VaultEntityType)) {
        throw new JarvisActionInputError(
          `vault_search: type must be one of ${Array.from(VAULT_TYPES).join(", ")}`,
        );
      }
      out.type = r.type as VaultEntityType;
    }
    const limit = readOptionalInt(r, "limit", "vault_search");
    if (limit !== undefined) out.limit = limit;
    return out;
  },

  async execute(input, ctx) {
    return requireContextProvider(ctx, "vault_search").vaultSearch(input);
  },
};

// -------------------------------------------------------- vault_get_entity

export interface VaultGetInput {
  id: string;
}

export const vaultGetEntityAction: JarvisAction<VaultGetInput, VaultEntitySnapshot | null> = {
  name: "vault_get_entity",
  displayName: "Vault: get entity by id",
  description: "Fetch a single vault entity by id. Returns null if not found.",

  parseInput: (raw) => {
    const r = asObject(raw, "vault_get_entity");
    if (typeof r.id !== "string" || r.id.length === 0) {
      throw new JarvisActionInputError("vault_get_entity: id is required");
    }
    return { id: r.id };
  },

  async execute(input, ctx) {
    return requireContextProvider(ctx, "vault_get_entity").vaultGetEntity(input.id);
  },
};

// ----------------------------------------------------- awareness_recent

export const awarenessRecentAction: JarvisAction<AwarenessRecentInput, AwarenessActivitySnapshot[]> = {
  name: "awareness_recent",
  displayName: "Awareness: recent activity",
  description:
    "Return recent awareness activities (foreground app, window title, URL, optional summary), most recent first.",

  parseInput: (raw) => {
    const r = asObject(raw, "awareness_recent");
    const out: AwarenessRecentInput = {};
    const limit = readOptionalInt(r, "limit", "awareness_recent");
    if (limit !== undefined) out.limit = limit;
    const since = readOptionalInt(r, "since", "awareness_recent");
    if (since !== undefined) out.since = since;
    return out;
  },

  async execute(input, ctx) {
    return requireContextProvider(ctx, "awareness_recent").awarenessRecent(input);
  },
};

// ----------------------------------------------------- commitments_list

export const commitmentsListAction: JarvisAction<CommitmentsListInput, CommitmentSnapshot[]> = {
  name: "commitments_list",
  displayName: "Commitments: list",
  description: "List commitments, optionally filtered by status.",

  parseInput: (raw) => {
    const r = asObject(raw, "commitments_list");
    const out: CommitmentsListInput = {};
    if (r.status !== undefined) {
      if (typeof r.status !== "string" || !COMMITMENT_STATUSES.has(r.status as CommitmentStatus)) {
        throw new JarvisActionInputError(
          `commitments_list: status must be one of ${Array.from(COMMITMENT_STATUSES).join(", ")}`,
        );
      }
      out.status = r.status as CommitmentStatus;
    }
    const limit = readOptionalInt(r, "limit", "commitments_list");
    if (limit !== undefined) out.limit = limit;
    return out;
  },

  async execute(input, ctx) {
    return requireContextProvider(ctx, "commitments_list").commitmentsList(input);
  },
};

export const jarvisContextPiece: JarvisPiece = {
  name: "jarvis-context",
  displayName: "Jarvis: Context",
  description:
    "Read from Jarvis state: vault entities, recent awareness activity, commitments. Read-only; use the relevant write tools or pieces for mutation.",
  actions: {
    [vaultSearchAction.name]: vaultSearchAction as unknown as JarvisAction,
    [vaultGetEntityAction.name]: vaultGetEntityAction as unknown as JarvisAction,
    [awarenessRecentAction.name]: awarenessRecentAction as unknown as JarvisAction,
    [commitmentsListAction.name]: commitmentsListAction as unknown as JarvisAction,
  },
};
