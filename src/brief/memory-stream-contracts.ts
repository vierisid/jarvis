import type { MemoryUsageCoverage } from '../vault/memory-usage';
import type { BriefMemory, BriefMemoryUse } from './contracts';
import type { BriefProvider } from './providers';

export interface MemoryStreamQuery {
  cursor?: string;
  limit?: number;
  q?: string;
  source?: string;
  /** Exact conversation:<id> or run:<id>. Selected-only evidence never matches. */
  usedIn?: string;
  /** Inclusive lower / exclusive upper UTC millisecond bounds. */
  updatedFrom?: number;
  updatedBefore?: number;
}
export interface MemoryStreamItem extends BriefMemory {
  revision: string;
  subjectId: string;
  /** Canonical assertion context; an empty string means unspecified. */
  scope: string;
  usageCoverage?: MemoryUsageCoverage;
  updatedAt: number;
  validity: { from: number | null; to: number | null };
  sourceSummary: { labels: string[]; evidenceCount: number };
  detailHref: string;
  historyHref: string;
  supersededBy: string | null;
}
export interface MemoryStreamPage {
  usageCoverage?: MemoryUsageCoverage;
  items: MemoryStreamItem[];
  nextCursor: string | null;
  count: { total: number; matched: number; returned: number };
  usedIn: { state: 'ready' } | { state: 'unavailable'; reason: 'provider_unavailable' | 'no_supplied_evidence' };
}
/** Empty retains exact counts. Stale never sends cached, possibly forgotten content. */
export type MemoryStreamResult =
  | { state: 'ready' | 'empty'; data: MemoryStreamPage; asOf: number }
  | { state: 'stale'; reason: 'cursor_expired' | 'source_changed' }
  | { state: 'unavailable'; reason: 'provider_unavailable' | 'capacity_exceeded' | 'usage_unavailable' };

/** F18 supplies this synchronous read seam from the SAME vault read transaction.
 * Return only committed ledger records, without prompts or inferred associations.
 * A ready empty ledger means no retained events within its declared coverage; missing instrumentation means unknown.
 */
export interface MemoryUsageReader extends BriefProvider {
  readUses(factIds: readonly string[]): { state: 'ready'; uses: BriefMemoryUse[]; coverage?: MemoryUsageCoverage } | { state: 'unavailable' };
}
