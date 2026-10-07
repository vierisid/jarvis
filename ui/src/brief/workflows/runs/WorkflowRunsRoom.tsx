import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { Check, Circle, RefreshCw } from "lucide-react";
import type {
  BriefReadState,
  BriefRoomModule,
  BriefShellPort,
} from "../../contracts";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import { BriefButton } from "../../components/controls";
import { WorkflowViewHeader } from "./WorkflowViewHeader";
import { WorkflowRunsController } from "./controller";
import { STATUS, type RunDetail, type RunStatus } from "./model";
import "../canvas/canvas.css";
import "./runs.css";
export interface WorkflowRunsBinding {
  source: "live" | "fixture";
  scopeId: string;
  flowId: string;
  versionId: string;
  title: string;
  capabilities: unknown;
  controller: WorkflowRunsController;
}
export function runsAvailable(
  shell: BriefShellPort,
  b?: WorkflowRunsBinding,
): b is WorkflowRunsBinding {
  return (
    !!b &&
    !!b.scopeId.trim() &&
    !!b.flowId.trim() &&
    !!b.versionId.trim() &&
    !!b.title.trim() &&
    b.source === (shell.mode === "preview" ? "fixture" : "live") &&
    shell.route.selection.flowId === b.flowId &&
    (!shell.route.selection.versionId ||
      shell.route.selection.versionId === b.versionId) &&
    b.controller.scope.scopeId === b.scopeId &&
    b.controller.scope.flowId === b.flowId &&
    b.controller.scope.versionId === b.versionId &&
    isBriefCapabilityEnabled(b.capabilities, "workflowContext")
  );
}
export function WorkflowRunsRoom({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: WorkflowRunsBinding;
}) {
  if (!runsAvailable(shell, binding))
    return (
      <section>
        <h1 className="brief-type-room-title">Runs</h1>
        <p role="status">Run inspection is unavailable for this workflow.</p>
      </section>
    );
  return (
    <BoundRuns
      key={JSON.stringify([binding.scopeId, binding.flowId, binding.versionId])}
      shell={shell}
      binding={binding}
    />
  );
}
function BoundRuns({
  shell,
  binding: b,
}: {
  shell: BriefShellPort;
  binding: WorkflowRunsBinding;
}) {
  const store = b.controller,
    state = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );
  const list = useRef<HTMLDivElement>(null),
    detail = useRef<HTMLElement>(null);
  const history =
    state.history.status === "ready" || state.history.status === "stale"
      ? state.history.data
      : null;
  const inspected =
    state.detail.status === "ready" || state.detail.status === "stale"
      ? state.detail.data
      : null;
  useEffect(() => {
    if (store.getSnapshot().history.status === "loading")
      void store.load(shell.route.selection.runId);
  }, [store]);
  useEffect(() => {
    if (shell.route.selection.runId) store.select(shell.route.selection.runId);
  }, [store, shell.route.selection.runId]);
  // Poll read projections only. Never repeat a command, and retain the selected ID.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void store.refresh();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [store]);
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = store.position("history");
  }, [store]);
  useLayoutEffect(() => {
    if (detail.current && inspected?.runId === state.selectedId)
      detail.current.scrollTop = store.position(`detail:${state.selectedId}`);
  }, [store, state.selectedId, inspected?.runId]);
  function select(id: string) {
    store.select(id);
    shell.navigate({
      room: "workflow-runs",
      selection: { flowId: b.flowId, versionId: b.versionId, runId: id },
    });
  }
  async function start() {
    await store.start();
    const latest = store.getSnapshot();
    if (latest.submission === "accepted" && latest.selectedId) {
      // The originating room owns this navigation; a later owner/room must not
      // be pulled back by a slow command acknowledgement.
      if (mounted.current) select(latest.selectedId);
    }
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <section className="brief-workflow-runs" aria-label="Workflow run history">
      <WorkflowViewHeader
        shell={shell}
        flowId={b.flowId}
        versionId={b.versionId}
        active="runs"
        title={<h1>{b.title}</h1>}
        runAction={
          <BriefButton
            variant="primary"
            onClick={() => void start()}
            disabled={!store.canRun}
          >
            {state.submission === "pending" ? "Requesting…" : "Run workflow"}
          </BriefButton>
        }
      />
      <div className="brief-runs-feedback" role="status">
        {state.message}
      </div>
      <div className="brief-runs-columns">
        <section className="brief-runs-history" aria-label="Run history">
          <div className="brief-runs-history-heading">
            <h2>Run history</h2>
            <BriefButton
              size="sm"
              icon={<RefreshCw size={16} />}
              aria-label="Refresh run history"
              onClick={() => void store.refresh()}
            />
          </div>
          <p className="brief-runs-count">
            {history
              ? history.total === null
                ? `${history.items.length} runs loaded`
                : `${history.total} ${history.total === 1 ? "execution" : "executions"}`
              : "Run history"}
          </p>
          <div className="brief-runs-row-head" aria-hidden="true">
            <span>Run</span>
            <span>Started</span>
            <span>Status</span>
          </div>
          <div
            ref={list}
            className="brief-runs-list"
            onScroll={(e) =>
              store.rememberPosition("history", e.currentTarget.scrollTop)
            }
          >
            {history?.items.map((run) => (
              <button
                type="button"
                key={run.runId}
                className="brief-runs-row"
                data-selected={state.selectedId === run.runId}
                aria-current={
                  state.selectedId === run.runId ? "true" : undefined
                }
                aria-label={`Open ${run.label}`}
                onClick={() => select(run.runId)}
              >
                <strong>{run.label}</strong>
                <time>{date(run.startedAt)}</time>
                <Status status={run.status} />
              </button>
            ))}
            {state.history.status !== "ready" && (
              <ReadFeedback
                state={state.history}
                empty="No runs yet."
                retry={() => void store.refresh()}
              />
            )}
            {history?.items.length === 0 && <p>No runs yet.</p>}
            {history?.nextCursor && (
              <BriefButton
                size="sm"
                onClick={() => void store.more()}
                disabled={state.loadingMore}
              >
                {state.loadingMore ? "Loading…" : "Load earlier runs"}
              </BriefButton>
            )}
          </div>
        </section>
        <article
          ref={detail}
          className="brief-run-detail"
          aria-label="Selected run details"
          aria-busy={state.detail.status === "loading"}
          onScroll={(e) => {
            if (inspected?.runId === state.selectedId)
              store.rememberPosition(
                `detail:${state.selectedId}`,
                e.currentTarget.scrollTop,
              );
          }}
        >
          {inspected && inspected.runId === state.selectedId ? (
            <RunDocument key={inspected.runId} run={inspected} />
          ) : (
            <div className="brief-run-placeholder">
              <h2>
                {history?.items.find((r) => r.runId === state.selectedId)
                  ?.label ?? "Run details"}
              </h2>
              <ReadFeedback
                state={state.detail}
                empty="Select a run to inspect its outcome."
                retry={() => void store.refresh()}
              />
            </div>
          )}
          {state.detail.status === "stale" && (
            <p role="status" className="brief-runs-notice">
              Inspection may be out of date. Refresh to check its current state.
            </p>
          )}
        </article>
      </div>
    </section>
  );
}
function date(value: number | null) {
  return value === null
    ? "Not started"
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(value);
}
export function Status({ status }: { status: RunStatus | "not_run" }) {
  return (
    <span className="brief-run-status" data-tone={STATUS[status].tone}>
      <i aria-hidden="true" />
      {STATUS[status].label}
    </span>
  );
}
function RunDocument({ run }: { run: RunDetail }) {
  return (
    <div className="brief-run-document" data-run-id={run.runId}>
      <div className="brief-run-document-heading">
        <h2>{run.label}</h2>
        <Status status={run.status} />
      </div>
      <h3 className="brief-run-summary">
        {run.summary || "No outcome recorded yet."}
      </h3>
      <dl className="brief-run-metadata">
        <dt>Trigger</dt>
        <dd>{run.trigger ?? "Not recorded"}</dd>
        <dt>Started</dt>
        <dd>{date(run.startedAt)}</dd>
        <dt>Version</dt>
        <dd>{run.versionId}</dd>
      </dl>
      {run.inspection.status === "partial" && (
        <p className="brief-runs-notice">
          {run.inspection.note || "Some inspection data is unavailable."}
        </p>
      )}
      <h3>Execution</h3>
      <ol className="brief-run-steps">
        {run.steps.map((step) => (
          <li key={step.id}>
            <span
              className="brief-run-step-mark"
              data-tone={STATUS[step.status].tone}
            >
              {step.status === "succeeded" ? (
                <Check size={12} />
              ) : (
                <Circle size={12} />
              )}
            </span>
            <div>
              <div className="brief-run-step-title">
                <strong>{step.title}</strong>
                <Status status={step.status} />
              </div>
              <p>{step.description}</p>
              {step.fields.length > 0 && (
                <details>
                  <summary>Inspect step</summary>
                  <dl>
                    {step.fields.map((field, i) => (
                      <React.Fragment key={i}>
                        <dt>{field.label}</dt>
                        <dd>
                          <pre>{field.redacted ? "Redacted" : field.value}</pre>
                        </dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </details>
              )}
            </div>
          </li>
        ))}
      </ol>
      {run.steps.length === 0 && (
        <p className="brief-runs-muted">No step results recorded yet.</p>
      )}
      {run.effects.length > 0 && (
        <section className="brief-run-evidence">
          <h3>Action receipts</h3>
          {run.effects.map((effect) => (
            <div key={effect.id} className="brief-run-receipt">
              <div>
                <strong>{effect.label}</strong>
                <span>
                  {effect.status === "unknown" ? "Uncertain" : effect.status}
                </span>
              </div>
              <p>{effect.description}</p>
              <small>Receipt {effect.id}</small>
            </div>
          ))}
        </section>
      )}
      {run.waits.length > 0 && (
        <section className="brief-run-evidence">
          <h3>Waitpoints</h3>
          {run.waits.map((wait) => (
            <div key={wait.id} className="brief-run-receipt">
              <div>
                <strong>{wait.label}</strong>
                <span>{wait.status}</span>
              </div>
              <p>{wait.stepName}</p>
              <small>{wait.id}</small>
            </div>
          ))}
        </section>
      )}
      {run.context.length > 0 && (
        <section className="brief-run-evidence">
          <h3>Context used</h3>
          <dl>
            {run.context.map((c, i) => (
              <React.Fragment key={`${c.kind}:${c.id}:${i}`}>
                <dt>{c.kind}</dt>
                <dd>
                  {c.availability === "redacted" ? "Redacted" : c.label}
                  {c.availability === "removed" ? " · No longer available" : ""}
                  <small>{c.id}</small>
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
function ReadFeedback({
  state,
  empty,
  retry,
}: {
  state: BriefReadState<unknown>;
  empty: string;
  retry: () => void;
}) {
  if (state.status === "ready") return null;
  return (
    <div className="brief-runs-read-state" role="status">
      {state.status === "loading" ? (
        <>
          <span className="brief-run-skeleton" />
          <p>Loading…</p>
        </>
      ) : state.status === "empty" ? (
        <p>{empty}</p>
      ) : (
        <>
          <p>
            {state.status === "stale"
              ? "History may be out of date."
              : state.status === "unsupported"
                ? "Run inspection is not supported by this connection."
                : "This information could not be loaded."}
          </p>
          <BriefButton size="sm" onClick={retry}>
            Refresh
          </BriefButton>
        </>
      )}
    </div>
  );
}
export function workflowRunsRegistration(
  useBinding: (shell: BriefShellPort) => WorkflowRunsBinding | undefined,
): BriefRoomModule {
  return {
    id: "workflow-runs",
    title: "Runs",
    legacyRoom: "workflows",
    Body: ({ shell }) => (
      <WorkflowRunsRoom shell={shell} binding={useBinding(shell)} />
    ),
  };
}
