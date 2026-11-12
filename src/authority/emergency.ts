/**
 * Emergency controls: pause and kill switch.
 */

export type EmergencyState = 'normal' | 'paused' | 'killed';

export class EmergencyController {
  private state: EmergencyState = 'normal';
  private onStateChange: ((state: EmergencyState) => void) | null = null;
  /** Everything else that acts on a state change (#987); see `subscribe`. */
  private listeners = new Set<(state: EmergencyState) => void>();

  getState(): EmergencyState {
    return this.state;
  }

  /**
   * Pause: freeze all agent tool execution. Agents can still receive messages
   * but all tools return [SYSTEM PAUSED]. A background task already running
   * is NOT stopped: its loop keeps calling the model with every tool refused
   * (#987 left whether Pause should cancel it to the owner). With
   * `setPauseHoldsLoops(true)` its next model call waits for Resume instead
   * (`whenRunnable`): held, not cancelled.
   */
  pause(): void {
    if (this.state === 'killed') return; // Can't pause from killed
    this.state = 'paused';
    this.notify();
    console.log('[EmergencyController] System PAUSED — all tool execution suspended');
  }

  /**
   * Resume from paused state.
   */
  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'normal';
    this.notify();
    console.log('[EmergencyController] System RESUMED — tool execution restored');
  }

  /**
   * Kill: refuse every tool call and every new agent, and stop every
   * sub-agent loop run under this controller (#987). The task manager
   * subscribes and aborts its `manage_agents` tasks, model call in flight
   * included; any other sub-agent run (`delegate_task`, a workflow
   * delegation) stops at its next fence in `runSubAgent`. The orchestrator's
   * own loops are NOT stopped: a chat turn, a background-agent turn and a
   * conversation-tier task keep calling the model with every tool refused.
   * Requires explicit reset() to recover. The daemon also stops
   * unfinished workflow runs and denies pending cards except Stop agent cards
   * (Q-08). Tool dispatch stops at its next checkpoint.
   */
  kill(): void {
    this.state = 'killed';
    this.notify();
    console.log('[EmergencyController] System KILLED - tools refused, sub-agent runs stopped');
  }

  /**
   * Reset from killed state back to normal.
   */
  reset(): void {
    if (this.state !== 'killed') return;
    this.state = 'normal';
    this.notify();
    console.log('[EmergencyController] System RESET — back to normal');
  }

  /**
   * Check if tool execution is allowed.
   */
  canExecute(): boolean {
    return this.state === 'normal';
  }

  setStateChangeCallback(cb: (state: EmergencyState) => void): void {
    this.onStateChange = cb;
  }

  /**
   * Be told of every state change, alongside the one persistence callback.
   * Returns the unsubscribe function. A listener that throws is logged and
   * does not stop the others: Kill must reach every task it stops.
   */
  subscribe(listener: (state: EmergencyState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (err) {
        console.error('[EmergencyController] state listener failed:', err instanceof Error ? err.message : err);
      }
    }
    this.onStateChange?.(this.state);
  }
}

let active: EmergencyController | null = null;

/**
 * The daemon's controller, for enforcement points it does not hand one to:
 * tool dispatch, the workflow worker, triggers and continuations (Q-08).
 */
export function setActiveEmergencyController(controller: EmergencyController | null): void {
  active = controller;
}

/** The active controller's state; normal when none is wired (tests, tools). */
export function activeEmergencyState(): EmergencyState {
  return active?.getState() ?? 'normal';
}

/** Thrown into a held model call when Jarvis is stopped with Kill while it waits. */
export class HeldCallStopped extends Error {
  constructor() {
    super('[SYSTEM KILLED] Jarvis was stopped while this work was held by a pause, so it was not carried on.');
    this.name = 'HeldCallStopped';
  }
}

let pauseHoldsLoops = false;

/**
 * Whether Pause also holds the model loops (see `whenRunnable`). Off unless
 * the daemon turns it on: #987 left that choice to the owner, and it is made
 * together with the surface that lets the person stop everything at once.
 */
export function setPauseHoldsLoops(on: boolean): void {
  pauseHoldsLoops = on;
}

/**
 * Resolves when background work may make its next model call: at once when
 * Jarvis is running, and after Resume when it is paused. This is what makes
 * Pause stop the loops that it otherwise only starves: a paused loop is told
 * no by every tool, asks the model what to do about that, and can go round
 * up to its iteration limit spending the whole way. Held here it makes no
 * call at all until Resume, and then carries on from where it was.
 *
 * Rejects with `HeldCallStopped` when Jarvis is stopped with Kill while it
 * waits, and with the signal's reason when the caller gives up.
 *
 * Nothing is held unless `setPauseHoldsLoops(true)` was called, so with it
 * off Pause is exactly what it was. What is held lives in memory: a brain
 * restarted while paused comes back paused, with the held work gone.
 */
export function whenRunnable(signal?: AbortSignal): Promise<void> {
  const controller = active;
  if (!pauseHoldsLoops || !controller || controller.getState() !== 'paused') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let off: () => void = () => {};
    const onAbort = (): void => { finish(() => reject(signal?.reason ?? new Error('aborted'))); };
    const finish = (settle: () => void): void => {
      off();
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    off = controller.subscribe((state) => {
      if (state === 'normal') finish(resolve);
      else if (state === 'killed') finish(() => reject(new HeldCallStopped()));
    });
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
