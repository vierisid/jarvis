import { uuid } from "../../lib/uuid";
import {
  connectionKey,
  readWorkspace,
  readTicket,
  type CatalogService,
  type ConnectionItem,
  type ConnectionsPort,
  type DeviceAction,
  type SetupCommand,
  type SetupRead,
  type SetupTicket,
  type WorkspaceRead,
} from "./model";

export interface ConnectionsState {
  read: WorkspaceRead | { state: "loading" };
  panel: "workspace" | "catalog" | "setup" | "device";
  search: string;
  service: CatalogService | null;
  reconnectKey: string | null;
  deviceKey: string | null;
  attemptId: string | null;
  ticket: SetupTicket | null;
  setupState:
    | "idle"
    | "pending"
    | "expired"
    | "cancelled"
    | "confirmed"
    | "configured"
    | "unknown";
  busy: boolean;
  canceling: boolean;
  candidateKeys: string[];
  selectedKey: string;
  message: string;
}
const empty = (): ConnectionsState => ({
  read: { state: "loading" },
  panel: "workspace",
  search: "",
  service: null,
  reconnectKey: null,
  deviceKey: null,
  attemptId: null,
  ticket: null,
  setupState: "idle",
  busy: false,
  canceling: false,
  candidateKeys: [],
  selectedKey: "",
  message: "",
});
export class ConnectionsController {
  readonly source;
  readonly scopeId;
  readonly scrollPositions = new Map<string, number>();
  private state = empty();
  private listeners = new Set<() => void>();
  private access = false;
  private alive = true;
  private generation = 0;
  private abort?: AbortController;
  constructor(
    private port: ConnectionsPort,
    private requestId = uuid,
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
  private publish(patch: Partial<ConnectionsState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private operation() {
    this.abort?.abort();
    this.abort = new AbortController();
    const generation = ++this.generation;
    return {
      signal: this.abort.signal,
      current: () =>
        this.alive && this.access && generation === this.generation,
    };
  }
  setAccess(value: boolean) {
    if (!this.alive || value === this.access) return;
    this.access = value;
    if (value) void this.refresh(true);
    else {
      this.generation++;
      this.abort?.abort();
      this.scrollPositions.clear();
      this.publish({ ...empty(), read: { state: "unavailable" } });
    }
  }
  private safeRead(read: WorkspaceRead): ConnectionsState["read"] {
    if (read.state === "ready" || read.state === "stale") {
      const data = readWorkspace(read.data);
      return data ? { state: read.state, data } : { state: "error" };
    }
    return {
      state:
        read.state === "unavailable" || read.state === "unsupported"
          ? read.state
          : "error",
    };
  }
  async refresh(resume = false) {
    if (!this.access || this.state.busy) return;
    const op = this.operation();
    this.publish({ busy: true, message: "" });
    try {
      const read = this.safeRead(await this.port.read(op.signal));
      if (!op.current()) return;
      if (read.state !== "ready" && read.state !== "stale") {
        this.publish({ ...empty(), read });
        return;
      }
      this.publish({ read });
      if (resume && read.state === "ready") {
        const result = await this.port.resume(op.signal);
        if (!op.current()) return;
        if (result.state !== "none") await this.accept(result, op);
        else
          this.publish({ attemptId: null, ticket: null, setupState: "idle" });
      }
      if (op.current()) this.publish({ busy: false });
    } catch {
      if (op.current())
        this.publish({
          read: { state: "error" },
          busy: false,
          message: "Could not refresh Connected workspace.",
        });
    }
  }
  setSearch(search: string) {
    if (this.access) this.publish({ search: search.slice(0, 320) });
  }
  catalog() {
    if (this.usable() && !this.hasAttempt())
      this.publish({ panel: "catalog", message: "", service: null });
  }
  private usable() {
    return (
      this.alive &&
      this.access &&
      !this.state.busy &&
      this.state.read.state === "ready"
    );
  }
  private hasAttempt() {
    return (
      this.state.setupState === "unknown" ||
      (!!this.state.attemptId &&
        !["expired", "cancelled", "confirmed", "configured"].includes(
          this.state.setupState,
        ))
    );
  }
  select(serviceId: string, reconnectKey: string | null = null) {
    if (
      !this.usable() ||
      this.hasAttempt() ||
      this.state.read.state !== "ready"
    )
      return;
    const service = this.state.read.data.catalog.find(
      (item) => item.id === serviceId,
    );
    const row = this.state.read.data.connections.find(
      (item) => connectionKey(item.identity) === reconnectKey,
    );
    if (
      !service ||
      (reconnectKey &&
        (!row ||
          row.setupServiceId !== serviceId ||
          !row.identity.permissions.canConnect ||
          row.identity.kind !== service.kind))
    )
      return;
    this.publish({
      panel: "setup",
      service,
      reconnectKey,
      attemptId: null,
      ticket: null,
      candidateKeys: [],
      selectedKey: "",
      setupState: "idle",
      message: "",
    });
  }
  back() {
    if (!this.access || this.state.busy || this.hasAttempt()) return;
    this.publish({
      panel:
        this.state.panel === "setup" &&
        !this.state.reconnectKey &&
        !["confirmed", "configured"].includes(this.state.setupState)
          ? "catalog"
          : "workspace",
      service: null,
      deviceKey: null,
      attemptId: null,
      ticket: null,
      candidateKeys: [],
      selectedKey: "",
      setupState: "idle",
      message: "",
    });
  }
  selectAccount(key: string) {
    if (!this.state.busy && this.state.candidateKeys.includes(key))
      this.publish({ selectedKey: key });
  }
  async start() {
    if (!this.usable() || !this.state.service || this.hasAttempt()) return;
    const read = this.state.read;
    if (read.state !== "ready") return;
    const service = read.data.catalog.find(
      (item) => item.id === this.state.service!.id,
    );
    const row = read.data.connections.find(
      (item) => connectionKey(item.identity) === this.state.reconnectKey,
    );
    if (
      !service ||
      (this.state.reconnectKey &&
        (!row ||
          !row.identity.permissions.canConnect ||
          row.setupServiceId !== service.id ||
          row.identity.kind !== service.kind))
    ) {
      this.publish({
        message:
          "This setup is no longer available. Return to Connected workspace and refresh.",
      });
      return;
    }
    const command: SetupCommand = {
      attemptId: this.requestId(),
      serviceId: this.state.service.id,
      reconnectKey: this.state.reconnectKey,
      position: {
        search: this.state.search,
        anchorId: this.state.service.id,
        scrollTop:
          this.scrollPositions.get(
            this.state.reconnectKey ? "workspace" : "catalog",
          ) ?? 0,
      },
    };
    const op = this.operation();
    this.publish({
      service,
      busy: true,
      attemptId: command.attemptId,
      ticket: null,
      candidateKeys: [],
      selectedKey: "",
      setupState: "pending",
      message: "Preparing secure setup…",
    });
    try {
      const result = await this.port.start(command, op.signal);
      if (op.current()) await this.accept(result, op, command);
    } catch {
      if (op.current()) this.unknown();
    } finally {
      if (op.current()) this.publish({ busy: false });
    }
  }
  private unknown() {
    this.publish({
      setupState: "unknown",
      message:
        "Setup could not be verified. Check its status before starting again.",
    });
  }
  private async accept(
    result: SetupRead,
    op: ReturnType<ConnectionsController["operation"]>,
    expected?: SetupCommand,
  ) {
    if (
      !result ||
      typeof result !== "object" ||
      ![
        "pending",
        "expired",
        "cancelled",
        "confirmed",
        "configured",
        "unavailable",
        "unsupported",
        "error",
      ].includes(result.state)
    ) {
      this.unknown();
      return;
    }
    if (!("ticket" in result)) {
      if (result.state === "unavailable")
        this.publish({ ...empty(), read: { state: "unavailable" } });
      else this.unknown();
      return;
    }
    const ticket = readTicket(result.ticket),
      prior =
        expected ??
        (this.state.attemptId
          ? {
              attemptId: this.state.attemptId,
              serviceId: this.state.service?.id,
              reconnectKey: this.state.reconnectKey,
            }
          : null);
    if (
      !ticket ||
      (prior &&
        (ticket.attemptId !== prior.attemptId ||
          ticket.serviceId !== prior.serviceId ||
          ticket.reconnectKey !== prior.reconnectKey))
    ) {
      this.unknown();
      return;
    }
    const read = this.state.read;
    const service =
      read.state === "ready" || read.state === "stale"
        ? read.data.catalog.find((s) => s.id === ticket.serviceId)
        : null;
    if (!service) {
      this.unknown();
      return;
    }
    if (!prior && "position" in result && result.position) {
      this.publish({ search: result.position.search.slice(0, 300) });
      this.scrollPositions.set(
        ticket.reconnectKey ? "workspace" : "catalog",
        result.position.scrollTop,
      );
    }
    const terminal =
      result.state === "confirmed" || result.state === "configured";
    this.publish({
      panel: "setup",
      service,
      reconnectKey: ticket.reconnectKey,
      attemptId: ticket.attemptId,
      ticket,
      setupState: terminal ? "pending" : result.state,
      candidateKeys:
        "candidateKeys" in result
          ? (result.candidateKeys ?? []).filter(
              (key) =>
                (read.state === "ready" || read.state === "stale") &&
                read.data.connections.some(
                  (r) => connectionKey(r.identity) === key,
                ),
            )
          : [],
      message: "",
    });
    if (result.state === "confirmed" || result.state === "configured") {
      // Browser return, launch and callback parameters are never confirmation. Re-read the
      // canonical projection and require the exact account named by its verified attempt.
      this.publish({
        setupState: "pending",
        message: "Checking the connected account…",
      });
      const fresh = this.safeRead(await this.port.read(op.signal));
      if (!op.current()) return;
      if (fresh.state === "unavailable" || fresh.state === "unsupported") {
        this.publish({ ...empty(), read: fresh });
        return;
      }
      const row =
        fresh.state === "ready"
          ? fresh.data.connections.find(
              (item) => connectionKey(item.identity) === result.connectionKey,
            )
          : null;
      if (
        !row ||
        row.setupServiceId !== ticket.serviceId ||
        row.identity.kind !== service.kind ||
        (result.state === "confirmed"
          ? row.identity.authenticated !== true ||
            row.identity.availability !== "ready" ||
            (row.observedStatus !== undefined &&
              row.observedStatus !== "connected")
          : row.observedStatus !== "configured") ||
        (ticket.reconnectKey && ticket.reconnectKey !== result.connectionKey)
      ) {
        this.unknown();
        return;
      }
      this.publish({
        read: fresh,
        setupState: result.state,
        message:
          result.state === "configured"
            ? `${service.name} credentials are saved. Authentication has not been verified.`
            : `${service.name} is connected to ${row.accountLabel ?? "the verified account"}.`,
      });
    } else if (result.state === "cancelled")
      this.publish({ message: "Setup canceled. No connection was confirmed." });
    else if (result.state === "expired")
      this.publish({
        message: "This setup expired. Start again when you’re ready.",
      });
  }
  async check() {
    return this.resolveAttempt("check");
  }
  async cancel() {
    return this.resolveAttempt("cancel");
  }
  private async resolveAttempt(action: "check" | "cancel") {
    const id = this.state.attemptId;
    if (
      !this.access ||
      !id ||
      (action === "check" && this.state.busy) ||
      (action === "cancel" && this.state.canceling)
    )
      return;
    const op = this.operation();
    this.publish({
      busy: true,
      canceling: action === "cancel",
      message:
        action === "cancel" ? "Canceling setup…" : "Checking connection…",
    });
    try {
      const result = await this.port[action](
        id,
        op.signal,
        this.state.selectedKey || undefined,
      );
      if (
        op.current() &&
        action === "check" &&
        "candidateKeys" in result &&
        result.candidateKeys?.length
      ) {
        const fresh = this.safeRead(await this.port.read(op.signal));
        if (!op.current()) return;
        if (fresh.state !== "ready") {
          this.publish({ ...empty(), read: fresh });
          return;
        }
        this.publish({ read: fresh });
      }
      if (op.current()) await this.accept(result, op);
    } catch {
      if (op.current()) this.unknown();
    } finally {
      if (op.current()) this.publish({ busy: false, canceling: false });
    }
  }
  async handoff() {
    const ticket = this.state.ticket;
    if (
      !this.access ||
      this.state.busy ||
      !ticket ||
      this.state.setupState !== "pending"
    )
      return;
    const op = this.operation();
    this.publish({ busy: true });
    try {
      const result = await this.port.handoff(ticket);
      if (op.current() && result.state === "unavailable") {
        this.publish({ ...empty(), read: { state: "unavailable" } });
        return;
      }
      if (op.current())
        this.publish({
          message:
            result.state === "opened"
              ? "Finish setup there, then check the connection here."
              : "Setup could not be opened. Try opening it again, or cancel.",
        });
    } catch {
      if (op.current())
        this.publish({
          message:
            "Setup could not be opened. Try opening it again, or cancel.",
        });
    } finally {
      if (op.current()) this.publish({ busy: false });
    }
  }
  device(key: string) {
    if (
      !this.usable() ||
      this.hasAttempt() ||
      this.state.read.state !== "ready"
    )
      return;
    const item = this.state.read.data.connections.find(
      (i) => connectionKey(i.identity) === key,
    );
    if (
      item?.identity.kind === "device" &&
      item.identity.permissions.canInspect
    )
      this.publish({ panel: "device", deviceKey: key, message: "" });
  }
  async manageDevice(action: DeviceAction) {
    if (!this.usable() || this.state.read.state !== "ready") return;
    const row = this.state.read.data.connections.find(
      (i) => connectionKey(i.identity) === this.state.deviceKey,
    );
    if (
      !row ||
      row.identity.kind !== "device" ||
      !row.identity.permissions.canInspect ||
      (action === "update" && !row.device?.canUpdate) ||
      (action === "revoke" && !row.identity.permissions.canRevoke)
    )
      return;
    await this.manage(() => this.port.manageDevice(row.identity, action));
  }
  async addDevice() {
    if (this.usable()) await this.manage(() => this.port.addDevice());
  }
  private async manage(run: () => ReturnType<ConnectionsPort["addDevice"]>) {
    const op = this.operation();
    this.publish({ busy: true });
    try {
      const result = await run();
      if (op.current() && result.state === "unavailable") {
        this.publish({ ...empty(), read: { state: "unavailable" } });
        return;
      }
      if (op.current())
        this.publish({
          message:
            result.state === "opened"
              ? "Continue in device settings. Refresh here to see verified changes."
              : "Device settings are unavailable. Try again later.",
        });
    } catch {
      if (op.current())
        this.publish({
          message: "Device settings are unavailable. Try again later.",
        });
    } finally {
      if (op.current()) this.publish({ busy: false });
    }
  }
  retire() {
    this.setAccess(false);
    this.alive = false;
    this.generation++;
    this.abort?.abort();
    this.listeners.clear();
  }
}
