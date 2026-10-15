import type { Database } from 'bun:sqlite';
import type { UserProfileFact, UserProfileRecord } from '../../user/profile.ts';

export type Scope = { actorId: string; projectId: string };
export type Fact = Omit<UserProfileFact, 'recorded_at'>;
/** Internal server port, never a client mutation. Structurally matches B04. */
export interface CommitInput {
  scope: Scope;
  sessionId: string;
  turnId: string;
  clientRequestId: string;
  attemptId: string;
  facts: Fact[];
  wrap: boolean;
  signal: AbortSignal;
  isCurrent(): boolean;
}
export interface Receipt {
  schemaVersion: 1;
  digest: string;
  confirmedFactIds: string[];
}
export interface Transaction {
  readProfile(): UserProfileRecord | null;
  /** Must use the canonical writer with completion deferred. */
  append(fact: Fact): void;
  wrap(): void;
  readReceipt(key: string): unknown;
  writeReceipt(key: string, receipt: Receipt): void;
}
/** Synchronous atomic transaction: writes and receipt commit or roll back together.
 * No remote/async writer can satisfy this port. Scope is bound by the host. */
export interface Store {
  transaction<T>(scope: Scope, work: (tx: Transaction) => T): T;
}
export interface CanonicalStoreOptions {
  /** Server-selected owner of this single-user vault, never client input. */
  owner: Scope;
  database(): Database;
}
