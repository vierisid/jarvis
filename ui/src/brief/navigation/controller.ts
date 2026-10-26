import { isBriefCapabilityEnabled } from "../../../../src/brief/capabilities";
import { destination, roomIntent, type DestinationId, type NavigationTarget, type Resolution, type RoomAvailability } from "./destinations";

export interface NavigationHost {
  /** A room is ready only when its real Body and required providers are mounted. */
  roomAvailable: RoomAvailability;
  /** Shared Profile/Settings dirty-draft guard. Resolve false on cancel. No navigation inside this callback. */
  canLeave(signal: AbortSignal): Promise<boolean>;
  /** Synchronous commit after the guard and the final abort/access check. */
  commit(target: NavigationTarget): void;
  explain(message: string): void;
}
export type NavigationResult = { state: "opened" | "unavailable" | "cancelled" };

/** One host/account lifetime; no socket, storage, API, room writer, or action acknowledgement. */
export class NavigationCompatibility {
  private enabled = false;
  private retired = false;
  private pending?: AbortController;
  constructor(private readonly host: NavigationHost) {}
  setAccess(snapshot: unknown) {
    this.enabled = !this.retired && isBriefCapabilityEnabled(snapshot, "navigationCompatibility");
    if (!this.enabled) this.pending?.abort();
  }
  available() { return this.enabled && !this.retired; }
  retire() { this.retired = true; this.enabled = false; this.pending?.abort(); }
  navigate(id: DestinationId, signal?: AbortSignal) {
    return this.open(() => destination(id, this.host.roomAvailable), signal);
  }
  intent(key: string, hasRoomAction = true, signal?: AbortSignal) {
    return this.open(() => roomIntent(key, this.host.roomAvailable, hasRoomAction), signal);
  }
  async open(resolve: () => Resolution, signal?: AbortSignal): Promise<NavigationResult> {
    if (!this.available() || signal?.aborted) return { state: "unavailable" };
    this.pending?.abort();
    const pending = this.pending = new AbortController();
    const abort = () => pending.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (!await this.host.canLeave(pending.signal)) return { state: "cancelled" };
      if (!this.available() || pending.signal.aborted) return { state: "cancelled" };
      // Resolve after the guard: providers may have disappeared while a draft dialog was open.
      const result = resolve();
      this.host.commit(result.target);
      if (result.message) this.host.explain(result.message);
      return { state: "opened" };
    } catch {
      if (this.available() && !pending.signal.aborted) this.host.explain("This destination could not be opened. Your current view is still available.");
      return { state: "unavailable" };
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.pending === pending) this.pending = undefined;
    }
  }
}

/** D-27/D-28 use result-bearing callbacks and AbortSignal; never acknowledge a cancelled handoff. */
export function destinationPort(navigation: NavigationCompatibility) {
  return {
    navigate: async (id: DestinationId, signal?: AbortSignal): Promise<{ state: "opened" | "unavailable" }> => {
      const result = await navigation.navigate(id, signal);
      return { state: result.state === "opened" ? "opened" : "unavailable" };
    },
    /** D-30 callbacks signal failure by rejecting. */
    callback: (id: DestinationId) => async () => {
      const result = await navigation.navigate(id);
      if (result.state !== "opened") throw new Error("Navigation did not open");
    },
  };
}
