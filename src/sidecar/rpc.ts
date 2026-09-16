/**
 * RPC Tracker — Two-Timeout State Machine
 *
 * Tracks outbound RPC requests with an initial timeout (fast ack)
 * and a max timeout (detached execution). Resolves promises accordingly.
 */

import type { RPCState, RPCTimeouts, RPCRequest } from './protocol.ts';
import { DEFAULT_RPC_TIMEOUTS } from './protocol.ts';

/** A reply from the remote handler, as distinct from a lost connection. */
export class SidecarRPCError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SidecarRPCError';
  }
}

export interface PendingRPC {
  id: string;
  sidecarId: string;
  method: string;
  state: RPCState;
  createdAt: number;
  /** Resolves the dispatch() promise. For pending: result value. For detached: "detached" string. */
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  initialTimer: Timer | null;
  maxTimer: Timer | null;
  /** Callback invoked when a detached RPC completes */
  detachedCallback?: (rpcId: string, result: unknown) => void;
}

export type DetachedCompleteCallback = (rpcId: string, result: unknown, error?: Error) => void;

export class RPCTracker {
  private pending = new Map<string, PendingRPC>();
  private detachedCallback: DetachedCompleteCallback | null = null;

  /** Register a global callback for when detached RPCs complete */
  onDetachedComplete(callback: DetachedCompleteCallback): void {
    this.detachedCallback = callback;
  }

  /**
   * Dispatch an RPC: creates a tracked entry, sets initial timer.
   * Returns the result if it arrives within initial_timeout, or "detached" if it transitions.
   */
  dispatch(
    rpcId: string,
    sidecarId: string,
    method: string,
    timeouts: RPCTimeouts = DEFAULT_RPC_TIMEOUTS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry: PendingRPC = {
        id: rpcId,
        sidecarId,
        method,
        state: 'pending',
        createdAt: Date.now(),
        resolve,
        reject,
        initialTimer: null,
        maxTimer: null,
      };

      // Initial timeout: transition to DETACHED
      entry.initialTimer = setTimeout(() => {
        if (entry.state !== 'pending') return;

        entry.state = 'detached';
        entry.initialTimer = null;

        // Resolve the dispatch promise with "detached"
        resolve('detached');

        // Start max timeout
        entry.maxTimer = setTimeout(() => {
          if (entry.state !== 'detached') return;
          entry.state = 'timed_out';
          this.pending.delete(rpcId);
          console.warn(`[RPCTracker] RPC ${rpcId} (${method}) timed out after max timeout`);
        }, timeouts.max);
      }, timeouts.initial);

      this.pending.set(rpcId, entry);
    });
  }

  /** Called when an rpc_result event arrives. Resolves/rejects the RPC. */
  resolve(rpcId: string, result: unknown): void {
    const entry = this.pending.get(rpcId);
    if (!entry) return;

    this.clearTimers(entry);

    if (entry.state === 'pending') {
      // Fast path: result arrived within initial timeout
      entry.state = 'completed';
      entry.resolve(result);
    } else if (entry.state === 'detached') {
      // Late arrival: dispatch promise already resolved with "detached"
      entry.state = 'completed';
      this.detachedCallback?.(rpcId, result);
    }

    this.pending.delete(rpcId);
  }

  /** Called when an rpc_result with error arrives. */
  fail(rpcId: string, error: Error): void {
    const entry = this.pending.get(rpcId);
    if (!entry) return;

    this.clearTimers(entry);

    if (entry.state === 'pending') {
      entry.state = 'failed';
      entry.reject(error);
    } else if (entry.state === 'detached') {
      entry.state = 'failed';
      this.detachedCallback?.(rpcId, undefined, error);
    }

    this.pending.delete(rpcId);
  }

  /** Fail all pending RPCs for a disconnected sidecar */
  failAll(sidecarId: string, reason: string): void {
    for (const [rpcId, entry] of this.pending) {
      if (entry.sidecarId !== sidecarId) continue;

      this.clearTimers(entry);

      const error = new Error(`Sidecar disconnected: ${reason}`);
      if (entry.state === 'pending') {
        entry.state = 'failed';
        entry.reject(error);
      } else if (entry.state === 'detached') {
        entry.state = 'failed';
        this.detachedCallback?.(rpcId, undefined, error);
      }

      this.pending.delete(rpcId);
    }
  }

  /** Get a pending RPC by ID */
  get(rpcId: string): PendingRPC | undefined {
    return this.pending.get(rpcId);
  }

  /** Get count of pending RPCs */
  get size(): number {
    return this.pending.size;
  }

  private clearTimers(entry: PendingRPC): void {
    if (entry.initialTimer) {
      clearTimeout(entry.initialTimer);
      entry.initialTimer = null;
    }
    if (entry.maxTimer) {
      clearTimeout(entry.maxTimer);
      entry.maxTimer = null;
    }
  }
}
