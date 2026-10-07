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

import {
  CronScheduler, CRON_GRACE_MS, CRON_MISSED_LISTED, CRON_MISSED_LOOKBACK_MS, getCronTimezone,
  type CronMissedSummary, type CronOccurrence,
} from "./cron";
import { WebhookManager, type WebhookDelivery, type WebhookFireResult } from "./webhook";
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
import { getWorkflowDb } from '../../db';
import { assertVersionReady, WorkflowReadinessError } from '../../db/repos/flow-readiness';
import { ungrantedCodeSteps } from "../../db/repos/flow-code-steps";
import { createFlowRun, updateRun } from "../../db/repos/flow-run";
import { enqueue, countQueued } from "../../db/repos/job-queue";
import {
  claimFire, clearScheduleWatch, DELAYED_AFTER_MS, getScheduleWatch, latestScheduledFire, pruneFires, recordBlocked,
  recordFire, repeatOf, setScheduleWatch, type FireSource,
} from "../../db/repos/trigger-fire";
import { RUN_FLOW } from "../handler";
import { DEFAULT_IDS } from "../../db/schema";
import type { EngineRuntime } from "../engine-runtime/engine-runtime";
import { toUpstreamFlowVersion } from "../engine-runtime/flow-version-adapter";
import { graphDigest } from "../../runtime/continuation";

interface TriggerNode {
  type: string;
  name?: string;
  settings?: {
    pieceName?: string;
    triggerName?: string;
    input?: Record<string, unknown>;
  };
}

/**
 * Queued jobs beyond which webhook ingress is refused (503, Retry-After) and
 * any webhook fire that slipped past the probe is dropped with a log line.
 */
export const MAX_QUEUED_WEBHOOK_RUNS = 500;

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
  /** Digest of the trigger the subscription was registered from; a saved draft that changes it re-registers. */
  triggerDigest?: string;
  teardown: () => Promise<void> | void;
};


/**
 * Digest of what a subscription is registered from: the trigger node, not the
 * steps after it. Saving a step of a live draft leaves the registration alone
 * (re-registering an engine trigger tears down its external subscription and
 * resets its cursor); changing the schedule or the trigger's settings
 * re-registers.
 */
const triggerDigest = (trigger: unknown): string =>
  graphDigest(trigger && typeof trigger === "object" ? { ...(trigger as Record<string, unknown>), nextAction: undefined } : trigger);

/** The bundled schedule piece is a schedule, not a poll: its occurrences can be missed. */
const isSchedulePiece = (pieceName: unknown): boolean =>
  typeof pieceName === "string" && /(^|\/)piece-schedule$/.test(pieceName);

/** The zone schedules actually run in: Jarvis's configured one, else this machine's. */
function scheduleZone(): string {
  return getCronTimezone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Schedules run in Jarvis's configured time zone (an owner decision, Q-06). A
 * schedule that states another zone fires at that wall-clock time in Jarvis's
 * zone instead; say so where the trigger list shows it, unless it fires at the
 * same moments in both zones (hourly between whole-hour zones). Its next
 * firing times, now and half a year on (the other side of daylight saving),
 * are read in the stated zone: half-hour zones and schedules tied to an hour,
 * a day or a date differ there.
 */
export function scheduleZoneWarning(expression: string, statedZone: unknown, now = Date.now()): string | undefined {
  if (typeof statedZone !== "string" || !statedZone.trim() || expression.trim().startsWith("@")) return undefined;
  let stated: string;
  try { stated = new Intl.DateTimeFormat("en-US", { timeZone: statedZone.trim() }).resolvedOptions().timeZone; }
  catch { return `This schedule names an unknown time zone "${statedZone}"; it runs in ${scheduleZone()}.`; }
  const actual = scheduleZone();
  if (stated === actual) return undefined;
  const year = 366 * 24 * 60 * 60_000;
  const upcoming = [now, now + year / 2].flatMap((from) => CronScheduler.occurrencesBetween(expression, from, from + year, 8));
  if (upcoming.every((o) => CronScheduler.matchesIn(expression, new Date(o.at), stated))) return undefined;
  return `This schedule says ${stated}, but schedules run in Jarvis's time zone (${actual}): "${expression}" fires at that time in ${actual}.`;
}

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
  /** Startup/refresh refusal: notify the owner after its failed run is durable. */
  onRegistrationBlocked?: (notice: { flowId: string; runId: string; message: string }) => void;
  /** Optional logger; defaults to console. */
  log?: (line: string) => void;
  /**
   * Backoff schedule for retrying a failed engine ON_ENABLE, in ms. One entry
   * per retry; the flow is given up on after the last one. Tests override it
   * to keep the clock out of the assertions.
   */
  enableRetryDelaysMs?: number[];
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
  /**
   * Pending ON_ENABLE retries, keyed by flow id. An engine acquire can fail
   * for reasons that have nothing to do with the flow (loaded host, engine
   * mid-restart), and without a retry the flow stays silently unregistered
   * until someone toggles it or the daemon restarts -- the failure looks
   * exactly like "my trigger never fires".
   */
  private readonly enableRetries: Map<
    string,
    { attempt: number; timer: ReturnType<typeof setTimeout> }
  > = new Map();
  private readonly enableRetryDelaysMs: number[];
  private readonly onRegistrationBlocked: TriggerManagerDeps['onRegistrationBlocked'];
  private readonly registrationFailures = new Map<string, string>();
  /**
   * The last live readiness refusal per flow. A schedule tick or a pre-poll
   * check carries no input of its own, so a repeat of the same refusal is
   * one failed run plus a counted blocked row, not a failed run per minute.
   */
  private readonly liveRefusals = new Map<string, string>();
  /** Daily prune of the delivery ledger, for a daemon that runs for weeks. */
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: TriggerManagerDeps) {
    this.bus = deps.eventBus;
    this.onRegistrationBlocked = deps.onRegistrationBlocked;
    this.cron = deps.cronScheduler ?? new CronScheduler();
    this.webhooks = deps.webhookManager ?? new WebhookManager();
    // Public ingress answers 503 while the queue is backed up, so senders
    // retry instead of being told "ok" about a run that was never queued.
    this.webhooks.setCapacityCheck(() => {
      try {
        return countQueued() < MAX_QUEUED_WEBHOOK_RUNS;
      } catch {
        return true; // a probe failure must not close the ingress
      }
    });
    this.engineRuntime = deps.engineRuntime;
    this.log = deps.log ?? ((line) => console.log(`[trigger-manager] ${line}`));
    // 5s / 15s / 1m / 5m / 15m -- covers a brief engine hiccup within seconds
    // and a longer host-level problem (swap storm, restart loop) over ~21min
    // without spawning engines in a tight loop.
    this.enableRetryDelaysMs = deps.enableRetryDelaysMs ?? [
      5_000, 15_000, 60_000, 300_000, 900_000,
    ];

    this.webhooks.setTriggerCallback((flowId, payload, delivery) => this.fire(flowId, payload, "webhook", delivery));
  }

  /** Public surface for the webhook ingress route. */
  webhookManager(): WebhookManager {
    return this.webhooks;
  }

  /** Scan all ENABLED flows and register their triggers. Idempotent. */
  async start(): Promise<void> {
    const prune = () => { try { pruneFires(); } catch (e) { this.log(`trigger ledger prune failed: ${(e as Error).message}`); } };
    prune();
    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(prune, 24 * 60 * 60_000);
      (this.pruneTimer as unknown as { unref?: () => void }).unref?.();
    }
    const flows = listFlows(undefined, { status: "ENABLED", limit: 1000 });
    for (const flow of flows) {
      // Through the per-flow lock, re-reading the flow: one turned off while
      // startup worked through the others is not registered again.
      await this.refresh(flow.id);
    }
    this.log(`started; ${this.subs.size} active subscription(s)`);
  }

  /** Tear down all subscriptions. */
  async stop(): Promise<void> {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    for (const flowId of Array.from(this.enableRetries.keys())) {
      this.clearEnableRetry(flowId);
    }
    for (const sub of this.subs.values()) {
      try {
        await sub.teardown();
      } catch (e) {
        this.log(`teardown error for flow ${sub.flowId}: ${(e as Error).message}`);
      }
    }
    this.subs.clear();
    this.registrationFailures.clear();
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
        clearScheduleWatch(flowId);
        return;
      }

      const desiredVersionId =
        flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;

      // Already registered against the right version -> no-op. This is what
      // makes concurrent refreshes idempotent: the first one through the lock
      // does the work; subsequent calls observe the active sub and skip.
      // A saved edit to the live draft keeps its version id: compare what the
      // trigger says, so an edited schedule replaces the old one.
      const desiredTrigger = desiredVersionId ? getFlowVersion(desiredVersionId)?.trigger : undefined;
      if (existing && existing.versionId === desiredVersionId
        && (!existing.triggerDigest || existing.triggerDigest === triggerDigest(desiredTrigger))) return;

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

    // CODE gate backstop. Registration is the last point at which a version
    // becomes autonomously runnable, and it is not per execution, so declining
    // here is not the run-time refusal that got #459's allowlist pulled. It
    // catches the one thing the publish and enable gates cannot see: which
    // DRAFT is "latest" moves with any write that bumps a draft's `updated`,
    // so a CODE draft that was not live when the flow was enabled can become
    // live later. A published flow always carries the grant, so this can only
    // decline a flow that was never publishable in the first place.
    const ungranted = ungrantedCodeSteps(flow, version.trigger);
    if (ungranted) {
      this.log(
        `flow ${flow.id}: not registering a trigger -- version ${versionId} has CODE step(s) ` +
          `${ungranted.map((name) => `"${name}"`).join(", ")} and code steps are not enabled for this flow ` +
          `(POST /api/workflows/${flow.id}/code-steps {"enabled": true})`,
      );
      // A refused registration owes nothing for the time it stays refused.
      clearScheduleWatch(flow.id);
      return;
    }

    if (!this.checkReadiness(flow.id, versionId, 'registration')) {
      clearScheduleWatch(flow.id);
      return;
    }
    this.registrationFailures.delete(flow.id);
    const pieceName = trigger.type === "PIECE_TRIGGER" ? trigger.settings?.pieceName : undefined;
    // Only a schedule is owed its times: a flow switched to another trigger
    // and back must not have the gap reported as missed.
    if (pieceName !== "schedule" && !isSchedulePiece(pieceName)) clearScheduleWatch(flow.id);

    if (trigger.type === "EMPTY") return; // manual-run only

    if (trigger.type === "PIECE_TRIGGER") {
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
    // Cancel any pending ON_ENABLE retry first: a flow being disabled (or
    // republished) must not be resurrected by a timer armed for the old
    // version.
    this.clearEnableRetry(flowId);
    this.registrationFailures.delete(flowId);
    this.liveRefusals.delete(flowId);
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
    const warning = scheduleZoneWarning(expression, input.timezone);
    if (warning) this.log(`flow ${flowId}: ${warning}`);
    try {
      const dueAfter = this.catchUpMissed(flowId, versionId, expression);
      this.cron.schedule(
        `flow:${flowId}`,
        expression,
        (occurrence?: CronOccurrence) => this.fireSchedule(flowId, versionId, occurrence, { cronExpression: expression }),
        { onMissed: (missed, older) => this.recordMissed(flowId, versionId, missed, "Jarvis was asleep or too busy at that time", older), dueAfter },
      );
      this.subs.set(flowId, {
        flowId,
        versionId,
        kind: "cron",
        triggerDigest: triggerDigest(trigger),
        ...(warning ? { warning } : {}),
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
      triggerDigest: triggerDigest(trigger),
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
      this.fire(flowId, payload, "event", { key: eventItemKey(payload) });
    });
    this.subs.set(flowId, {
      flowId,
      versionId,
      kind: "event",
      triggerDigest: triggerDigest(trigger),
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
   *
   * A failed ON_ENABLE is retried on a backoff (`scheduleEnableRetry`) rather
   * than dropped: the engine round-trip can fail for host-level reasons, and
   * an unregistered flow gives the user no signal beyond "it never fires".
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
        this.scheduleEnableRetry(flow.id, (e as Error).message);
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
    const pureSchedule = isSchedulePiece((version.trigger as unknown as TriggerNode | null)?.settings?.pieceName);
    const warning = pureSchedule && schedule?.cronExpression ? scheduleZoneWarning(schedule.cronExpression, schedule.timezone) : undefined;
    if (warning) this.log(`flow ${flow.id}: ${warning}`);
    if (schedule?.cronExpression) {
      const expression = schedule.cronExpression;
      try {
        const dueAfter = pureSchedule ? this.catchUpMissed(flow.id, version.id, expression) : undefined;
        this.cron.schedule(
          `flow:${flow.id}`,
          expression,
          (occurrence?: CronOccurrence) => { void this.fireEngineTrigger(flow.id, version.id, "cron", occurrence, pureSchedule); },
          // A missed poll of an event source is not a missed run; a missed
          // occurrence of the schedule piece is.
          pureSchedule
            ? { onMissed: (missed, older) => this.recordMissed(flow.id, version.id, missed, "Jarvis was asleep or too busy at that time", older), dueAfter }
            : {},
        );
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
      triggerDigest: triggerDigest(version.trigger),
      ...(warning ? { warning } : {}),
      teardown: () => this.teardownEngineTrigger(flow.id, version.id, cronTearDown, webhookTearDown),
    };
    this.subs.set(flow.id, sub);
    this.clearEnableRetry(flow.id);
  }

  /**
   * Arm the next ON_ENABLE retry for a flow whose engine round-trip failed.
   * The retry goes through `refresh()`, so it re-reads the flow first and
   * quietly does nothing if the user disabled or republished it meanwhile.
   *
   * Attempts escalate along `enableRetryDelaysMs` and reset once the flow
   * registers, so a flow that fails, recovers, and fails again next week gets
   * the full schedule again rather than the tail of the old one.
   */
  private scheduleEnableRetry(flowId: string, reason: string, source = 'engine ON_ENABLE'): void {
    const prior = this.enableRetries.get(flowId);
    if (prior) clearTimeout(prior.timer);
    const attempt = prior ? prior.attempt + 1 : 0;
    const total = this.enableRetryDelaysMs.length;
    const delay = this.enableRetryDelaysMs[attempt];
    if (delay === undefined) {
      this.enableRetries.delete(flowId);
      this.log(
        `flow ${flowId}: ${source} failed: ${reason} -- giving up after ${total} ` +
          `retries; the flow is NOT firing. Re-enable it (or restart the daemon) once the engine is healthy`,
      );
      return;
    }
    const timer = setTimeout(() => {
      void this.refresh(flowId).catch((e) => {
        this.log(`flow ${flowId}: ON_ENABLE retry failed: ${(e as Error).message}`);
      });
    }, delay);
    // Don't hold the daemon open just for a pending retry.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.enableRetries.set(flowId, { attempt, timer });
    this.log(
      `flow ${flowId}: ${source} failed: ${reason} -- retrying in ${Math.round(delay / 1000)}s ` +
        `(attempt ${attempt + 1}/${total}); the flow will not fire until it registers`,
    );
  }

  private clearEnableRetry(flowId: string): void {
    const pending = this.enableRetries.get(flowId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.enableRetries.delete(flowId);
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

  /** A readiness refusal's FAILED run, keeping any input it was handed so nothing is replayed silently. */
  private refusalRun(flowId: string, versionId: string, kind: SubscriptionKind | 'registration', error: WorkflowReadinessError,
    recovery?: { payload: Record<string, unknown>; executeTrigger: boolean }) {
    return getWorkflowDb().transaction(() => {
      const now = Date.now();
      const created = createFlowRun({ flowId, flowVersionId: versionId,
        projectId: getFlow(flowId)?.project_id, triggeredBy: `trigger:${kind}`,
        status: 'FAILED', startTime: now, tags: ['workflow-readiness'] });
      return updateRun(created.id, { finishTime: now, stepsCount: 0,
        failedStep: { name: '<readiness>', displayName: 'Workflow readiness', errorMessage: error.message },
        steps: { '<readiness>': { status: 'FAILED', output: { code: error.code, phase: kind, readiness: error.readiness,
          // Polling may already have advanced its cursor while readiness
          // changed. Keep every returned item, but never replay it silently.
          ...(recovery ? { recovery: { ...recovery, requiresDecision: true } } : {}),
        } } } });
    })();
  }

  /** Registration-time readiness: one refusal per broken version, a notice, and a retry. */
  private checkReadiness(flowId: string, versionId: string, kind: 'registration'): boolean {
    try { assertVersionReady(flowId, versionId); return true; }
    catch (error) {
      if (!(error instanceof WorkflowReadinessError)) throw error;
      const signature = JSON.stringify([versionId, error.readiness]);
      if (this.registrationFailures.get(flowId) !== signature) {
        const run = this.refusalRun(flowId, versionId, kind, error);
        this.registrationFailures.set(flowId, signature);
        try { this.onRegistrationBlocked?.({ flowId, runId: run.id, message: error.message }); }
        catch (notifyError) { this.log(`flow ${flowId}: readiness notification failed: ${String(notifyError)}`); }
      }
      this.log(`flow ${flowId}: readiness refused ${kind}: ${error.message}`);
      this.scheduleEnableRetry(flowId, error.message, 'readiness');
      return false;
    }
  }

  /**
   * Why a live delivery may not start work, or null: the workflow still
   * exists, is on, and still runs the version this subscription was
   * registered for.
   */
  private notAdmitted(flowId: string, versionId: string): string | null {
    const flow = getFlow(flowId);
    if (!flow) return "The workflow no longer exists.";
    if (flow.status !== "ENABLED") return "The workflow is turned off.";
    if (this.subs.get(flowId)?.versionId !== versionId) return "The workflow changed; this trigger no longer runs it.";
    return null;
  }

  /**
   * A live readiness refusal. Input-carrying deliveries (webhooks, events, poll
   * items) keep a FAILED run each, holding their input for a person to decide
   * on, as before. A schedule tick or a pre-poll check carries nothing: a
   * repeat of the same refusal is folded into one counted blocked row.
   */
  private refuseLive(opts: LiveStart, error: WorkflowReadinessError): WebhookFireResult {
    const { flowId, versionId, source } = opts;
    const signature = JSON.stringify([versionId, error.readiness]);
    const carriesInput = opts.payload !== undefined && source !== "schedule";
    let runId: string | undefined;
    if (carriesInput || this.liveRefusals.get(flowId) !== signature) {
      runId = this.refusalRun(flowId, versionId, opts.kind, error,
        carriesInput ? { payload: opts.payload ?? {}, executeTrigger: opts.executeTrigger ?? false } : undefined).id;
      this.liveRefusals.set(flowId, signature);
    }
    const detail = { reason: error.message, code: error.code };
    const fire = carriesInput
      ? recordFire({ flowId, flowVersionId: versionId, source, dedupeKey: opts.dedupeKey, scheduledFor: opts.scheduledFor,
          lateMs: opts.lateMs, outcome: "blocked", runId, detail })
      : recordBlocked({ flowId, flowVersionId: versionId, source, signature, scheduledFor: opts.scheduledFor,
          lateMs: opts.lateMs, runId, detail });
    this.log(`flow ${flowId}: readiness refused ${source}: ${error.message}`);
    return { outcome: "blocked", fireId: fire?.id, reason: error.message };
  }

  /**
   * Start one run for one delivery, or say why not. Admission, a repeat of a
   * delivery already handled, and readiness come first; then the delivery's
   * key is claimed and the run and its queue job are created in one
   * transaction, so a crash between them cannot leave a queued run that
   * nothing will execute. Synchronous throughout: nothing can turn the
   * workflow off between the admission check and the claim.
   * `triggeredBy` keeps one convention, `trigger:<kind>`.
   */
  private startRun(opts: LiveStart): WebhookFireResult {
    const { flowId, versionId } = opts;
    const off = this.notAdmitted(flowId, versionId);
    if (off) {
      const fire = recordFire({ flowId, flowVersionId: versionId, source: opts.source, scheduledFor: opts.scheduledFor,
        outcome: "blocked", detail: { reason: off, ...(opts.dedupeKey ? { deliveryKey: opts.dedupeKey } : {}) } });
      this.log(`flow ${flowId} (${opts.source}) not started: ${off}`);
      return { outcome: "blocked", fireId: fire?.id, reason: off, disabled: true };
    }
    const repeat = opts.dedupeKey ? repeatOf({ flowId, source: opts.source, dedupeKey: opts.dedupeKey, duplicateSince: opts.duplicateSince }) : null;
    if (repeat) {
      this.log(`flow ${flowId} (${opts.source}) repeat of ${repeat.id} not run again`);
      return { outcome: "duplicate", fireId: repeat.id, runId: repeat.runId ?? undefined };
    }
    try { assertVersionReady(flowId, versionId); }
    catch (error) {
      if (!(error instanceof WorkflowReadinessError)) throw error;
      return this.refuseLive(opts, error);
    }
    this.liveRefusals.delete(flowId);
    const claimed = claimFire({ flowId, flowVersionId: versionId, source: opts.source, dedupeKey: opts.dedupeKey,
      duplicateSince: opts.duplicateSince, scheduledFor: opts.scheduledFor, lateMs: opts.lateMs, detail: opts.detail }, () => {
      const run = createFlowRun({ flowId, flowVersionId: versionId, projectId: getFlow(flowId)!.project_id,
        triggeredBy: `trigger:${opts.kind}`, startTime: Date.now() });
      enqueue({
        jobType: RUN_FLOW,
        payload: { runId: run.id, payload: opts.payload ?? {}, ...(opts.executeTrigger ? { executeTrigger: true } : {}) },
        flowRunId: run.id,
        flowId,
        flowVersionId: versionId,
        // No auto-retry: trigger-fired runs often have side effects that
        // would duplicate on retry (e.g. notify, email, downstream API
        // calls). Surface the failure once; the trigger's next fire is
        // the natural "retry" cadence.
        maxAttempts: 1,
      });
      return { runId: run.id };
    });
    if (claimed.outcome === "started") return { outcome: "started", fireId: claimed.fire.id, runId: claimed.runId };
    if (claimed.outcome === "duplicate") return { outcome: "duplicate", fireId: claimed.fire.id, runId: claimed.fire.runId ?? undefined };
    return { outcome: "blocked", fireId: claimed.fire.id, reason: claimed.reason };
  }

  /** A run from an earlier occurrence has not started yet: piling another behind it would only burst later. */
  private overlapping(flowId: string, triggeredBy: string): string | null {
    const queued = getWorkflowDb().query<{ id: string }, [string, string]>(
      `SELECT id FROM flow_run WHERE flow_id = ? AND status = 'QUEUED' AND triggered_by = ? LIMIT 1`,
    ).get(flowId, triggeredBy);
    return queued ? "The run from the previous time had not started yet." : null;
  }

  /**
   * Scheduled occurrences that came and went: recorded as missed, never run
   * late (an owner decision, Q-06). The newest are listed one by one, keyed so
   * a time is recorded once; older ones are counted in one row. One
   * transaction for the lot.
   */
  private recordMissed(flowId: string, versionId: string, missed: Array<{ at: number; key: string; lateMs?: number }>,
    reason: string, older?: CronMissedSummary): void {
    let recorded = 0;
    try {
      getWorkflowDb().transaction(() => {
        if (older) {
          recordFire({ flowId, flowVersionId: versionId, source: "schedule", scheduledFor: older.from, outcome: "missed",
            detail: { reason, count: older.count, through: older.through } });
          recorded += older.count;
        }
        for (const occurrence of missed) {
          if (recordFire({ flowId, flowVersionId: versionId, source: "schedule", dedupeKey: occurrence.key,
            scheduledFor: occurrence.at, lateMs: occurrence.lateMs ?? null, outcome: "missed", detail: { reason } })) recorded++;
        }
      })();
    } catch (e) {
      this.log(`flow ${flowId}: could not record missed schedule times: ${(e as Error).message}`);
    }
    if (recorded) this.log(`flow ${flowId}: ${recorded} scheduled time(s) missed (${reason}); not run late`);
  }

  /**
   * At registration, the occurrences this schedule was owed while Jarvis was
   * not running are recorded as missed. A schedule is owed from when it was
   * last watched (kept across a restart, cleared when the workflow is turned
   * off), and only for occurrences nothing has handled yet. The newest are
   * listed one by one; older ones are counted in a single row.
   *
   * Returns where the live tick should start: where this check stopped, so a
   * time inside the grace window is still run, late, rather than lost between
   * the two. A time the previous process already handled is then a repeat by
   * its key, never a second run. Undefined for a schedule that was not being
   * watched: it starts from its registration minute.
   */
  private catchUpMissed(flowId: string, versionId: string, expression: string): number | undefined {
    const now = Date.now();
    let dueAfter: number | undefined;
    try {
      const watch = getScheduleWatch(flowId);
      if (watch && watch.expression === expression) {
        const since = Math.max(watch.watchedSince, latestScheduledFire(flowId) ?? 0, now - CRON_MISSED_LOOKBACK_MS);
        dueAfter = now - CRON_GRACE_MS;
        const owed = CronScheduler.occurrencesBetween(expression, since, now - CRON_GRACE_MS, 100_000);
        const listed = owed.slice(-CRON_MISSED_LISTED);
        const older = owed.slice(0, owed.length - listed.length);
        this.recordMissed(flowId, versionId, listed.map((o) => ({ ...o, lateMs: now - o.at })), "The schedule was not running at that time",
          older.length ? { count: older.length, from: older[0]!.at, through: older[older.length - 1]!.at } : undefined);
      }
      setScheduleWatch(flowId, expression, now);
    } catch (e) {
      this.log(`flow ${flowId}: could not check for missed schedule times: ${(e as Error).message}`);
    }
    return dueAfter;
  }

  /**
   * A built-in schedule's occurrence. Never throws: it runs on the scheduler's
   * interval. An occurrence the previous run has not started for yet is
   * skipped, not stacked.
   */
  private fireSchedule(flowId: string, versionId: string, occurrence: CronOccurrence | undefined, payload: Record<string, unknown>): void {
    try {
      // A job left over from a replaced registration does nothing.
      if (this.subs.get(flowId)?.versionId !== versionId) return;
      const at = occurrence?.at ?? Date.now();
      const skipped = this.overlapping(flowId, "trigger:cron");
      if (skipped) {
        recordFire({ flowId, flowVersionId: versionId, source: "schedule", dedupeKey: occurrence?.key, scheduledFor: at,
          lateMs: occurrence?.lateMs ?? null, outcome: "skipped", detail: { reason: skipped } });
        this.log(`flow ${flowId}: schedule ${occurrence?.key ?? "tick"} skipped: ${skipped}`);
        return;
      }
      const result = this.startRun({
        flowId, versionId, kind: "cron", source: "schedule",
        payload: { ...payload, firedAt: Date.now(), scheduledFor: new Date(at).toISOString() },
        dedupeKey: occurrence?.key, scheduledFor: at, lateMs: occurrence?.lateMs, ...shiftedDetail(occurrence),
      });
      if (result.outcome === "started" && (occurrence?.lateMs ?? 0) > DELAYED_AFTER_MS) {
        this.log(`flow ${flowId}: schedule ${occurrence!.key} started ${Math.round(occurrence!.lateMs / 1000)}s late`);
      }
    } catch (e) {
      this.log(`flow ${flowId} (cron) fire failed: ${(e as Error).message}`);
    }
  }

  /**
   * Engine-managed trigger fire (polling sources, e.g. jarvis-trigger
   * on_event, and the bundled schedule piece). On each cron tick we run the
   * trigger's RUN hook to POLL for new events, then start exactly one run per
   * returned item that has not been handled before.
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
   *
   * Never rejects: it runs as a `void` interval callback, and an escaped
   * rejection (a workflow deleted mid-poll) used to take the daemon down.
   */
  private async fireEngineTrigger(flowId: string, versionId: string, source: string, occurrence?: CronOccurrence, pureSchedule = false): Promise<void> {
    try {
      await this.pollEngineTrigger(flowId, versionId, source, occurrence, pureSchedule);
    } catch (e) {
      this.log(`flow ${flowId} (engine-${source}) failed: ${(e as Error).message}`);
    }
  }

  private async pollEngineTrigger(flowId: string, versionId: string, source: string, occurrence: CronOccurrence | undefined,
    pureSchedule: boolean): Promise<void> {
    const engine = this.engineRuntime;
    if (!engine) return;
    // A scheduled time that does not run still leaves a row, so the ledger
    // can tell it from one that was never due.
    const unrun = (outcome: "blocked" | "skipped", reason: string): void => {
      if (pureSchedule) recordFire({ flowId, flowVersionId: versionId, source: "schedule", scheduledFor: occurrence?.at ?? null,
        lateMs: occurrence?.lateMs ?? null, outcome, detail: { reason } });
    };
    // Skip if a prior poll for this flow is still running (slow poll vs. fast
    // cron); the next tick will pick up anything missed.
    if (this.pollingInFlight.has(flowId)) {
      unrun("skipped", "The previous check of this schedule was still running.");
      return;
    }
    const version = getFlowVersion(versionId);
    if (!version) {
      this.log(`flow ${flowId} (engine-${source}): version ${versionId} not found; skipping poll`);
      unrun("blocked", "The workflow version no longer exists.");
      return;
    }
    const off = this.notAdmitted(flowId, versionId);
    if (off) {
      unrun("blocked", off);
      return;
    }
    const fireSource: FireSource = pureSchedule ? "schedule" : "poll";
    if (pureSchedule) {
      const skipped = this.overlapping(flowId, "trigger:engine");
      if (skipped) {
        recordFire({ flowId, flowVersionId: versionId, source: "schedule", dedupeKey: occurrence?.key,
          scheduledFor: occurrence?.at ?? null, lateMs: occurrence?.lateMs ?? null, outcome: "skipped", detail: { reason: skipped } });
        return;
      }
    }
    try { assertVersionReady(flowId, versionId); }
    catch (error) {
      if (!(error instanceof WorkflowReadinessError)) throw error;
      this.refuseLive({ flowId, versionId, kind: "engine", source: fireSource, scheduledFor: occurrence?.at, lateMs: occurrence?.lateMs }, error);
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
      unrun("blocked", `The schedule could not run: ${(e as Error).message.slice(0, 300)}`);
      return;
    } finally {
      this.pollingInFlight.delete(flowId);
    }

    if (items.length === 0) return; // no new events -> no run (the whole point)
    // The workflow may have been turned off, changed or deleted while the
    // engine polled: `startRun` refuses each item then, and records it, since
    // the trigger's cursor has already moved past it.
    let started = 0;
    for (const item of items) {
      // Pass the event through verbatim as the trigger payload. Objects are
      // used as-is; a bare value (rare) is wrapped so the payload stays an
      // object for the engine's variable resolver.
      const payload = item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : { value: item };
      try {
        const result = this.startRun({
          flowId, versionId, kind: "engine", source: fireSource, payload, executeTrigger: false,
          dedupeKey: pureSchedule ? occurrence?.key : eventItemKey(payload),
          ...(pureSchedule ? { scheduledFor: occurrence?.at, lateMs: occurrence?.lateMs, ...shiftedDetail(occurrence) } : {}),
        });
        if (result.outcome === "started") started++;
      } catch (e) {
        this.log(`flow ${flowId} (engine-${source}): a polled item could not start: ${(e as Error).message}`);
      }
    }
    this.log(`flow ${flowId} (engine-${source}): polled ${items.length} event(s) -> ${started} run(s)`);
  }

  /**
   * Trigger fire for webhook / direct event-bus subscribe (cron goes through
   * `fireSchedule`). The payload is forwarded as the trigger payload. For
   * engine-managed subscriptions (`sub.kind === "engine"`) the run is
   * enqueued with `executeTrigger=true` so the engine's `trigger.run()`
   * consumes the payload (e.g. webhook body for an engine webhook trigger)
   * to derive the actual flow-run payload(s); legacy subs run the chain
   * directly with the payload as initial state. Returns what became of the
   * delivery, for the webhook reply.
   */
  private fire(flowId: string, payload: Record<string, unknown>, kind: "webhook" | "event", delivery: WebhookDelivery = {}): WebhookFireResult {
    const sub = this.subs.get(flowId);
    const versionId = sub?.versionId;
    if (!sub || !versionId) {
      this.log(`flow ${flowId} (${kind}) fire skipped: no active subscription`);
      return { outcome: "blocked", reason: "The workflow is not listening for this trigger.", disabled: true };
    }
    // Backlog cap for the public ingress: the webhook route is rate limited
    // per minute, but a worker that is slow or down would still let the
    // queue grow without bound. Owner-driven kinds are not dropped.
    if (kind === "webhook") {
      let queued = 0;
      try {
        queued = countQueued();
      } catch (e) {
        this.log(`flow ${flowId} (webhook) backlog check failed: ${(e as Error).message}`);
      }
      if (queued >= MAX_QUEUED_WEBHOOK_RUNS) {
        this.log(`flow ${flowId} (webhook) fire dropped: ${queued} jobs already queued`);
        const fire = recordFire({ flowId, flowVersionId: versionId, source: "webhook", outcome: "skipped",
          detail: { reason: `${queued} jobs were already queued; the sender was asked to retry.` } });
        return { outcome: "skipped", fireId: fire?.id, reason: "Service busy, retry later", retryAfterSeconds: 30 };
      }
    }
    try {
      return this.startRun({
        flowId,
        versionId,
        kind: sub.kind,
        source: kind,
        payload,
        ...(sub.kind === "engine" ? { executeTrigger: true } : {}),
        dedupeKey: delivery.key,
        ...(delivery.windowMs ? { duplicateSince: Date.now() - delivery.windowMs } : {}),
        ...(delivery.label ? { detail: { delivery: delivery.label } } : {}),
      });
    } catch (e) {
      this.log(`flow ${flowId} (${kind}) fire failed: ${(e as Error).message}`);
      return { outcome: "error", reason: "The delivery could not be recorded; retry later." };
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

/** What `startRun` needs for one live delivery. */
interface LiveStart {
  flowId: string;
  versionId: string;
  kind: SubscriptionKind;
  source: FireSource;
  payload?: Record<string, unknown>;
  executeTrigger?: boolean;
  dedupeKey?: string;
  duplicateSince?: number;
  scheduledFor?: number;
  lateMs?: number;
  detail?: Record<string, unknown>;
}

/** Why a schedule ran at a time it does not name: the spring-forward jump skipped its own. */
function shiftedDetail(occurrence: CronOccurrence | undefined): { detail?: Record<string, unknown> } {
  return occurrence?.shifted ? { detail: { reason: "This time did not exist when clocks moved forward; it ran right after the change." } } : {};
}

/**
 * An event's delivery key: the stable key its publisher gave it (an email's
 * message id, a commitment and its due time), else the poll item's own key.
 * Without one, the event is not deduplicated.
 */
function eventItemKey(payload: Record<string, unknown>): string | undefined {
  const inner = payload.payload && typeof payload.payload === "object" ? (payload.payload as Record<string, unknown>) : undefined;
  const eventKey = inner?._eventKey ?? payload._eventKey;
  if (typeof eventKey === "string" && eventKey) return `event:${eventKey}`;
  const itemKey = payload._dedupe_key;
  return typeof itemKey === "string" || typeof itemKey === "number" ? `item:${String(itemKey)}` : undefined;
}
