/**
 * Event Scheduler — Round-Robin Fairness
 *
 * Processes sidecar events with round-robin scheduling across sidecars
 * to prevent any single sidecar from monopolizing event handling.
 */

import type { SidecarEvent, EventPriority } from './protocol.ts';

interface QueuedEvent {
  sidecarId: string;
  event: SidecarEvent;
  priority: EventPriority;
  enqueuedAt: number;
}

type EventHandler = (sidecarId: string, event: SidecarEvent) => Promise<void>;

/**
 * Hard cap per sidecar queue. Without it, a sidecar bursting events faster
 * than the drain rate grows its queue (and every payload on it) without
 * limit. When full, the oldest event of the lowest queued priority is
 * dropped — or the incoming event itself if it's lower-priority still.
 */
export const MAX_QUEUE_PER_SIDECAR = 500;

/**
 * Events dispatched per drain tick (round-robin across sidecars). One per
 * tick capped throughput at ~20 events/s across ALL sidecars; a batch keeps
 * the loop non-blocking while draining bursts at a useful rate.
 */
const DRAIN_BATCH_PER_TICK = 10;

/**
 * Event types the drop policy must never evict: an RPC caller is awaiting
 * these, and dropping one converts a deliverable result into an opaque
 * timeout. When the queue is full of undroppable events the cap is allowed
 * to overflow — pending-RPC tracking bounds how many can exist at once.
 */
const UNDROPPABLE_TYPES = new Set(['rpc_result', 'rpc_progress']);

/** Minimum interval between queue-overflow warn lines, per sidecar. */
const DROP_LOG_INTERVAL_MS = 5_000;

/** Drop counters for observability (mirrors WorkflowEventBuffer.dropped()). */
export interface DroppedEventsStats {
  /** Total events dropped by the overflow policy since construction. */
  count: number;
  /** Timestamp (ms) of the most recent drop. 0 when nothing was dropped. */
  lastDroppedAt: number;
  /** Per-sidecar drop counts. */
  bySidecar: Record<string, number>;
}

export class EventScheduler {
  private queues = new Map<string, QueuedEvent[]>();
  private sidecarIds: string[] = [];
  private roundRobinIndex = 0;
  private handlers = new Map<string, EventHandler[]>();
  private directTypes = new Set<string>();
  private running = false;
  private processing = false;
  private drainTimer: Timer | null = null;
  private readonly drainIntervalMs: number;
  private droppedCount = 0;
  private droppedLastAt = 0;
  private droppedBySidecar = new Map<string, number>();
  private dropLogLastAt = new Map<string, number>();
  private dropLogSuppressed = new Map<string, number>();

  constructor(drainIntervalMs = 50) {
    this.drainIntervalMs = drainIntervalMs;
  }

  /** Register a handler for a specific event_type */
  on(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  /**
   * Mark event types that bypass the round-robin queue and dispatch
   * synchronously on enqueue, in receive order. The queue drains only one
   * event per ~50 ms tick — fine for discrete events, but it would back up a
   * high-rate stream (e.g. realtime mic audio at ~25 frames/s) into seconds of
   * latency. Direct types skip the queue entirely so they stay real-time and
   * in order.
   */
  setDirectTypes(types: string[]): void {
    for (const t of types) this.directTypes.add(t);
  }

  /** Enqueue an event from a sidecar */
  enqueue(sidecarId: string, event: SidecarEvent, priority?: EventPriority): void {
    if (this.directTypes.has(event.event_type)) {
      // Bypass the queue: dispatch now, in receive order, zero added latency.
      const handlers = this.handlers.get(event.event_type) ?? [];
      const wildcardHandlers = this.handlers.get('*') ?? [];
      for (const handler of [...handlers, ...wildcardHandlers]) {
        // Handler starts synchronously (receive order); Promise.resolve routes
        // async rejections into the same log — a bare try/catch around a
        // void'ed call only sees synchronous throws.
        try {
          Promise.resolve(handler(sidecarId, event)).catch((err) => {
            console.error(`[EventScheduler] Direct handler error for ${event.event_type}:`, err);
          });
        } catch (err) {
          console.error(`[EventScheduler] Direct handler error for ${event.event_type}:`, err);
        }
      }
      return;
    }

    let queue = this.queues.get(sidecarId);
    if (!queue) {
      queue = [];
      this.queues.set(sidecarId, queue);
      this.sidecarIds.push(sidecarId);
    }

    const item: QueuedEvent = {
      sidecarId,
      event,
      priority: priority ?? event.priority ?? 'normal',
      enqueuedAt: Date.now(),
    };
    const weight = priorityWeight(item.priority);

    if (queue.length >= MAX_QUEUE_PER_SIDECAR) {
      // Candidates for eviction exclude RPC events — a caller awaits those.
      const droppable = queue.filter((q) => !UNDROPPABLE_TYPES.has(q.event.event_type));
      if (droppable.length === 0) {
        // Queue is entirely undroppable: let the cap overflow rather than
        // lose an awaited result. Pending-RPC tracking bounds this.
        if (!UNDROPPABLE_TYPES.has(event.event_type)) {
          this.recordDrop(sidecarId, item.priority, event.event_type, 'incoming');
          return;
        }
      } else {
        // Tail of the (priority-sorted) droppable set is the lowest
        // priority present.
        const tailWeight = priorityWeight(droppable[droppable.length - 1]!.priority);
        if (weight > tailWeight && !UNDROPPABLE_TYPES.has(event.event_type)) {
          // Incoming is lower priority than everything evictable — drop it.
          this.recordDrop(sidecarId, item.priority, event.event_type, 'incoming');
          return;
        }
        // Drop the oldest droppable event of the lowest priority class
        // (stale data — e.g. an old capture — is worth less than what just
        // arrived).
        const victim = droppable.find((q) => priorityWeight(q.priority) === tailWeight)!;
        queue.splice(queue.indexOf(victim), 1);
        this.recordDrop(sidecarId, victim.priority, victim.event.event_type, 'queued');
      }
    }

    // Insert in priority order, after existing items of the same priority
    // (stable FIFO within a class). Replaces the previous push+sort, which
    // re-sorted the whole queue on every enqueue.
    let insertAt = queue.length;
    while (insertAt > 0 && priorityWeight(queue[insertAt - 1]!.priority) > weight) {
      insertAt--;
    }
    queue.splice(insertAt, 0, item);
  }

  /** Drop counters since construction. Not persisted. */
  dropped(): DroppedEventsStats {
    return {
      count: this.droppedCount,
      lastDroppedAt: this.droppedLastAt,
      bySidecar: Object.fromEntries(this.droppedBySidecar),
    };
  }

  private recordDrop(
    sidecarId: string,
    priority: EventPriority,
    eventType: string,
    which: 'incoming' | 'queued',
  ): void {
    this.droppedCount++;
    this.droppedLastAt = Date.now();
    this.droppedBySidecar.set(sidecarId, (this.droppedBySidecar.get(sidecarId) ?? 0) + 1);

    // Rate-limit the log: an overflow burst is hundreds of drops per second,
    // and one warn per drop would flood the journal.
    const now = Date.now();
    const lastLog = this.dropLogLastAt.get(sidecarId) ?? 0;
    if (now - lastLog < DROP_LOG_INTERVAL_MS) {
      this.dropLogSuppressed.set(sidecarId, (this.dropLogSuppressed.get(sidecarId) ?? 0) + 1);
      return;
    }
    const suppressed = this.dropLogSuppressed.get(sidecarId) ?? 0;
    this.dropLogLastAt.set(sidecarId, now);
    this.dropLogSuppressed.set(sidecarId, 0);
    const suffix = suppressed > 0 ? ` (+${suppressed} more since last log)` : '';
    console.warn(
      `[EventScheduler] Queue full for ${sidecarId}, dropped ${which} ${priority} ${eventType}${suffix}`,
    );
  }

  /** Remove a sidecar's queue (on disconnect) */
  removeSidecar(sidecarId: string): void {
    this.dropLogLastAt.delete(sidecarId);
    this.dropLogSuppressed.delete(sidecarId);
    this.queues.delete(sidecarId);
    this.sidecarIds = this.sidecarIds.filter(id => id !== sidecarId);
    if (this.roundRobinIndex >= this.sidecarIds.length) {
      this.roundRobinIndex = 0;
    }
  }

  /** Start the processing loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.drainTimer = setInterval(() => this.drain(), this.drainIntervalMs);
  }

  /** Stop the processing loop */
  stop(): void {
    this.running = false;
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private async drain(): Promise<void> {
    if (this.processing || this.sidecarIds.length === 0) return;
    this.processing = true;

    try {
      // Up to DRAIN_BATCH_PER_TICK events per tick, round-robin across
      // sidecars so no single sidecar monopolizes the batch.
      for (let dispatched = 0; dispatched < DRAIN_BATCH_PER_TICK; dispatched++) {
        const item = this.nextItem();
        if (!item) break;
        await this.dispatch(item);
      }
    } catch (err) {
      console.error('[EventScheduler] Drain error:', err);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Round-robin pick: next non-empty queue after the last-served sidecar.
   * Re-reads sidecarIds each call — dispatch() awaits handlers, and a
   * sidecar may disconnect (removeSidecar) while one is in flight.
   */
  private nextItem(): QueuedEvent | null {
    const count = this.sidecarIds.length;
    for (let i = 0; i < count; i++) {
      const idx = (this.roundRobinIndex + i) % count;
      const queue = this.queues.get(this.sidecarIds[idx]!);
      if (!queue || queue.length === 0) continue;
      this.roundRobinIndex = (idx + 1) % count;
      return queue.shift()!;
    }
    return null;
  }

  private async dispatch(item: QueuedEvent): Promise<void> {
    const handlers = this.handlers.get(item.event.event_type) ?? [];
    const wildcardHandlers = this.handlers.get('*') ?? [];
    const allHandlers = [...handlers, ...wildcardHandlers];

    for (const handler of allHandlers) {
      try {
        await handler(item.sidecarId, item.event);
      } catch (err) {
        console.error(`[EventScheduler] Handler error for ${item.event.event_type}:`, err);
      }
    }
  }
}

function priorityWeight(p: EventPriority): number {
  switch (p) {
    case 'critical': return 0;
    case 'high': return 1;
    case 'normal': return 2;
    case 'low': return 3;
  }
}
