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
 * Trigger types we honor today:
 *   - `EMPTY` -- no subscription needed; flow runs only on manual `/run`.
 *   - `PIECE_TRIGGER` with pieceName="schedule" -- cron via the legacy
 *     `CronScheduler`. The cron expression is read from settings.input.
 *     Looked up in priority order: `cron_expression`, `cronExpression`,
 *     `expression`. (Activepieces' schedule piece uses different keys for
 *     different sub-triggers; we accept any.)
 *   - `PIECE_TRIGGER` with pieceName="webhook" -- registers a webhook route
 *     on the legacy `WebhookManager`. Path = "/webhooks/<flowId>". Optional
 *     HMAC secret from settings.input.secret.
 *   - `jarvis-trigger` with triggerName="on_event" -- subscribes to the
 *     piece-side event bus. eventType + filter from settings.input.
 *
 * Anything unrecognized is logged and skipped (the flow can still be run
 * manually). We do not throw -- the manager must not destabilize the daemon
 * if a single flow has a malformed trigger.
 *
 * Note: CronScheduler and WebhookManager are imported from the legacy
 * `src/workflows/triggers/` path. They're pure utilities and will move to
 * this directory (or be inlined here) when the Phase 6 cutover deletes the
 * rest of the legacy workflow tree.
 */

import { CronScheduler } from "../../triggers/cron";
import { WebhookManager } from "../../triggers/webhook";
import type { JarvisEventBusAdapter } from "../../adapters/event-bus";
import type { JarvisWorkflowRunnerAdapter } from "../../adapters/workflow-runner";
import { getFlow, listFlows, type FlowRow } from "../../db/repos/flow";
import { getFlowVersion, getLatestDraft } from "../../db/repos/flow-version";

interface TriggerNode {
  type: string;
  name?: string;
  settings?: {
    pieceName?: string;
    triggerName?: string;
    input?: Record<string, unknown>;
  };
}

type ActiveSub = { flowId: string; kind: "cron" | "webhook" | "event"; teardown: () => void };

export interface TriggerManagerDeps {
  workflowRunner: JarvisWorkflowRunnerAdapter;
  eventBus: JarvisEventBusAdapter;
  cronScheduler?: CronScheduler;
  webhookManager?: WebhookManager;
  /** Optional logger; defaults to console. */
  log?: (line: string) => void;
}

export class TriggerManager {
  private readonly runner: JarvisWorkflowRunnerAdapter;
  private readonly bus: JarvisEventBusAdapter;
  private readonly cron: CronScheduler;
  private readonly webhooks: WebhookManager;
  private readonly log: (line: string) => void;
  private readonly subs: Map<string, ActiveSub> = new Map();

  constructor(deps: TriggerManagerDeps) {
    this.runner = deps.workflowRunner;
    this.bus = deps.eventBus;
    this.cron = deps.cronScheduler ?? new CronScheduler();
    this.webhooks = deps.webhookManager ?? new WebhookManager();
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
  start(): void {
    const flows = listFlows(undefined, { status: "ENABLED", limit: 1000 });
    for (const flow of flows) {
      this.register(flow);
    }
    this.log(`started; ${this.subs.size} active subscription(s)`);
  }

  /** Tear down all subscriptions. */
  stop(): void {
    for (const sub of this.subs.values()) {
      try {
        sub.teardown();
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
  refresh(flowId: string): void {
    this.unregister(flowId);
    const flow = getFlow(flowId);
    if (!flow) return;
    if (flow.status !== "ENABLED") return;
    this.register(flow);
  }

  // ---------------------------------------------------------------- private

  private register(flow: FlowRow): void {
    const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
    if (!versionId) return;
    const version = getFlowVersion(versionId);
    if (!version) return;
    const trigger = version.trigger as unknown as TriggerNode | null;
    if (!trigger || typeof trigger !== "object") return;

    if (trigger.type === "EMPTY") return; // manual-run only

    if (trigger.type === "PIECE_TRIGGER") {
      const pieceName = trigger.settings?.pieceName;
      if (pieceName === "schedule") return this.registerCron(flow.id, trigger);
      if (pieceName === "webhook") return this.registerWebhook(flow.id, trigger);
      if (pieceName === "jarvis-trigger") return this.registerJarvisEvent(flow.id, trigger);
      this.log(`flow ${flow.id}: unsupported PIECE_TRIGGER pieceName="${pieceName}"; skipping`);
      return;
    }

    this.log(`flow ${flow.id}: unsupported trigger.type="${trigger.type}"; skipping`);
  }

  private unregister(flowId: string): void {
    const sub = this.subs.get(flowId);
    if (!sub) return;
    try {
      sub.teardown();
    } catch (e) {
      this.log(`teardown error for flow ${flowId}: ${(e as Error).message}`);
    }
    this.subs.delete(flowId);
  }

  private registerCron(flowId: string, trigger: TriggerNode): void {
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
        kind: "cron",
        teardown: () => this.cron.cancel(`flow:${flowId}`),
      });
    } catch (e) {
      this.log(`flow ${flowId}: failed to schedule cron "${expression}": ${(e as Error).message}`);
    }
  }

  private registerWebhook(flowId: string, trigger: TriggerNode): void {
    const input = (trigger.settings?.input ?? {}) as Record<string, unknown>;
    const secret = typeof input.secret === "string" && input.secret ? input.secret : undefined;
    this.webhooks.register(flowId, secret);
    this.subs.set(flowId, {
      flowId,
      kind: "webhook",
      teardown: () => this.webhooks.unregister(flowId),
    });
  }

  private registerJarvisEvent(flowId: string, trigger: TriggerNode): void {
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
      kind: "event",
      teardown: unsubscribe,
    });
  }

  private async fire(flowId: string, payload: Record<string, unknown>, source: string): Promise<void> {
    try {
      await this.runner.start({ flowId, payload });
    } catch (e) {
      this.log(`flow ${flowId} (${source}) fire failed: ${(e as Error).message}`);
    }
  }

  /** Snapshot of active subscriptions. Useful for tests and an /admin endpoint. */
  list(): Array<{ flowId: string; kind: "cron" | "webhook" | "event" }> {
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
