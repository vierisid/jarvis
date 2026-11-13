import { AsyncLocalStorage } from 'node:async_hooks';
import type { BriefTurnRef } from './contracts.ts';

/** Callback delivery inherits the originating turn, never whichever tab is active now. */
export interface BriefExecutionContext extends BriefTurnRef {
  signal: AbortSignal;
  progress: (phase: 'started' | 'completed' | 'failed') => void;
  /**
   * Set when the turn has ended. Work it left running (a timer, a promise
   * nobody waited for) still carries this context, so that what it delivers
   * finds its way back; it does not carry the turn's standing. What a person
   * allowed by asking, they allowed for the asking, not for whatever runs
   * afterwards (authority/app-open.ts, authority/owner-word.ts).
   */
  over?: boolean;
}
const current = new AsyncLocalStorage<BriefExecutionContext>();
export const currentBriefTurn = () => current.getStore();
export function withBriefTurn<T>(turn: BriefExecutionContext, run: () => T): T { return current.run(turn, run); }
/** Detached work (a background agent task) outlives the turn that started it and reports on its own. */
export function outsideBriefTurn<T>(run: () => T): T { return current.exit(run); }
