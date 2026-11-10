import type { Database } from 'bun:sqlite';
import { getDb } from '../vault/schema';
import { invalid, number, timezone } from '../goals/validation';
import type { BriefMeasurement, BriefOutcome, BriefReadResult, BriefEvidenceRef } from './contracts';
import { outcomeWindow, outcomeCalendar, type OutcomeWindow } from './outcome-windows';
import { estimateMinutesFromJson, MAX_ESTIMATED_MINUTES_PER_WORKFLOW_PER_DAY } from '../workflows/time-saved-estimate';
import { OutcomeConflict, outcomeId, readOutcomeTime, timeBack, timeCommand, type OutcomeTimeRecord } from './outcome-time';

type WorkRow = { work_id: string; goal_id: string | null; mode: string; workflow_id: string | null; workflow_version_id: string | null;
  run_id: string | null; decision: string | null; result_check: string; blocker: string | null; created_at: number; status: string; completed_at: number | null };
type Check = { id: string; verdict: string; checkedAt: number; checkedBy: string; runId: string | null; evidence: { ref: string }[] };
type Run = { id: string; flow_id: string; flow_version_id: string; parent_run_id: string | null; status: string;
  environment: string; step_name_to_test: string | null; execution_config: string | null; start_time: number | null; finish_time: number | null };
export interface OutcomeCoverage { candidates: number; eligible: number; excluded: Record<string, number>; timed: number; untimed: number; complete: boolean }
export interface GoalDelta {
  goalId: string; title: string; change: BriefMeasurement | null; reason: 'missing_opening' | 'definition_changed' | null;
  attribution: 'observed_change_only'; rollup: 'independent';
}
/** One counted root run: its minutes and where they came from. */
interface RunTime { runId: string; flowId: string; finishedAt: number; minutes: number; source: 'owner' | 'estimate'; capped?: boolean }
export interface OutcomeSummary {
  window: OutcomeWindow; today: BriefMeasurement | null; week: BriefMeasurement | null;
  /** Plain-words basis of the figure above, e.g. "14 runs x about 12 min. Estimated from each workflow's steps." */
  todayBasis: string | null; weekBasis: string | null;
  days: { id: string; current: boolean; future: boolean; time: BriefMeasurement | null; basis: string | null; coverage: OutcomeCoverage }[];
  completedWork: BriefMeasurement | null; outcomes: BriefOutcome[]; goalDeltas: GoalDelta[]; todayGoalDeltas: GoalDelta[];
  coverage: OutcomeCoverage; basis: string;
}
type Read<T> = BriefReadResult<T> & { coverage?: OutcomeCoverage };
const parse = <T>(s: string | null): T | null => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const within = (at: number, w: OutcomeWindow, now: number) => Number.isSafeInteger(at) && at >= w.start && at < w.end && at <= now;
const source = (id: string, revision: string): BriefEvidenceRef => ({ kind: 'source', id, revision });

/**
 * Time back has two tiers, and a run is counted in exactly one of them.
 *
 * 1. Checked work: a goal work item the owner checked, with a time record they
 *    reported. Its root run counts the user-reported minutes, as before.
 * 2. Every other successful root run of a workflow counts the minutes per run
 *    the owner set on the workflow (`flow.time_saved_per_run`), or else an
 *    estimate from the run's own flow version steps (`estimateMinutesFromJson`).
 *    Enabling a workflow is enough: no check or time record is needed.
 *
 * A run counts when it SUCCEEDED in PRODUCTION, has no parent, is not a test or
 * sample-data run, and finished inside the window. Child runs never count on
 * their own. Run-derived minutes are qualified `estimated`, never `measured`.
 */
export class Outcomes {
  constructor(private readonly db: Database) {}
  private has(table: string) { return !!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table); }
  readiness(): 'ready' | 'unavailable' {
    try { return getDb() === this.db && ['commitment_work', 'commitments', 'outcome_time_record', 'goal_measurement_receipt'].every(t => this.has(t)) ? 'ready' : 'unavailable'; }
    catch { return 'unavailable'; }
  }
  private available() { if (this.readiness() !== 'ready') throw Error('Outcome sources unavailable'); }
  private works(): WorkRow[] {
    const rows = this.db.query<WorkRow, []>(`SELECT w.work_id, w.goal_id, w.mode, w.workflow_id, w.workflow_version_id,
      w.run_id, w.decision, w.result_check, w.blocker, c.created_at, c.status, c.completed_at
      FROM commitment_work w JOIN commitments c ON c.id=w.work_id WHERE w.result_check IS NOT NULL LIMIT 10001`).all();
    if (rows.length > 10000) throw Error('Outcome coverage exceeds read bound');
    return rows;
  }
  /** Recheck canonical execution evidence, never trust status='verified' alone. */
  private eligible(w: WorkRow, c: Check | null, now: number): string | null {
    const decision = parse<{ outcome: string }>(w.decision);
    if (!c || !c.id || c.verdict !== 'passed' || c.checkedBy !== 'user' || !Number.isSafeInteger(c.checkedAt)
      || c.checkedAt > now || c.checkedAt < w.created_at || !Array.isArray(c.evidence) || !c.evidence.length
      || c.evidence.some(e => typeof e.ref !== 'string' || !e.ref.trim())) return 'unchecked_or_invalid';
    if (decision?.outcome !== 'accepted' || w.status !== 'completed' || w.completed_at !== c.checkedAt || w.blocker) return 'incomplete_work';
    if (w.mode === 'manual') return w.run_id === null && c.runId === null ? null : 'invalid_run_link';
    if (w.mode !== 'workflow' || !w.run_id || c.runId !== w.run_id) return 'invalid_run_link';
    if (!['flow_run', 'workflow_effect', 'workflow_run_cancellation', 'waitpoint'].every(t => this.has(t))) return 'runtime_unavailable';
    const root = this.db.query<Run, [string]>('SELECT * FROM flow_run WHERE id=?').get(w.run_id);
    if (!root || root.flow_id !== w.workflow_id || root.flow_version_id !== w.workflow_version_id) return 'run_changed';
    if (root.parent_run_id) return 'nested_run';
    const runs = this.db.query<Run, [string]>(`WITH RECURSIVE family(id) AS (
      SELECT id FROM flow_run WHERE id=? UNION SELECT r.id FROM flow_run r JOIN family f ON r.parent_run_id=f.id
    ) SELECT r.* FROM flow_run r JOIN family f ON r.id=f.id LIMIT 1001`).all(root.id);
    if (runs.length > 1000) return 'run_coverage_incomplete';
    const family = new Map(runs.map(run => [run.id, run]));
    let effectCount = 0;
    for (const run of runs) {
      const execution = parse<{ sampleData?: unknown; sampleInputOverride?: unknown; stepNameToTest?: unknown }>(run.execution_config);
      if (run.status !== 'SUCCEEDED' || run.environment !== 'PRODUCTION' || run.step_name_to_test
        || !Number.isSafeInteger(run.finish_time) || run.finish_time! > c.checkedAt || run.finish_time! < w.created_at
        || (run.execution_config !== null && (!execution || execution.sampleData || execution.sampleInputOverride || execution.stepNameToTest))) return 'ineligible_run';
      if (this.db.query('SELECT 1 FROM workflow_run_cancellation WHERE run_id=?').get(run.id)) return 'cancelled_run';
      if (this.db.query('SELECT 1 FROM waitpoint WHERE flow_run_id=? AND resumed_at IS NULL').get(run.id)) return 'pending_work';
      const effects = this.db.query<{ id: string; status: string; record: string }, [string]>('SELECT id,status,record FROM workflow_effect WHERE run_id=? LIMIT 10001').all(run.id);
      effectCount += effects.length; if (effectCount > 10000) return 'run_coverage_incomplete';
      for (const effect of effects) {
        const receipt = parse<{ id: string; runId: string; status: string; finishedAt: number; route?: string; toolName?: string;
          result?: { runId?: unknown }; target?: { flowId?: unknown; versionId?: unknown } }>(effect.record);
        if (effect.status !== 'succeeded' || !receipt || receipt.id !== effect.id || receipt.runId !== run.id || receipt.status !== 'succeeded'
          || !Number.isSafeInteger(receipt.finishedAt) || receipt.finishedAt > c.checkedAt) return 'uncertain_effect';
        // Launch success proves only that the child was queued. Its durable
        // receipt survives child-workflow deletion, unlike parent_run_id rows.
        // Require the exact child and pinned version, at every family depth.
        if (receipt.route === 'workflow' || receipt.toolName === 'workflow_start') {
          const child = typeof receipt.result?.runId === 'string' ? family.get(receipt.result.runId) : undefined;
          if (receipt.route !== 'workflow' || receipt.toolName !== 'workflow_start' || !child
            || child.parent_run_id !== run.id || child.flow_id !== receipt.target?.flowId
            || child.flow_version_id !== receipt.target?.versionId) return 'run_coverage_incomplete';
        }
      }
    }
    return null;
  }
  private evaluate(now: number) {
    const seenRuns = new Set<string>(), seenChecks = new Set<string>();
    const works = this.works().map(work => ({ work, check: parse<Check>(work.result_check) }))
      .sort((a, b) => (a.check?.checkedAt ?? 0) - (b.check?.checkedAt ?? 0) || a.work.work_id.localeCompare(b.work.work_id));
    return works.map(({ work, check }) => {
      // The earliest passed check owns the run even if its evidence is later
      // invalidated. A second link must not move benefit to another day or goal.
      const duplicate = !!check && (seenChecks.has(check.id) || !!work.run_id && seenRuns.has(work.run_id));
      if (check?.verdict === 'passed') { seenChecks.add(check.id); if (work.run_id) seenRuns.add(work.run_id); }
      return { work, check, reason: duplicate ? 'duplicate_work' : this.eligible(work, check, now) };
    });
  }
  private collect(w: OutcomeWindow, now: number, evaluated = this.evaluate(now)): { items: BriefOutcome[]; coverage: OutcomeCoverage } {
    const coverage: OutcomeCoverage = { candidates: 0, eligible: 0, excluded: {}, timed: 0, untimed: 0, complete: true };
    const items: BriefOutcome[] = [];
    for (const { work, check, reason } of evaluated) {
      const inWindow = !!check && within(check.checkedAt, w, now);
      if (!inWindow) continue;
      coverage.candidates++;
      if (reason) { coverage.excluded[reason] = (coverage.excluded[reason] ?? 0) + 1; continue; }
      const time = readOutcomeTime(this.db, work.work_id);
      const measuredTime = work.mode === 'workflow' && time?.resultCheckId === check!.id ? timeBack(time) : null;
      if (measuredTime) coverage.timed++; else coverage.untimed++;
      items.push({ outcomeId: work.run_id ? `run:${work.run_id}` : `work:${work.work_id}`, workItemId: work.work_id, runId: work.run_id,
        goalIds: work.goal_id ? [work.goal_id] : [], window: w,
        result: { value: 1, unit: 'checked work items', baseline: null, target: null, asOf: check!.checkedAt,
          provenance: [source(`work-check:${check!.id}`, '1'), ...check!.evidence.filter(e => e.ref.length <= 512).map(e => source(e.ref, 'user-cited'))], qualification: 'user_reported' },
        timeBack: measuredTime });
    }
    coverage.eligible = items.length; coverage.complete = coverage.untimed === 0 && Object.keys(coverage.excluded).length === 0;
    return { items, coverage };
  }
  async read(raw: unknown): Promise<Read<BriefOutcome[]>> {
    const w = outcomeWindow(raw); this.available();
    return this.db.transaction(() => {
      const now = Date.now(), { items, coverage } = this.collect(w, now);
      if (!items.length && (coverage.excluded.runtime_unavailable || coverage.excluded.run_coverage_incomplete)) return { state: 'unavailable', reason: 'provider_unavailable', coverage } as const;
      return items.length ? { state: 'ready', data: items, asOf: now, coverage } as const : { state: 'empty', asOf: now, coverage } as const;
    })();
  }
  /** Root runs eligible for estimated time, finished inside `w`, except runs whose checked work already carries the owner's own time. */
  private runTimes(w: OutcomeWindow, now: number, skip: Set<string>): RunTime[] {
    if (!['flow_run', 'flow', 'flow_version'].every(t => this.has(t))) return [];
    const rows = this.db.query<{ id: string; flow_id: string; finish_time: number; execution_config: string | null; owner_minutes: number | null; trigger: string | null; flow_version_id: string }, [number, number]>(
      `SELECT r.id, r.flow_id, r.flow_version_id, r.finish_time, r.execution_config, f.time_saved_per_run AS owner_minutes, v.trigger
       FROM flow_run r LEFT JOIN flow f ON f.id=r.flow_id LEFT JOIN flow_version v ON v.id=r.flow_version_id
       WHERE r.status='SUCCEEDED' AND r.environment='PRODUCTION' AND r.parent_run_id IS NULL AND r.step_name_to_test IS NULL
         AND r.finish_time >= ? AND r.finish_time < ? LIMIT 20001`).all(w.start, Math.min(w.end, now + 1));
    if (rows.length > 20000) throw Error('Run coverage exceeds read bound');
    const estimates = new Map<string, number>(), out: RunTime[] = [];
    for (const row of rows) {
      if (skip.has(row.id) || !Number.isSafeInteger(row.finish_time)) continue;
      const execution = parse<{ sampleData?: unknown; sampleInputOverride?: unknown; stepNameToTest?: unknown }>(row.execution_config);
      if (row.execution_config !== null && (!execution || execution.sampleData || execution.sampleInputOverride || execution.stepNameToTest)) continue;
      const owner = row.owner_minutes !== null && Number.isFinite(row.owner_minutes) && row.owner_minutes >= 0 ? row.owner_minutes : null;
      let minutes = owner;
      if (minutes === null) {
        if (!estimates.has(row.flow_version_id)) estimates.set(row.flow_version_id, estimateMinutesFromJson(row.trigger));
        minutes = estimates.get(row.flow_version_id)!;
      }
      out.push({ runId: row.id, flowId: row.flow_id, finishedAt: row.finish_time, minutes, source: owner !== null ? 'owner' : 'estimate' });
    }
    return out;
  }
  /** Runs whose checked, timed work item already counts the owner's own minutes. */
  private timedRunIds(evaluated: ReturnType<Outcomes['evaluate']>): Set<string> {
    const ids = new Set<string>();
    for (const { work, check, reason } of evaluated)
      if (!reason && work.mode === 'workflow' && work.run_id && readOutcomeTime(this.db, work.work_id)?.resultCheckId === check!.id) ids.add(work.run_id);
    return ids;
  }
  /** Checked-work time plus run-derived time for one window, with the basis in plain words. */
  /** Default estimates stop at the per-workflow daily cap; owner-set minutes are never capped. */
  private capEstimates(runs: RunTime[], days: OutcomeWindow[]): RunTime[] {
    const used = new Map<string, number>();
    return [...runs].sort((a, b) => a.finishedAt - b.finishedAt).map(run => {
      if (run.source === 'owner') return run;
      const key = `${run.flowId}|${days.findIndex(d => run.finishedAt >= d.start && run.finishedAt < d.end)}`;
      const left = Math.max(0, MAX_ESTIMATED_MINUTES_PER_WORKFLOW_PER_DAY - (used.get(key) ?? 0)), minutes = Math.min(run.minutes, left);
      used.set(key, (used.get(key) ?? 0) + minutes);
      return minutes < run.minutes ? { ...run, minutes, capped: true } : run;
    });
  }
  /** `known`: the window has started and runs can be read, so no successful run is a real zero, not an unknown. */
  private time(items: BriefOutcome[], runs: RunTime[], known: boolean, now: number): { measurement: BriefMeasurement | null; basis: string | null } {
    const checked = items.filter(i => i.timeBack !== null), parts = checked.map(i => i.timeBack!);
    if (runs.length) {
      const total = runs.reduce((n, r) => n + r.minutes, 0), flows = new Map<string, RunTime['source']>();
      for (const r of runs) flows.set(r.flowId, r.source);
      parts.push({ value: total, unit: 'minutes', baseline: total, target: null, asOf: Math.max(...runs.map(r => r.finishedAt)),
        provenance: [...flows].map(([flowId, kind]) => source(`flow-runs:${flowId}`, kind === 'owner' ? 'owner-set-minutes' : 'estimated-from-steps')),
        qualification: 'estimated' });
    }
    const measurement = this.aggregate(parts);
    if (!measurement) return known ? { measurement: { value: 0, unit: 'minutes', baseline: 0, target: null, asOf: now,
      provenance: [source('flow-runs:none', 'no-successful-runs')], qualification: 'estimated' }, basis: 'No time saved.' } : { measurement, basis: null };
    const owner = runs.filter(r => r.source === 'owner').length, estimated = runs.length - owner;
    const each = runs.length ? Math.round(runs.reduce((n, r) => n + r.minutes, 0) / runs.length) : 0;
    const same = runs.every(r => r.minutes === runs[0]!.minutes);
    const count = `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`;
    const runBasis = !runs.length ? '' : owner && estimated ? `${count}, about ${each} min each. Some minutes you set, the rest estimated from the workflow's steps.`
      : owner ? `${count} x ${same ? '' : 'about '}${each} min. You set the minutes per run.` : `${count} x about ${each} min. Estimated from the workflow's steps.`;
    const checkedBasis = checked.length ? `${checked.length} checked work ${checked.length === 1 ? 'item' : 'items'} with minutes you reported.` : '';
    const capBasis = runs.some(r => r.capped) ? `Estimates are capped at ${MAX_ESTIMATED_MINUTES_PER_WORKFLOW_PER_DAY} min per workflow per day.` : '';
    return { measurement, basis: [runBasis, checkedBasis, capBasis].filter(Boolean).join(' ') };
  }
  private aggregate(values: BriefMeasurement[]): BriefMeasurement | null;
  private aggregate(items: BriefOutcome[], field: 'result'): BriefMeasurement | null;
  private aggregate(input: BriefMeasurement[] | BriefOutcome[], field?: 'result'): BriefMeasurement | null {
    const values = field ? (input as BriefOutcome[]).map(item => item[field]).filter((m): m is BriefMeasurement => m !== null) : input as BriefMeasurement[];
    if (!values.length) return null;
    const refs = new Map<string, BriefEvidenceRef>();
    for (const m of values) for (const r of m.provenance) refs.set(JSON.stringify(r), r);
    return { value: values.reduce((n, m) => n + m.value, 0), unit: field ? 'checked work items' : 'minutes',
      baseline: field ? null : values.reduce((n, m) => n + m.baseline!, 0), target: null,
      asOf: Math.max(...values.map(m => m.asOf)), provenance: [...refs.values()],
      // One run-derived part makes the whole figure an estimate; it is never promoted to what the owner reported.
      qualification: values.every(m => m.qualification === 'user_reported') ? 'user_reported' : 'estimated' };
  }
  private goalDeltas(w: OutcomeWindow, now: number): GoalDelta[] {
    // Optional F15 persistence seam. No count is inferred from goal.score, titles,
    // completed work or the measurement definition's unobserved baseline.
    const rows = this.db.query<{ goal_id: string; request_id: string; receipt: string; measured_at: number; title: string }, [number]>(
      `SELECT r.goal_id,r.request_id,r.receipt,r.measured_at,g.title FROM goal_measurement_receipt r JOIN goals g ON g.id=r.goal_id
       WHERE r.measured_at IS NOT NULL AND r.measured_at < ? ORDER BY r.goal_id,r.measured_at,r.rowid LIMIT 50001`).all(Math.min(w.end, now + 1));
    if (rows.length > 50000) throw Error('Goal evidence exceeds read bound');
    type Point = { value: number; unit: string; baseline: number; target: number; measuredAt: number;
      evidence: { id: string; revision: string }; qualification: BriefMeasurement['qualification']; basis?: string };
    const goals = new Map<string, { title: string; opening?: Point; ending?: Point }>();
    for (const row of rows) {
      const receipt = parse<{ measurement: Point }>(row.receipt), m = receipt?.measurement;
      // Carry the writer's qualification instead of asserting one: anything other
      // than a measured or user-reported observation never becomes a delta.
      if (!m || !Number.isFinite(m.value) || m.measuredAt !== row.measured_at || !m.evidence
        || (m.qualification !== 'measured' && m.qualification !== 'user_reported')) throw Error('Goal evidence is incomplete');
      const g = goals.get(row.goal_id) ?? { title: row.title }; goals.set(row.goal_id, g);
      if (row.measured_at < w.start) g.opening = m; else g.ending = m;
    }
    return [...goals].filter(([, g]) => g.ending).map(([goalId, g]) => {
      const a = g.opening, b = g.ending!;
      const reason = !a ? 'missing_opening' : a.unit !== b.unit || a.baseline !== b.baseline || a.target !== b.target
        // A typed value and a count of observations are different measures, even with one unit.
        || (a.basis ?? 'typed') !== (b.basis ?? 'typed') ? 'definition_changed' : null;
      return { goalId, title: g.title, reason, attribution: 'observed_change_only', rollup: 'independent',
        change: reason ? null : { value: b.value - a!.value, unit: b.unit, baseline: a!.value, target: b.target, asOf: b.measuredAt,
          provenance: [source(a!.evidence.id, a!.evidence.revision), source(b.evidence.id, b.evidence.revision)],
          qualification: a!.qualification === 'measured' && b.qualification === 'measured' ? 'measured' : 'user_reported' } };
    });
  }
  async summary(raw: { timezone: string; at?: number }): Promise<Read<OutcomeSummary>> {
    const zone = timezone(raw.timezone), now = Date.now();
    const at = raw.at === undefined ? now : number(raw.at, 'at', 0, now, true);
    const calendar = outcomeCalendar(at, zone); this.available();
    return this.db.transaction(() => {
      const evaluated = this.evaluate(now), week = this.collect(calendar.week, now, evaluated), goals = this.goalDeltas(calendar.week, now);
      const todayGoals = this.goalDeltas(calendar.today, now);
      const skip = this.timedRunIds(evaluated), weekRuns = this.capEstimates(this.runTimes(calendar.week, now, skip), calendar.days), canRead = ['flow_run', 'flow', 'flow_version'].every(t => this.has(t));
      const runsIn = (w: OutcomeWindow) => weekRuns.filter(r => within(r.finishedAt, w, now));
      const todayTime = this.time(week.items.filter(i => within(i.result.asOf, calendar.today, now)), runsIn(calendar.today), canRead, now);
      const weekTime = this.time(week.items, weekRuns, canRead, now);
      const data: OutcomeSummary = { window: calendar.week, today: todayTime.measurement, week: weekTime.measurement,
        todayBasis: todayTime.basis, weekBasis: weekTime.basis,
        days: calendar.days.map(day => {
          const { items, coverage } = this.collect(day, now, evaluated), t = this.time(items, runsIn(day), canRead && day.start <= now, now);
          return { id: day.id, current: day.id === calendar.date, future: day.start > now, time: t.measurement, basis: t.basis, coverage };
        }), completedWork: this.aggregate(week.items, 'result'), outcomes: week.items, goalDeltas: goals, todayGoalDeltas: todayGoals,
        coverage: { ...week.coverage, complete: week.coverage.complete && [...goals, ...todayGoals].every(g => g.change !== null) },
        basis: 'Time saved counts every successful run of your workflows once, never its child runs or test runs. Each run counts the minutes you set for the workflow, or an estimate from its steps, and both are estimates. Work you checked and timed yourself uses your own numbers. Goal changes are independent observations, not causal attribution to work.' };
      if (!week.items.length && !weekRuns.length && !goals.length && (week.coverage.excluded.runtime_unavailable || week.coverage.excluded.run_coverage_incomplete)) return { state: 'unavailable', reason: 'provider_unavailable', coverage: data.coverage } as const;
      return week.items.length || weekRuns.length || goals.length || canRead ? { state: 'ready', data, asOf: now, coverage: data.coverage } as const : { state: 'empty', asOf: now, coverage: data.coverage } as const;
    })();
  }
  recordTime(workId: string, raw: unknown): OutcomeTimeRecord {
    outcomeId(workId, 'workItemId'); const command = timeCommand(raw), serialized = JSON.stringify(command); this.available();
    return this.db.transaction(() => {
      const prior = this.db.query<{ command: string; snapshot: string }, [string, string]>(
        'SELECT command,snapshot FROM outcome_time_record WHERE work_id=? AND request_id=?').get(workId, command.requestId);
      if (prior) { if (prior.command !== serialized) throw new OutcomeConflict('Request already has different time evidence'); return JSON.parse(prior.snapshot); }
      const work = this.works().find(w => w.work_id === workId), check = work ? parse<Check>(work.result_check) : null;
      if (!work || !check || work.mode !== 'workflow' || check.id !== command.resultCheckId || this.eligible(work, check, Date.now())) throw new OutcomeConflict('Time evidence requires eligible checked workflow work');
      if ((readOutcomeTime(this.db, workId)?.revision ?? 0) !== command.revision) throw new OutcomeConflict('Time evidence changed; refresh before saving');
      if (command.intervention.intervals.some(t => t.start < work.created_at || t.end > Date.now())) invalid('intervention', 'intervals must be observed during or after this work, never in the future');
      const snapshot: OutcomeTimeRecord = { workItemId: workId, resultCheckId: check.id, revision: command.revision + 1, recordedAt: Date.now(),
        baseline: command.baseline, intervention: command.intervention };
      this.db.run('INSERT INTO outcome_time_record VALUES (?,?,?,?,?,?)', [workId, snapshot.revision, command.requestId, serialized, JSON.stringify(snapshot), snapshot.recordedAt]);
      return snapshot;
    }).immediate();
  }
  /** Latest editable evidence; historical request receipts never substitute for this read. */
  currentTime(workId: string): OutcomeTimeRecord | null {
    outcomeId(workId, 'workItemId'); this.available();
    return readOutcomeTime(this.db, workId);
  }
  timeReceipt(workId: string, requestId: string): OutcomeTimeRecord | null {
    outcomeId(workId, 'workItemId'); outcomeId(requestId, 'requestId'); this.available();
    const row = this.db.query<{ snapshot: string }, [string, string]>('SELECT snapshot FROM outcome_time_record WHERE work_id=? AND request_id=?').get(workId, requestId);
    return row ? JSON.parse(row.snapshot) : null;
  }
}
