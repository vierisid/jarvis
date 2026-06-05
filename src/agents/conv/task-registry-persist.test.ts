import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { TaskRegistry } from './task-registry.ts';
import type { TaskRequest } from './task-envelope.ts';
import type { LLMMessage } from '../../llm/provider.ts';
import { initDatabase, closeDb, getDb } from '../../vault/schema.ts';

const sampleRequest: TaskRequest = {
  tier: 'medium',
  template: 'research',
  intent: 'Find the latest news on X',
  original_message: 'tell me what is going on',
};

function dbResolver() {
  return () => { try { return getDb(); } catch { return null; } };
}

function rowCount(): number {
  return getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tasks').get()!.n;
}

describe('TaskRegistry persistence', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });
  afterEach(() => { closeDb(); });

  it('create() writes a row', () => {
    const reg = new TaskRegistry({ db: dbResolver() });
    const rec = reg.create(sampleRequest, 'test');
    expect(rowCount()).toBe(1);
    const row = getDb().query<{ id: string; status: string }, []>('SELECT id, status FROM tasks').get()!;
    expect(row.id).toBe(rec.id);
    expect(row.status).toBe('queued');
  });

  it('transition() updates the same row', () => {
    const reg = new TaskRegistry({ db: dbResolver() });
    const rec = reg.create(sampleRequest, 'test');
    reg.transition(rec.id, 'completed', { task_id: rec.id, status: 'completed', summary: 'done' });
    expect(rowCount()).toBe(1);
    const row = getDb()
      .query<{ status: string; result_json: string }, []>('SELECT status, result_json FROM tasks').get()!;
    expect(row.status).toBe('completed');
    expect(JSON.parse(row.result_json).summary).toBe('done');
  });

  it('recordPauseState() persists the buffer and question', () => {
    const reg = new TaskRegistry({ db: dbResolver() });
    const rec = reg.create(sampleRequest, 'test');
    const convo: LLMMessage[] = [{ role: 'user', content: 'pick one' }];
    reg.recordPauseState(rec.id, 'Which one?', convo);
    const row = getDb()
      .query<{ question: string; paused_conversation: string }, []>(
        'SELECT question, paused_conversation FROM tasks',
      ).get()!;
    expect(row.question).toBe('Which one?');
    expect(JSON.parse(row.paused_conversation)).toEqual(convo);
  });

  it('clearPauseState() drops the buffer columns', () => {
    const reg = new TaskRegistry({ db: dbResolver() });
    const rec = reg.create(sampleRequest, 'test');
    reg.recordPauseState(rec.id, 'q', [{ role: 'user', content: 'x' }]);
    reg.clearPauseState(rec.id);
    const row = getDb()
      .query<{ question: string | null; paused_conversation: string | null }, []>(
        'SELECT question, paused_conversation FROM tasks',
      ).get()!;
    expect(row.question).toBeNull();
    expect(row.paused_conversation).toBeNull();
  });

  it('eviction past the keep window drops DB rows too', () => {
    const reg = new TaskRegistry({ maxKeepCompleted: 2, db: dbResolver() });
    for (let i = 0; i < 5; i++) {
      const rec = reg.create(sampleRequest, 'test');
      reg.transition(rec.id, 'completed', { task_id: rec.id, status: 'completed', summary: String(i) });
    }
    expect(rowCount()).toBe(2);
  });

  it('null DB resolver disables persistence (in-memory only mode still works)', () => {
    const reg = new TaskRegistry();
    const rec = reg.create(sampleRequest, 'test');
    reg.transition(rec.id, 'completed', { task_id: rec.id, status: 'completed', summary: 'done' });
    expect(reg.get(rec.id)?.status).toBe('completed');
    // DB exists but registry was constructed without a resolver: no rows.
    expect(rowCount()).toBe(0);
  });
});

describe('TaskRegistry hydrate', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });
  afterEach(() => { closeDb(); });

  it('restores terminal records into the cache', () => {
    const reg1 = new TaskRegistry({ db: dbResolver() });
    const rec = reg1.create(sampleRequest, 'test');
    reg1.transition(rec.id, 'completed', { task_id: rec.id, status: 'completed', summary: 'old' });

    // Simulate a daemon restart: drop the in-memory cache, create a new
    // registry against the same DB, hydrate.
    const reg2 = new TaskRegistry({ db: dbResolver() });
    reg2.hydrate();
    const restored = reg2.get(rec.id);
    expect(restored).toBeDefined();
    expect(restored!.status).toBe('completed');
    expect(restored!.result?.summary).toBe('old');
  });

  it('restores needs_input records with their paused conversation intact', () => {
    const reg1 = new TaskRegistry({ db: dbResolver() });
    const rec = reg1.create(sampleRequest, 'test');
    const convo: LLMMessage[] = [
      { role: 'user', content: 'book a meeting with Sarah' },
      { role: 'assistant', content: 'which Sarah?' },
    ];
    reg1.recordPauseState(rec.id, 'Which Sarah?', convo);
    reg1.transition(rec.id, 'needs_input', {
      task_id: rec.id,
      status: 'needs_input',
      summary: 'Which Sarah?',
      needs_input: { question: 'Which Sarah?' },
    });

    const reg2 = new TaskRegistry({ db: dbResolver() });
    reg2.hydrate();
    const restored = reg2.get(rec.id);
    expect(restored).toBeDefined();
    expect(restored!.status).toBe('needs_input');
    expect(restored!.question).toBe('Which Sarah?');
    expect(restored!.pausedConversation).toEqual(convo);
  });

  it('demotes running/queued records to failed on hydrate (daemon_restart)', () => {
    const reg1 = new TaskRegistry({ db: dbResolver() });
    const running = reg1.create(sampleRequest, 'test');
    reg1.transition(running.id, 'running');
    const queued = reg1.create(sampleRequest, 'test'); // stays queued

    const reg2 = new TaskRegistry({ db: dbResolver() });
    reg2.hydrate();
    const r = reg2.get(running.id);
    const q = reg2.get(queued.id);
    expect(r?.status).toBe('failed');
    expect(r?.result?.error).toBe('daemon_restart');
    expect(q?.status).toBe('failed');
    expect(q?.result?.error).toBe('daemon_restart');

    // And the DB reflects the demotion (so a second restart doesn't see
    // them as running again).
    const fromDb = getDb()
      .query<{ status: string }, [string]>('SELECT status FROM tasks WHERE id = ?')
      .get(running.id)!;
    expect(fromDb.status).toBe('failed');
  });

  it('hydrate on an empty table is a no-op', () => {
    const reg = new TaskRegistry({ db: dbResolver() });
    reg.hydrate();
    expect(reg.inFlight()).toHaveLength(0);
    expect(reg.recentResults()).toHaveLength(0);
  });
});
