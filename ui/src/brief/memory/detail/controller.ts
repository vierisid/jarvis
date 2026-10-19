import {
  CONFLICT,
  FAILURE,
  validDetail,
  validFactId,
  validItem,
  type DetailRead,
  type HistoryRead,
  type MemoryDetailPort,
  type ReadFailure,
} from "./model";
export type Panel = "correct" | "confirm" | null;
export interface ReturnOrigin {
  factId: string;
  ids: string[];
  offset: number;
  scrollTop: number;
  sentence?: { left: number; top: number };
}
export interface DetailState {
  factId: string | null;
  /** Successful correction awaiting route acknowledgment, retained across room remounts. */
  replacement: { from: string; to: string } | null;
  read: DetailRead | { state: "loading" | "idle" };
  history: HistoryRead | { state: "idle" | "loading" };
  panel: Panel;
  phase: "idle" | "pending" | "unknown";
  object: string;
  reason: string;
  message: string;
}
const empty = (): DetailState => ({
  factId: null,
  replacement: null,
  read: { state: "idle" },
  history: { state: "idle" },
  panel: null,
  phase: "idle",
  object: "",
  reason: "",
  message: "",
});
function staleRead(read: DetailRead | HistoryRead): read is ReadFailure & {
  state: "unavailable" | "missing" | "conflict";
} {
  return (
    "reason" in read &&
    ["unavailable", "missing", "conflict"].includes(read.state)
  );
}
export const UNSAVED_MESSAGE =
  "You have an unsaved edit. Save it or choose Cancel before leaving this memory.";
/** One instance per authenticated scope, retained beside the stream controller across routes. */
export class MemoryDetailController {
  readonly source;
  readonly scopeId;
  origin: ReturnOrigin | null = null;
  returnId: string | null = null;
  returnPending = false;
  dirty = false;
  private state = empty();
  private listeners = new Set<() => void>();
  private generation = 0;
  private historyGeneration = 0;
  private abort?: AbortController;
  private historyAbort?: AbortController;
  private access = false;
  private alive = true;
  /** Canonical value the open editor started from. */
  private baseline = "";
  constructor(
    private port: MemoryDetailPort,
    private invalidateStream: () => void,
  ) {
    this.source = port.source;
    this.scopeId = port.scopeId;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<DetailState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private cancel() {
    this.generation++;
    this.historyGeneration++;
    this.abort?.abort();
    this.historyAbort?.abort();
    // Callers publish their next state synchronously; batch cancellation with that update.
    if (this.state.history.state === "loading")
      this.state = { ...this.state, history: { state: "idle" } };
  }
  private start() {
    this.cancel();
    this.abort = new AbortController();
    return { generation: this.generation, signal: this.abort.signal };
  }
  private current(generation: number) {
    return this.alive && this.access && this.generation === generation;
  }
  setAccess(value: boolean) {
    if (!this.alive || value === this.access) return;
    this.access = value;
    if (!value) {
      this.cancel();
      this.origin = null;
      this.returnId = null;
      this.returnPending = false;
      this.publish({
        ...empty(),
        read: { state: "unavailable", reason: "Memory access ended." },
      });
    }
  }
  open(id: string) {
    return this.load(id, null);
  }
  acknowledgeRoute(id: string) {
    if (this.state.replacement?.to === id) this.publish({ replacement: null });
  }
  private discardRead(read: ReadFailure) {
    this.cancel();
    this.invalidate();
    this.publish({
      ...empty(),
      factId: this.state.factId,
      replacement: this.state.replacement,
      read,
    });
  }
  private async load(id: string, replacement: DetailState["replacement"]) {
    if (!this.access || !this.alive) return;
    const { generation, signal } = this.start();
    this.publish({
      ...empty(),
      factId: id,
      replacement,
      read: { state: "loading" },
    });
    try {
      const read = validFactId(id) ? await this.port.read(id, signal) : FAILURE;
      if (!this.current(generation)) return;
      if (staleRead(read)) {
        this.discardRead(read);
        return;
      }
      this.publish({
        read:
          read.state === "ready" && !validDetail(read.data, id)
            ? FAILURE
            : read,
      });
    } catch {
      if (this.current(generation))
        this.publish({
          read: {
            state: "error",
            reason: "Could not load this fact. Reload to try again.",
          },
        });
    }
  }
  /** Re-read the fact. A conflicted draft survives so it can be reapplied to the fresh value. */
  async reload() {
    const { factId, phase, panel, object, reason } = this.state;
    if (!factId || phase === "pending") return;
    const draft =
      phase === "idle" && this.unsaved() ? { panel, object, reason } : null;
    await this.load(factId, null);
    const read = this.state.read;
    if (
      draft &&
      this.access &&
      this.state.factId === factId &&
      read.state === "ready" &&
      read.data.item.permissions.canCorrect &&
      read.data.item.status !== "superseded"
    )
      this.publish({
        ...draft,
        message:
          "Reloaded the current value. Your unsaved edit is kept; review it before saving.",
      });
  }
  private invalidate() {
    this.dirty = true;
    this.invalidateStream();
  }
  /** An open editor whose text differs from the canonical value it started from. */
  unsaved() {
    const { panel, phase, object, reason } = this.state;
    // After an unknown save result the draft was already submitted; reload decides its fate.
    if (!panel || phase === "unknown") return false;
    return !!reason.trim() || (panel === "correct" && object !== this.baseline);
  }
  /** Leaving never drops an unsaved edit silently: the editor stays and says why. */
  canLeave() {
    if (this.state.phase === "pending") return false;
    if (!this.unsaved()) return true;
    this.publish({ message: UNSAVED_MESSAGE });
    return false;
  }
  close() {
    if (!this.canLeave()) return false;
    this.cancel();
    this.returnPending = true;
    this.publish(empty());
    return true;
  }
  setDraft(patch: { object?: string; reason?: string }) {
    if (!this.access || this.state.phase !== "idle") return;
    this.publish({ ...patch, message: "" });
  }
  begin(panel: "correct" | "confirm") {
    const read = this.state.read;
    if (
      !this.access ||
      this.state.phase !== "idle" ||
      read.state !== "ready" ||
      !read.data.item.permissions.canCorrect ||
      read.data.item.status === "superseded"
    )
      return;
    this.baseline = read.data.fact.object;
    this.publish({
      panel,
      object: read.data.fact.object,
      reason: "",
      message: "",
    });
  }
  cancelPanel() {
    if (this.state.phase === "pending" || this.state.phase === "unknown")
      return;
    this.cancel();
    this.publish({
      panel: null,
      phase: "idle",
      object: "",
      reason: "",
      message: "",
    });
  }
  async loadHistory() {
    const id = this.state.factId;
    if (!this.access || !id || this.state.read.state !== "ready") return;
    const generation = ++this.historyGeneration;
    this.historyAbort?.abort();
    this.historyAbort = new AbortController();
    this.publish({ history: { state: "loading" } });
    try {
      const history = await this.port.history(id, this.historyAbort.signal);
      if (!this.access || !this.alive || generation !== this.historyGeneration)
        return;
      if (staleRead(history)) {
        this.discardRead(history);
        return;
      }
      this.publish({
        history:
          history.state === "ready" &&
          (!history.items.every(validItem) ||
            history.items.length > 100 ||
            !history.items.some((item) => item.factId === id))
            ? FAILURE
            : history,
      });
    } catch {
      if (this.access && this.alive && generation === this.historyGeneration)
        this.publish({ history: FAILURE });
    }
  }
  async save() {
    const { read, panel, phase, object, reason, factId } = this.state;
    if (
      !this.access ||
      phase !== "idle" ||
      (panel !== "confirm" && panel !== "correct") ||
      read.state !== "ready" ||
      !factId ||
      !read.data.item.permissions.canCorrect ||
      read.data.item.status === "superseded"
    )
      return;
    if (
      !reason.trim() ||
      reason.length > 1000 ||
      (panel === "correct" && (!object.trim() || object.length > 4000))
    ) {
      this.publish({
        message:
          "Enter a reason (up to 1,000 characters) and a value (up to 4,000 characters).",
      });
      return;
    }
    const { generation, signal } = this.start();
    this.invalidate();
    this.publish({ phase: "pending", message: "Saving the confirmed value…" });
    try {
      const result = await this.port.decide(
        {
          kind: panel,
          factId,
          revision: read.data.item.revision,
          object,
          reason,
        },
        signal,
      );
      if (!this.current(generation)) return;
      if (result.state === "saved" && validFactId(result.factId)) {
        this.returnId = result.factId;
        await this.load(
          result.factId,
          result.factId === factId ? null : { from: factId, to: result.factId },
        );
        if (this.access && this.state.factId === result.factId)
          this.publish({
            message:
              "Confirmed value saved. Earlier evidence remains in its history.",
          });
      } else if (result.state === "unknown" || result.state === "saved") {
        this.publish({
          phase: "unknown",
          read: {
            state: "unavailable",
            reason: "The save result is unknown. Reload the current fact.",
          },
          history: { state: "idle" },
          message:
            "The save result is unknown. Reload the current fact before another action.",
        });
      } else {
        // Keep the draft and geometry on a definite rejection. A conflict requires a fresh read.
        this.publish({
          phase: "idle",
          message: result.reason,
          ...(result.state === "conflict" ||
          result.state === "missing" ||
          result.state === "unavailable"
            ? { read: result, history: { state: "idle" } as const }
            : {}),
        });
      }
    } catch {
      if (this.current(generation))
        this.publish({
          phase: "unknown",
          read: {
            state: "unavailable",
            reason: "The save result is unknown. Reload the current fact.",
          },
          history: { state: "idle" },
          message: "Reload the current fact before another action.",
        });
    }
  }
  retire() {
    this.setAccess(false);
    this.alive = false;
    this.cancel();
    this.listeners.clear();
  }
}
