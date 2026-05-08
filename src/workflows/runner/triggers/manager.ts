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
import type { JarvisEventBusAdapter } from "../../adapters/event-bus";
import type { JarvisWorkflowRunnerAdapter } from "../../adapters/workflow-runner";
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
  teardown: () => Promise<void> | void;
};

export interface TriggerManagerDeps {
  workflowRunner: JarvisWorkflowRunnerAdapter;
  eventBus: JarvisEventBusAdapter;
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
  private readonly runner: JarvisWorkflowRunnerAdapter;
  private readonly bus: JarvisEventBusAdapter;
  private readonly cron: CronScheduler;
  private readonly webhooks: WebhookManager;
  private readonly engineRuntime: EngineRuntime | undefined;
  private readonly log: (line: string) => void;
  private readonly subs: Map<string, ActiveSub> = new Map();

  constructor(deps: TriggerManagerDeps) {
    this.runner = deps.workflowRunner;
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
   */
  async refresh(flowId: string): Promise<void> {
    await this.unregister(flowId);
    const flow = getFlow(flowId);
    if (!flow) return;
    if (flow.status !== "ENABLED") return;
    await this.register(flow);
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
          projectId: flow.project_id ?? DEFAULT_IDS.project,
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
          `flow ${flow.id}: engine ON_ENABLE failed: ${(e as Error).message}; skipping`,
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
      // Webhook routing for engine-managed triggers lands in Phase K alongside
      // the daemon-side WebhookManager wiring. For now we persisted the
      // listeners; the daemon will read them out and register routes there.
      this.log(
        `flow ${flow.id}: engine returned ${listeners.length} webhook listener(s); routing deferred to K`,
      );
    }

    this.subs.set(flow.id, {
      flowId: flow.id,
      versionId: version.id,
      kind: "engine",
      teardown: () => this.teardownEngineTrigger(flow.id, version.id, cronTearDown),
    });
  }

  private async teardownEngineTrigger(
    flowId: string,
    versionId: string,
    cronTearDown: (() => void) | null,
  ): Promise<void> {
    if (cronTearDown) cronTearDown();
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
        setEngineTriggerState(versionId, {
          engineListeners: null,
          engineSchedule: null,
        });
      } finally {
        await handle.release();
      }
    } catch (e) {
      this.log(`flow ${flowId}: engine ON_DISABLE failed: ${(e as Error).message}`);
    }
  }

  /**
   * Enqueue a RUN_FLOW for an engine-managed trigger. The engine's executor
   * will invoke the trigger's `run()` (because `executeTrigger=true`) to
   * produce one or more real payloads, then walk the action chain per
   * payload.
   */
  private fireEngineTrigger(flowId: string, versionId: string, source: string): void {
    try {
      const run = createFlowRun({
        flowId,
        flowVersionId: versionId,
        triggeredBy: `trigger:engine-${source}`,
        startTime: Date.now(),
      });
      enqueue({
        jobType: RUN_FLOW,
        payload: { runId: run.id, payload: {}, executeTrigger: true },
        flowRunId: run.id,
        flowId,
        flowVersionId: versionId,
      });
    } catch (e) {
      this.log(`flow ${flowId} (engine-${source}) fire failed: ${(e as Error).message}`);
    }
  }

  private async fire(flowId: string, payload: Record<string, unknown>, source: string): Promise<void> {
    try {
      await this.runner.start({ flowId, payload });
    } catch (e) {
      this.log(`flow ${flowId} (${source}) fire failed: ${(e as Error).message}`);
    }
  }

  /** Snapshot of active subscriptions. Useful for tests and an /admin endpoint. */
  list(): Array<{ flowId: string; kind: SubscriptionKind }> {
    return Array.from(this.subs.values()).map(({ flowId, kind }) => ({ flowId, kind }));
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
