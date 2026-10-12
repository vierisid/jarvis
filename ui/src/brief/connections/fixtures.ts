import { ConnectionsController } from "./controller";
import {
  connectionKey,
  type CatalogService,
  type ConnectionItem,
  type ConnectionsPort,
  type SetupRead,
  type SetupTicket,
  type WorkspaceData,
} from "./model";
export const CONNECTION_EXAMPLES = [
  "ready",
  "empty",
  "stale",
  "unavailable",
  "read-only",
  "expired",
  "lost-start",
  "lost-cancel",
  "long",
  "configured",
  "partial",
] as const;
export type ConnectionExample = (typeof CONNECTION_EXAMPLES)[number];
export const CONNECTION_SCOPE = "d27-disposable-preview";
const catalog: CatalogService[] = [
  {
    id: "gmail",
    name: "Gmail",
    icon: "mail",
    description: "Connect your email account.",
    kind: "native_service",
    setup: "browser",
  },
  {
    id: "calendar",
    name: "Google Calendar",
    icon: "calendar",
    description: "Bring your calendar into your workspace.",
    kind: "native_service",
    setup: "browser",
  },
  {
    id: "notion",
    name: "Notion",
    icon: "document",
    description: "Connect the pages your team works with.",
    kind: "workflow_connection",
    setup: "browser",
  },
  {
    id: "slack",
    name: "Slack",
    icon: "message",
    description: "Set up a workspace connection in service settings.",
    kind: "channel",
    setup: "settings",
  },
];
function item(
  id: string,
  name: string,
  kind: ConnectionItem["identity"]["kind"],
  account: string | null,
  authenticated: boolean | null,
  serviceId: string | null = null,
): ConnectionItem {
  const service = catalog.find((s) => s.id === serviceId);
  return {
    identity: {
      sourceId: id,
      kind,
      accountId: account,
      availability: "ready",
      authenticated,
      permissions: {
        canInspect: true,
        canConnect: kind !== "device",
        canRevoke: true,
      },
    },
    name,
    icon: service?.icon ?? "monitor",
    accountLabel: account,
    detail: kind === "device" ? "Preview desktop" : null,
    setupServiceId: serviceId,
    device:
      kind === "device"
        ? { version: "0.15.0", updateLabel: null, canUpdate: true }
        : null,
  };
}
/** Disposable service behavior, deliberately separate from live adapters and OAuth. */
export function makeConnectionsFixture(
  example: ConnectionExample = "ready",
  delay = 0,
) {
  const desktop = item(
    "preview-desktop",
    "Jarvis desktop",
    "device",
    null,
    null,
  );
  const laptop = item("preview-laptop", "Travel laptop", "device", null, null);
  laptop.identity.availability = "unavailable";
  laptop.device!.updateLabel = "Update available · review in device settings";
  const data: WorkspaceData = {
    connections: [
      desktop,
      laptop,
      item(
        "google",
        "Gmail",
        "native_service",
        "alex@studio.example",
        true,
        "gmail",
      ),
      item(
        "google-calendar",
        "Google Calendar",
        "native_service",
        "alex@studio.example",
        true,
        "calendar",
      ),
      item(
        "notion-project",
        "Notion",
        "workflow_connection",
        "Studio workspace",
        false,
        "notion",
      ),
    ],
    catalog: structuredClone(catalog),
  };
  if (example === "empty") data.connections = [];
  if (example === "read-only")
    for (const row of data.connections) {
      row.identity.permissions.canConnect = false;
      row.identity.permissions.canRevoke = false;
      if (row.device) row.device.canUpdate = false;
    }
  if (example === "long") {
    data.connections[0]!.name =
      "Studio desktop used for the international editorial and production planning workspace";
    data.connections[2]!.accountLabel =
      "alexandra.extended.account.name@international-production-studio.example";
    data.catalog[0]!.description =
      "Connect the account you use for long-running production planning, international client correspondence and the studio’s shared editorial work.";
  }
  if (example === "partial") data.unavailableSources = ["google", "accounts"];
  if (example === "configured") {
    data.connections[4]!.observedStatus = "configured";
    data.connections[4]!.identity.authenticated = null;
    data.connections[4]!.identity.availability = "unknown";
    data.catalog[2]!.setup = "settings";
  }
  let current: SetupRead | { state: "none" } = { state: "none" },
    starts = 0,
    cancels = 0;
  const handoffs: string[] = [],
    devices: { key: string; action: string }[] = [];
  const pause = () =>
    new Promise<void>((resolve) => setTimeout(resolve, delay));
  const port: ConnectionsPort = {
    source: "fixture",
    scopeId: CONNECTION_SCOPE,
    async read() {
      await pause();
      return example === "unavailable"
        ? { state: "unavailable" }
        : {
            state: example === "stale" ? "stale" : "ready",
            data: structuredClone(data),
          };
    },
    async resume() {
      await pause();
      return structuredClone(current);
    },
    async start(command) {
      starts++;
      const ticket: SetupTicket = {
        ...command,
        expiresAt: Date.now() + 10 * 60_000,
      };
      current = { state: "pending", ticket };
      await pause();
      if (example === "lost-start") throw Error("Lost response");
      return structuredClone(current);
    },
    async check(attemptId, _signal, selectedKey) {
      await pause();
      if (!("ticket" in current) || current.ticket.attemptId !== attemptId)
        return { state: "error" };
      if (example === "configured" && current.state === "pending") {
        const ticket = current.ticket;
        const keys = data.connections
          .filter((r) => r.setupServiceId === ticket.serviceId)
          .map((r) => connectionKey(r.identity));
        if (!current.ticket.reconnectKey && !selectedKey)
          return { ...current, candidateKeys: keys };
        const key = current.ticket.reconnectKey ?? selectedKey;
        if (key && keys.includes(key))
          return {
            state: "configured",
            ticket: current.ticket,
            connectionKey: key,
          };
      }
      if (example === "expired")
        current = { state: "expired", ticket: current.ticket };
      return structuredClone(current);
    },
    async cancel(attemptId) {
      cancels++;
      if (!("ticket" in current) || current.ticket.attemptId !== attemptId)
        return { state: "error" };
      current = { state: "cancelled", ticket: current.ticket };
      await pause();
      if (example === "lost-cancel") throw Error("Lost cancellation response");
      return structuredClone(current);
    },
    async handoff(ticket) {
      handoffs.push(ticket.serviceId);
      return { state: "opened" };
    },
    async manageDevice(identity, action) {
      devices.push({ key: connectionKey(identity), action });
      return { state: "opened" };
    },
    async addDevice() {
      devices.push({ key: "enrollment", action: "add" });
      return { state: "opened" };
    },
  };
  function confirm() {
    if (!("ticket" in current) || current.state !== "pending") return;
    const ticket = current.ticket;
    const service = data.catalog.find((s) => s.id === ticket.serviceId)!;
    let row = data.connections.find(
      (i) => connectionKey(i.identity) === ticket.reconnectKey,
    );
    if (!row) {
      row = item(
        `preview-${service.id}-${starts}`,
        service.name,
        service.kind,
        `preview.account.${starts}@studio.example`,
        true,
        service.id,
      );
      data.connections.push(row);
    }
    row.identity.authenticated = true;
    row.identity.availability = "ready";
    current = {
      state: "confirmed",
      ticket: current.ticket,
      connectionKey: connectionKey(row.identity),
    };
  }
  return {
    controller: new ConnectionsController(port),
    port,
    data,
    confirm,
    handoffs,
    devices,
    starts: () => starts,
    cancels: () => cancels,
  };
}
