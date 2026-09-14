import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

/** C6 supplies its versioned pattern key; legacy app pairs have their own namespace. */
export function automationIdentity(data: { type: string; title: string; body: string; context?: Record<string, unknown> }): string | null {
  if (data.type !== 'automation') return null;
  const context = data.context;
  const opportunity = context?.opportunity as Record<string, unknown> | undefined;
  if (typeof opportunity?.patternKey === 'string' && opportunity.patternKey.length <= 200) {
    return `opportunity:${opportunity.patternKey}`;
  }
  if (context?.pattern === 'app_switch' && typeof context.fromApp === 'string' && typeof context.toApp === 'string') {
    return `app-pair-v1:${JSON.stringify([context.fromApp, context.toApp].map(s => s.trim().toLowerCase()).sort())}`;
  }
  return `automation-v1:${createHash('sha256').update(JSON.stringify([data.title, data.body])).digest('hex')}`;
}

export function suggestionContext(context: string | null): Record<string, unknown> {
  try { const value = JSON.parse(context ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}

export function ensureSuggestionSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS suggestion_identities (
    suggestion_id TEXT PRIMARY KEY REFERENCES awareness_suggestions(id) ON DELETE CASCADE,
    pattern_key TEXT NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_suggestion_identity_pattern ON suggestion_identities(pattern_key)');
  db.run(`CREATE TABLE IF NOT EXISTS suggestion_feedback (
    id TEXT PRIMARY KEY,
    suggestion_id TEXT NOT NULL REFERENCES awareness_suggestions(id),
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('dismiss', 'interest', 'accept', 'retry')),
    reason TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(suggestion_id, request_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS suggestion_composition_jobs (
    id TEXT PRIMARY KEY,
    suggestion_id TEXT NOT NULL UNIQUE REFERENCES awareness_suggestions(id),
    feedback_id TEXT NOT NULL REFERENCES suggestion_feedback(id),
    request TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'failed', 'draft_ready')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    flow_id TEXT,
    version_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK((flow_id IS NULL) = (version_id IS NULL))
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_suggestion_composition_state ON suggestion_composition_jobs(state, created_at)');
  // Legacy duplicates remain addressable. The earliest row is the canonical ID;
  // feedback resolves aliases to it and considers flags from the whole family.
  db.transaction(() => {
    const rows = db.query<{ id: string; type: string; title: string; body: string; context: string | null }, []>(
      `SELECT s.* FROM awareness_suggestions s LEFT JOIN suggestion_identities i ON i.suggestion_id = s.id
       WHERE s.type = 'automation' AND i.suggestion_id IS NULL`).all();
    for (const row of rows) {
      db.run('INSERT INTO suggestion_identities VALUES (?, ?)', [row.id,
        automationIdentity({ ...row, context: suggestionContext(row.context) })!]);
    }
  }).immediate();
}
