import type { MemoryStreamQuery, MemoryStreamResult } from './memory-stream-contracts';
import type {
  BriefConversation, BriefDecision, BriefGoal, BriefMemory, BriefConnection,
  BriefOutcome, BriefPreparedOpportunity, BriefPage, BriefPageQuery, BriefReadResult,
} from './contracts.ts';

export interface BriefProvider {
  /** Pure, synchronous status of initialized local services. No I/O, model call or effect. */
  readiness(): 'ready' | 'loading' | 'unavailable';
}
/** Read-only seam. Feature-specific writes must still use canonical services and authority. */
export interface BriefReadProvider<Query, Data> extends BriefProvider {
  read(query: Query): Promise<BriefReadResult<Data>>;
}
/** Providers are optional so a room compiles without importing an unmerged implementation. */
export interface BriefReadProviders {
  conversations?: BriefReadProvider<BriefPageQuery, BriefPage<BriefConversation>>;
  decisions?: BriefReadProvider<BriefPageQuery, BriefPage<BriefDecision>>;
  preparedOpportunities?: BriefReadProvider<BriefPageQuery, BriefPage<BriefPreparedOpportunity>>;
  goals?: BriefReadProvider<{ goalId: string }, BriefGoal>;
  outcomes?: BriefReadProvider<{ start: number; end: number; timezone: string }, BriefOutcome[]>;
  memory?: BriefReadProvider<BriefPageQuery, BriefPage<BriefMemory>>;
  /** F17 retains empty counts and never returns cached content with stale cursors. */
  memoryStream?: BriefProvider & { read(query: MemoryStreamQuery): Promise<MemoryStreamResult> };
  connections?: BriefReadProvider<void, BriefConnection[]>;
}
