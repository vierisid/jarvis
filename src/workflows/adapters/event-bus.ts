/**
 * Adapter: PieceEventBus.
 *
 * Status: in-process pub/sub only. The Jarvis EventReactor (M5/M13) is
 * classification-driven and does not yet expose a generic subscribe API.
 * Wiring this through requires extending the reactor with a typed event
 * stream, which is its own piece of work. For now this adapter offers an
 * in-process bus that anyone in the daemon can publish into; the Jarvis
 * services can be connected to it incrementally (`bus.publish("awareness.context_changed", ...)`).
 *
 * When the Jarvis side is ready, the bus can be re-implemented to subscribe
 * to the reactor without changing the piece-side surface.
 */

import type { PieceEventBus } from "../jarvis-pieces/types";

type Handler = (payload: Record<string, unknown>) => void;

export class JarvisEventBusAdapter implements PieceEventBus {
  private readonly handlers: Map<string, Set<Handler>> = new Map();

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

  /** Publish from Jarvis daemon code. Errors in handlers are swallowed-and-logged. */
  publish(eventType: string, payload: Record<string, unknown>): void {
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
