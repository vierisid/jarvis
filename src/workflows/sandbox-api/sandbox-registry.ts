/**
 * In-memory registry of live sandboxes. The SandboxApi server consults this
 * registry on every authenticated request: a valid engineToken whose sandboxId
 * is no longer in the registry (because we terminated the sandbox) is rejected
 * even if the JWT signature is still valid. This prevents zombie engines from
 * making API calls after the daemon decided their run was done.
 *
 * The registry is also where the EngineFlowExecutor stashes the per-run
 * context that route handlers need (runId -> projectId, payload, etc.) so the
 * routes don't have to thread state through every call site.
 */

import { randomBytes } from "node:crypto";
import type { SandboxIdentity, SandboxRecord } from "./types";

export class SandboxRegistry {
  private readonly sandboxes = new Map<string, SandboxRecord>();

  /** Generate a fresh sandbox id (also serves as socket.io auth identifier). */
  static newSandboxId(): string {
    return randomBytes(12).toString("hex");
  }

  register(record: SandboxRecord): void {
    if (this.sandboxes.has(record.sandboxId)) {
      throw new Error(`sandboxId ${record.sandboxId} already registered`);
    }
    this.sandboxes.set(record.sandboxId, record);
  }

  /** Returns the live sandbox record, or null if the sandbox is unknown or terminated. */
  get(sandboxId: string): SandboxRecord | null {
    const record = this.sandboxes.get(sandboxId);
    if (!record) return null;
    if (record.terminatedAt !== null) return null;
    return record;
  }

  byRunId(runId: string): SandboxRecord | null {
    for (const record of this.sandboxes.values()) {
      if (record.runId === runId && record.terminatedAt === null) return record;
    }
    return null;
  }

  /**
   * Re-point an existing sandbox at a new run. Used by the engine pool: a
   * warm engine keeps its `sandboxId` (the engine's socket.io auth value
   * is fixed at spawn time) but each acquire mints a new engineToken bound
   * to a new (runId, projectId). Throws if the sandbox is unknown or
   * already terminated.
   */
  rebind(
    sandboxId: string,
    patch: { runId: string; projectId: string; engineToken: string; expiresAt: number },
  ): void {
    const record = this.sandboxes.get(sandboxId);
    if (!record) throw new Error(`rebind: sandboxId ${sandboxId} not registered`);
    if (record.terminatedAt !== null) throw new Error(`rebind: sandboxId ${sandboxId} terminated`);
    record.runId = patch.runId;
    record.projectId = patch.projectId;
    record.engineToken = patch.engineToken;
    record.expiresAt = patch.expiresAt;
  }

  /** Mark the sandbox as terminated; subsequent get/byRunId will return null. */
  terminate(sandboxId: string, now = Date.now()): void {
    const record = this.sandboxes.get(sandboxId);
    if (!record) return;
    if (record.terminatedAt !== null) return;
    record.terminatedAt = now;
  }

  /**
   * Drop terminated entries older than `retainMs` from the map. Called
   * occasionally to keep the map from growing unbounded over a long-running
   * daemon. Active records are never removed.
   */
  prune(retainMs = 5 * 60_000, now = Date.now()): number {
    let dropped = 0;
    for (const [id, record] of this.sandboxes) {
      if (record.terminatedAt !== null && now - record.terminatedAt > retainMs) {
        this.sandboxes.delete(id);
        dropped++;
      }
    }
    return dropped;
  }

  size(): number {
    return this.sandboxes.size;
  }

  liveCount(): number {
    let live = 0;
    for (const record of this.sandboxes.values()) {
      if (record.terminatedAt === null) live++;
    }
    return live;
  }

  /** Test helper: drop everything. */
  reset(): void {
    this.sandboxes.clear();
  }

  identityFromToken(claims: SandboxIdentity): SandboxRecord | null {
    return this.get(claims.sandboxId);
  }
}
