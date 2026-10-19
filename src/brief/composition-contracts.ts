import type { CompositionIngredient } from '../workflows/runtime/composition-ingredients';

/** F-07/F-08 wire types. Jobs prepare disabled drafts; they never publish or run them. */
export const COMPOSITION_LIMITS = { promptBytes: 16_384, nameChars: 160, requestIdChars: 128, bodyBytes: 100_000, pendingJobs: 32 } as const;
export interface BriefComposeRequest { requestId: string; prompt: string; name?: string; ingredients?: CompositionIngredient[] }
export type BriefCompositionState = 'queued' | 'running' | 'draft_ready' | 'blocked' | 'failed' | 'cancelled';
export interface BriefCompositionJob {
  jobId: string;
  requestId: string;
  /** Original specification, not a model paraphrase. */
  specification: { name: string; prompt: string; ingredients?: CompositionIngredient[] };
  state: BriefCompositionState;
  progress: { checkedCandidates: number };
  compositionId: string | null;
  /** Creation receipt only; use the canonical workflow API for its current activation/version state. */
  workflow: { flowId: string; versionId: string } | null;
  blocker: { code: 'ingredient_unavailable' | 'insufficient_information' | 'composition_blocked' | 'composition_failed' | 'timeout' | 'interrupted' | 'cancelled'; message: string; details: string[] } | null;
  createdAt: number;
  updatedAt: number;
}
