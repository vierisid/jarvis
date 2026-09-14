import type { Database } from 'bun:sqlite';
import { predicateKey, valueKey, currentState, samePeriod, type FactRow } from './fact-policy.ts';
import { USER_PROFILE_SETTING_KEY, normalizeUserProfileAnswers, profileQuestionForPredicate } from '../user/profile.ts';

function legacyProfileAnswers(db: Database) {
  // Facts are upgraded before settings are created in a fresh database.
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()) return {};
  const record = db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(USER_PROFILE_SETTING_KEY);
  try { return normalizeUserProfileAnswers(JSON.parse(record?.value ?? '{}').answers ?? {}); }
  catch { return {}; }
}

export function reconcileFacts(db: Database, subjectId: string, predicate: string, scope: string): void {
  const rows = db.query<FactRow, [string, string, string]>(
    'SELECT * FROM facts WHERE subject_id = ? AND predicate_key = ? AND scope = ?'
  ).all(subjectId, predicate, scope);
  for (const row of rows) {
    const status = currentState(row, rows);
    if (status !== row.status) db.run('UPDATE facts SET status = ? WHERE id = ?', [status, row.id]);
  }
}

/** Additive upgrade; preserve old IDs and all provenance, including duplicate rows. */
export function ensureFactSchema(db: Database): void {
  db.transaction(() => {
    const columns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(facts)').all().map(c => c.name));
    for (const [name, declaration] of Object.entries({
      predicate_key: 'TEXT', value_key: 'TEXT', scope: "TEXT NOT NULL DEFAULT ''",
      status: "TEXT NOT NULL DEFAULT 'active'", superseded_by: 'TEXT', valid_from: 'INTEGER', valid_to: 'INTEGER',
    })) if (!columns.has(name)) db.run(`ALTER TABLE facts ADD COLUMN ${name} ${declaration}`);
    db.run(`CREATE TABLE IF NOT EXISTS fact_evidence (
      id TEXT PRIMARY KEY, fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      source TEXT, source_ref TEXT, quote TEXT, basis TEXT NOT NULL,
      confidence REAL NOT NULL, recorded_at INTEGER NOT NULL, evidence_key TEXT NOT NULL,
      UNIQUE(fact_id, evidence_key)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_fact_evidence_fact ON fact_evidence(fact_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_facts_identity ON facts(subject_id, predicate_key, scope, value_key)');
    const legacy = db.query<FactRow, []>('SELECT * FROM facts WHERE predicate_key IS NULL ORDER BY created_at, id').all();
    const answers = legacyProfileAnswers(db);
    const profileEntity = db.query<{ id: string }, []>("SELECT id FROM entities WHERE source = 'user_profile' ORDER BY updated_at DESC LIMIT 1").get();
    const groups = new Map<string, [string, string, string]>();
    for (const row of legacy) {
      row.predicate_key = predicateKey(row.predicate); row.value_key = valueKey(row.predicate, row.object);
      const question = profileQuestionForPredicate(row.predicate_key);
      const answer = question ? answers[question] : undefined;
      // The source label alone cannot confirm heuristic aliases or unsupported values.
      if (row.source === 'user_profile' && row.verified_at === null && row.subject_id === profileEntity?.id
          && answer && valueKey(row.predicate, answer) === row.value_key) row.verified_at = row.created_at;
      db.run('UPDATE facts SET predicate_key = ?, value_key = ?, verified_at = ? WHERE id = ?',
        [row.predicate_key, row.value_key, row.verified_at, row.id]);
      const basis = row.verified_at !== null ? 'confirmed'
        : row.source === 'llm_extraction' || (row.source === 'user_profile' && ['alias', 'username'].includes(row.predicate_key)) ? 'inferred' : 'unspecified';
      const peers = db.query<FactRow, [string, string, string, string, string]>(`SELECT * FROM facts
        WHERE subject_id = ? AND predicate_key = ? AND scope = ? AND value_key = ? AND id != ? AND status != 'superseded'
        ORDER BY created_at, id`).all(row.subject_id, row.predicate_key, row.scope, row.value_key, row.id);
      const canonical = peers.find(peer => samePeriod(row, peer));
      const target = canonical?.id ?? row.id;
      db.run(`INSERT OR IGNORE INTO fact_evidence
        (id, fact_id, source, source_ref, quote, basis, confidence, recorded_at, evidence_key)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [crypto.randomUUID(), target, row.source, `legacy:${row.id}`, basis, row.confidence ?? 0,
        row.created_at, `legacy:${row.id}`]);
      if (canonical) {
        db.run("UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ?", [canonical.id, row.id]);
        if (row.verified_at !== null && canonical.verified_at === null) {
          db.run('UPDATE facts SET verified_at = ?, confidence = ?, source = ? WHERE id = ?',
            [row.verified_at, row.confidence, row.source, canonical.id]);
        }
      }
      groups.set(JSON.stringify([row.subject_id, row.predicate_key, row.scope]), [row.subject_id, row.predicate_key, row.scope]);
    }
    for (const group of groups.values()) reconcileFacts(db, ...group);
  }).immediate();
}
