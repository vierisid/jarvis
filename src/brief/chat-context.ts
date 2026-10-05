import { AsyncLocalStorage } from 'node:async_hooks';
import type { BriefTurnRef } from './contracts.ts';

/** Callback delivery inherits the originating turn, never whichever tab is active now. */
export interface BriefExecutionContext extends BriefTurnRef {
  signal: AbortSignal;
  progress: (phase: 'started' | 'completed' | 'failed') => void;
}
const current = new AsyncLocalStorage<BriefExecutionContext>();
export const currentBriefTurn = () => current.getStore();
export function withBriefTurn<T>(turn: BriefExecutionContext, run: () => T): T { return current.run(turn, run); }
