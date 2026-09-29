/**
 * #571: a commitment records the tool scope of the turn that created it.
 *
 * `commitments` is the one in-scope tool whose whole effect is to schedule a
 * LATER turn whose text the model writes, and that turn executes on the
 * background agent, which does not carry the site chat's scope. #571 does not
 * close that (daemon/commitment-executor.ts explains why: the background tool
 * registry has no site-builder tools, so applying the scope there would
 * withhold the generic file tools against an empty replacement surface). What
 * it does is stop the fact being lost at creation, so the escalation is
 * recorded and auditable and the real fix has something to read.
 *
 * Two creation routes have to work: an explicit `scope_id` (ws-service's
 * heuristic auto-created tracked task, which knows the `projectId` directly)
 * and the ambient turn scope (the row the MODEL writes through the tool, which
 * is the route that actually matters).
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDb, getDb } from './schema.ts';
import { createCommitment, getCommitment } from './commitments.ts';
import { withTurnScopeId } from '../actions/tools/turn-scope-store.ts';
import { PROJECT_SITE_CHAT_SCOPE } from '../actions/tools/tool-scope.ts';

describe('commitment scope provenance', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  test('an explicit scope_id is stored and read back', () => {
    const c = createCommitment('deploy the site', { scope_id: PROJECT_SITE_CHAT_SCOPE.id });
    expect(c.scope_id).toBe(PROJECT_SITE_CHAT_SCOPE.id);
    expect(getCommitment(c.id)!.scope_id).toBe(PROJECT_SITE_CHAT_SCOPE.id);
  });

  test('the ambient turn scope is picked up with no explicit argument', () => {
    // This is the model-driven route: the `commitments` tool passes no
    // scope_id, and the orchestrator has entered the store for the tool call.
    const c = withTurnScopeId(PROJECT_SITE_CHAT_SCOPE.id, () =>
      createCommitment('put the pricing page live tomorrow'));
    expect(c.scope_id).toBe(PROJECT_SITE_CHAT_SCOPE.id);
    expect(getCommitment(c.id)!.scope_id).toBe(PROJECT_SITE_CHAT_SCOPE.id);
  });

  test('an explicit argument wins over the ambient scope', () => {
    const c = withTurnScopeId(PROJECT_SITE_CHAT_SCOPE.id, () =>
      createCommitment('x', { scope_id: 'something_else' }));
    expect(c.scope_id).toBe('something_else');
  });

  test('outside any scoped turn the column stays null', () => {
    const c = createCommitment('buy milk');
    expect(c.scope_id).toBeNull();
    expect(getCommitment(c.id)!.scope_id).toBeNull();
    // And explicitly on the row, not just on the returned object.
    const row = getDb().query<{ scope_id: string | null }, [string]>(
      'SELECT scope_id FROM commitments WHERE id = ?').get(c.id);
    expect(row!.scope_id).toBeNull();
  });

  test('a NULL in the column reads as unscoped', () => {
    const c = createCommitment('legacy', { scope_id: PROJECT_SITE_CHAT_SCOPE.id });
    getDb().run('UPDATE commitments SET scope_id = NULL WHERE id = ?', [c.id]);
    expect(getCommitment(c.id)!.scope_id).toBeNull();
  });

  test('a table that never got the column still accepts writes', () => {
    // The real pre-migration risk, and the reason `createCommitment` probes
    // instead of assuming: the column arrives by an `ALTER TABLE` inside a
    // swallowing try/catch, and unlike `TaskRegistry.persist` this INSERT is
    // not wrapped in a catch of its own. If it named a column that was not
    // there, every commitment write in the product would throw -- out of a
    // chat turn, out of the HTTP create, out of the extractor.
    //
    // Rebuilt without the column rather than simulated, so this fails if the
    // probe is removed.
    const db = getDb();
    db.run('DROP TABLE commitments');
    db.run(`CREATE TABLE commitments (
      id TEXT PRIMARY KEY, what TEXT NOT NULL, when_due INTEGER, context TEXT,
      priority TEXT DEFAULT 'normal', status TEXT DEFAULT 'pending',
      retry_policy TEXT, created_from TEXT, assigned_to TEXT,
      created_at INTEGER NOT NULL, completed_at INTEGER, result TEXT,
      sort_order INTEGER DEFAULT 0
    )`);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    let created: ReturnType<typeof createCommitment> | null = null;
    try {
      expect(() => {
        created = withTurnScopeId(PROJECT_SITE_CHAT_SCOPE.id, () =>
          createCommitment('deploy the site'));
      }).not.toThrow();
    } finally {
      console.warn = origWarn;
    }
    // The write succeeded, the provenance is simply absent, and it said so.
    expect(created!.what).toBe('deploy the site');
    expect(getCommitment(created!.id)!.scope_id).toBeNull();
    expect(warnings.some((w) => w.includes('commitments.scope_id is missing'))).toBe(true);
  });
});
