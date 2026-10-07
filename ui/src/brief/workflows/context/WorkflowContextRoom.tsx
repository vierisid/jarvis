import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import type {
  BriefReadState,
  BriefRoomModule,
  BriefShellPort,
} from "../../contracts";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import { BriefButton, BriefSegments } from "../../components/controls";
import { WorkflowViewHeader } from "../runs/WorkflowViewHeader";
import type { WorkflowRunsController } from "../runs/controller";
import { WorkflowContextController } from "./controller";
import {
  queryKey,
  type ContextDocument,
  type ContextEntry,
  type ContextGroup,
  type ContextQuery,
  type ContextSource,
} from "./model";
import "../canvas/canvas.css";
import "./context.css";
export interface WorkflowContextBinding {
  source: "live" | "fixture";
  scopeId: string;
  flowId: string;
  versionId: string;
  title: string;
  capabilities: unknown;
  controller: WorkflowContextController;
  /** Optional shared command owner, the SAME instance used by Runs. */
  runs?: WorkflowRunsController;
  /** Host resolves authorized source IDs, with the current workflow return route. */
  openSource?: (source: ContextSource) => void;
}
export function contextAvailable(
  shell: BriefShellPort,
  b?: WorkflowContextBinding,
): b is WorkflowContextBinding {
  return (
    !!b &&
    !!b.scopeId.trim() &&
    !!b.flowId.trim() &&
    !!b.versionId.trim() &&
    !!b.title.trim() &&
    b.controller.active &&
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
export function WorkflowContextRoom({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: WorkflowContextBinding;
}) {
  if (!contextAvailable(shell, binding))
    return (
      <section>
        <h1 className="brief-type-room-title">Context &amp; rules</h1>
        <p role="status">Context is unavailable for this workflow.</p>
      </section>
    );
  return (
    <BoundContext
      key={JSON.stringify([binding.scopeId, binding.flowId, binding.versionId])}
      shell={shell}
      binding={binding}
    />
  );
}
function BoundContext({
  shell,
  binding: b,
}: {
  shell: BriefShellPort;
  binding: WorkflowContextBinding;
}) {
  const store = b.controller,
    state = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );
  const runId = shell.route.selection.runId;
  const query: ContextQuery =
    state.mode === "recorded" && runId
      ? { basis: "recorded", runId }
      : { basis: "configured" };
  const key = queryKey(query),
    read = store.get(query);
  const doc =
    read.status === "ready" || read.status === "stale" ? read.data : null;
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void store.refresh(query);
  }, [store, key]);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = store.position(query);
  }, [store, key, !!doc]);
  const sharedRuns =
    b.runs &&
    b.runs.scope.scopeId === b.scopeId &&
    b.runs.scope.flowId === b.flowId &&
    b.runs.scope.versionId === b.versionId
      ? b.runs
      : undefined;
  return (
    <section
      className="brief-workflow-context"
      aria-label="Workflow context and rules"
      data-selected-run={runId ?? ""}
    >
      <WorkflowViewHeader
        shell={shell}
        flowId={b.flowId}
        versionId={b.versionId}
        active="context"
        title={<h1>{b.title}</h1>}
        runAction={
          sharedRuns ? (
            <ContextRunAction shell={shell} store={sharedRuns} />
          ) : (
            <BriefButton
              variant="primary"
              disabled
              title="Run is not available"
            >
              Run workflow
            </BriefButton>
          )
        }
      />
      <div className="brief-context-toolbar">
        <BriefSegments
          label="Context basis"
          value={query.basis}
          options={[
            { value: "configured", label: "Configured" },
            { value: "recorded", label: "Used by run", disabled: !runId },
          ]}
          onValueChange={(value) =>
            store.setMode(value as ContextQuery["basis"])
          }
        />
        <span className="brief-context-version">
          {query.basis === "configured"
            ? `Version ${b.versionId}`
            : doc
              ? `${doc.runLabel} · ${doc.versionId}`
              : `Run · ${query.runId}`}
        </span>
        <BriefButton
          size="sm"
          icon={<RefreshCw size={16} />}
          aria-label="Refresh workflow context"
          onClick={() => void store.refresh(query)}
        />
      </div>
      {sharedRuns && <ContextRunFeedback store={sharedRuns} />}
      <div
        className="brief-context-scroll"
        ref={scroll}
        onScroll={(e) =>
          store.rememberPosition(query, e.currentTarget.scrollTop)
        }
        aria-busy={read.status === "loading"}
      >
        {read.status !== "ready" && (
          <ContextFeedback
            state={read}
            recorded={query.basis === "recorded"}
            retry={() => void store.refresh(query)}
          />
        )}
        {doc && (
          <div
            className="brief-context-grid"
            data-context-basis={doc.basis}
            data-context-version={doc.versionId}
            data-context-run={doc.runId ?? ""}
          >
            {(["goal", "memory", "bindings", "rules", "target"] as const).map(
              (group) => (
                <ContextSection
                  key={group}
                  group={group}
                  doc={doc}
                  openSource={b.openSource}
                />
              ),
            )}
          </div>
        )}
      </div>
    </section>
  );
}
const TITLES: Record<ContextGroup, [string, string]> = {
  goal: ["Linked goal", "Goal recorded"],
  memory: ["Context it can use", "Memory recorded"],
  bindings: ["Connections", "Connections recorded"],
  target: ["Execution target", "Target recorded"],
  rules: ["Rules that stay in force", "Rules recorded"],
};
const EMPTY: Record<ContextGroup, string> = {
  goal: "No goal linked.",
  memory: "No memory configured.",
  bindings: "No connections configured.",
  target: "No target configured.",
  rules: "No rules configured.",
};
const AVAILABILITY = {
  available: "",
  missing: "Missing source",
  removed: "Source removed",
  stale: "Needs checking",
  redacted: "Restricted",
};
function ContextSection({
  group,
  doc,
  openSource,
}: {
  group: ContextGroup;
  doc: ContextDocument;
  openSource?: WorkflowContextBinding["openSource"];
}) {
  const state = doc.groups[group],
    recorded = doc.basis === "recorded";
  const rows =
    state.status === "ready" || state.status === "stale" ? state.data : null;
  return (
    <section
      className={`brief-context-card brief-context-${group}`}
      aria-label={TITLES[group][recorded ? 1 : 0]}
    >
      <h2>{TITLES[group][recorded ? 1 : 0]}</h2>
      {state.status === "stale" && (
        <p className="brief-context-notice">This group may be out of date.</p>
      )}
      {rows?.map((entry) => (
        <ContextRow key={entry.id} entry={entry} openSource={openSource} />
      ))}
      {(state.status === "empty" || rows?.length === 0) && (
        <p className="brief-context-muted">
          {recorded ? "None recorded for this run." : EMPTY[group]}
        </p>
      )}
      {state.status !== "ready" &&
        state.status !== "stale" &&
        state.status !== "empty" && (
          <p className="brief-context-muted" role="status">
            {state.status === "loading"
              ? "Loading context…"
              : state.status === "unsupported"
                ? "Not supported by this connection."
                : recorded
                  ? "Recorded usage is unavailable."
                  : "Configured context is unavailable."}
          </p>
        )}
    </section>
  );
}
function ContextRow({
  entry: e,
  openSource,
}: {
  entry: ContextEntry;
  openSource?: WorkflowContextBinding["openSource"];
}) {
  const canOpen =
    !!e.source &&
    !!openSource &&
    (e.availability === "available" || e.availability === "stale");
  return (
    <div className="brief-context-row" data-availability={e.availability}>
      <div className="brief-context-row-heading">
        <h3>{e.label}</h3>
        {e.availability !== "available" && (
          <span className="brief-context-status">
            <i aria-hidden="true" />
            {AVAILABILITY[e.availability]}
          </span>
        )}
      </div>
      {e.value && <p>{e.value}</p>}
      {e.source && (
        <div className="brief-context-source">
          {canOpen ? (
            <button
              type="button"
              className="brief-context-source-link"
              title={e.source.id}
              onClick={() => openSource!(e.source!)}
              aria-label={`Open ${e.source.kind} ${e.source.id}`}
            >
              <span>
                Open{" "}
                {e.source.kind === "fact"
                  ? "memory"
                  : e.source.kind === "rule"
                    ? "authority"
                    : e.source.kind === "workflow"
                      ? "workflow settings"
                      : e.source.kind === "step"
                        ? "in canvas"
                        : e.source.kind}
              </span>
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          ) : null}
          <span className="brief-context-source-id">{e.source.id}</span>
        </div>
      )}
    </div>
  );
}
function ContextFeedback({
  state,
  recorded,
  retry,
}: {
  state: BriefReadState<unknown>;
  recorded: boolean;
  retry: () => void;
}) {
  return (
    <div className="brief-context-feedback" role="status">
      {state.status === "loading" ? (
        <>
          <div className="brief-context-skeleton" />
          <p>Loading context…</p>
        </>
      ) : (
        <>
          <p>
            {state.status === "empty"
              ? recorded
                ? "No context was recorded for this run."
                : "No context is configured for this version."
              : state.status === "stale"
                ? "This context may be out of date."
                : state.status === "unsupported"
                  ? "Context inspection is not supported by this connection."
                  : "Context could not be loaded."}
          </p>
          {state.status !== "empty" && (
            <BriefButton size="sm" onClick={retry}>
              Refresh context
            </BriefButton>
          )}
        </>
      )}
    </div>
  );
}
function ContextRunAction({
  shell,
  store,
}: {
  shell: BriefShellPort;
  store: WorkflowRunsController;
}) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const mounted = useRef(true),
    activeStore = useRef(store);
  activeStore.current = store;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [store]);
  async function start() {
    await store.start();
    const current = store.getSnapshot();
    if (
      mounted.current &&
      activeStore.current === store &&
      current.submission === "accepted" &&
      current.selectedId
    )
      shell.navigate({
        room: "workflow-runs",
        selection: {
          flowId: store.scope.flowId,
          versionId: store.scope.versionId,
          runId: current.selectedId,
        },
      });
  }
  return (
    <BriefButton
      variant="primary"
      disabled={!store.canRun}
      title={`Run version ${store.scope.versionId}`}
      onClick={() => void start()}
    >
      {state.submission === "pending" ? "Requesting…" : "Run workflow"}
    </BriefButton>
  );
}
/** Feedback has its own flow row so long failures cannot cover the header controls. */
function ContextRunFeedback({ store }: { store: WorkflowRunsController }) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return (
    <div role="status" className="brief-context-run-message">
      {state.message}
    </div>
  );
}
export function workflowContextRegistration(
  useBinding: (shell: BriefShellPort) => WorkflowContextBinding | undefined,
): BriefRoomModule {
  return {
    id: "workflow-context",
    title: "Context & rules",
    legacyRoom: "workflows",
    Body: ({ shell }) => (
      <WorkflowContextRoom shell={shell} binding={useBinding(shell)} />
    ),
  };
}
