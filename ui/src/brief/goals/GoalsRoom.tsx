import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { ArrowRight, Check, RefreshCw } from "lucide-react";
import { isBriefCapabilityEnabled } from "../../../../src/brief/capabilities";
import type { BriefRoomModule, BriefShellPort } from "../contracts";
import {
  BriefButton,
  BriefIconButton,
  BriefSelect,
  BriefTabs,
} from "../components/controls";
import { useBriefReducedMotion } from "../motion";
import { GoalSegments, OutcomeNumber } from "../today/outcomes/Values";
import { formatNumber, qualified } from "../today/outcomes/model";
import { GoalsController } from "./controller";
import {
  goalValue,
  nextGoalRoute,
  type GoalDatum,
  type GoalFilter,
  type GoalPath,
} from "./model";
import "../today/outcomes/outcomes.css";
import "./goals.css";

export interface GoalsBinding {
  source: "live" | "fixture";
  scopeId: string;
  capabilities?: unknown;
  controller: GoalsController;
  /** Host opens the existing goal-creation flow. No second writer in this room. */
  onCreate?: () => void;
}
export function goalsAvailable(shell: BriefShellPort, binding?: GoalsBinding) {
  return (
    !!binding &&
    !!binding.scopeId &&
    binding.source === (shell.mode === "preview" ? "fixture" : "live") &&
    binding.controller.scopeId === binding.scopeId &&
    binding.controller.source === binding.source &&
    (shell.mode === "preview" ||
      isBriefCapabilityEnabled(binding.capabilities, "goalMeasurements"))
  );
}
export function GoalsRoom({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: GoalsBinding;
}) {
  const available = goalsAvailable(shell, binding);
  useLayoutEffect(() => {
    binding?.controller.setAccess(available);
  }, [available, binding?.controller]);
  if (!available || !binding)
    return (
      <section>
        <h1 className="brief-type-room-title">Goals</h1>
        <p role="status">Your goals are unavailable here.</p>
      </section>
    );
  return (
    <ConnectedGoals
      key={`${binding.source}:${binding.scopeId}`}
      shell={shell}
      binding={binding}
    />
  );
}
function ConnectedGoals({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding: GoalsBinding;
}) {
  const controller = binding.controller;
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const reduced = useBriefReducedMotion();
  const routeKey = useRef("");
  const selectors = useRef<HTMLDivElement>(null);
  const pathElement = useRef<HTMLElement>(null);
  const all = controller.rows(),
    rows = controller.visible();
  const path = rows.find((row) => row.goal.goalId === state.selectedId);
  const positionKey = `${state.tab}:${state.filter}`;
  useEffect(() => {
    const key = `${shell.route.room}:${shell.route.selection.goalId ?? ""}`;
    if (routeKey.current === key) return;
    if (shell.route.selection.goalId) {
      if (!controller.open(shell.route.selection.goalId)) return;
    } else if (shell.route.room === "completed-goals")
      controller.setTab("completed");
    routeKey.current = key;
  }, [shell.route, controller, state.read]);
  useLayoutEffect(() => {
    const node = selectors.current;
    if (node) node.scrollLeft = controller.positions.get(positionKey) ?? 0;
  }, [controller, positionKey]);
  useLayoutEffect(() => {
    const node = selectors.current;
    const selected = node?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!node || !selected) return;
    const reveal = () => {
      const a = selected.getBoundingClientRect(),
        b = node.getBoundingClientRect();
      if (a.left < b.left) node.scrollLeft += a.left - b.left - 3;
      else if (a.right > b.right) node.scrollLeft += a.right - b.right + 3;
    };
    reveal();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [state.selectedId, controller]);
  // One local crossfade for changing goals. Progress changes use only shared glyph/segment motion.
  const previous = useRef(state.selectedId);
  useLayoutEffect(() => {
    const changed =
      previous.current !== null && previous.current !== state.selectedId;
    previous.current = state.selectedId;
    if (!changed || reduced) return;
    const animation = pathElement.current?.animate?.(
      [{ opacity: 0.65 }, { opacity: 1 }],
      { duration: 180, easing: "cubic-bezier(0,0,.58,1)" },
    );
    void animation?.finished?.catch(() => {});
    return () => animation?.cancel();
  }, [state.selectedId, reduced]);
  const pick = (id: string) => {
    if (controller.select(id))
      shell.navigate({
        room: state.tab === "completed" ? "completed-goals" : "goals",
        selection: { goalId: id },
      });
  };
  const fresh = state.read.status === "ready";
  const canReview =
    shell.mode === "preview" ||
    (isBriefCapabilityEnabled(binding.capabilities, "recommendations") &&
      isBriefCapabilityEnabled(binding.capabilities, "decisions"));
  const countsKnown = "data" in state.read || state.read.status === "empty";
  const tabLabel = (label: string, count: number) =>
    countsKnown ? `${label} · ${count}` : label;
  const content = (
    <>
      <div className="brief-goals-filter">
        {state.tab === "active" && (
          <BriefSelect
            label="Status"
            density="sm"
            value={state.filter}
            onChange={(e) => controller.setFilter(e.target.value as GoalFilter)}
          >
            <option value="active">Active</option>
            <option value="all">All non-completed</option>
            <option value="paused">Paused</option>
            <option value="failed">Failed</option>
            <option value="draft">Draft</option>
            <option value="killed">Killed</option>
          </BriefSelect>
        )}
      </div>
      <div
        role="status"
        className="brief-goals-read-status brief-type-body"
        aria-live="polite"
      >
        {state.read.status === "loading"
          ? "Loading your goals…"
          : "reason" in state.read
            ? state.read.reason
            : null}
      </div>
      {rows.length > 0 && state.tab === "completed" ? (
        <div className="brief-goals-completed" aria-label="Completed goals">
          {rows.map((row) => (
            <CompletedGoal key={row.goal.goalId} path={row} reduced={reduced} />
          ))}
        </div>
      ) : rows.length > 0 ? (
        <>
          <div
            ref={selectors}
            className="brief-goal-selectors"
            role="group"
            aria-label={
              state.tab === "completed" ? "Completed goals" : "Choose a goal"
            }
            onScroll={(e) =>
              controller.positions.set(positionKey, e.currentTarget.scrollLeft)
            }
          >
            {rows.map(({ goal }) => (
              <button
                key={goal.goalId}
                className="brief-goal-selector"
                aria-label={goal.title}
                aria-pressed={goal.goalId === state.selectedId}
                onClick={() => pick(goal.goalId)}
              >
                <strong className="brief-type-body-emphasis">
                  <span className="brief-goal-full-title">{goal.title}</span>
                  <span className="brief-goal-compact-title">
                    {goal.compactTitle || goal.title}
                  </span>
                </strong>
                <span className="brief-type-utility brief-secondary">
                  {goalValue(goal).label}
                </span>
                {goal.status !== "active" && (
                  <span className="brief-goal-status brief-type-utility">
                    {goal.status === "completed" && (
                      <Check size={13} aria-hidden="true" />
                    )}
                    {statusLabel(goal.status)}
                  </span>
                )}
              </button>
            ))}
          </div>
          {path && (
            <section
              ref={pathElement}
              className="brief-goal-path"
              data-goal-id={path.goal.goalId}
              aria-labelledby="brief-goal-path-title"
            >
              <div className="brief-goal-path-heading">
                <h2
                  id="brief-goal-path-title"
                  className="brief-type-section-heading"
                >
                  {path.pathTitle || path.goal.title}
                </h2>
                {path.change && qualified(path.change.measurement) && (
                  <span
                    data-positive={path.change.measurement.value > 0}
                    className={`brief-goal-change brief-type-utility${path.change.measurement.value > 0 ? " brief-positive" : " brief-secondary"}`}
                  >
                    {path.change.measurement.value > 0 ? "+" : ""}
                    {formatNumber(path.change.measurement.value)}{" "}
                    {path.change.label}
                  </span>
                )}
              </div>
              <ol
                className="brief-goal-stages"
                aria-label="Path to the goal"
                data-long-path={path.stages.length > 4}
              >
                {(path.stages.length ? path.stages : [path.goal]).map(
                  (stage, index, stages) => (
                    <li key={`${path.goal.goalId}:${stage.goalId}`}>
                      <PathCard
                        goal={stage}
                        current={stage.goalId === path.goal.goalId}
                        reduced={reduced}
                      />
                      {index < stages.length - 1 && (
                        <ArrowRight
                          className="brief-goal-connector"
                          size={22}
                          aria-hidden="true"
                        />
                      )}
                    </li>
                  ),
                )}
              </ol>
              {path.goal.status === "active" && (
                <NextStep
                  path={path}
                  fresh={fresh && canReview}
                  shell={shell}
                />
              )}
            </section>
          )}
        </>
      ) : (
        (countsKnown || state.read.status === "ready") && (
          <p className="brief-goals-empty brief-type-body">
            {state.tab === "completed"
              ? "No completed goals yet."
              : state.filter === "active"
                ? "No active goals."
                : state.filter === "all"
                  ? "No matching goals."
                  : `No ${state.filter} goals.`}
          </p>
        )
      )}
    </>
  );
  return (
    <section
      className="brief-goals-room"
      data-chat-open={shell.chatOpen}
      data-reduced={reduced}
      aria-label="Goals"
      aria-busy={state.read.status === "loading" || undefined}
    >
      <header className="brief-goals-heading">
        <h1 className="brief-type-room-title">Goals</h1>
        <div>
          <BriefIconButton
            label="Refresh goals"
            icon={<RefreshCw size={16} />}
            onClick={() => void controller.refresh()}
          />
          {binding.onCreate && (
            <BriefButton variant="secondary" onClick={binding.onCreate}>
              Add a goal
            </BriefButton>
          )}
        </div>
      </header>
      <BriefTabs
        label="Goal views"
        value={state.tab}
        onValueChange={(value) => {
          controller.setTab(value as "active" | "completed");
          shell.navigate({
            room: value === "completed" ? "completed-goals" : "goals",
            selection: {},
          });
        }}
        items={[
          {
            value: "active",
            label: tabLabel(
              "Active",
              all.filter((p) => p.goal.status === "active").length,
            ),
            content: state.tab === "active" ? content : null,
          },
          {
            value: "completed",
            label: tabLabel(
              "Completed",
              all.filter((p) => p.goal.status === "completed").length,
            ),
            content: state.tab === "completed" ? content : null,
          },
        ]}
      />
    </section>
  );
}
function statusLabel(status: GoalDatum["status"]) {
  return status[0]!.toUpperCase() + status.slice(1);
}
function CompletedGoal({
  path,
  reduced,
}: {
  path: GoalPath;
  reduced: boolean;
}) {
  const value = goalValue(path.goal);
  const at = path.completion?.at;
  return (
    <article
      className="brief-goal-completed brief-surface"
      data-goal-id={path.goal.goalId}
      aria-label={path.goal.title}
    >
      <div className="brief-goal-completed-heading">
        <span className="brief-goal-completed-badge brief-type-utility">
          <Check size={14} aria-hidden="true" />
          Completed
        </span>
        {at !== null &&
          at !== undefined &&
          Number.isFinite(new Date(at).getTime()) && (
            <time
              className="brief-type-utility brief-secondary"
              dateTime={new Date(at).toISOString()}
            >
              {new Intl.DateTimeFormat("en-GB", {
                day: "numeric",
                month: "long",
                timeZone: "UTC",
              }).format(at)}
            </time>
          )}
      </div>
      <h2 className="brief-type-section-heading">{path.goal.title}</h2>
      <div className="brief-goal-completed-value">
        <strong>
          {value.kind === "measurement" ? (
            <OutcomeNumber
              value={value.measurement.value}
              reducedMotion={reduced}
            />
          ) : value.kind === "score" ? (
            <>
              <OutcomeNumber
                value={Math.round(value.fraction * 1000) / 10}
                reducedMotion={reduced}
              />
              %
            </>
          ) : (
            "—"
          )}
        </strong>
        <span className="brief-secondary">
          {value.kind === "measurement"
            ? `${value.ordinaryCount ? "/ " : "Target "}${formatNumber(value.measurement.target!)} ${value.measurement.unit}`
            : value.kind === "score"
              ? "Score"
              : "Not measured"}
        </span>
      </div>
      <ol className="brief-goal-milestones" aria-label="Milestones">
        {path.stages.map((stage) => (
          <li key={stage.goalId} data-complete={stage.status === "completed"}>
            <span className="brief-goal-milestone-mark" aria-hidden="true">
              {stage.status === "completed" ? <Check size={14} /> : "·"}
            </span>
            <span>
              {stage.title}
              <span className="brief-sr-only">
                {" "}
                · {statusLabel(stage.status)}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {path.completion && (
        <div className="brief-goal-completion-context brief-secondary">
          <p className="brief-type-body">{path.completion.summary}</p>
          {path.completion.supportedBy && (
            <p className="brief-type-utility">
              Supported by {path.completion.supportedBy}
            </p>
          )}
        </div>
      )}
      {value.kind === "measurement" && (
        <details className="brief-goal-basis brief-type-utility brief-secondary">
          <summary>Data basis</summary>
          <p>
            {value.measurement.qualification === "user_reported"
              ? "User reported"
              : "Measured"}{" "}
            · Baseline {formatNumber(value.measurement.baseline!)} ·{" "}
            {new Date(value.measurement.asOf).toISOString()}
          </p>
          {value.measurement.provenance.map((ref, i) => (
            <p key={i}>
              {ref.id}
              {ref.revision ? ` · ${ref.revision}` : ""}
            </p>
          ))}
        </details>
      )}
    </article>
  );
}
function PathCard({
  goal,
  current,
  reduced,
}: {
  goal: GoalDatum;
  current: boolean;
  reduced: boolean;
}) {
  const value = goalValue(goal);
  return (
    <article
      className="brief-goal-stage brief-surface"
      data-current={current}
      data-status={goal.status}
      aria-label={goal.title}
    >
      <h3 className="brief-type-body-emphasis">
        {goal.pathLabel || goal.title}
      </h3>
      {value.kind === "measurement" ? (
        <>
          <div className="brief-goal-stage-value">
            <strong>
              <OutcomeNumber
                value={value.measurement.value}
                reducedMotion={reduced}
              />
            </strong>
            <span>
              {value.ordinaryCount ? "/ " : "Target "}
              {formatNumber(value.measurement.target!)}
            </span>
          </div>
          <span className="brief-goal-unit brief-type-utility brief-secondary">
            {value.measurement.unit}
          </span>
        </>
      ) : (
        <div
          className="brief-goal-stage-value"
          data-score={value.kind === "score"}
        >
          <strong>
            {value.kind === "score" ? (
              <>
                <OutcomeNumber
                  value={Math.round(value.fraction * 1000) / 10}
                  reducedMotion={reduced}
                />
                %
              </>
            ) : (
              "—"
            )}
          </strong>
          <span>{value.kind === "score" ? "Score" : "Not measured"}</span>
        </div>
      )}
      {value.fraction !== null && (
        <GoalSegments
          value={value.fraction}
          target={1}
          label={`${goal.title}: ${formatNumber(Math.round(value.fraction * 1000) / 10)}% ${value.kind === "score" ? "score" : "progress"}`}
          reducedMotion={reduced}
        />
      )}
      <p className="brief-goal-stage-caption brief-type-utility brief-secondary">
        {goal.caption || statusLabel(goal.status)}
      </p>
      {value.kind === "measurement" && (
        <details className="brief-goal-basis brief-type-utility brief-secondary">
          <summary>Data basis</summary>
          <dl>
            <dt>Basis</dt>
            <dd>
              {value.measurement.qualification === "user_reported"
                ? "User reported"
                : "Measured"}
            </dd>
            <dt>Baseline</dt>
            <dd>{formatNumber(value.measurement.baseline!)}</dd>
            <dt>As of</dt>
            <dd>{new Date(value.measurement.asOf).toISOString()}</dd>
            <dt>Source</dt>
            <dd>
              {value.measurement.provenance.map((ref, i) => (
                <span key={i}>
                  {ref.id}
                  {ref.revision ? ` · ${ref.revision}` : ""}
                  <br />
                </span>
              ))}
            </dd>
          </dl>
        </details>
      )}
    </article>
  );
}
function NextStep({
  path,
  fresh,
  shell,
}: {
  path: GoalPath;
  fresh: boolean;
  shell: BriefShellPort;
}) {
  const route = nextGoalRoute(path, fresh);
  return (
    <section
      className="brief-goal-next-action brief-surface"
      aria-label="Next step"
      data-decision-id={path.next?.decisionId}
      data-work-item-id={path.next?.workItemId}
    >
      <div>
        <p className="brief-type-body-emphasis">
          {path.next ? "Move the next step forward" : "What’s next?"}
        </p>
        <h3 className="brief-type-section-heading">
          {path.next?.title || "No next step is ready yet."}
        </h3>
        {path.next?.context && (
          <p className="brief-type-body brief-secondary">{path.next.context}</p>
        )}
      </div>
      {path.next && (
        <div>
          <BriefButton
            variant="primary"
            disabled={!route}
            onClick={() => {
              if (route) shell.navigate(route);
            }}
          >
            {path.next.label || "Review next step"}
          </BriefButton>
          {!route && (
            <p role="status" className="brief-type-utility brief-secondary">
              Refresh to review the current step.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
/** Optional registration. The default registry and legacy Goals remain untouched. */
export function goalsRegistrations(
  useBinding: () => GoalsBinding | undefined,
): readonly BriefRoomModule[] {
  const Body = ({ shell }: { shell: BriefShellPort }) => (
    <GoalsRoom shell={shell} binding={useBinding()} />
  );
  return [
    { id: "goals", title: "Goals", legacyRoom: "goals", Body },
    {
      id: "completed-goals",
      title: "Completed goals",
      legacyRoom: "goals",
      Body,
    },
  ];
}
