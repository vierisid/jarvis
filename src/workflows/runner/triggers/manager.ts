/**
 * `TriggerManager` -- runtime owner of trigger subscriptions for the new
 * workflow system.
 *
 * Responsibilities:
 *   - On `start()`: scan all ENABLED flows, register their triggers.
 *   - On `refresh(flowId)`: re-read a flow's status + version, register or
 *     unregister as appropriate. Called by the v2 API after status flips.
 *   - On `stop()`: tear down all subscriptions cleanly.
 *
 * Routing today (Phase J):
 *   - `EMPTY` -- no subscription needed; flow runs only on manual `/run`.
 *   - `PIECE_TRIGGER` with pieceName="schedule" -- cron via `CronScheduler`.
 *   - `PIECE_TRIGGER` with pieceName="webhook" -- webhook route via `WebhookManager`.
 *   - All other `PIECE_TRIGGER` nodes:
 *       * If `engineRuntime` is set, call EXECUTE_TRIGGER_HOOK(ON_ENABLE) on
 *         the engine, persist the returned `scheduleOptions` + `listeners`
 *         on the flow_version, and wire cron/webhooks accordingly. Cron
 *         fires enqueue RUN_FLOW with `executeTrigger=true` so the engine's
 *         trigger.run() produces the actual payload(s).
 *       * If `engineRuntime` is not set, fall back to the legacy
 *         direct-subscribe path for `jarvis-trigger:on_event` (kept until
 *         Phase K wires the engine into daemon bootstrap proper). Other
 *         engine-only triggers (vendored polling pieces, gmail webhook,
 *         etc.) are skipped and logged.
 *
 * Anything unrecognized is logged and skipped (the flow can still be run
 * manually). We do not throw -- the manager must not destabilize the daemon
 * if a single flow has a malformed trigger.
 *
 * Note: webhook listeners returned by ON_ENABLE (`listeners[].name=='WEBHOOK'`,
 * `APP_WEBHOOK`) are persisted on flow_version but not yet routed to the
 * `WebhookManager` -- that lands in K alongside the daemon-side wiring.
 */

import { CronScheduler } from "./cron";
import { WebhookManager } from "./webhook";
import type { WorkflowEventBus } from "../../runtime/event-bus";
import { getFlow, listFlows, type FlowRow } from "../../db/repos/flow";
import {
  getFlowVersion,
  getLatestDraft,
  setEngineTriggerState,
  type AppEventListener,
  type EngineScheduleOptions,
  type FlowVersion,
} from "../../db/repos/flow-version";
import { createFlowRun } from "../../db/repos/flow-run";
import { enqueue } from "../../db/repos/job-queue";
import { RUN_FLOW } from "../handler";
import { DEFAULT_IDS } from "../../db/schema";
import type { EngineRuntime } from "../engine-runtime/engine-runtime";
import { toUpstreamFlowVersion } from "../engine-runtime/flow-version-adapter";

interface TriggerNode {
  type: string;
  name?: string;
  settings?: {
    pieceName?: string;
    triggerName?: string;
    input?: Record<string, unknown>;
  };
}

type SubscriptionKind = "cron" | "webhook" | "event" | "engine";
type ActiveSub = {
  flowId: string;
  versionId: string;
  kind: SubscriptionKind;
  /**
   * Optional human-readable warning surfaced by `list()`. Set when the
   * subscription is partially active -- e.g. an engine trigger that returned
   * webhook listeners but no cron schedule (listener routing is not wired
   * until Phase K, so the flow is enabled-but-non-firing).
   */
  warning?: string;
  teardown: () => Promise<void> | void;
};

export interface TriggerManagerDeps {
  /**
   * In-process event bus. Used by the legacy `jarvis-trigger:on_event`
   * direct-subscribe path -- only exercised when `engineRuntime` is unset.
   * With an engine runtime in scope, the engine-managed polling trigger
   * handles event delivery via the daemon's event buffer.
   */
  eventBus: WorkflowEventBus;
  cronScheduler?: CronScheduler;
  webhookManager?: WebhookManager;
  /**
   * When set, non-schedule/non-webhook PIECE_TRIGGER nodes are activated via
   * EXECUTE_TRIGGER_HOOK(ON_ENABLE) on the engine and the returned schedule
   * is persisted + drives the cron loop. When unset, the only such trigger
   * supported is `jarvis-trigger:on_event`, which falls back to direct
   * event-bus subscription.
   */
  engineRuntime?: EngineRuntime;
  /** Optional logger; defaults to console. */
  log?: (line: string) => void;
}

export class TriggerManager {
  private readonly bus: WorkflowEventBus;
  private readonly cron: CronScheduler;
  private readonly webhooks: WebhookManager;
  private readonly engineRuntime: EngineRuntime | undefined;
  private readonly log: (line: string) => void;
  private readonly subs: Map<string, ActiveSub> = new Map();
  /**
   * Per-flow serialization queue. Two concurrent `refresh(sameFlow)` calls
   * (e.g., racing API requests) would otherwise both spawn engines, both
   * call ON_ENABLE, both write `setEngineTriggerState`, and end up with
   * duplicate cron jobs. Each flow's operations chain off the prior one's
   * settlement so register/unregister/refresh are observed in order.
   */
  private readonly inFlight: Map<string, Promise<void>> = new Map();
  /**
   * Flows with an engine poll currently running. Guards against pile-ups when a
   * poll outlives its cron interval (every-minute tick + a slow poll would
   * otherwise stack overlapping engine spawns).
   */
  private readonly pollingInFlight: Set<string> = new Set();

  constructor(deps: TriggerManagerDeps) {
    this.bus = deps.eventBus;
    this.cron = deps.cronScheduler ?? new CronScheduler();
    this.webhooks = deps.webhookManager ?? new WebhookManager();
    this.engineRuntime = deps.engineRuntime;
    this.log = deps.log ?? ((line) => console.log(`[trigger-manager] ${line}`));

    this.webhooks.setTriggerCallback((flowId, payload) => {
      void this.fire(flowId, payload, "webhook");
    });
  }

  /** Public surface for the webhook ingress route. */
  webhookManager(): WebhookManager {
    return this.webhooks;
  }

  /** Scan all ENABLED flows and register their triggers. Idempotent. */
  async start(): Promise<void> {
    const flows = listFlows(undefined, { status: "ENABLED", limit: 1000 });
    for (const flow of flows) {
      await this.register(flow);
    }
    this.log(`started; ${this.subs.size} active subscription(s)`);
  }

  /** Tear down all subscriptions. */
  async stop(): Promise<void> {
    for (const sub of this.subs.values()) {
      try {
        await sub.teardown();
      } catch (e) {
        this.log(`teardown error for flow ${sub.flowId}: ${(e as Error).message}`);
      }
    }
    this.subs.clear();
    this.cron.cancelAll();
    this.log("stopped");
  }

  /**
   * Re-read the flow and reconcile its subscription. Called by the API after
   * status changes, version publish, or delete.
   *
   * Serialized per `flowId` -- if a refresh is already mid-flight for the
   * same flow, this call queues behind it. Cross-flow refreshes still run
   * concurrently.
   */
  async refresh(flowId: string): Promise<void> {
    return this.withFlowLock(flowId, async () => {
      const flow = getFlow(flowId);
      const existing = this.subs.get(flowId);

      // Flow gone or disabled -> tear down whatever's active.
      if (!flow || flow.status !== "ENABLED") {
        await this.unregister(flowId);
        return;
      }

      const desiredVersionId =
        flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;

      // Already registered against the right version -> no-op. This is what
      // makes concurrent refreshes idempotent: the first one through the lock
      // does the work; subsequent calls observe the active sub and skip.
      if (existing && existing.versionId === desiredVersionId) return;

      // Either no sub yet, or a stale sub for a previous version. Tear down
      // the old one (clears engine state + ON_DISABLE) before registering
      // against the current version.
      if (existing) await this.unregister(flowId);
      await this.register(flow);
    });
  }

  /**
   * Run `fn` exclusively for the given flow id. Concurrent calls for the
   * same flow chain. Cross-flow calls run in parallel. The map entry is
   * cleared once the chain settles back to empty.
   */
  private async withFlowLock<T>(flowId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.inFlight.get(flowId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    // Track only the side-effect chain so the next caller waits regardless of
    // whether the previous one resolved or rejected.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set(flowId, tail);
    try {
      return await next;
    } finally {
      // If our tail is still the head of the queue (no one piled on after
      // us), drop the map entry so it doesn't leak.
      if (this.inFlight.get(flowId) === tail) {
        this.inFlight.delete(flowId);
      }
    }
  }

  // ---------------------------------------------------------------- private

  private async register(flow: FlowRow): Promise<void> {
    const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
    if (!versionId) return;
    const version = getFlowVersion(versionId);
    if (!version) return;
    const trigger = version.trigger as unknown as TriggerNode | null;
    if (!trigger || typeof trigger !== "object") return;

    if (trigger.type === "EMPTY") return; // manual-run only

    if (trigger.type === "PIECE_TRIGGER") {
      const pieceName = trigger.settings?.pieceName;
      if (pieceName === "schedule") return this.registerCron(flow.id, versionId, trigger);
      if (pieceName === "webhook") return this.registerWebhook(flow.id, versionId, trigger);
      if (this.engineRuntime) {
        return this.registerEngineTrigger(flow, version, trigger);
      }
      // Engine-less fallback for jarvis-trigger:on_event. In
      // production the daemon always boots with an engineRuntime
      // (set during bootstrap), so the branch above short-circuits
      // every PIECE_TRIGGER flow. The fallback exists ONLY to keep
      // the event-bus subscription wiring testable without spinning
      // up a real engine subprocess -- see
      // `manager.test.ts:"TriggerManager: jarvis-trigger on_event"`.
      // The piece-name string here is the legacy unscoped alias the
      // test fixtures use; the editor and the projection layer both
      // commit to the scoped npm name. Don't add new fallbacks
      // through this path; new pieces should be tested through the
      // engine.
      if (pieceName === "jarvis-trigger") {
        return this.registerJarvisEvent(flow.id, versionId, trigger);
      }
      this.log(
        `flow ${flow.id}: PIECE_TRIGGER pieceName="${pieceName}" requires engine runtime; skipping`,
      );
      return;
    }

    this.log(`flow ${flow.id}: unsupported trigger.type="${trigger.type}"; skipping`);
  }

  private async unregister(flowId: string): Promise<void> {
    const sub = this.subs.get(flowId);
    if (!sub) return;
    try {
      await sub.teardown();
    } catch (e) {
      this.log(`teardown error for flow ${flowId}: ${(e as Error).message}`);
    }
    this.subs.delete(flowId);
  }

  private registerCron(flowId: string, versionId: string, trigger: TriggerNode): void {
    const input = (trigger.settings?.input ?? {}) as Record<string, unknown>;
    const expression =
      (typeof input.cron_expression === "string" && input.cron_expression) ||
      (typeof input.cronExpression === "string" && input.cronExpression) ||
      (typeof input.expression === "string" && input.expression) ||
      null;
    if (!expression) {
      this.log(`flow ${flowId}: schedule trigger missing cron expression; skipping`);
      return;
    }
    try {
      this.cron.schedule(`flow:${flowId}`, expression, () => {
        void this.fire(flowId, { cronExpression: expression, firedAt: Date.now() }, "cron");
      });
      this.subs.set(flowId, {
        flowId,
        versionId,
        kind: "cron",
        teardown: () => this.cron.cancel(`flow:${flowId}`),
      });
    } catch (e) {
      this.log(`flow ${flowId}: failed to schedule cron "${expression}": ${(e as Error).message}`);
    }
  }

  private registerWebhook(flowId: string, versionId: string, trigger: TriggerNode): void {
    const input = (trigger.settings?.input ?? {}) as Record<string, unknown>;
    const secret = typeof input.secret === "string" && input.secret ? input.secret : undefined;
    this.webhooks.register(flowId, secret);
    this.subs.set(flowId, {
      flowId,
      versionId,
      kind: "webhook",
      teardown: () => this.webhooks.unregister(flowId),
    });
  }

  private registerJarvisEvent(flowId: string, versionId: string, trigger: TriggerNode): void {
    if (trigger.settings?.triggerName !== "on_event") {
      this.log(
        `flow ${flowId}: jarvis-trigger has triggerName="${trigger.settings?.triggerName}"; only "on_event" is supported`,
      );
      return;
    }
    const input = (trigger.settings?.input ?? {}) as Record<string, unknown>;
    const eventType = typeof input.eventType === "string" ? input.eventType : "";
    if (!eventType) {
      this.log(`flow ${flowId}: on_event trigger missing eventType; skipping`);
      return;
    }
    const filter =
      input.filter && typeof input.filter === "object" && !Array.isArray(input.filter)
        ? (input.filter as Record<string, unknown>)
        : undefined;
    const matches = makeFilter(filter);
    const unsubscribe = this.bus.subscribe(eventType, (payload) => {
      if (!matches(payload)) return;
      void this.fire(flowId, payload, "event");
    });
    this.subs.set(flowId, {
      flowId,
      versionId,
      kind: "event",
      teardown: unsubscribe,
    });
  }

  /**
   * Engine-managed trigger. Calls EXECUTE_TRIGGER_HOOK(ON_ENABLE) on a
   * short-lived engine subprocess, persists the returned `scheduleOptions`
   * and `listeners` on the flow_version, and wires the cron driver. Cron
   * fires enqueue RUN_FLOW with `executeTrigger=true` so the engine runs the
   * trigger's `run()` to produce the real payload(s).
   *
   * Idempotent: if the version already has `engineSchedule` persisted (from
   * a prior enable), we skip the engine round-trip and just rewire the cron.
   * On_disable refreshes always go through the engine to give the trigger a
   * chance to clean up upstream state.
   */
  private async registerEngineTrigger(
    flow: FlowRow,
    version: FlowVersion,
    _trigger: TriggerNode,
  ): Promise<void> {
    const engine = this.engineRuntime;
    if (!engine) return;

    let schedule: EngineScheduleOptions | null = version.engineSchedule;
    let listeners: AppEventListener[] | null = version.engineListeners;

    if (!schedule && !listeners) {
      try {
        const handle = await engine.acquire({
          runId: `enable-${flow.id}-${Date.now().toString(36)}`,
          projectId: flow.project_id,
        });
        try {
          const upstreamVersion = toUpstreamFlowVersion(version);
          const response = (await handle.executeTriggerHook("ON_ENABLE", {
            flowVersion: upstreamVersion,
          })) as {
            listeners?: AppEventListener[];
            scheduleOptions?: EngineScheduleOptions;
          };
          schedule = response.scheduleOptions ?? null;
          listeners = response.listeners ?? null;
          setEngineTriggerState(version.id, {
            engineListeners: listeners,
            engineSchedule: schedule,
          });
        } finally {
          await handle.release();
        }
      } catch (e) {
        this.log(
          `flow ${flow.id}: engine ON_ENABLE failed: ${(e as Error).message} -- skipping registration this cycle; next refresh will retry`,
        );
        return;
      }
    }

    if (!schedule && (!listeners || listeners.length === 0)) {
      this.log(
        `flow ${flow.id}: engine ON_ENABLE returned neither schedule nor listeners; flow can still be run manually`,
      );
      return;
    }

    let cronTearDown: (() => void) | null = null;
    let webhookTearDown: (() => void) | null = null;
    if (schedule?.cronExpression) {
      try {
        this.cron.schedule(`flow:${flow.id}`, schedule.cronExpression, () => {
          void this.fireEngineTrigger(flow.id, version.id, "cron");
        });
        cronTearDown = () => this.cron.cancel(`flow:${flow.id}`);
      } catch (e) {
        this.log(
          `flow ${flow.id}: failed to schedule engine cron "${schedule.cronExpression}": ${(e as Error).message}`,
        );
      }
    }
    if (listeners && listeners.length > 0) {
      // Engine-returned listeners drive webhook routing: register the flow on
      // the WebhookManager so external POSTs to `/webhooks/<flowId>` enqueue
      // RUN_FLOW with `executeTrigger=true`, letting the engine's
      // `trigger.run()` consume the request body as the trigger payload.
      // Multiple listeners (e.g. Gmail watch + identifier) share one webhook
      // endpoint per flow; the engine's onEnable already encoded what to
      // listen for via its external API (Gmail watch, etc.).
      this.webhooks.register(flow.id);
      webhookTearDown = () => this.webhooks.unregister(flow.id);
      this.log(
        `flow ${flow.id}: engine registered ${listeners.length} listener(s); webhook route /webhooks/${flow.id} active`,
      );
    }

    const sub: ActiveSub = {
      flowId: flow.id,
      versionId: version.id,
      kind: "engine",
      teardown: () => this.teardownEngineTrigger(flow.id, version.id, cronTearDown, webhookTearDown),
    };
    this.subs.set(flow.id, sub);
  }

  private async teardownEngineTrigger(
    flowId: string,
    versionId: string,
    cronTearDown: (() => void) | null,
    webhookTearDown: (() => void) | null = null,
  ): Promise<void> {
    if (cronTearDown) cronTearDown();
    if (webhookTearDown) webhookTearDown();
    // Clear our persisted state FIRST so the DB is consistent even if the
    // engine call below fails mid-flight (engine half-crashes, network blip).
    // Trade-off: an external resource the trigger registered (e.g. a Gmail
    // watch) may leak engine-side, but our local state is always trustworthy
    // -- the next ENABLE will re-issue ON_ENABLE because no persisted state
    // is present, which gives the trigger a chance to recreate / dedupe the
    // external resource.
    setEngineTriggerState(versionId, {
      engineListeners: null,
      engineSchedule: null,
    });
    if (!this.engineRuntime) return;
    const flow = getFlow(flowId);
    const version = getFlowVersion(versionId);
    if (!version) return;
    try {
      const handle = await this.engineRuntime.acquire({
        runId: `disable-${flowId}-${Date.now().toString(36)}`,
        projectId: flow?.project_id ?? DEFAULT_IDS.project,
      });
      try {
        const upstreamVersion = toUpstreamFlowVersion(version);
        await handle.executeTriggerHook("ON_DISABLE", {
          flowVersion: upstreamVersion,
        });
      } finally {
        await handle.release();
      }
    } catch (e) {
      this.log(`flow ${flowId}: engine ON_DISABLE failed: ${(e as Error).message}`);
    }
  }

  /**
   * Enqueue a RUN_FLOW. Used by every trigger fire path so `triggeredBy`
   * follows one convention -- `trigger:<kind>` -- across cron, webhook,
   * direct event-bus subscribe, and engine-managed sources.
   */
  private enqueueFlowRun(opts: {
    flowId: string;
    versionId: string;
    kind: SubscriptionKind;
    payload?: Record<string, unknown>;
    executeTrigger?: boolean;
  }): void {
    const run = createFlowRun({
      flowId: opts.flowId,
      flowVersionId: opts.versionId,
      triggeredBy: `trigger:${opts.kind}`,
      startTime: Date.now(),
    });
    enqueue({
      jobType: RUN_FLOW,
      payload: {
        runId: run.id,
        payload: opts.payload ?? {},
        ...(opts.executeTrigger ? { executeTrigger: true } : {}),
      },
      flowRunId: run.id,
      flowId: opts.flowId,
      flowVersionId: opts.versionId,
      // No auto-retry: trigger-fired runs often have side effects that
      // would duplicate on retry (e.g. notify, email, downstream API
      // calls). Surface the failure once; the trigger's next fire is
      // the natural "retry" cadence.
      maxAttempts: 1,
    });
  }

  /**
   * Engine-managed trigger fire (polling sources, e.g. jarvis-trigger
   * on_event). On each cron tick we run the trigger's RUN hook to POLL for new
   * events, then enqueue exactly one flow run per returned event.
   *
   * Why not the old way: previously this blindly enqueued a run with
   * `executeTrigger=true` every tick, so a poll that found NO new events still
   * walked the entire action chain with an empty trigger payload. That misfired
   * every event workflow on every idle minute -- emails classified with no
   * body, clipboard flows routing to fallback, etc. Polling here and only
   * enqueuing per real event means "no new events -> no run".
   *
   * Each returned item is the trigger's output shape (for on_event:
   * `{ id, eventType, payload, timestamp, _dedupe_key }`) and is passed through
   * as the run's trigger payload (executeTrigger=false) so `{{trigger.payload.*}}`
   * resolves. The trigger's `run()` advances its own `context.store` cursor, so
   * events aren't re-delivered on the next poll.
   */
  private async fireEngineTrigger(flowId: string, versionId: string, source: string): Promise<void> {
    const engine = this.engineRuntime;
    if (!engine) return;
    // Skip if a prior poll for this flow is still running (slow poll vs. fast
    // cron); the next tick will pick up anything missed.
    if (this.pollingInFlight.has(flowId)) return;
    const version = getFlowVersion(versionId);
    if (!version) {
      this.log(`flow ${flowId} (engine-${source}): version ${versionId} not found; skipping poll`);
      return;
    }

    this.pollingInFlight.add(flowId);
    let items: unknown[];
    try {
      const handle = await engine.acquire({
        runId: `poll-${flowId}-${Date.now().toString(36)}`,
        projectId: getFlow(flowId)?.project_id ?? DEFAULT_IDS.project,
      });
      try {
        // RUN hook = "poll the trigger and return its items" without executing
        // the flow. For a POLLING trigger this calls `run()` and hands back
        // whatever it yielded.
        const response = (await handle.executeTriggerHook("RUN", {
          flowVersion: toUpstreamFlowVersion(version),
        })) as { output?: unknown[] } | undefined;
        items = Array.isArray(response?.output) ? response.output : [];
      } finally {
        await handle.release();
      }
    } catch (e) {
      this.log(`flow ${flowId} (engine-${source}) poll failed: ${(e as Error).message}`);
      return;
    } finally {
      this.pollingInFlight.delete(flowId);
    }

    if (items.length === 0) return; // no new events -> no run (the whole point)
    for (const item of items) {
      this.enqueueFlowRun({
        flowId,
        versionId,
        kind: "engine",
        // Pass the event through verbatim as the trigger payload. Objects are
        // used as-is; a bare value (rare) is wrapped so the payload stays an
        // object for the engine's variable resolver.
        payload:
          item && typeof item === "object" && !Array.isArray(item)
            ? (item as Record<string, unknown>)
            : { value: item },
        executeTrigger: false,
      });
    }
    this.log(`flow ${flowId} (engine-${source}): polled ${items.length} event(s) -> ${items.length} run(s)`);
  }

  /**
   * Trigger fire for cron / webhook / direct event-bus subscribe. The
   * payload is forwarded as the trigger payload. For engine-managed
   * subscriptions (`sub.kind === "engine"`) the run is enqueued with
   * `executeTrigger=true` so the engine's `trigger.run()` consumes the
   * payload (e.g. webhook body for an engine webhook trigger) to derive the
   * actual flow-run payload(s); legacy subs run the chain directly with the
   * payload as initial state.
   */
  private fire(flowId: string, payload: Record<string, unknown>, kind: SubscriptionKind): void {
    const sub = this.subs.get(flowId);
    const versionId = sub?.versionId;
    if (!versionId) {
      this.log(`flow ${flowId} (${kind}) fire skipped: no active subscription`);
      return;
    }
    try {
      this.enqueueFlowRun({
        flowId,
        versionId,
        kind: sub.kind,
        payload,
        ...(sub.kind === "engine" ? { executeTrigger: true } : {}),
      });
    } catch (e) {
      this.log(`flow ${flowId} (${kind}) fire failed: ${(e as Error).message}`);
    }
  }

  /**
   * Snapshot of active subscriptions. Each entry includes the registered
   * flow id, kind, and an optional `warning` set when the subscription is
   * partially active (e.g. engine returned webhook listeners but the route
   * wiring hasn't landed yet, so the flow is enabled-but-non-firing). API
   * + dashboard consumers should surface the warning to the user.
   */
  list(): Array<{ flowId: string; kind: SubscriptionKind; warning?: string }> {
    return Array.from(this.subs.values()).map((s) => {
      const out: { flowId: string; kind: SubscriptionKind; warning?: string } = {
        flowId: s.flowId,
        kind: s.kind,
      };
      if (s.warning) out.warning = s.warning;
      return out;
    });
  }
}

function makeFilter(filter?: Record<string, unknown>): (payload: Record<string, unknown>) => boolean {
  if (!filter) return () => true;
  const entries = Object.entries(filter);
  if (entries.length === 0) return () => true;
  return (payload) => {
    for (const [k, v] of entries) {
      if (payload[k] !== v) return false;
    }
    return true;
  };
}
