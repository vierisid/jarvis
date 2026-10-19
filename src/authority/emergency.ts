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
   * (#987 left whether Pause should cancel it to the owner).
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
