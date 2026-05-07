/**
 * Adapter: PieceContextProvider over the vault entities/awareness/commitments
 * modules.
 *
 * Vault `commitment.status` has values our piece type doesn't carry verbatim
 * ("active", "escalated"). We map at the boundary:
 *   piece in_progress  <-> vault active
 *   piece failed       <-  vault escalated  (escalation signals failure-needing-attention)
 *
 * Awareness: vault `screen_captures` is a single-frame log. We bucket each
 * row into an `AwarenessActivitySnapshot` using its `app_name`, `window_title`,
 * `url`, and `timestamp` as start_time. `endTime` is unknown for individual
 * captures (sessions roll up); set to null.
 *
 * "scheduled" was previously an accepted piece-side status (mapped to vault
 * "pending"); removed because the vault has no such state and surfacing it
 * to the UI was misleading. Direct piece statuses now: pending, in_progress,
 * completed, failed.
 */

import type {
  AwarenessActivitySnapshot,
  AwarenessRecentInput,
  CommitmentSnapshot,
  CommitmentsListInput,
  CommitmentStatus as PieceCommitmentStatus,
  PieceContextProvider,
  VaultEntitySnapshot,
  VaultEntityType,
  VaultSearchInput,
} from "../jarvis-pieces/types";

import { findEntities, getEntity, type Entity, type EntityType } from "../../vault/entities";
import { findCommitments, type Commitment, type CommitmentStatus as VaultCommitmentStatus } from "../../vault/commitments";
import { getRecentCaptures } from "../../vault/awareness";
import type { ScreenCaptureRow } from "../../awareness/types";

export class JarvisContextProviderAdapter implements PieceContextProvider {
  async vaultSearch(input: VaultSearchInput): Promise<VaultEntitySnapshot[]> {
    const query: { type?: EntityType; nameContains?: string } = {};
    if (input.type !== undefined) query.type = input.type;
    if (input.query !== undefined) query.nameContains = input.query;
    const entities = findEntities(query);
    const limit = input.limit ?? 25;
    return entities.slice(0, limit).map(entityToSnapshot);
  }

  async vaultGetEntity(id: string): Promise<VaultEntitySnapshot | null> {
    const ent = getEntity(id);
    return ent ? entityToSnapshot(ent) : null;
  }

  async awarenessRecent(input: AwarenessRecentInput): Promise<AwarenessActivitySnapshot[]> {
    const limit = input.limit ?? 25;
    const rows = getRecentCaptures(limit);
    const since = input.since;
    const filtered = since !== undefined ? rows.filter((r) => r.timestamp >= since) : rows;
    return filtered.map(captureToSnapshot);
  }

  async commitmentsList(input: CommitmentsListInput): Promise<CommitmentSnapshot[]> {
    const filter: { status?: VaultCommitmentStatus } = {};
    const mapped = pieceToVaultStatus(input.status);
    if (mapped) filter.status = mapped;
    const rows = findCommitments(filter);
    const limit = input.limit ?? 25;
    return rows.slice(0, limit).map(commitmentToSnapshot);
  }
}

function entityToSnapshot(e: Entity): VaultEntitySnapshot {
  return {
    id: e.id,
    type: e.type as VaultEntityType,
    name: e.name,
    properties: (e.properties as Record<string, unknown> | null) ?? null,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

function captureToSnapshot(row: ScreenCaptureRow): AwarenessActivitySnapshot {
  return {
    id: row.id,
    appName: row.app_name ?? null,
    windowTitle: row.window_title ?? null,
    url: row.url ?? null,
    startTime: row.timestamp,
    endTime: null,
    summary: null,
  };
}

function commitmentToSnapshot(c: Commitment): CommitmentSnapshot {
  return {
    id: c.id,
    description: c.what,
    status: vaultToPieceStatus(c.status),
    dueAt: c.when_due,
    priority: c.priority === "critical" ? "urgent" : c.priority,
    createdAt: c.created_at,
  };
}

function pieceToVaultStatus(s: PieceCommitmentStatus | undefined): VaultCommitmentStatus | undefined {
  if (s === undefined) return undefined;
  if (s === "in_progress") return "active";
  // pending / completed / failed pass through
  return s as VaultCommitmentStatus;
}

function vaultToPieceStatus(s: VaultCommitmentStatus): PieceCommitmentStatus {
  if (s === "active") return "in_progress";
  if (s === "escalated") return "failed";
  // pending / completed / failed pass through
  return s as PieceCommitmentStatus;
}
