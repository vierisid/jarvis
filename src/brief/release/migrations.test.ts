import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { initDatabase, closeDb } from '../../vault/schema';
import { createSchema } from '../../workflows/db/schema';
import { ensureCompositionJobSchema } from '../composition-schema';
import { ensurePreparedSchema } from '../../awareness/prepared-schema';
import { ensureDecisionSchema } from '../decision-schema';
import { ensureRecommendationSchema } from '../recommendation-schema';
import { ConversationRepository } from '../../vault/conversation-lifecycle';
import { ensureConversationTab } from '../../vault/conversation-schema';
import { createFlow } from '../../workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../../workflows/db/repos/flow-version';
import { createFlowRun } from '../../workflows/db/repos/flow-run';
import { BriefReleaseCapabilities } from './activation';
import { BRIEF_CAPABILITY_IDS } from '../capabilities';
import provenance from './fixtures/provenance.json';

// Every table added by F-02..F-27 relative to the audited pre-Brief schema.
const tables = [
  'brief_chat_approvals', 'brief_chat_attachments', 'brief_chat_events', 'brief_chat_sequences', 'brief_chat_turns',
  'brief_conversation_workspace', 'brief_decision_document', 'brief_decision_document_receipt', 'brief_decision_document_revision',
  'brief_decision_placement', 'brief_decision_queue_clock', 'brief_manual_run_requests', 'brief_recommendation',
  'brief_workflow_commands', 'brief_workflow_composition_jobs', 'brief_workflow_removals', 'brief_workflow_slots',
  'conversation_tabs', 'conversation_workspace_state', 'goal_measurement', 'goal_measurement_receipt',
  'memory_forget_receipts', 'memory_forget_state', 'memory_forget_suppressions', 'memory_profile_revisions',
  'memory_use_events', 'memory_use_state', 'opportunity_composition_owners', 'outcome_time_record',
  'prepared_opportunities', 'prepared_opportunity_attempts', 'prepared_opportunity_history',
  'workflow_composition_ingredients', 'workflow_run_inspection_versions',
];
let directory: string;
afterEach(() => { closeDb(); if (directory) rmSync(directory, { recursive: true, force: true }); });
function open(file: string) {
  const db = initDatabase(file, { quiet: true }); createSchema(db);
  // The four provider-owned migrations run at their constructors in the daemon.
  for (const ensure of [ensureCompositionJobSchema, ensurePreparedSchema, ensureDecisionSchema, ensureRecommendationSchema]) ensure(db);
  return db;
}
const rows = (db: Database, table: string) => db.query(`SELECT * FROM "${table}" ORDER BY rowid`).all();
const columns = (db: Database, table: string) => (db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(c => c.name);
function seedLegacy(db: Database) {
  db.exec(`INSERT INTO conversations(id,channel,started_at,last_message_at,message_count,metadata) VALUES('old-chat','legacy',1,2,1,'{"retain":true}');
    INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES('old-message','old-chat','user','Preserve exact history',2);
    INSERT INTO goals(id,level,title,score,created_at,updated_at) VALUES('old-goal','objective','Measured later',0.6,1,1);
    INSERT INTO commitments(id,what,created_at) VALUES('old-work','Keep work identity',1);
    INSERT INTO commitment_work(work_id,updated_at) VALUES('old-work',1);
    INSERT INTO awareness_suggestions(id,type,title,body,created_at) VALUES('opportunity','automation','Fixture','No effect',1);`);
}
function seedBrief(db: Database) {
  ensureConversationTab(db, 'old-chat');
  const conversations = new ConversationRepository(db); conversations.rename('old-chat', 'Saved title'); conversations.setOpen('old-chat', true);
  const flow = createFlow(), version = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'Fixture', trigger: { name: 'trigger', type: 'EMPTY' } }).id);
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  db.exec(`INSERT INTO brief_chat_turns VALUES('turn','workspace','old-chat','request','input',0,'completed','user','assistant',1,2);
    INSERT INTO brief_chat_sequences VALUES('old-chat',1);
    INSERT INTO brief_chat_events VALUES('old-chat',1,'event','turn','{"kind":"terminal","state":"completed"}');
    INSERT INTO brief_chat_approvals VALUES('approval','turn');
    INSERT INTO brief_chat_attachments(attachment_id,workspace_id,conversation_id,kind,name,media_type,size,sha256,expires_at,state,turn_id)
      VALUES('attachment','workspace','old-chat','document','fixture','text/plain',0,'digest',100,'accepted','turn');
    INSERT INTO brief_decision_document VALUES('decision','effect','approval',1,'deferred',1);
    INSERT INTO brief_decision_document_revision VALUES('decision',1,'approval','{}',1);
    INSERT INTO brief_decision_document_receipt VALUES('doc-request','decision','digest','{}');
    INSERT INTO brief_decision_placement VALUES('decision',10);
    INSERT INTO brief_recommendation VALUES('recommendation','rec-request','{}',1,'dismissed',NULL,NULL);
    INSERT INTO brief_workflow_composition_jobs(id,project_id,request_id,name,prompt,state,created_at,updated_at)
      VALUES('job','project','job-request','Fixture','Retain prompt','failed',1,1);
    INSERT INTO goal_measurement VALUES('old-goal',1,'{"value":6,"target":10,"unit":"items"}');
    INSERT INTO goal_measurement_receipt VALUES('old-goal','measure-request','{}','{}','evidence',1);
    INSERT INTO outcome_time_record VALUES('old-work',1,'time-request','{}','{"value":null}',1);
    INSERT INTO memory_forget_receipts VALUES('forgotten-fact','forget-request','revision',1,1);
    INSERT INTO memory_forget_suppressions VALUES('assertion-digest','source-digest','forgotten-fact');
    INSERT INTO memory_profile_revisions VALUES('preferred_name','revision');
    INSERT INTO memory_use_state VALUES(1,1,1);
    INSERT INTO memory_use_events VALUES('use','forgotten-fact','revision','supplied','conversation_context','old-chat','turn','request',NULL,NULL,'call',1);
    INSERT INTO prepared_opportunities(id,opportunity_id,revision,specification,state,created_at,updated_at)
      VALUES('proposal','opportunity','revision','{}','failed',1,1);
    INSERT INTO prepared_opportunity_attempts VALUES('attempt','proposal',1);
    INSERT INTO prepared_opportunity_history VALUES('proposal','revision','{}',1);
    INSERT INTO opportunity_composition_owners VALUES('opportunity','prepared','proposal');`);
  db.run('INSERT INTO workflow_composition_ingredients VALUES (?, ?)', [flow.id, '[]']);
  db.run('INSERT INTO brief_manual_run_requests VALUES (?, ?, ?, ?, ?, ?)', [flow.project_id, 'manual-request', flow.id, 'digest', '{}', 1]);
  db.run('INSERT INTO brief_workflow_commands VALUES (?, ?, ?, ?, ?, ?)', [flow.project_id, 'remove-request', flow.id, 'digest', '{}', 1]);
  db.run('INSERT INTO brief_workflow_removals VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['receipt', flow.id, flow.project_id, version.id, 'revision', 1, 2, null]);
  db.run('UPDATE brief_workflow_slots SET receipt_id=? WHERE flow_id=?', ['receipt', flow.id]);
  return { flowId: flow.id, versionId: version.id, runId: run.id };
}

test.each(['fresh', 'pre-brief', 'main'] as const)('%s schema preserves old and new data through upgrade, flag rollback and reopen', async baseline => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f28-migration-')); const file = join(directory, 'fixture.db');
  let oldColumns: Record<string, string[]> = {};
  if (baseline !== 'fresh') {
    const old = new Database(file); const sql = readFileSync(join(import.meta.dir, 'fixtures', `${baseline}.sql`), 'utf8');
    expect(createHash('sha256').update(sql).digest('hex')).toBe(provenance[baseline].schemaSha256);
    old.exec(sql); seedLegacy(old);
    const names = (old.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(r => r.name);
    oldColumns = Object.fromEntries(names.map(name => [name, columns(old, name)])); old.close();
  }
  let db = open(file); if (baseline === 'fresh') seedLegacy(db);
  for (const [table, expected] of Object.entries(oldColumns)) for (const column of expected) expect(columns(db, table)).toContain(column);
  for (const table of tables) expect(columns(db, table).length).toBeGreaterThan(0);
  expect(columns(db, 'brief_workflow_composition_jobs')).toContain('ingredients');
  expect(columns(db, 'brief_workflow_slots')).toContain('pinned_draft_id');
  expect(columns(db, 'fact_evidence')).toContain('replay_source_ref');
  expect(rows(db, 'goal_measurement')).toEqual([]); // Legacy score must not become a fabricated count.
  if (baseline === 'pre-brief') {
    const names = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(r => r.name);
    expect(names.filter(name => !(name in oldColumns)).sort()).toEqual([...tables].sort());
  }
  const ids = seedBrief(db);
  const before = Object.fromEntries(tables.map(table => [table, rows(db, table)]));
  for (const table of tables) expect(before[table]!.length).toBeGreaterThan(0);
  // Disabling release capabilities never changes the schema, histories, leases or receipts.
  const registry = new BriefReleaseCapabilities([], BRIEF_CAPABILITY_IDS, { revision: 'a'.repeat(40), deployment: 'self_hosted' });
  expect(BRIEF_CAPABILITY_IDS.every(id => !registry.snapshot().capabilities[id].enabled)).toBe(true);
  closeDb(); db = open(file);
  for (const table of tables) expect(rows(db, table)).toEqual(before[table]!);
  expect(db.query('SELECT content FROM conversation_messages WHERE id=?').get('old-message')).toEqual({ content: 'Preserve exact history' });
  expect(db.query('SELECT score FROM goals WHERE id=?').get('old-goal')).toEqual({ score: 0.6 });
  expect(db.query('SELECT id FROM commitments WHERE id=?').get('old-work')).toEqual({ id: 'old-work' });
  // Persistent fences also protect writes issued by an old client/raw connection after flag rollback.
  const legacy = new Database(file); legacy.exec('PRAGMA foreign_keys=ON');
  try {
    expect(() => legacy.run("UPDATE flow SET status='ENABLED' WHERE id=?", [ids.flowId])).toThrow('workflow_removed');
    expect(() => legacy.run('DELETE FROM flow WHERE id=?', [ids.flowId])).toThrow('workflow_history_retained');
  } finally { legacy.close(); }
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
});

test.each(['pre-brief', 'main'] as const)('%s conversation code reads and writes the upgraded database before re-upgrade', async baseline => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f28-reader-')); const file = join(directory, 'fixture.db');
  const old = new Database(file); old.exec(readFileSync(join(import.meta.dir, 'fixtures', `${baseline}.sql`), 'utf8')); seedLegacy(old); old.close();
  let db = open(file); seedBrief(db);
  const repo = new ConversationRepository(db); repo.rename('old-chat', 'Retained title');
  const retained = Object.fromEntries(tables.map(table => [table, rows(db, table)]));
  const title = repo.get('old-chat'); closeDb();
  // Historical reader/writer code is byte-for-byte from the pinned revision. Only its DB owner is a fixture shim.
  const source = readFileSync(join(import.meta.dir, 'fixtures', `${baseline}-conversations.ts.txt`), 'utf8');
  expect(createHash('sha256').update(source).digest('hex')).toBe(provenance[baseline].sources['src/vault/conversations.ts']);
  writeFileSync(join(directory, 'conversations.ts'), source);
  writeFileSync(join(directory, 'schema.ts'), `import { Database } from 'bun:sqlite'; export const db = new Database(${JSON.stringify(file)});
    export const getDb = () => db; export const generateId = () => crypto.randomUUID();`);
  const reader = await import(join(directory, 'conversations.ts'));
  const shim = await import(join(directory, 'schema.ts'));
  let id: string;
  try {
    expect(reader.getMessages('old-chat')[0].content).toBe('Preserve exact history');
    id = reader.getOrCreateConversation('rollback-fixture').id;
    reader.addMessage(id, { role: 'user', content: 'Written by previous conversation code' });
  } finally { shim.db.close(); }
  db = open(file); const restored = new ConversationRepository(db);
  expect(restored.get('old-chat')).toEqual(title);
  expect(restored.get(id!).tab.open).toBe(false);
  expect(restored.messages(id!).items[0]?.content).toBe('Written by previous conversation code');
  for (const table of tables) {
    // Re-upgrade adopts the old writer's newly-created conversation; all prior rows remain exact.
    const after = table === 'conversation_tabs' ? rows(db, table).filter((row: any) => row.conversation_id !== id!) : rows(db, table);
    expect(after).toEqual(retained[table]!);
  }
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('partial F-07/F-20 installations add ingredient and draft-pin columns without losing saved rows', () => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f28-partial-')); const file = join(directory, 'fixture.db');
  const old = new Database(file); old.exec(readFileSync(join(import.meta.dir, 'fixtures/pre-brief.sql'), 'utf8'));
  old.exec(`CREATE TABLE brief_workflow_composition_jobs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_id TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
    state TEXT NOT NULL, checked_candidates INTEGER NOT NULL DEFAULT 0, composition_id TEXT, flow_id TEXT, version_id TEXT,
    blocker TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, request_id));
    INSERT INTO brief_workflow_composition_jobs(id,project_id,request_id,name,prompt,state,created_at,updated_at)
      VALUES('saved-job','project','saved-request','Saved','Keep the original request','draft_ready',1,2);
    CREATE TABLE brief_workflow_slots (
      position INTEGER PRIMARY KEY AUTOINCREMENT, flow_id TEXT NOT NULL UNIQUE REFERENCES flow(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL DEFAULT 0, receipt_id TEXT, reconcile_pending INTEGER NOT NULL DEFAULT 0,
      reconcile_revision INTEGER NOT NULL DEFAULT 0);
    INSERT INTO flow(id,external_id,project_id,status,created,updated) VALUES('saved-flow','saved-flow','project','DISABLED',1,1);
    INSERT INTO brief_workflow_slots(position,flow_id,generation) VALUES(17,'saved-flow',4);`);
  old.close();
  let db = open(file);
  expect(db.query('SELECT prompt,state,ingredients FROM brief_workflow_composition_jobs').get())
    .toEqual({ prompt: 'Keep the original request', state: 'draft_ready', ingredients: '[]' });
  expect(db.query('SELECT position,generation,pinned_draft_id FROM brief_workflow_slots').get())
    .toEqual({ position: 17, generation: 4, pinned_draft_id: null });
  closeDb(); db = open(file);
  expect(rows(db, 'brief_workflow_composition_jobs')).toHaveLength(1);
  expect(rows(db, 'brief_workflow_slots')).toHaveLength(1);
});
