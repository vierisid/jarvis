/**
 * In-process pub/sub bus. Lives at the runtime level so the daemon can
 * publish observer events / commitment events into it; subscribers are the
 * legacy `jarvis-trigger:on_event` direct-subscribe path inside
 * `TriggerManager` (kept as a fallback when no engine runtime is wired) and
 * the workflow event buffer mirror used by `/v1/jarvis/events/poll`.
 *
 * Replaces the previous `JarvisEventBusAdapter` in `adapters/` (deleted with
 * the rest of the legacy adapter tree); behaviour is identical.
 */

type Handler = (payload: Record<string, unknown>) => void;

export class WorkflowEventBus {
  private readonly handlers: Map<string, Set<Handler>> = new Map();
  private onPublish: ((eventType: string, payload: Record<string, unknown>) => void) | null = null;

  subscribe(eventType: string, handler: Handler): () => void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  listEventTypes(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  /**
   * Optional observer invoked on every publish. The daemon hooks this to
   * mirror events into the `WorkflowEventBuffer` that backs
   * `/v1/jarvis/events/poll`, so engine-managed `on_event` triggers see the
   * same stream as legacy direct subscribers.
   */
  setObserver(fn: (eventType: string, payload: Record<string, unknown>) => void): void {
    this.onPublish = fn;
  }

  /** Publish from Jarvis daemon code. Errors in handlers are swallowed-and-logged. */
  publish(eventType: string, payload: Record<string, unknown>): void {
    if (this.onPublish) {
      try {
        this.onPublish(eventType, payload);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[workflow-event-bus] observer threw: ${msg}`);
      }
    }
    const set = this.handlers.get(eventType);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[workflow-event-bus] handler for "${eventType}" threw: ${msg}`);
      }
    }
  }
}
