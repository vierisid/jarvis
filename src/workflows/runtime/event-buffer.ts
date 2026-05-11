/**
 * In-memory recent-events buffer that backs the `/v1/jarvis/events/poll`
 * route used by the `jarvis-trigger:on_event` polling trigger.
 *
 * The daemon's existing `JarvisEventBusAdapter` is publish/subscribe; this
 * buffer is a side-track that captures every published event with a
 * monotonic id. The trigger persists its `since` cursor (the highest id
 * delivered) and asks for events newer than that, optionally narrowed by
 * `eventType` and a shallow-equality `filter`.
 *
 * Bounded: keeps at most `capacity` entries, dropping the oldest. Events
 * older than `maxAgeMs` are pruned on every poll. Both knobs default to
 * conservative values (10 000 events, 1 hour); the polling trigger's
 * default cadence is 1 minute so the buffer rarely fills.
 */

export interface BufferedEvent {
  id: number;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface WorkflowEventBufferOptions {
  capacity?: number;
  maxAgeMs?: number;
  now?: () => number;
}

export interface DroppedEventsSignal {
  /** Total count of events evicted by capacity overflow or age pruning since the buffer started. */
  count: number;
  /** Timestamp (ms) of the most recent drop. 0 when nothing has been dropped. */
  lastDroppedAt: number;
  /**
   * Highest id seen at the time of the most recent drop. Triggers can
   * compare against their persisted `since` cursor to know whether the
   * drop covered events they hadn't yet polled (event might be missed) or
   * only events they'd already consumed (no impact).
   */
  lastDroppedHeadId: number;
}

export class WorkflowEventBuffer {
  private readonly capacity: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly events: BufferedEvent[] = [];
  private nextId = 0;
  /**
   * Eviction counter. Increments when `publish` overflows the capacity or
   * `prune` ages events out. Surfaced via `dropped()` so the polling
   * trigger / dashboard can warn when the buffer might have lost events
   * a polling trigger hadn't yet consumed. Resets on construction; not
   * persisted.
   */
  private droppedCount = 0;
  private droppedLastAt = 0;
  private droppedLastHeadId = 0;

  constructor(opts: WorkflowEventBufferOptions = {}) {
    this.capacity = opts.capacity ?? 10_000;
    this.maxAgeMs = opts.maxAgeMs ?? 60 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Append an event. Returns the assigned id so callers can correlate (most
   * just ignore it -- the buffer is fire-and-forget from the publish side).
   */
  publish(eventType: string, payload: Record<string, unknown>): number {
    this.prune();
    const id = ++this.nextId;
    this.events.push({ id, eventType, payload, timestamp: this.now() });
    if (this.events.length > this.capacity) {
      const excess = this.events.length - this.capacity;
      this.events.splice(0, excess);
      this.recordDropped(excess);
    }
    return id;
  }

  /**
   * Read events newer than `since` matching `eventType` and (optional)
   * shallow-equality `filter`. Returns the matched events plus the buffer's
   * current head id (whether or not any matched). Caller persists the head
   * as the next `since`.
   *
   * `headOnly` returns `{events: [], cursor: head}` without any filtering --
   * used by the trigger's `onEnable` to seed its initial cursor without
   * delivering historical events.
   */
  poll(req: {
    eventType: string;
    filter?: Record<string, unknown>;
    since?: number;
    headOnly?: boolean;
  }): { events: BufferedEvent[]; cursor: number } {
    this.prune();
    const head = this.nextId;
    if (req.headOnly) return { events: [], cursor: head };
    const since = typeof req.since === "number" && Number.isFinite(req.since) ? req.since : 0;
    const matchFilter = makeShallowEq(req.filter);
    const matched: BufferedEvent[] = [];
    for (const ev of this.events) {
      if (ev.id <= since) continue;
      if (ev.eventType !== req.eventType) continue;
      if (!matchFilter(ev.payload)) continue;
      matched.push(ev);
    }
    return { events: matched, cursor: head };
  }

  /** Test/debug accessor. */
  size(): number {
    return this.events.length;
  }

  /**
   * Returns the running overflow/eviction signal. Callers (the TriggerManager
   * surface, the dashboard) use this to warn when events may have been
   * dropped between two polls -- e.g. a polling trigger that hasn't fired
   * for an hour while the buffer churned through hundreds of unrelated
   * events.
   */
  dropped(): DroppedEventsSignal {
    return {
      count: this.droppedCount,
      lastDroppedAt: this.droppedLastAt,
      lastDroppedHeadId: this.droppedLastHeadId,
    };
  }

  private recordDropped(n: number): void {
    if (n <= 0) return;
    this.droppedCount += n;
    this.droppedLastAt = this.now();
    this.droppedLastHeadId = this.nextId;
  }

  private prune(): void {
    if (this.maxAgeMs <= 0) return;
    const cutoff = this.now() - this.maxAgeMs;
    let drop = 0;
    while (drop < this.events.length && this.events[drop]!.timestamp < cutoff) drop++;
    if (drop > 0) {
      this.events.splice(0, drop);
      this.recordDropped(drop);
    }
  }
}

function makeShallowEq(filter?: Record<string, unknown>): (payload: Record<string, unknown>) => boolean {
  if (!filter) return () => true;
  const entries = Object.entries(filter);
  if (entries.length === 0) return () => true;
  return (payload) => {
    for (const [k, v] of entries) {
      if (payload[k] !== v) return false;
    }
    return true;
  };
}
