import type { BriefReadState } from "../../contracts";
import {
  validateList,
  validateWorkflow,
  validateResult,
  type ManagedWorkflow,
  type ManageCommand,
  type ManageResult,
  type RemovalReceipt,
  type WorkflowManagementPort,
} from "./model";
export interface ManagementSlot {
  item: ManagedWorkflow;
  removed: boolean;
  confirming: boolean;
  phase: "idle" | "pending" | "uncertain";
  command: ManageCommand | null;
  receipt: RemovalReceipt | null;
  message: string | null;
}
export interface ManagementState {
  read: BriefReadState<null>;
  rows: ManagementSlot[];
  access: boolean;
  refreshing: boolean;
  selectedId: string | null;
  scrollTop: number;
}
const slot = (item: ManagedWorkflow): ManagementSlot => ({
  item,
  removed: false,
  confirming: false,
  phase: "idle",
  command: null,
  receipt: null,
  message: null,
});
/** One owner-scoped instance survives room/shell changes. Retire on logout or
 * owner replacement. An uncertain command can ONLY be cleared by reconciliation. */
export class WorkflowManagementController {
  private state: ManagementState = {
    read: { status: "loading" },
    rows: [],
    access: false,
    refreshing: false,
    selectedId: null,
    scrollTop: 0,
  };
  private listeners = new Set<() => void>();
  private sequence = 0;
  private abort: AbortController | null = null;
  private loaded = false;
  active = true;
  constructor(
    readonly scopeId: string,
    readonly source: "live" | "fixture",
    private port: WorkflowManagementPort,
    private clock: () => number = Date.now,
    private requestId: () => string = () => crypto.randomUUID(),
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.state;
  private publish(patch: Partial<ManagementState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private patch(id: string, patch: Partial<ManagementSlot>) {
    this.publish({
      rows: this.state.rows.map((r) =>
        r.item.flowId === id ? { ...r, ...patch } : r,
      ),
    });
  }
  setAccess(value: boolean) {
    if (value !== this.state.access) this.publish({ access: value });
  }
  savePosition(top: number, selectedId = this.state.selectedId) {
    this.publish({ scrollTop: Math.max(0, top), selectedId });
  }
  get hasUnresolved() {
    return this.state.rows.some((r) => r.phase !== "idle");
  }
  get canRefresh() {
    return this.active && this.state.access && !this.hasUnresolved;
  }
  getRow(id: string) {
    return this.state.rows.find((r) => r.item.flowId === id);
  }
  canChange(id: string) {
    const r = this.getRow(id);
    return (
      this.active &&
      this.state.access &&
      !!this.port.change &&
      (this.state.read.status === "ready" ||
        (this.state.read.status === "empty" && r?.removed)) &&
      !!r &&
      r.phase === "idle"
    );
  }
  canReconcile(id: string) {
    return (
      this.active &&
      this.state.access &&
      !!this.port.reconcile &&
      this.getRow(id)?.phase === "uncertain"
    );
  }
  async load() {
    if (!this.loaded) await this.refresh();
  }
  async refresh() {
    if (!this.canRefresh) return;
    this.loaded = true;
    const seq = ++this.sequence;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.publish({ read: { status: "loading" }, refreshing: true });
    try {
      const result = await this.port.read(abort.signal);
      if (!this.active || seq !== this.sequence) return;
      if (result.status === "ready" || result.status === "stale") {
        const data = validateList(result.data, this.scopeId),
          incoming = new Map(data.items.map((w) => [w.flowId, w]));
        // Keep the established order even if an activation updates server sort
        // timestamps. Tombstones reserve their slot across out-of-order Undo.
        const rows = this.state.rows.flatMap((r) => {
          const item = incoming.get(r.item.flowId);
          incoming.delete(r.item.flowId);
          // Only an authoritative active record can supersede a tombstone.
          // A stale pre-deletion snapshot must retain the receipt and slot.
          if (r.removed && (result.status !== "ready" || !item)) return [r];
          if (!item) return [];
          // Refresh is blocked while any command is unresolved. Fresh data can
          // therefore replace settled action feedback, including an obsolete
          // Undo after restoration elsewhere, without losing a pending command.
          return [
            result.status === "ready"
              ? slot(item)
              : { ...r, item, confirming: false },
          ];
        });
        rows.push(...[...incoming.values()].map(slot));
        this.publish({
          rows,
          read:
            result.status === "ready"
              ? { status: "ready", data: null }
              : {
                  status: "stale",
                  data: null,
                  reason: "Workflow data may be out of date.",
                },
        });
      } else if (result.status === "empty")
        this.publish({
          read: { status: "empty" },
          rows: this.state.rows.filter((r) => r.removed),
        });
      else if (result.status === "loading")
        this.publish({ read: { status: "loading" } });
      else if (
        result.status === "unsupported" ||
        result.status === "unavailable"
      )
        this.publish({
          read: {
            status: result.status,
            reason: "Workflow management is unavailable.",
          },
        });
      else throw Error("Invalid list state");
    } catch {
      if (this.active && seq === this.sequence)
        this.publish({
          read: {
            status: "unavailable",
            reason: "Workflows could not be loaded.",
          },
        });
    } finally {
      if (this.active && seq === this.sequence)
        this.publish({ refreshing: false });
    }
  }
  confirm(id: string) {
    if (!this.canChange(id) || this.getRow(id)!.removed) return;
    this.patch(id, { confirming: true, message: null });
  }
  cancel(id: string) {
    const r = this.getRow(id);
    if (r?.phase === "idle")
      this.patch(id, { confirming: false, message: null });
  }
  async activate(id: string, enabled: boolean) {
    const r = this.getRow(id);
    if (
      !r ||
      r.removed ||
      !this.canChange(id) ||
      r.confirming ||
      (r.item.activation === "ENABLED") === enabled
    )
      return;
    await this.submit(r, "activation", {
      activation: enabled ? "ENABLED" : "DISABLED",
    });
  }
  async remove(id: string) {
    const r = this.getRow(id);
    if (!r || r.removed || !r.confirming || !this.canChange(id)) return;
    await this.submit(r, "remove");
  }
  async restore(id: string) {
    const r = this.getRow(id);
    if (!r?.removed || !r.receipt || !this.canChange(id)) return;
    if (r.receipt.expiresAt <= this.clock()) {
      this.patch(id, { message: "Undo has expired." });
      return;
    }
    await this.submit(r, "restore", { receiptId: r.receipt.receiptId });
  }
  private async submit(
    row: ManagementSlot,
    action: ManageCommand["action"],
    extra: Partial<ManageCommand> = {},
  ) {
    const command: ManageCommand = {
      ...extra,
      scopeId: this.scopeId,
      flowId: row.item.flowId,
      versionId: row.item.versionId,
      expectedRevision: row.item.revision,
      requestId: this.requestId(),
      action,
    };
    ++this.sequence;
    this.abort?.abort();
    this.patch(command.flowId, { phase: "pending", command, message: null });
    try {
      this.accept(
        command,
        await this.port.change!(Object.freeze({ ...command })),
      );
    } catch {
      this.uncertain(command);
    }
  }
  private owns(c: ManageCommand) {
    return (
      this.active && this.getRow(c.flowId)?.command?.requestId === c.requestId
    );
  }
  private uncertain(c: ManageCommand) {
    if (this.owns(c))
      this.patch(c.flowId, {
        phase: "uncertain",
        message:
          "Confirmation was not received. Check the result before acting again.",
      });
  }
  private accept(command: ManageCommand, result: ManageResult) {
    if (!this.owns(command)) return;
    validateResult(result, command);
    if (result.status === "pending") {
      this.uncertain(command);
      return;
    }
    const r = this.getRow(command.flowId)!;
    if (result.status === "rejected") {
      this.patch(command.flowId, {
        phase: "idle",
        command: null,
        confirming: false,
        message: result.message,
        ...(!r.removed && result.current
          ? { item: validateWorkflow(result.current) }
          : {}),
      });
      return;
    }
    if (command.action === "remove")
      this.patch(command.flowId, {
        removed: true,
        confirming: false,
        phase: "idle",
        command: null,
        receipt: { ...result.receipt! },
        message: "Workflow deleted. Undo restores it paused.",
      });
    else {
      if (this.state.read.status === "empty")
        this.publish({ read: { status: "ready", data: null } });
      this.patch(command.flowId, {
        item: validateWorkflow(result.item!),
        removed: false,
        confirming: false,
        phase: "idle",
        command: null,
        receipt: null,
        message:
          command.action === "restore"
            ? "Restored, paused."
            : result.item!.activation === "ENABLED"
              ? "Workflow enabled."
              : "Workflow paused.",
      });
    }
  }
  async reconcile(id: string) {
    if (!this.canReconcile(id)) return;
    const command = this.getRow(id)!.command!;
    this.patch(id, { phase: "pending" });
    try {
      this.accept(
        command,
        await this.port.reconcile!(Object.freeze({ ...command })),
      );
    } catch {
      this.uncertain(command);
    }
  }
  retire() {
    this.active = false;
    this.abort?.abort();
    ++this.sequence;
    this.listeners.clear();
  }
}
