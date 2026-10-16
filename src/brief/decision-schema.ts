import type { Database } from 'bun:sqlite';

/** The source tables an earlier draft of F-12 put write triggers on. */
const FORMER_TRIGGER_TABLES = ['approval_requests', 'commitment_work', 'commitments', 'workflow_effect',
  'flow_run', 'flow', 'flow_version', 'waitpoint', 'workflow_run_cancellation', 'brief_decision_placement'];

/** Queue metadata only. Canonical writers retain all decision and execution ownership. */
export function ensureDecisionSchema(db: Database): void {
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS brief_decision_queue_clock (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), epoch TEXT NOT NULL, generation INTEGER NOT NULL
    )`);
    db.run('INSERT OR IGNORE INTO brief_decision_queue_clock VALUES (1, ?, 0)', [crypto.randomUUID()]);
    db.run(`CREATE TABLE IF NOT EXISTS brief_decision_placement (
      decision_id TEXT PRIMARY KEY, position INTEGER NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_brief_effect_approval ON workflow_effect(approval_id, status)');
    // No triggers on source tables. bun:sqlite counts a trigger's writes in a
    // statement's `changes`, so a trigger on flow_run or workflow_effect turns
    // the `changes === 1` checks there (createFlowRun, the effect dispatch
    // claim) into failures for every workflow. Drop any left by a dev build.
    for (const table of FORMER_TRIGGER_TABLES) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.run(`DROP TRIGGER IF EXISTS brief_decision_${table}_${operation}`);
    }
  }).immediate();
}
