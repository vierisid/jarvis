/**
 * Q-06: the trigger delivery ledger. Every scheduled occurrence, webhook
 * delivery, event, poll item and continuation the daemon handles leaves one
 * row saying what became of it: started a run, was a repeat of one already
 * handled, was missed while Jarvis was off, was blocked, was skipped, or
 * stopped a run because its workflow was turned off.
 *
 * A delivery's identity is its `dedupe_key`: the schedule's wall-clock minute,
 * a provider's delivery id, an event key, a waitpoint digest. The key is
 * claimed in the same transaction that creates the run and its queue job, so
 * a repeated delivery (a provider retry, a restart inside the firing minute,
 * the autumn hour that happens twice) never becomes a second run.
 */
import { createHash } from "node:crypto";
import { getWorkflowDb } from "../index";
import { apId } from "../ids";

export type FireSource = "schedule" | "webhook" | "event" | "poll" | "resume" | "lifecycle";
export type FireOutcome = "started" | "duplicate" | "missed" | "blocked" | "skipped" | "stopped";

export interface TriggerFire {
  id: string;
  flowId: string;
  flowVersionId: string | null;
  source: FireSource;
  dedupeKey: string | null;
  /** When the delivery was due: a schedule's occurrence, a timer's resume time. */
  scheduledFor: number | null;
  observedAt: number;
  outcome: FireOutcome;
  runId: string | null;
  /** How long after `scheduledFor` it was handled, when that is known. */
  lateMs: number | null;
  /** How many more times the same delivery arrived and was not run again. */
  repeats: number;
  lastRepeatAt: number | null;
  detail: Record<string, unknown> | null;
}

interface FireRow {
  id: string; flow_id: string; flow_version_id: string | null; source: string; dedupe_key: string | null;
  scheduled_for: number | null; observed_at: number; outcome: string; run_id: string | null; late_ms: number | null;
  repeats: number; last_repeat_at: number | null; detail: string | null;
}

/** A start that ran past this is shown as delayed. */
export const DELAYED_AFTER_MS = 60_000;
/** Ledger rows older than this are pruned. */
export const FIRE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DETAIL_MAX = 2_000;

const db = () => getWorkflowDb();

function rowToFire(row: FireRow): TriggerFire {
  let detail: Record<string, unknown> | null = null;
  try { detail = row.detail ? JSON.parse(row.detail) as Record<string, unknown> : null; } catch { detail = null; }
  return {
    id: row.id, flowId: row.flow_id, flowVersionId: row.flow_version_id, source: row.source as FireSource,
    dedupeKey: row.dedupe_key, scheduledFor: row.scheduled_for, observedAt: row.observed_at,
    outcome: row.outcome as FireOutcome, runId: row.run_id, lateMs: row.late_ms, repeats: row.repeats,
    lastRepeatAt: row.last_repeat_at, detail,
  };
}

/** Bounded, so a long reason or payload excerpt cannot grow a row without limit. */
function detailJson(detail?: Record<string, unknown> | null): string | null {
  if (!detail) return null;
  const json = JSON.stringify(detail);
  return json.length <= DETAIL_MAX ? json : JSON.stringify({ truncated: true, reason: String(detail.reason ?? "").slice(0, 500) });
}

/** A bearer capability (a waitpoint id) never goes into a readable column as itself. */
export function fireDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export interface FireInput {
  flowId: string;
  flowVersionId?: string | null;
  source: FireSource;
  dedupeKey?: string | null;
  scheduledFor?: number | null;
  observedAt?: number;
  lateMs?: number | null;
  detail?: Record<string, unknown> | null;
}

/**
 * Record a delivery that started nothing. With a key it is recorded once:
 * recording the same missed occurrence again (a second restart) is a no-op.
 */
export function recordFire(input: FireInput & { outcome: Exclude<FireOutcome, "started" | "duplicate">; runId?: string | null }): TriggerFire | null {
  const id = apId();
  const result = db().run(
    `INSERT OR IGNORE INTO workflow_trigger_fire (id, flow_id, flow_version_id, source, dedupe_key, scheduled_for,
      observed_at, outcome, run_id, late_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.flowId, input.flowVersionId ?? null, input.source, input.dedupeKey ?? null, input.scheduledFor ?? null,
      input.observedAt ?? Date.now(), input.outcome, input.runId ?? null, input.lateMs ?? null, detailJson(input.detail)],
  );
  return result.changes ? getFire(id) : null;
}

/**
 * Fold a repeat of the same blocked condition into the latest row instead of
 * adding one per tick: a broken every-minute schedule is one row that counts
 * its blocked occurrences, not 1,440 rows a day.
 */
export function recordBlocked(input: FireInput & { signature: string; runId?: string | null }): TriggerFire {
  const now = input.observedAt ?? Date.now();
  return db().transaction(() => {
    const latest = db().query<FireRow, [string, string]>(
      `SELECT * FROM workflow_trigger_fire WHERE flow_id = ? AND source = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
    ).get(input.flowId, input.source);
    const latestFire = latest ? rowToFire(latest) : null;
    if (latestFire?.outcome === "blocked" && latestFire.detail?.signature === input.signature) {
      db().run(`UPDATE workflow_trigger_fire SET repeats = repeats + 1, last_repeat_at = ?, scheduled_for = COALESCE(?, scheduled_for)
        WHERE id = ?`, [now, input.scheduledFor ?? null, latestFire.id]);
      return getFire(latestFire.id)!;
    }
    const id = apId();
    db().run(
      `INSERT INTO workflow_trigger_fire (id, flow_id, flow_version_id, source, dedupe_key, scheduled_for, observed_at,
        outcome, run_id, late_ms, detail) VALUES (?, ?, ?, ?, NULL, ?, ?, 'blocked', ?, ?, ?)`,
      [id, input.flowId, input.flowVersionId ?? null, input.source, input.scheduledFor ?? null, now, input.runId ?? null,
        input.lateMs ?? null, detailJson({ ...(input.detail ?? {}), signature: input.signature })],
    );
    return getFire(id)!;
  }).immediate();
}

/**
 * The earlier delivery this one repeats (same key, seen since
 * `duplicateSince`), with the repeat counted on it; null when it is new.
 * Asked before readiness, so a provider retrying into a broken workflow does
 * not leave a failed run per retry.
 */
export function repeatOf(input: { flowId: string; source: FireSource; dedupeKey: string; duplicateSince?: number }): TriggerFire | null {
  return db().transaction((): TriggerFire | null => {
    const existing = db().query<FireRow, [string, string, string, number]>(
      `SELECT * FROM workflow_trigger_fire WHERE flow_id = ? AND source = ? AND dedupe_key = ? AND observed_at >= ?`,
    ).get(input.flowId, input.source, input.dedupeKey, input.duplicateSince ?? 0);
    if (!existing) return null;
    db().run(`UPDATE workflow_trigger_fire SET repeats = repeats + 1, last_repeat_at = ? WHERE id = ?`, [Date.now(), existing.id]);
    return getFire(existing.id);
  }).immediate();
}

export type ClaimStart = { runId: string } | { blocked: string; keepKey?: boolean };
export type ClaimResult =
  | { outcome: "started"; fire: TriggerFire; runId: string }
  | { outcome: "duplicate"; fire: TriggerFire }
  | { outcome: "blocked"; fire: TriggerFire; reason: string };

/**
 * Claim a delivery and start its run in one transaction. A delivery whose key
 * (or one of `alsoDuplicateOf`, seen since `duplicateSince`) was handled
 * before is a repeat: the original row counts it and nothing starts. `start`
 * creates the run and its queue job inside the same transaction, or declines
 * (`blocked`); a declined delivery keeps its key only when `keepKey` is set,
 * so a provider retrying after the workflow is turned back on is not refused.
 */
export function claimFire(
  input: FireInput & { alsoDuplicateOf?: string[]; duplicateSince?: number },
  start: (fireId: string) => ClaimStart,
): ClaimResult {
  const now = input.observedAt ?? Date.now();
  return db().transaction((): ClaimResult => {
    const keys = [input.dedupeKey, ...(input.alsoDuplicateOf ?? [])].filter((key): key is string => !!key);
    if (keys.length) {
      const existing = db().query<FireRow, (string | number)[]>(
        `SELECT * FROM workflow_trigger_fire WHERE flow_id = ? AND source = ? AND dedupe_key IN (${keys.map(() => "?").join(", ")})
           AND observed_at >= ? ORDER BY observed_at LIMIT 1`,
      ).get(input.flowId, input.source, ...keys, input.duplicateSince ?? 0);
      if (existing) {
        db().run(`UPDATE workflow_trigger_fire SET repeats = repeats + 1, last_repeat_at = ? WHERE id = ?`, [now, existing.id]);
        return { outcome: "duplicate", fire: getFire(existing.id)! };
      }
    }
    const id = apId();
    // A key older than the duplicate window is released before it is reused.
    if (input.dedupeKey && input.duplicateSince) {
      db().run(`UPDATE workflow_trigger_fire SET dedupe_key = NULL WHERE flow_id = ? AND source = ? AND dedupe_key = ?`,
        [input.flowId, input.source, input.dedupeKey]);
    }
    db().run(
      `INSERT INTO workflow_trigger_fire (id, flow_id, flow_version_id, source, dedupe_key, scheduled_for, observed_at,
        outcome, run_id, late_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', NULL, ?, ?)`,
      [id, input.flowId, input.flowVersionId ?? null, input.source, input.dedupeKey ?? null, input.scheduledFor ?? null,
        now, input.lateMs ?? null, detailJson(input.detail)],
    );
    const started = start(id);
    if ("blocked" in started) {
      db().run(`UPDATE workflow_trigger_fire SET outcome = 'blocked', dedupe_key = ?, detail = ? WHERE id = ?`,
        [started.keepKey ? input.dedupeKey ?? null : null,
          detailJson({ ...(input.detail ?? {}), reason: started.blocked, ...(started.keepKey || !input.dedupeKey ? {} : { deliveryKey: input.dedupeKey }) }), id]);
      return { outcome: "blocked", fire: getFire(id)!, reason: started.blocked };
    }
    db().run(`UPDATE workflow_trigger_fire SET run_id = ? WHERE id = ?`, [started.runId, id]);
    return { outcome: "started", fire: getFire(id)!, runId: started.runId };
  }).immediate();
}

export function getFire(id: string): TriggerFire | null {
  const row = db().query<FireRow, [string]>(`SELECT * FROM workflow_trigger_fire WHERE id = ?`).get(id);
  return row ? rowToFire(row) : null;
}

/** The delivery that started this run, if a trigger or continuation did. */
export function fireForRun(runId: string): TriggerFire | null {
  const row = db().query<FireRow, [string]>(
    `SELECT * FROM workflow_trigger_fire WHERE run_id = ? AND source != 'resume' AND source != 'lifecycle' ORDER BY observed_at LIMIT 1`,
  ).get(runId);
  return row ? rowToFire(row) : null;
}

/** The latest schedule occurrence this flow handled, whatever became of it. */
export function latestScheduledFire(flowId: string): number | null {
  const row = db().query<{ at: number | null }, [string]>(
    `SELECT MAX(scheduled_for) AS at FROM workflow_trigger_fire WHERE flow_id = ? AND source = 'schedule'`,
  ).get(flowId);
  return row?.at ?? null;
}

export interface TriggerFireView extends TriggerFire {
  /** What a person reads: missed, blocked, skipped, duplicate, stopped, or the run's own state (delayed when it started late). */
  label: string;
  runStatus: string | null;
}

/** Newest first, with the run's status so completed, failed and delayed work read apart. */
export function listFlowFires(flowId: string, opts: { limit?: number; before?: number } = {}): TriggerFireView[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const rows = db().query<FireRow & { run_status: string | null }, [string, number, number]>(
    `SELECT f.*, r.status AS run_status FROM workflow_trigger_fire f LEFT JOIN flow_run r ON r.id = f.run_id
      WHERE f.flow_id = ? AND f.observed_at < ? ORDER BY f.observed_at DESC, f.rowid DESC LIMIT ?`,
  ).all(flowId, opts.before ?? Number.MAX_SAFE_INTEGER, limit);
  return rows.map(row => {
    const fire = rowToFire(row);
    return { ...fire, runStatus: row.run_status, label: fireLabel(fire, row.run_status) };
  });
}

export function fireLabel(fire: TriggerFire, runStatus: string | null): string {
  if (fire.outcome !== "started") return fire.outcome;
  const late = (fire.lateMs ?? 0) > DELAYED_AFTER_MS;
  if (!runStatus) return late ? "delayed" : "started";
  if (runStatus === "SUCCEEDED") return late ? "completed late" : "completed";
  if (runStatus === "QUEUED" || runStatus === "RUNNING" || runStatus === "PAUSED") return late ? "delayed" : runStatus.toLowerCase();
  return runStatus.toLowerCase();
}

/** Keep the ledger bounded. */
export function pruneFires(now = Date.now()): number {
  return db().run(`DELETE FROM workflow_trigger_fire WHERE observed_at < ?`, [now - FIRE_RETENTION_MS]).changes;
}

export interface ScheduleWatch { flowId: string; expression: string; watchedSince: number }

export function getScheduleWatch(flowId: string): ScheduleWatch | null {
  const row = db().query<{ flow_id: string; expression: string; watched_since: number }, [string]>(
    `SELECT * FROM workflow_schedule_watch WHERE flow_id = ?`).get(flowId);
  return row ? { flowId: row.flow_id, expression: row.expression, watchedSince: row.watched_since } : null;
}

export function setScheduleWatch(flowId: string, expression: string, since = Date.now()): void {
  db().run(`INSERT INTO workflow_schedule_watch (flow_id, expression, watched_since) VALUES (?, ?, ?)
    ON CONFLICT(flow_id) DO UPDATE SET expression = excluded.expression, watched_since = excluded.watched_since`,
    [flowId, expression, since]);
}

/** A turned-off or deleted workflow is owed nothing. */
export function clearScheduleWatch(flowId: string): void {
  db().run(`DELETE FROM workflow_schedule_watch WHERE flow_id = ?`, [flowId]);
}
