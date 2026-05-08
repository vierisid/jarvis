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

export class WorkflowEventBuffer {
  private readonly capacity: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly events: BufferedEvent[] = [];
  private nextId = 0;

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
      this.events.splice(0, this.events.length - this.capacity);
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

  private prune(): void {
    if (this.maxAgeMs <= 0) return;
    const cutoff = this.now() - this.maxAgeMs;
    let drop = 0;
    while (drop < this.events.length && this.events[drop]!.timestamp < cutoff) drop++;
    if (drop > 0) this.events.splice(0, drop);
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
