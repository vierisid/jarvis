import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  CalendarDays,
  FileText,
  Mail,
  MessageSquare,
  Monitor,
  Plug,
  ArrowLeft,
  ArrowUpRight,
  Plus,
  Search,
  ChevronRight,
} from "lucide-react";
import { isBriefCapabilityEnabled } from "../../../../src/brief/capabilities";
import type { BriefRoomModule, BriefShellPort } from "../contracts";
import { BriefButton } from "../components/controls";
import { ConnectionsController } from "./controller";
import {
  connectionKey,
  connectionStatus,
  type ConnectionItem,
  type ServiceIcon,
} from "./model";
import "./connections.css";

export interface ConnectionsBinding {
  controller: ConnectionsController;
  scopeId: string;
  source: "live" | "fixture";
  capabilities?: unknown;
}
export function connectionsAvailable(
  shell: BriefShellPort,
  binding?: ConnectionsBinding,
) {
  return (
    !!binding &&
    binding.controller.scopeId === binding.scopeId &&
    binding.controller.source === binding.source &&
    (shell.mode === "preview"
      ? binding.source === "fixture"
      : binding.source === "live" &&
        isBriefCapabilityEnabled(binding.capabilities, "connections") &&
        isBriefCapabilityEnabled(
          binding.capabilities,
          "navigationCompatibility",
        ))
  );
}
const icons = {
  mail: Mail,
  calendar: CalendarDays,
  document: FileText,
  message: MessageSquare,
  monitor: Monitor,
  service: Plug,
};
export function ConnectionIcon({ icon }: { icon: ServiceIcon }) {
  const Icon = icons[icon];
  return (
    <span className="brief-connection-icon">
      <Icon size={21} aria-hidden="true" />
    </span>
  );
}
export function ConnectedWorkspace({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: ConnectionsBinding;
}) {
  const allowed = connectionsAvailable(shell, binding);
  useLayoutEffect(() => {
    binding?.controller.setAccess(allowed);
  }, [binding?.controller, allowed]);
  if (!binding || !allowed)
    return (
      <section className="brief-connections">
        <h1 className="brief-type-room-title">Connected workspace</h1>
        <p role="status">Connected workspace is unavailable here.</p>
      </section>
    );
  return (
    <ConnectedBody
      key={`${binding.source}:${binding.scopeId}`}
      controller={binding.controller}
    />
  );
}
function ConnectedBody({ controller }: { controller: ConnectionsController }) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const root = useRef<HTMLElement>(null),
    title = useRef<HTMLHeadingElement>(null),
    setupHeading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(state.panel),
    positions = useRef(controller.scrollPositions),
    focus = useRef(new Map<string, HTMLElement>());
  const scroller = () =>
    root.current?.closest<HTMLElement>(".brief-workspace-content");
  useLayoutEffect(() => {
    const parent = scroller();
    if (parent) parent.scrollTop = positions.current.get(state.panel) ?? 0;
  }, []);
  useLayoutEffect(() => {
    if (previous.current !== state.panel) {
      const parent = scroller();
      if (parent) parent.scrollTop = positions.current.get(state.panel) ?? 0;
      const target = focus.current.get(state.panel);
      if (target?.isConnected && !target.closest("[hidden]"))
        target.focus({ preventScroll: true });
      else title.current?.focus({ preventScroll: true });
      previous.current = state.panel;
    }
  }, [state.panel]);
  useEffect(() => {
    const returned = () => {
      const current = controller.snapshot();
      if (
        current.panel === "setup" &&
        ["pending", "unknown"].includes(current.setupState)
      )
        void controller.check();
    };
    window.addEventListener("focus", returned);
    return () => window.removeEventListener("focus", returned);
  }, [controller]);
  useLayoutEffect(() => {
    if (
      ["confirmed", "configured", "cancelled", "expired", "unknown"].includes(
        state.setupState,
      )
    )
      setupHeading.current?.focus({ preventScroll: true });
  }, [state.setupState]);
  const data = "data" in state.read ? state.read.data : null;
  const stale = state.read.state === "stale";
  const usable = state.read.state === "ready" && !state.busy;
  const active =
    state.setupState === "unknown" ||
    (!!state.attemptId &&
      !["expired", "cancelled", "confirmed", "configured"].includes(
        state.setupState,
      ));
  const devices =
    data?.connections.filter((row) => row.identity.kind === "device") ?? [];
  const services =
    data?.connections.filter((row) => row.identity.kind !== "device") ?? [];
  const selectedDevice = devices.find(
    (row) => connectionKey(row.identity) === state.deviceKey,
  );
  const reconnectAccount = data?.connections.find(
    (row) => connectionKey(row.identity) === state.reconnectKey,
  );
  const row = (item: ConnectionItem) => {
    const key = connectionKey(item.identity),
      status = connectionStatus(item, stale),
      device = item.identity.kind === "device";
    return (
      <li className="brief-connection-row" key={key} data-connection-key={key}>
        <ConnectionIcon icon={item.icon} />
        <div className="brief-connection-label">
          <strong>{item.name}</strong>
          <span>
            {item.accountLabel ??
              item.detail ??
              (device ? "Device details unavailable" : "Account not reported")}
          </span>
          {item.device?.updateLabel && <small>{item.device.updateLabel}</small>}
        </div>
        <span className="brief-connection-status" data-tone={status.tone}>
          <i aria-hidden="true" />
          {status.text}
        </span>
        <div className="brief-connection-actions">
          {device && item.identity.permissions.canInspect && (
            <BriefButton
              variant="text"
              size="sm"
              aria-label={`Manage ${item.name}`}
              disabled={!usable}
              onClick={() => controller.device(key)}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </BriefButton>
          )}
          {!device &&
            item.setupServiceId &&
            item.identity.permissions.canConnect &&
            status.text !== "Connected" && (
              <BriefButton
                variant="text"
                size="sm"
                disabled={
                  !usable ||
                  !data?.catalog.some((s) => s.id === item.setupServiceId)
                }
                onClick={() =>
                  controller.select(
                    item.setupServiceId!,
                    item.identity.kind === "library_piece" ? null : key,
                  )
                }
              >
                {item.identity.kind === "library_piece"
                  ? "Set up"
                  : item.observedStatus === "configured"
                    ? "Edit setup"
                    : "Reconnect"}
              </BriefButton>
            )}
        </div>
      </li>
    );
  };
  return (
    <section
      className="brief-connections"
      ref={root}
      onClickCapture={(event) => {
        positions.current.set(state.panel, scroller()?.scrollTop ?? 0);
        const target = (event.target as HTMLElement).closest<HTMLElement>(
          "button, input, a",
        );
        if (target) focus.current.set(state.panel, target);
      }}
    >
      <header className="brief-connections-heading">
        {state.panel !== "workspace" && (
          <BriefButton
            variant="text"
            size="sm"
            disabled={state.busy || active}
            onClick={() => controller.back()}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            {state.panel === "setup" &&
            !state.reconnectKey &&
            !["confirmed", "configured"].includes(state.setupState)
              ? "All services"
              : "Connected workspace"}
          </BriefButton>
        )}
        <h1 className="brief-type-room-title" tabIndex={-1} ref={title}>
          {state.panel === "catalog"
            ? "Connect a service"
            : state.panel === "setup"
              ? (state.service?.name ?? "Service setup")
              : state.panel === "device"
                ? (selectedDevice?.name ?? "Device")
                : "Connected workspace"}
        </h1>
      </header>
      {state.read.state === "loading" ? (
        <p role="status" className="brief-connections-empty">
          Loading devices and services…
        </p>
      ) : !data ? (
        <div className="brief-connections-empty">
          <h2>Connections aren’t available</h2>
          <p role="status">
            {state.read.state === "unsupported"
              ? "This workspace does not provide Connected workspace yet."
              : "Could not verify devices or connected accounts. Try refreshing."}
          </p>
          <BriefButton
            variant="secondary"
            disabled={state.busy}
            onClick={() => void controller.refresh(true)}
          >
            Refresh
          </BriefButton>
        </div>
      ) : (
        <>
          {stale && (
            <p role="status" className="brief-connections-notice">
              These details need a refresh. Setup and device actions are
              unavailable until then.
            </p>
          )}
          <div hidden={state.panel !== "workspace"}>
            <section aria-labelledby="connected-devices-heading">
              <div className="brief-connections-section-heading">
                <h2 id="connected-devices-heading">Devices</h2>
                <BriefButton
                  variant="text"
                  size="sm"
                  disabled={!usable}
                  onClick={() => void controller.addDevice()}
                >
                  Add a device
                  <ArrowUpRight size={14} aria-hidden="true" />
                </BriefButton>
              </div>
              {devices.length ? (
                <ul className="brief-connections-list">{devices.map(row)}</ul>
              ) : (
                <p className="brief-connections-empty">
                  No devices have been reported. Add a device to connect this
                  workspace to your computer.
                </p>
              )}
            </section>
            <section aria-labelledby="connected-services-heading">
              <div className="brief-connections-section-heading">
                <h2 id="connected-services-heading">Services</h2>
                <BriefButton
                  variant="primary"
                  disabled={!usable || active}
                  onClick={() => controller.catalog()}
                >
                  <Plus size={15} aria-hidden="true" />
                  Connect a service
                </BriefButton>
              </div>
              {services.length ? (
                <ul className="brief-connections-list">{services.map(row)}</ul>
              ) : (
                <p className="brief-connections-empty">
                  No connected services yet. Choose a service to set it up.
                </p>
              )}
            </section>
            <div className="brief-connections-refresh">
              <BriefButton
                variant="text"
                size="sm"
                disabled={state.busy}
                onClick={() =>
                  void controller.refresh(
                    state.setupState === "unknown" && !state.attemptId,
                  )
                }
              >
                Refresh status
              </BriefButton>
            </div>
          </div>
          {!!data.unavailableSources?.length && (
            <p role="status">
              Some sources could not be refreshed:{" "}
              {data.unavailableSources.join(", ")}. Their missing rows do not
              mean they are disconnected.
            </p>
          )}
          <div hidden={state.panel !== "catalog"}>
            <p className="brief-connections-intro">
              Choose a service to connect to your workspace.
            </p>
            <label className="brief-connections-search">
              <Search size={18} aria-hidden="true" />
              <span className="brief-connections-sr-only">Search services</span>
              <input
                type="search"
                aria-label="Search services"
                placeholder="Search services"
                value={state.search}
                onChange={(e) => controller.setSearch(e.target.value)}
              />
            </label>
            <ul className="brief-connections-catalog">
              {data.catalog
                .filter((service) =>
                  `${service.name} ${service.description}`
                    .toLocaleLowerCase()
                    .includes(state.search.toLocaleLowerCase()),
                )
                .map((service) => (
                  <li key={service.id}>
                    <button
                      className="brief-connections-catalog-row"
                      disabled={!usable}
                      onClick={() => controller.select(service.id)}
                      data-service-id={service.id}
                    >
                      <ConnectionIcon icon={service.icon} />
                      <span>
                        <strong>{service.name}</strong>
                        <small>{service.description}</small>
                      </span>
                      <ArrowUpRight size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
            </ul>
            {!data.catalog.length ? (
              <p className="brief-connections-empty">
                No supported service setup is available here yet.
              </p>
            ) : (
              !data.catalog.some((service) =>
                `${service.name} ${service.description}`
                  .toLocaleLowerCase()
                  .includes(state.search.toLocaleLowerCase()),
              ) && (
                <p className="brief-connections-empty" role="status">
                  No services match this search.
                </p>
              )
            )}
          </div>
          {state.panel === "setup" && (state.service || state.attemptId) && (
            <div className="brief-connections-setup">
              <div className="brief-connections-service">
                <ConnectionIcon icon={state.service?.icon ?? "service"} />
                <div>
                  <h2>{state.service?.name ?? "Service unavailable"}</h2>
                  <p>
                    {state.service?.description ??
                      "This service is no longer available. You can cancel this setup and return to Connected workspace."}
                  </p>
                  {reconnectAccount && (
                    <p>
                      Reconnecting{" "}
                      {reconnectAccount.accountLabel ??
                        reconnectAccount.identity.accountId ??
                        "this account"}
                    </p>
                  )}
                </div>
              </div>
              {state.setupState === "idle" ? (
                <>
                  <h3 ref={setupHeading} tabIndex={-1}>
                    {state.reconnectKey
                      ? "Reconnect your account"
                      : `Connect ${state.service?.name ?? "service"}`}
                  </h3>
                  <p>
                    {state.service?.setup === "browser"
                      ? "Continue in your browser to choose an account and review access. You’ll return here to check the connection."
                      : "Open service settings to enter your credentials and finish setup."}
                  </p>
                  <BriefButton
                    variant="primary"
                    disabled={!usable || !state.service}
                    onClick={() => void controller.start()}
                  >
                    Start setup
                  </BriefButton>
                </>
              ) : ["confirmed", "configured"].includes(state.setupState) ? (
                <>
                  <h3 ref={setupHeading} tabIndex={-1}>
                    {state.setupState === "configured"
                      ? "Credentials saved"
                      : "Connection confirmed"}
                  </h3>
                  <p>
                    {state.setupState === "configured"
                      ? "The credentials are configured. This does not verify authentication with the service."
                      : "Your account was verified. It is now available in Connected workspace."}
                  </p>
                  <BriefButton
                    variant="primary"
                    disabled={state.busy}
                    onClick={() => controller.back()}
                  >
                    Done
                  </BriefButton>
                </>
              ) : state.setupState === "expired" ||
                state.setupState === "cancelled" ? (
                <>
                  <h3 ref={setupHeading} tabIndex={-1}>
                    {state.setupState === "expired"
                      ? "Setup expired"
                      : "Setup canceled"}
                  </h3>
                  <p>
                    {state.setupState === "expired"
                      ? "Start a fresh setup to continue with this service."
                      : "You can choose another service or start again."}
                  </p>
                  <BriefButton
                    variant="primary"
                    disabled={!usable || !state.service}
                    onClick={() => void controller.start()}
                  >
                    Start again
                  </BriefButton>
                </>
              ) : (
                <>
                  <h3 ref={setupHeading} tabIndex={-1}>
                    {state.setupState === "unknown"
                      ? "Connection not verified"
                      : "Finish connecting your account"}
                  </h3>
                  <p>
                    Finish setup in your browser or service settings. We’ll show
                    this account as connected once the service confirms it.
                  </p>
                  {state.ticket && (
                    <p className="brief-connections-note">
                      Setup expires{" "}
                      {new Date(state.ticket.expiresAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      .
                    </p>
                  )}
                  {!!state.candidateKeys.length && (
                    <label className="brief-connections-account">
                      Account to verify
                      <select
                        aria-label="Account to verify"
                        value={state.selectedKey}
                        onChange={(event) =>
                          controller.selectAccount(event.target.value)
                        }
                      >
                        <option value="">Choose the account you set up</option>
                        {state.candidateKeys.map((key) => {
                          const item = data.connections.find(
                            (r) => connectionKey(r.identity) === key,
                          );
                          return (
                            item && (
                              <option key={key} value={key}>
                                {item.name} ·{" "}
                                {item.accountLabel ?? item.identity.sourceId}
                              </option>
                            )
                          );
                        })}
                      </select>
                    </label>
                  )}
                  <div className="brief-connections-buttons">
                    {state.ticket &&
                      state.service &&
                      state.setupState === "pending" && (
                        <BriefButton
                          variant="primary"
                          disabled={state.busy}
                          onClick={() => void controller.handoff()}
                        >
                          {state.service.setup === "browser"
                            ? "Continue in browser"
                            : "Open service settings"}
                          <ArrowUpRight size={16} aria-hidden="true" />
                        </BriefButton>
                      )}
                    <BriefButton
                      variant="secondary"
                      disabled={state.busy}
                      onClick={() => void controller.check()}
                    >
                      Check connection
                    </BriefButton>
                    <BriefButton
                      variant="text"
                      disabled={state.canceling}
                      onClick={() => void controller.cancel()}
                    >
                      Cancel setup
                    </BriefButton>
                  </div>
                </>
              )}
            </div>
          )}
          {state.panel === "device" &&
            (selectedDevice ? (
              <div className="brief-connections-setup">
                <div className="brief-connections-service">
                  <ConnectionIcon icon={selectedDevice.icon} />
                  <div>
                    <h2>{selectedDevice.name}</h2>
                    <p>
                      {selectedDevice.accountLabel ?? selectedDevice.detail}
                    </p>
                  </div>
                </div>
                <dl className="brief-connections-device">
                  <div>
                    <dt>Status</dt>
                    <dd>{connectionStatus(selectedDevice, stale).text}</dd>
                  </div>
                  <div>
                    <dt>Version</dt>
                    <dd>{selectedDevice.device?.version ?? "Not reported"}</dd>
                  </div>
                </dl>
                {selectedDevice.device?.updateLabel && (
                  <p>{selectedDevice.device.updateLabel}</p>
                )}
                <p>
                  Open device settings to review configuration, update this
                  device or revoke its access.
                </p>
                <div className="brief-connections-buttons">
                  <BriefButton
                    variant="secondary"
                    disabled={!usable}
                    onClick={() => void controller.manageDevice("inspect")}
                  >
                    Device settings
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </BriefButton>
                  {selectedDevice.device?.canUpdate && (
                    <BriefButton
                      variant="secondary"
                      disabled={!usable}
                      onClick={() => void controller.manageDevice("update")}
                    >
                      Update device
                    </BriefButton>
                  )}
                  {selectedDevice.identity.permissions.canRevoke && (
                    <BriefButton
                      variant="text"
                      disabled={!usable}
                      onClick={() => void controller.manageDevice("revoke")}
                    >
                      Revoke access
                    </BriefButton>
                  )}
                </div>
              </div>
            ) : (
              <p role="status">
                This device is no longer available. Return to Connected
                workspace for its current status.
              </p>
            ))}
        </>
      )}
      <p
        role="status"
        aria-live="polite"
        className="brief-connections-feedback"
      >
        {state.message || (state.busy ? "Checking workspace…" : "")}
      </p>
    </section>
  );
}
export function connectionsRegistration(
  useBinding: () => ConnectionsBinding | undefined,
): BriefRoomModule {
  return {
    id: "connected-workspace",
    title: "Connected workspace",
    legacyRoom: "settings",
    Body: ({ shell }) => (
      <ConnectedWorkspace shell={shell} binding={useBinding()} />
    ),
  };
}
