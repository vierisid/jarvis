import type { Database } from 'bun:sqlite';

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
    // Any writer, including legacy surfaces, invalidates an in-progress pagination
    // traversal. Return a refresh conflict rather than silently skip/repeat a card.
    for (const table of ['approval_requests', 'commitment_work', 'commitments', 'workflow_effect',
      'flow_run', 'flow', 'flow_version', 'waitpoint', 'workflow_run_cancellation', 'brief_decision_placement']) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        db.run(`CREATE TRIGGER IF NOT EXISTS brief_decision_${table}_${operation}
          AFTER ${operation} ON ${table} BEGIN
          UPDATE brief_decision_queue_clock SET generation = generation + 1 WHERE singleton = 1;
        END`);
      }
    }
  }).immediate();
}
