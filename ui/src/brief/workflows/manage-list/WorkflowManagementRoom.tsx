import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ArrowLeft, Trash2, RefreshCw } from "lucide-react";
import type { BriefRoomModule, BriefShellPort } from "../../contracts";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import {
  BriefButton,
  BriefIconButton,
  BriefSwitch,
} from "../../components/controls";
import type {
  ManagementSlot,
  WorkflowManagementController,
} from "./controller";
import type { ManagedWorkflow } from "./model";
import "./management.css";
export interface WorkflowManagementBinding {
  source: "fixture" | "live";
  scopeId: string;
  capabilities: unknown;
  controller: WorkflowManagementController;
}
export function managementAvailable(
  shell: BriefShellPort,
  b?: WorkflowManagementBinding,
): b is WorkflowManagementBinding {
  return (
    !!b &&
    !!b.scopeId.trim() &&
    b.scopeId === b.controller.scopeId &&
    b.controller.active &&
    b.source === b.controller.source &&
    b.source === (shell.mode === "preview" ? "fixture" : "live") &&
    isBriefCapabilityEnabled(b.capabilities, "workflowRemoval")
  );
}
export function WorkflowManagementRoom({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: WorkflowManagementBinding;
}) {
  const available = managementAvailable(shell, binding);
  useLayoutEffect(() => {
    binding?.controller.setAccess(available);
  }, [binding?.controller, available]);
  if (!available)
    return (
      <section className="brief-management">
        <h1 className="brief-type-room-title">All workflows</h1>
        <p role="status">Workflow management is unavailable.</p>
        <BriefButton
          onClick={() => shell.navigate({ room: "workflows", selection: {} })}
        >
          Back to workflow creation
        </BriefButton>
      </section>
    );
  return (
    <BoundManagement key={binding.scopeId} shell={shell} binding={binding} />
  );
}
function BoundManagement({
  shell,
  binding: b,
}: {
  shell: BriefShellPort;
  binding: WorkflowManagementBinding;
}) {
  const store = b.controller,
    state = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );
  const root = useRef<HTMLElement>(null),
    restore = useRef({ done: false, top: state.scrollTop });
  const [now, setNow] = useState(Date.now);
  const removed = state.rows.filter((r) => r.removed),
    visible = state.rows.filter((r) => !r.removed);
  useEffect(() => {
    void store.load();
  }, [store]);
  useEffect(() => {
    if (!removed.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [removed.length]);
  useLayoutEffect(() => {
    const scroll = root.current?.querySelector<HTMLElement>(
      ".brief-management-scroll",
    );
    if (!scroll) return;
    const save = () => {
      if (restore.current.done) store.savePosition(scroll.scrollTop);
    };
    scroll.addEventListener("scroll", save, { passive: true });
    return () => scroll.removeEventListener("scroll", save);
  }, [store]);
  useLayoutEffect(() => {
    const scroll = root.current?.querySelector<HTMLElement>(
      ".brief-management-scroll",
    );
    if (
      !scroll ||
      restore.current.done ||
      !["ready", "stale", "empty"].includes(state.read.status)
    )
      return;
    const frame = requestAnimationFrame(() => {
      scroll.scrollTop = restore.current.top;
      restore.current.done = true;
      if (state.selectedId)
        root.current
          ?.querySelector<HTMLElement>(
            `[data-flow="${CSS.escape(state.selectedId)}"] .brief-management-open`,
          )
          ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [state.read.status, store]);
  function open(item: ManagedWorkflow) {
    store.savePosition(
      root.current?.querySelector<HTMLElement>(".brief-management-scroll")
        ?.scrollTop ?? 0,
      item.flowId,
    );
    shell.navigate({
      room: "workflow",
      selection: {
        flowId: item.flowId,
        ...(item.versionId ? { versionId: item.versionId } : {}),
      },
    });
  }
  const focusOwner = useRef<string | null>(null);
  function recordFocus(e: React.SyntheticEvent) {
    const el = e.target as HTMLElement;
    focusOwner.current =
      el.closest<HTMLElement>("[data-flow]")?.dataset.flow ??
      el.closest<HTMLElement>("[data-undo]")?.dataset.undo ??
      null;
  }
  function restoreFocus(id: string, target: "undo" | "open" | "bin") {
    const active = document.activeElement;
    const activeId =
      (active as HTMLElement | null)?.closest<HTMLElement>("[data-flow]")
        ?.dataset.flow ??
      (active as HTMLElement | null)?.closest<HTMLElement>("[data-undo]")
        ?.dataset.undo;
    if (
      focusOwner.current !== id ||
      (active !== document.body && activeId !== id)
    )
      return;
    const selector =
      target === "undo"
        ? `[data-undo="${CSS.escape(id)}"] button`
        : `[data-flow="${CSS.escape(id)}"] .brief-management-${target}`;
    const control = root.current?.querySelector<HTMLElement>(selector);
    control?.focus({ preventScroll: true });
    if (target === "undo" && control) {
      const list = control.closest<HTMLElement>(".brief-management-undo-list");
      if (list) {
        const a = control.getBoundingClientRect(),
          b = list.getBoundingClientRect();
        if (a.bottom > b.bottom) list.scrollTop += a.bottom - b.bottom;
        else if (a.top < b.top) list.scrollTop += a.top - b.top;
      }
    }
  }
  return (
    <section
      ref={root}
      onFocusCapture={recordFocus}
      onClickCapture={recordFocus}
      className="brief-management"
      aria-labelledby="brief-management-title"
    >
      <h1 id="brief-management-title" className="brief-type-room-title">
        All workflows
      </h1>
      <BriefButton
        variant="text"
        icon={<ArrowLeft size={15} />}
        onClick={() => {
          store.savePosition(
            root.current?.querySelector<HTMLElement>(".brief-management-scroll")
              ?.scrollTop ?? 0,
          );
          shell.navigate({ room: "workflows", selection: {} });
        }}
      >
        Back to workflow creation
      </BriefButton>
      <div className="brief-management-meta">
        <span aria-live="polite">
          {state.read.status === "ready" || state.read.status === "empty"
            ? `${visible.length} ${visible.length === 1 ? "workflow" : "workflows"}`
            : state.read.status === "loading"
              ? "Loading workflows…"
              : "Workflows"}
        </span>
        <BriefIconButton
          label="Refresh workflows"
          icon={<RefreshCw size={15} />}
          disabled={!store.canRefresh || state.refreshing}
          onClick={() => void store.refresh()}
        />
      </div>
      {state.read.status !== "ready" && state.read.status !== "empty" && (
        <p role="status" className="brief-management-notice">
          {state.read.status === "loading"
            ? "Loading the list…"
            : state.read.status === "stale"
              ? "This list may be out of date. Refresh before making changes."
              : state.read.status === "unsupported"
                ? "This connection does not support workflow management."
                : "Workflows could not be loaded. Your pending changes are retained."}
        </p>
      )}
      <div
        className="brief-management-scroll"
        tabIndex={0}
        aria-label="Workflow list"
      >
        <div
          className="brief-management-table"
          role="table"
          aria-label="Workflow management"
        >
          <div className="brief-management-head" role="row">
            <span role="columnheader">Workflow</span>
            <span role="columnheader">Runs when</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Latest run</span>
            <span role="columnheader" className="brief-sr-only">
              Actions
            </span>
          </div>
          <div role="rowgroup">
            {state.rows.map((r) => (
              <WorkflowRow
                key={r.item.flowId}
                row={r}
                store={store}
                open={() => open(r.item)}
                remove={() => void store.remove(r.item.flowId)}
                restoreFocus={restoreFocus}
              />
            ))}
          </div>
        </div>
        {(state.read.status === "empty" || state.read.status === "ready") &&
          !visible.length && (
            <p className="brief-management-empty">No workflows in this list.</p>
          )}
      </div>
      <div
        className="brief-management-undo-list"
        aria-label="Recently deleted workflows"
      >
        {removed.map((r) => (
          <div
            key={r.item.flowId}
            className="brief-management-undo"
            data-undo={r.item.flowId}
          >
            <div>
              <strong>{r.item.name}</strong>
              <p role="status">
                {r.phase === "uncertain"
                  ? r.message
                  : r.phase === "pending"
                    ? "Checking restoration…"
                    : r.receipt && r.receipt.expiresAt <= now
                      ? "Deleted. Undo has expired."
                      : r.message}
              </p>
            </div>
            {r.phase === "uncertain" ? (
              <BriefButton
                size="sm"
                disabled={!store.canReconcile(r.item.flowId)}
                onClick={() => void store.reconcile(r.item.flowId)}
              >
                Check result
              </BriefButton>
            ) : (
              <BriefButton
                size="sm"
                disabled={
                  !store.canChange(r.item.flowId) ||
                  !r.receipt ||
                  r.receipt.expiresAt <= now
                }
                state={r.phase === "pending" ? "pending" : "idle"}
                onClick={() => void store.restore(r.item.flowId)}
                aria-label={`Undo delete ${r.item.name}`}
              >
                Undo
              </BriefButton>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
function WorkflowRow({
  row: r,
  store,
  open,
  remove,
  restoreFocus,
}: {
  row: ManagementSlot;
  store: WorkflowManagementController;
  open: () => void;
  remove: () => void;
  restoreFocus: (id: string, target: "undo" | "open" | "bin") => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  const previous = useRef({ confirming: r.confirming, removed: r.removed });
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = { confirming: r.confirming, removed: r.removed };
    if (r.removed && !old.removed) restoreFocus(r.item.flowId, "undo");
    else if (!r.removed && old.removed) restoreFocus(r.item.flowId, "open");
    else if (r.confirming && !old.confirming)
      cancel.current?.focus({ preventScroll: true });
    else if (!r.confirming && old.confirming && !r.removed)
      restoreFocus(r.item.flowId, "bin");
  }, [r.confirming, r.removed, r.item.flowId]);
  function cancelDelete() {
    store.cancel(r.item.flowId);
  }
  const w = r.item,
    locked = !store.canChange(w.flowId);
  return (
    <div
      className="brief-management-collapse"
      data-removed={r.removed}
      aria-hidden={r.removed || undefined}
      inert={r.removed || undefined}
    >
      <div className="brief-management-clip">
        <div
          ref={ref}
          role="row"
          data-flow={w.flowId}
          data-confirming={r.confirming}
          className="brief-management-row"
          onKeyDown={(e) => {
            if (e.key === "Escape" && r.confirming && r.phase === "idle") {
              e.preventDefault();
              cancelDelete();
            }
          }}
        >
          <div role="cell" className="brief-management-name">
            {r.confirming ? (
              <strong>{w.name}</strong>
            ) : (
              <button
                type="button"
                className="brief-management-open"
                onClick={open}
              >
                {w.name}
              </button>
            )}
            <p className="brief-management-description">
              {r.confirming ? "Delete this workflow?" : w.description}
            </p>
            {!r.confirming &&
              (w.publication === "unpublished" ||
                w.readiness.state !== "ready") && (
                <p className="brief-management-readiness">
                  {w.publication === "unpublished" ? "Unpublished · " : ""}
                  {w.readiness.state === "blocked"
                    ? (w.readiness.reason ?? "Needs setup")
                    : w.readiness.state === "unknown"
                      ? "Readiness unknown"
                      : "Ready"}
                </p>
              )}
          </div>
          {r.confirming ? (
            <div role="cell" className="brief-management-confirm">
              <BriefButton
                ref={cancel}
                size="sm"
                disabled={r.phase !== "idle"}
                onClick={cancelDelete}
              >
                Cancel
              </BriefButton>
              <BriefButton
                size="sm"
                variant="danger"
                disabled={locked}
                state={r.phase === "pending" ? "pending" : "idle"}
                stateLabels={{ pending: "Deleting…" }}
                onClick={remove}
              >
                Delete
              </BriefButton>
            </div>
          ) : (
            <>
              <div role="cell" className="brief-management-trigger">
                <span className="brief-management-mobile-label">Runs when</span>
                {w.trigger || "Not configured"}
              </div>
              <div role="cell" className="brief-management-activation">
                <BriefSwitch
                  label={`Enable ${w.name}`}
                  checked={w.activation === "ENABLED"}
                  onCheckedChange={(v) => void store.activate(w.flowId, v)}
                  disabled={locked}
                  onLabel="Enabled"
                  offLabel="Paused"
                />
              </div>
              <div role="cell" className="brief-management-latest">
                <span className="brief-management-mobile-label">
                  Latest run
                </span>
                {w.latestRun?.label ?? "Never run"}
              </div>
              <div role="cell" className="brief-management-actions">
                <BriefIconButton
                  label={`Delete ${w.name}`}
                  className="brief-management-bin"
                  icon={<Trash2 size={16} />}
                  intent="destructive"
                  disabled={locked}
                  onClick={() => store.confirm(w.flowId)}
                />
              </div>
            </>
          )}
          <div className="brief-management-row-feedback" role="cell">
            <span role="status">
              {r.phase === "pending"
                ? r.command?.action === "activation"
                  ? "Updating status…"
                  : "Waiting for confirmation…"
                : r.message}
            </span>
            {r.phase === "uncertain" && (
              <BriefButton
                size="sm"
                disabled={!store.canReconcile(w.flowId)}
                onClick={() => void store.reconcile(w.flowId)}
              >
                Check result
              </BriefButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
export function workflowManagementRegistration(
  useBinding: (shell: BriefShellPort) => WorkflowManagementBinding | undefined,
): BriefRoomModule {
  return {
    id: "all-workflows",
    title: "All workflows",
    legacyRoom: "workflows",
    Body: ({ shell }) => (
      <WorkflowManagementRoom shell={shell} binding={useBinding(shell)} />
    ),
  };
}
