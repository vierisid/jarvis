import type { BriefConnection } from "../../../../src/brief/contracts";
import {
  connectionKey,
  readWorkspace,
  unavailableConnectionsPort,
  type ConnectionsPort,
  type ConnectionItem,
  type DeviceAction,
  type Handoff,
  type SetupCommand,
  type SetupRead,
  type SetupTicket,
  type WorkspaceData,
} from "./model";

// Structural subset of F-22 v1. Inject its real exports when integrating the stacks;
// a missing provider compiles and fails closed, without copying its setup engine.
export interface F22Row extends BriefConnection {
  label: string;
  serviceId: string;
  status: NonNullable<ConnectionItem["observedStatus"]>;
  evidence:
    | "live_session"
    | "provider_status"
    | "stored_grant"
    | "saved_credentials"
    | "loaded_piece"
    | "none";
  pieceVersion: string | null;
  setupActionId: string | null;
}
export interface F22Action {
  id: string;
  label: string;
  target:
    | { kind: "google"; flow: "oauth" | "manual_client" | "hosted_browser" }
    | { kind: "hosted_integration"; provider: "clickup" | "mailchimp" }
    | { kind: "channel"; channel: "telegram" | "discord" }
    | { kind: "device"; flow: "enrollment" | "hosted_sign_in" }
    | {
        kind: "piece_credentials";
        pieceName: string;
        pieceVersion: string;
        authType: string;
      };
  verifies: { kind: BriefConnection["kind"]; serviceId: string };
}
export interface F22Snapshot {
  contractVersion: 1;
  scopeId: string;
  asOf: number;
  rows: F22Row[];
  setup: F22Action[];
  sources: Record<
    "devices" | "google" | "channels" | "pieces" | "accounts",
    "ready" | "unavailable"
  >;
}
type Position = NonNullable<SetupCommand["position"]>;
interface Attempt {
  version: 1;
  scopeId: string;
  nonce: string;
  actionId: string;
  rowId: string | null;
  position: Position;
  expiresAt: number;
  phase: "pending" | "returned" | "canceled" | "expired";
}
export interface F22Setup {
  current(): Attempt | null;
  begin(
    actionId: string,
    position: Position,
    rowId?: string | null,
  ): Promise<Attempt | null>;
  cancel(): Position | null;
  verify(
    nonce: string,
    selectedRowId?: string,
  ): Promise<{
    row: F22Row;
    result: "connected" | "configured" | "not_connected";
  } | null>;
}
export interface F22Binding {
  read(): Promise<
    | { status: "ready"; data: F22Snapshot }
    | { status: "unavailable" | "unsupported"; code: string }
  >;
  storage: Pick<Storage, "getItem" | "setItem">;
  createSetup(
    scopeId: string,
    ports: {
      storage: Pick<Storage, "getItem" | "setItem">;
      read(): Promise<F22Snapshot>;
      open(action: F22Action, rowId: string | null): void;
      nonce(): string;
    },
  ): F22Setup;
  /** Bind to F-22 openLegacyConnectionSetup. Its existing surfaces own OAuth and secrets. */
  openSetup(action: F22Action, rowId: string | null): void;
  /** F-25 supplies exact destinations/update metadata and checks the signal before delayed navigation. */
  deviceDetails?(identity: BriefConnection): ConnectionItem["device"];
  manageDevice(
    identity: BriefConnection,
    action: DeviceAction,
    signal: AbortSignal,
  ): Promise<Handoff>;
  addDevice(signal: AbortSignal): Promise<Handoff>;
}
const sourceNames = [
  "devices",
  "google",
  "channels",
  "pieces",
  "accounts",
] as const;
const icon = (kind: BriefConnection["kind"]): ConnectionItem["icon"] =>
  kind === "device" ? "monitor" : kind === "channel" ? "message" : "service";

export function projectF22(
  snapshot: F22Snapshot,
  scopeId: string,
  details?: F22Binding["deviceDetails"],
): WorkspaceData | null {
  if (
    snapshot?.contractVersion !== 1 ||
    snapshot.scopeId !== scopeId ||
    !Number.isFinite(snapshot.asOf) ||
    !Array.isArray(snapshot.rows) ||
    !Array.isArray(snapshot.setup) ||
    snapshot.rows.length > 5000 ||
    snapshot.setup.length > 2000 ||
    !sourceNames.every((s) =>
      ["ready", "unavailable"].includes(snapshot.sources?.[s]),
    ) ||
    new Set(snapshot.rows.map((r) => r.sourceId)).size !==
      snapshot.rows.length ||
    snapshot.rows.some((r) => !r.serviceId || !r.status) ||
    snapshot.setup.some(
      (a) =>
        !a.verifies?.serviceId ||
        !["google", "channel", "device", "piece_credentials"].includes(
          a.target?.kind,
        ),
    )
  )
    return null;
  return readWorkspace({
    connections: snapshot.rows.map((r) => ({
      identity: r,
      observedStatus: r.status,
      name:
        r.kind === "workflow_connection"
          ? (snapshot.setup.find((a) => a.id === r.setupActionId)?.label ??
            snapshot.rows.find(
              (p) => p.kind === "library_piece" && p.serviceId === r.serviceId,
            )?.label ??
            r.serviceId)
          : r.label,
      icon: icon(r.kind),
      accountLabel: r.kind === "workflow_connection" ? r.label : null,
      detail:
        r.kind === "library_piece"
          ? "Installed service · account setup is separate"
          : null,
      setupServiceId: r.setupActionId,
      device:
        r.kind === "device"
          ? (details?.(r) ?? {
              version: null,
              updateLabel: null,
              canUpdate: false,
            })
          : null,
    })),
    catalog: snapshot.setup
      .filter((a) => a.verifies.kind !== "device")
      .map((a) => ({
        id: a.id,
        name: a.label,
        icon: icon(a.verifies.kind),
        kind: a.verifies.kind,
        // Every current F-22 target goes through an existing settings/form surface,
        // including Google, which may then open its existing external browser flow.
        setup: "settings",
        description:
          a.target.kind === "piece_credentials"
            ? "Configure credentials in the existing service form. Saved credentials still need authentication verification."
            : a.target.kind === "google"
              ? "Open Google settings to configure access or continue in your browser."
              : "Configure this service in its existing settings.",
      })),
    unavailableSources: sourceNames.filter(
      (s) => snapshot.sources[s] !== "ready",
    ),
  });
}

export function createF22ConnectionsPort(
  scopeId: string,
  binding?: F22Binding,
): ConnectionsPort {
  if (!binding) return unavailableConnectionsPort(scopeId);
  let latest: F22Snapshot | undefined;
  let starting: SetupCommand | undefined;
  let completedNonce: string | undefined;
  const read = async () => {
    const result = await binding.read();
    if (result.status !== "ready") {
      latest = undefined;
      throw new Error(result.status);
    }
    if (!projectF22(result.data, scopeId, binding.deviceDetails)) {
      latest = undefined;
      throw new Error("invalid");
    }
    latest = result.data;
    return latest;
  };
  const setup = binding.createSetup(scopeId, {
    storage: binding.storage,
    read,
    nonce: () => {
      if (!starting) throw new Error("No explicit setup");
      return starting.attemptId;
    },
    open: (action, rowId) => binding.openSetup(action, rowId),
  });
  const ticket = (a: Attempt): SetupTicket | null => {
    const row = a.rowId
      ? latest?.rows.find((r) => r.sourceId === a.rowId)
      : undefined;
    // The local attempt must remain recoverable when its canonical row disappears.
    // Verification and reopening still require the exact F-22 rowId below.
    if (a.scopeId !== scopeId) return null;
    return {
      attemptId: a.nonce,
      serviceId: a.actionId,
      reconnectKey: row ? connectionKey(row) : null,
      expiresAt: a.expiresAt,
    };
  };
  const state = (a: Attempt | null): SetupRead | { state: "none" } => {
    if (!a) return { state: "none" };
    const t = ticket(a);
    return t
      ? {
          state:
            a.phase === "canceled"
              ? "cancelled"
              : a.phase === "expired"
                ? "expired"
                : "pending",
          ticket: t,
          position: a.position,
        }
      : { state: "error" };
  };
  const failure = (
    error: unknown,
  ): { state: "unavailable" | "unsupported" | "error" } => ({
    state:
      error instanceof Error &&
      (error.message === "unavailable" || error.message === "unsupported")
        ? error.message
        : "error",
  });
  const accountCandidates = (a: Attempt) => {
    const action = latest?.setup.find((s) => s.id === a.actionId);
    if (!action) return [];
    return (
      latest?.rows.filter(
        (r) =>
          r.kind === action.verifies.kind &&
          r.serviceId === action.verifies.serviceId,
      ) ?? []
    );
  };
  return {
    source: "live",
    scopeId,
    async read() {
      try {
        return {
          state: "ready",
          data: projectF22(await read(), scopeId, binding.deviceDetails)!,
        };
      } catch (error) {
        return failure(error);
      }
    },
    async resume() {
      try {
        await read();
        return state(setup.current());
      } catch (error) {
        return failure(error);
      }
    },
    async start(command, signal) {
      if (starting || signal.aborted) return { state: "error" };
      const existing = setup.current();
      if (
        existing &&
        !["expired", "canceled"].includes(existing.phase) &&
        existing.nonce !== completedNonce
      )
        return { state: "error" };
      starting = command;
      const abort = () => {
        try {
          setup.cancel();
        } catch {
          /* Still invalidate the UI response. */
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const snapshot = await read();
        if (signal.aborted) return { state: "error" };
        const row = command.reconnectKey
          ? snapshot.rows.find((r) => connectionKey(r) === command.reconnectKey)
          : null;
        if (
          command.reconnectKey &&
          (!row?.permissions.canConnect ||
            row.setupActionId !== command.serviceId)
        )
          return {
            state: "cancelled",
            ticket: { ...command, expiresAt: Date.now() + 600_000 },
          };
        const a = await setup.begin(
          command.serviceId,
          command.position ?? { search: "", anchorId: null, scrollTop: 0 },
          row?.sourceId ?? null,
        );
        const result = state(a);
        return result.state === "none" ? { state: "error" } : result;
      } catch (error) {
        const failed = failure(error);
        const current = setup.current();
        // A retained terminal attempt belongs to the previous action. If F-22 never
        // replaced it, this new launch did not persist or open and may be retried.
        if (
          failed.state === "error" &&
          (!current ||
            (current.nonce === existing?.nonce &&
              current.nonce !== command.attemptId))
        )
          return {
            state: "cancelled",
            ticket: { ...command, expiresAt: Date.now() + 600_000 },
          };
        return failed;
      } finally {
        starting = undefined;
        signal.removeEventListener("abort", abort);
      }
    },
    async check(id, signal, selectedKey) {
      try {
        const snapshot = await read(),
          a = setup.current();
        if (signal.aborted || !a || a.nonce !== id) return { state: "error" };
        const result = state(a);
        if (result.state !== "pending")
          return result.state === "none" ? { state: "error" } : result;
        const action = snapshot.setup.find((s) => s.id === a.actionId);
        if (!action) return { state: "error" };
        const candidates = accountCandidates(a);
        const chosen = a.rowId
          ? candidates.find((r) => r.sourceId === a.rowId)
          : candidates.find((r) => connectionKey(r) === selectedKey);
        if (!chosen)
          return {
            ...result,
            candidateKeys: a.rowId ? [] : candidates.map(connectionKey),
          };
        const verified = await setup.verify(id, chosen.sourceId);
        if (signal.aborted) return { state: "error" };
        if (
          verified?.result === "connected" ||
          verified?.result === "configured"
        ) {
          completedNonce = id;
          return {
            state: verified.result === "connected" ? "confirmed" : "configured",
            ticket: result.ticket,
            connectionKey: connectionKey(verified.row),
          };
        }
        const pending = state(setup.current());
        return pending.state === "pending"
          ? {
              ...pending,
              candidateKeys: a.rowId
                ? []
                : accountCandidates(a).map(connectionKey),
            }
          : pending.state === "none"
            ? { state: "error" }
            : pending;
      } catch (error) {
        return failure(error);
      }
    },
    async cancel(id) {
      try {
        const a = setup.current();
        if (a?.nonce !== id && starting?.attemptId !== id)
          return { state: "error" };
        setup.cancel();
        if (a?.nonce !== id && starting?.attemptId === id)
          return {
            state: "cancelled",
            ticket: { ...starting, expiresAt: Date.now() + 600_000 },
          };
        return state(setup.current()) as SetupRead;
      } catch (error) {
        return failure(error);
      }
    },
    async handoff(t, signal) {
      if (signal.aborted) return { state: "error" };
      try {
        const snapshot = await read(),
          a = setup.current();
        if (
          signal.aborted ||
          !a ||
          a.nonce !== t.attemptId ||
          ["expired", "canceled"].includes(a.phase)
        )
          return { state: "error" };
        const action = snapshot.setup.find((s) => s.id === a.actionId);
        const row = a.rowId
          ? snapshot.rows.find((r) => r.sourceId === a.rowId)
          : null;
        if (
          !action ||
          (a.rowId &&
            (!row?.permissions.canConnect || row.setupActionId !== action.id))
        )
          return { state: "error" };
        binding.openSetup(action, a.rowId);
        return { state: "opened" };
      } catch (error) {
        return failure(error);
      }
    },
    async manageDevice(identity, action, signal) {
      if (signal.aborted) return { state: "error" };
      try {
        const snapshot = await read(),
          row = snapshot.rows.find(
            (r) => connectionKey(r) === connectionKey(identity),
          );
        if (
          signal.aborted ||
          !row ||
          row.kind !== "device" ||
          !row.permissions.canInspect ||
          (action === "revoke" && !row.permissions.canRevoke) ||
          (action === "update" && !binding.deviceDetails?.(row)?.canUpdate)
        )
          return { state: "unavailable" };
        return await binding.manageDevice(row, action, signal);
      } catch (error) {
        return failure(error);
      }
    },
    async addDevice(signal) {
      if (signal.aborted) return { state: "error" };
      try {
        const snapshot = await read();
        if (
          signal.aborted ||
          !snapshot.setup.some((a) => a.target.kind === "device")
        )
          return { state: "unavailable" };
        return await binding.addDevice(signal);
      } catch (error) {
        return failure(error);
      }
    },
  };
}
