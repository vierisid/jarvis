import type { BriefConnection } from "../../../../src/brief/contracts";

export const ICONS = [
  "mail",
  "calendar",
  "document",
  "message",
  "monitor",
  "service",
] as const;
export type ServiceIcon = (typeof ICONS)[number];
export type DeviceAction = "inspect" | "update" | "revoke";
export interface ConnectionItem {
  identity: BriefConnection;
  observedStatus?:
    | "connected"
    | "disconnected"
    | "configured"
    | "reconnect_required"
    | "installed"
    | "unavailable"
    | "unknown";
  name: string;
  icon: ServiceIcon;
  accountLabel: string | null;
  detail: string | null;
  setupServiceId: string | null;
  device: {
    version: string | null;
    updateLabel: string | null;
    canUpdate: boolean;
  } | null;
}
export interface CatalogService {
  id: string;
  name: string;
  icon: ServiceIcon;
  description: string;
  kind: "native_service" | "channel" | "workflow_connection";
  setup: "browser" | "settings";
}
export interface WorkspaceData {
  connections: ConnectionItem[];
  catalog: CatalogService[];
  unavailableSources?: string[];
}
export type Failure = { state: "unavailable" | "unsupported" | "error" };
export type WorkspaceRead =
  { state: "ready" | "stale"; data: WorkspaceData } | Failure;
export interface SetupCommand {
  attemptId: string;
  serviceId: string;
  reconnectKey: string | null;
  position?: { search: string; anchorId: string | null; scrollTop: number };
}
export interface SetupTicket extends SetupCommand {
  expiresAt: number;
}
export type SetupRead =
  | {
      state: "pending" | "expired" | "cancelled";
      ticket: SetupTicket;
      candidateKeys?: string[];
      position?: SetupCommand["position"];
    }
  | {
      state: "confirmed" | "configured";
      ticket: SetupTicket;
      connectionKey: string;
    }
  | Failure;
export type Handoff = { state: "opened" } | Failure;
/** Presentation port. The optional F-22 bridge delegates persistence, local nonce and
 * canonical verification to its existing headless adapter. F-25 owns management routes.
 * No credentials or OAuth callback query enters this interface. Retain per authenticated scope.
 */
export interface ConnectionsPort {
  source: "fixture" | "live";
  scopeId: string;
  read(signal: AbortSignal): Promise<WorkspaceRead>;
  resume(signal: AbortSignal): Promise<SetupRead | { state: "none" }>;
  start(command: SetupCommand, signal: AbortSignal): Promise<SetupRead>;
  check(
    attemptId: string,
    signal: AbortSignal,
    selectedKey?: string,
  ): Promise<SetupRead>;
  cancel(attemptId: string, signal: AbortSignal): Promise<SetupRead>;
  /** The host opens its verified browser/settings destination; it must report blocked launch. */
  handoff(ticket: SetupTicket): Promise<Handoff>;
  manageDevice(
    identity: BriefConnection,
    action: DeviceAction,
  ): Promise<Handoff>;
  addDevice(): Promise<Handoff>;
}
/** Compile-safe until F-22/F-25 are integrated; never substitute specimen accounts. */
export function unavailableConnectionsPort(scopeId: string): ConnectionsPort {
  const unsupported = async () => ({ state: "unsupported" }) as const;
  return {
    scopeId,
    source: "live",
    read: unsupported,
    resume: unsupported,
    start: unsupported,
    check: unsupported,
    cancel: unsupported,
    handoff: unsupported,
    manageDevice: unsupported,
    addDevice: unsupported,
  };
}
export const connectionKey = (identity: BriefConnection) =>
  JSON.stringify([identity.kind, identity.sourceId, identity.accountId]);
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const label = (v: unknown, max = 320): v is string =>
  typeof v === "string" &&
  !!v.trim() &&
  v.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
const nullable = (v: unknown) => v === null || label(v);
const kinds = [
  "device",
  "native_service",
  "channel",
  "workflow_connection",
  "library_piece",
];
export function readWorkspace(value: unknown): WorkspaceData | null {
  if (
    !record(value) ||
    !Array.isArray(value.connections) ||
    !Array.isArray(value.catalog) ||
    value.connections.length > 5000 ||
    value.catalog.length > 2000
  )
    return null;
  const connections: ConnectionItem[] = [],
    catalog: CatalogService[] = [],
    seen = new Set<string>();
  for (const row of value.connections) {
    const i = row?.identity,
      p = i?.permissions,
      d = row?.device;
    if (
      !record(i) ||
      !kinds.includes(i.kind) ||
      !label(i.sourceId) ||
      !nullable(i.accountId) ||
      !["ready", "unavailable", "unknown"].includes(i.availability) ||
      !(i.authenticated === null || typeof i.authenticated === "boolean") ||
      !record(p) ||
      ![p.canInspect, p.canConnect, p.canRevoke].every(
        (v) => typeof v === "boolean",
      ) ||
      (row.observedStatus !== undefined &&
        ![
          "connected",
          "disconnected",
          "configured",
          "reconnect_required",
          "installed",
          "unavailable",
          "unknown",
        ].includes(row.observedStatus)) ||
      !label(row.name) ||
      !ICONS.includes(row.icon) ||
      !nullable(row.accountLabel) ||
      !nullable(row.detail) ||
      !nullable(row.setupServiceId) ||
      !(
        d === null ||
        (i.kind === "device" &&
          record(d) &&
          nullable(d.version) &&
          nullable(d.updateLabel) &&
          typeof d.canUpdate === "boolean")
      )
    )
      return null;
    const identity: BriefConnection = {
      sourceId: i.sourceId,
      kind: i.kind,
      accountId: i.accountId,
      availability: i.availability,
      authenticated: i.authenticated,
      permissions: {
        canInspect: p.canInspect,
        canConnect: p.canConnect,
        canRevoke: p.canRevoke,
      },
    };
    const key = connectionKey(identity);
    if (seen.has(key)) return null;
    seen.add(key);
    // Deliberately copy only public fields. Extra provider fields never enter the view state.
    connections.push({
      identity,
      ...(row.observedStatus ? { observedStatus: row.observedStatus } : {}),
      name: row.name,
      icon: row.icon,
      accountLabel: row.accountLabel,
      detail: row.detail,
      setupServiceId: row.setupServiceId,
      device:
        d === null
          ? null
          : {
              version: d.version,
              updateLabel: d.updateLabel,
              canUpdate: d.canUpdate,
            },
    });
  }
  seen.clear();
  for (const row of value.catalog) {
    if (
      !record(row) ||
      !label(row.id) ||
      (row.observedStatus !== undefined &&
        ![
          "connected",
          "disconnected",
          "configured",
          "reconnect_required",
          "installed",
          "unavailable",
          "unknown",
        ].includes(row.observedStatus)) ||
      !label(row.name) ||
      !label(row.description, 1000) ||
      !ICONS.includes(row.icon) ||
      !["native_service", "channel", "workflow_connection"].includes(
        row.kind,
      ) ||
      !["browser", "settings"].includes(row.setup) ||
      seen.has(row.id)
    )
      return null;
    seen.add(row.id);
    catalog.push({
      id: row.id,
      name: row.name,
      icon: row.icon,
      description: row.description,
      kind: row.kind,
      setup: row.setup,
    });
  }
  if (
    value.unavailableSources !== undefined &&
    (!Array.isArray(value.unavailableSources) ||
      value.unavailableSources.length > 5 ||
      !value.unavailableSources.every(
        (s: unknown) =>
          typeof s === "string" &&
          ["devices", "google", "channels", "pieces", "accounts"].includes(s),
      ))
  )
    return null;
  return {
    connections,
    catalog,
    ...(value.unavailableSources
      ? { unavailableSources: [...value.unavailableSources] }
      : {}),
  };
}
export function readTicket(value: unknown): SetupTicket | null {
  if (
    !record(value) ||
    !label(value.attemptId) ||
    !label(value.serviceId) ||
    !(value.reconnectKey === null || label(value.reconnectKey, 1000)) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= 0
  )
    return null;
  return {
    attemptId: value.attemptId,
    serviceId: value.serviceId,
    reconnectKey: value.reconnectKey,
    expiresAt: value.expiresAt,
  };
}
export function connectionStatus(
  item: ConnectionItem,
  stale = false,
): { text: string; tone: "good" | "quiet" | "warn" } {
  if (stale) return { text: "Status needs refresh", tone: "quiet" };
  const i = item.identity;
  if (i.kind === "device")
    return i.availability === "ready"
      ? { text: "Connected", tone: "good" }
      : {
          text: i.availability === "unavailable" ? "Offline" : "Status unknown",
          tone: "quiet",
        };
  if (i.kind === "library_piece")
    return {
      text:
        i.availability === "ready"
          ? "Available in library"
          : "Library unavailable",
      tone: "quiet",
    };
  if (item.observedStatus === "configured")
    return { text: "Configured · not verified", tone: "quiet" };
  if (item.observedStatus === "unavailable")
    return { text: "Unavailable", tone: "quiet" };
  if (item.observedStatus === "disconnected")
    return { text: "Not connected", tone: "quiet" };
  if (i.availability === "ready" && i.authenticated === true)
    return { text: "Connected", tone: "good" };
  if (i.authenticated === false)
    return { text: "Reconnect needed", tone: "warn" };
  return {
    text: i.availability === "unavailable" ? "Unavailable" : "Not verified",
    tone: "quiet",
  };
}
