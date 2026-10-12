import {
  CONFLICT,
  FAILURE,
  validDetail,
  validFactId,
  validItem,
  validReceipt,
  validScope,
  type DetailRead,
  type ForgetCommand,
  type ForgetRead,
  type HistoryRead,
  type MemoryDetailPort,
  type ReadFailure,
} from "./model";
export type Panel = "correct" | "confirm" | "forget" | null;
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
  phase: "idle" | "preparing" | "pending" | "unknown";
  object: string;
  reason: string;
  message: string;
  prepared: Extract<ForgetRead, { state: "ready" }> | null;
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
  prepared: null,
});
function staleRead(
  read: DetailRead | HistoryRead | ForgetRead,
): read is ReadFailure & {
  state: "unavailable" | "missing" | "forgotten" | "conflict";
} {
  return (
    "reason" in read &&
    ["unavailable", "missing", "forgotten", "conflict"].includes(read.state)
  );
}
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
  private command: ForgetCommand | null = null;
  constructor(
    private port: MemoryDetailPort,
    private invalidateStream: () => void,
    private requestId: () => string = () => crypto.randomUUID(),
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
      this.command = null;
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
    this.command = null;
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
    this.command = null;
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
  reload() {
    if (this.state.factId && this.state.phase !== "pending")
      return this.open(this.state.factId);
  }
  private invalidate() {
    this.dirty = true;
    this.invalidateStream();
  }
  close() {
    if (this.state.phase === "pending") return false;
    this.cancel();
    this.command = null;
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
    this.publish({
      panel,
      object: read.data.fact.object,
      reason: "",
      message: "",
      prepared: null,
    });
  }
  cancelPanel() {
    if (this.state.phase === "pending" || this.state.phase === "unknown")
      return;
    this.cancel();
    this.command = null;
    this.publish({
      panel: null,
      phase: "idle",
      object: "",
      reason: "",
      message: "",
      prepared: null,
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
          result.state === "forgotten" ||
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
  async beginForget() {
    const { read, factId, phase } = this.state;
    if (
      !this.access ||
      !factId ||
      phase !== "idle" ||
      read.state !== "ready" ||
      !read.data.item.permissions.canForget
    )
      return;
    const { generation, signal } = this.start();
    this.publish({
      panel: "forget",
      phase: "preparing",
      message: "Checking this fact and its Forget scope…",
      prepared: null,
    });
    try {
      const prepared = await this.port.prepareForget(factId, signal);
      if (!this.current(generation)) return;
      if (
        prepared.state === "forgotten" &&
        "receipt" in prepared &&
        validReceipt(prepared.receipt, factId)
      ) {
        this.forgotten();
        return;
      }
      if (staleRead(prepared)) {
        this.discardRead(prepared);
        return;
      }
      if (
        prepared.state !== "ready" ||
        prepared.factId !== factId ||
        !validScope(prepared.scope) ||
        !/^[a-f0-9]{64}$/.test(prepared.revision)
      ) {
        this.publish({
          phase: "idle",
          message: "reason" in prepared ? prepared.reason : FAILURE.reason,
        });
        return;
      }
      // F17 stream revision includes usage; F19 uses a DIFFERENT source digest. Never substitute one for the other.
      const current = await this.port.read(factId, signal);
      if (!this.current(generation)) return;
      if (staleRead(current)) {
        this.discardRead(current);
        return;
      }
      if (
        current.state !== "ready" ||
        !validDetail(current.data, factId) ||
        !current.data.item.permissions.canForget ||
        current.data.item.revision !== read.data.item.revision
      ) {
        this.publish({
          phase: "idle",
          read: CONFLICT,
          history: { state: "idle" },
          message: CONFLICT.reason,
        });
        return;
      }
      this.command = {
        requestId: this.requestId(),
        expectedRevision: prepared.revision,
        confirmed: true,
      };
      this.publish({ phase: "idle", prepared, message: "" });
    } catch {
      if (this.current(generation))
        this.publish({
          phase: "idle",
          message: "Could not prepare Forget. Cancel and try again.",
        });
    }
  }
  private forgotten() {
    this.invalidate();
    this.command = null;
    this.publish({
      read: { state: "forgotten", reason: "This fact has been forgotten." },
      history: { state: "idle" },
      panel: null,
      phase: "idle",
      prepared: null,
      object: "",
      reason: "",
      message:
        "Forgotten from canonical memory. Original sources and backups remain.",
    });
  }
  async confirmForget() {
    const { factId, prepared, read } = this.state;
    if (
      !this.access ||
      this.state.phase !== "idle" ||
      this.state.panel !== "forget" ||
      !factId ||
      !prepared ||
      !this.command ||
      read.state !== "ready" ||
      !read.data.item.permissions.canForget
    )
      return;
    const { generation, signal } = this.start();
    const command = { ...this.command };
    this.invalidate();
    this.publish({ phase: "pending", message: "Forgetting this fact…" });
    try {
      const result = await this.port.forget(factId, command, signal);
      if (!this.current(generation)) return;
      if (
        result.state === "forgotten" &&
        "receipt" in result &&
        validReceipt(result.receipt, factId) &&
        result.receipt.revision === command.expectedRevision
      ) {
        this.forgotten();
        return;
      }
      if (result.state === "unknown" || result.state === "forgotten") {
        this.publish({
          phase: "unknown",
          read: {
            state: "unavailable",
            reason: "The Forget result is unknown. Check the receipt.",
          },
          history: { state: "idle" },
          message:
            "The Forget result is unknown. Check its receipt before another action.",
        });
      } else
        this.publish({
          phase: "idle",
          prepared: null,
          read: result,
          history: { state: "idle" },
          message: result.reason,
        });
    } catch {
      if (this.current(generation))
        this.publish({
          phase: "unknown",
          read: {
            state: "unavailable",
            reason: "The Forget result is unknown. Check the receipt.",
          },
          history: { state: "idle" },
          message: "The Forget result is unknown. Check its receipt.",
        });
    }
  }
  async checkForget() {
    const id = this.state.factId;
    if (
      !this.access ||
      !id ||
      this.state.phase !== "unknown" ||
      this.state.panel !== "forget"
    )
      return;
    const { generation, signal } = this.start();
    this.publish({
      phase: "preparing",
      message: "Checking the saved receipt…",
    });
    try {
      const result = await this.port.prepareForget(id, signal);
      if (!this.current(generation)) return;
      if (
        result.state === "forgotten" &&
        "receipt" in result &&
        validReceipt(result.receipt, id)
      )
        this.forgotten();
      else {
        await this.open(id);
        if (this.access && this.state.factId === id)
          this.publish({
            message:
              "No Forget receipt was recovered. Review the current fact before a new decision.",
          });
      }
    } catch {
      if (this.current(generation))
        this.publish({
          phase: "unknown",
          message: "The receipt is still unavailable. Check again later.",
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
