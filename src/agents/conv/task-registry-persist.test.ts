import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { TaskRegistry } from './task-registry.ts';
import { TaskDispatcher, type TaskRunner } from './task-dispatcher.ts';
import type { TaskRequest } from './task-envelope.ts';
import type { LLMMessage, LLMProvider, LLMResponse, LLMStreamEvent } from '../../llm/provider.ts';
import { LLMManager } from '../../llm/manager.ts';
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

  it('hydrate is idempotent (second call does not corrupt or duplicate)', () => {
    const reg1 = new TaskRegistry({ db: dbResolver() });
    const rec = reg1.create(sampleRequest, 'test');
    reg1.transition(rec.id, 'completed', { task_id: rec.id, status: 'completed', summary: 's' });

    const reg2 = new TaskRegistry({ db: dbResolver() });
    reg2.hydrate();
    reg2.hydrate(); // second call must not break anything

    expect(reg2.recentResults()).toHaveLength(1);
    expect(reg2.get(rec.id)?.status).toBe('completed');
    // And the DB still has exactly one row.
    expect(rowCount()).toBe(1);
  });

  it('hydrate when the DB query throws starts empty (no crash)', () => {
    // A resolver that returns a DB-shaped object whose query() throws.
    const brokenDb = {
      query: () => { throw new Error('table missing'); },
    } as unknown as Database;
    const reg = new TaskRegistry({ db: () => brokenDb });
    expect(() => reg.hydrate()).not.toThrow();
    expect(reg.inFlight()).toHaveLength(0);
    expect(reg.recentResults()).toHaveLength(0);
  });

  it('hydrate ignores a row with unparseable paused_conversation JSON', () => {
    const reg1 = new TaskRegistry({ db: dbResolver() });
    const rec = reg1.create(sampleRequest, 'test');
    reg1.transition(rec.id, 'needs_input', {
      task_id: rec.id,
      status: 'needs_input',
      summary: 'q',
      needs_input: { question: 'q' },
    });
    // Hand-corrupt the JSON in the DB.
    getDb().run('UPDATE tasks SET paused_conversation = ?, question = ? WHERE id = ?', ['{not json', 'q', rec.id]);

    const reg2 = new TaskRegistry({ db: dbResolver() });
    reg2.hydrate();
    const restored = reg2.get(rec.id);
    // Record still loads (the row isn't a write-off) but the buffer is dropped,
    // so a subsequent resume would fail loudly ("not waiting") rather than
    // silently feed the LLM corrupt context.
    expect(restored).toBeDefined();
    expect(restored!.question).toBe('q');
    expect(restored!.pausedConversation).toBeUndefined();
  });
});

describe('TaskRegistry eviction interaction with paused tasks', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });
  afterEach(() => { closeDb(); });

  it('paused (needs_input) tasks survive even with a tiny keep window', () => {
    // Eviction only targets terminal records (completed/failed/cancelled).
    // A user who paces through 100 paused tasks must not have any silently
    // dropped: that would lose conversations.
    const reg = new TaskRegistry({ maxKeepCompleted: 1, db: dbResolver() });
    const pausedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const rec = reg.create(sampleRequest, 'test');
      reg.recordPauseState(rec.id, `q${i}`, [{ role: 'user', content: `c${i}` }]);
      reg.transition(rec.id, 'needs_input', {
        task_id: rec.id,
        status: 'needs_input',
        summary: `q${i}`,
        needs_input: { question: `q${i}` },
      });
      pausedIds.push(rec.id);
    }
    // Also queue some terminals so eviction has something to chew on.
    for (let i = 0; i < 3; i++) {
      const rec = reg.create(sampleRequest, 'test');
      reg.transition(rec.id, 'completed', { task_id: rec.id, status: 'completed', summary: '' });
    }

    expect(reg.inFlight()).toHaveLength(5); // all paused still present
    for (const id of pausedIds) expect(reg.get(id)?.status).toBe('needs_input');
    // Terminals trimmed to the keep window.
    expect(reg.recentResults(10)).toHaveLength(1);
  });
});

describe('TaskRegistry persistence error resilience', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });
  afterEach(() => { closeDb(); });

  it('a write failure does not break the live registry', () => {
    // Returning a DB whose run() throws simulates e.g. a transient SQLite
    // lock or a malformed prepared statement. The registry promises this is
    // best-effort; the in-memory cache stays consistent.
    const throwingDb = {
      run: () => { throw new Error('disk full'); },
      query: () => ({ all: () => [], get: () => null }),
    } as unknown as Database;
    const reg = new TaskRegistry({ db: () => throwingDb });

    // Silence the expected "[TaskRegistry] persist failed" warnings - they
    // confirm the resilience path fired; the assertion below proves the
    // registry stayed live, not the log line.
    const origWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      expect(() => {
        const rec = reg.create(sampleRequest, 'test');
        reg.transition(rec.id, 'completed', { task_id: rec.id, status: 'completed', summary: '' });
      }).not.toThrow();
    } finally {
      console.warn = origWarn;
    }

    // Cache still reflects every transition.
    expect(reg.recentResults()).toHaveLength(1);
    expect(reg.recentResults()[0]!.status).toBe('completed');
    // Both create + transition tried to persist and got swallowed.
    expect(warnings.length).toBe(2);
    expect(String(warnings[0]![0])).toContain('persist failed');
  });
});

describe('TaskRegistry listeners after hydrate', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });
  afterEach(() => { closeDb(); });

  it('a listener attached to a fresh registry fires on transitions of hydrated records', () => {
    const reg1 = new TaskRegistry({ db: dbResolver() });
    const rec = reg1.create(sampleRequest, 'test');
    reg1.transition(rec.id, 'needs_input', {
      task_id: rec.id,
      status: 'needs_input',
      summary: 'q',
      needs_input: { question: 'q' },
    });

    const reg2 = new TaskRegistry({ db: dbResolver() });
    reg2.hydrate();
    const events: string[] = [];
    reg2.subscribe((r) => events.push(r.status));

    // Continue the lifecycle of the restored record.
    reg2.transition(rec.id, 'running');
    reg2.transition(rec.id, 'completed', { task_id: rec.id, status: 'completed', summary: '' });

    expect(events).toEqual(['running', 'completed']);
  });
});

// --- End-to-end durability scenario ---

class StubLLM implements LLMProvider {
  name = 'stub';
  async chat(): Promise<LLMResponse> {
    return { content: 'condensed', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'stub', finish_reason: 'stop' };
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamEvent> { throw new Error('not used'); }
  async listModels(): Promise<string[]> { return ['stub']; }
}

function makeManager(): LLMManager {
  const m = new LLMManager();
  m.registerProvider(new StubLLM());
  m.setTierMap({ low: { provider: 'stub' }, medium: { provider: 'stub' } });
  return m;
}

describe('Task durability end-to-end (pause -> restart -> resume)', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });
  afterEach(() => { closeDb(); });

  it('a paused task resumes from a fresh registry built against the same DB', async () => {
    // --- Run 1: dispatch a task that pauses awaiting clarification.
    const llm1 = makeManager();
    const reg1 = new TaskRegistry({ db: dbResolver() });
    const runner1: TaskRunner = async () => ({
      kind: 'paused',
      question: 'Which Sarah?',
      conversation: [
        { role: 'system', content: 'be helpful' } as LLMMessage,
        { role: 'user', content: 'book a meeting with Sarah' } as LLMMessage,
      ],
    });
    const dispatcher1 = new TaskDispatcher(llm1, reg1, runner1);
    const first = await dispatcher1.dispatch({
      tier: 'medium', template: 'general', intent: 'book a meeting with Sarah',
    });
    expect(first.status).toBe('needs_input');
    expect(first.needs_input?.question).toBe('Which Sarah?');

    // --- "Daemon restart": throw reg1 away, build a new registry + dispatcher
    //     against the SAME DB. The user's clarification arrives via this run.
    const llm2 = makeManager();
    const reg2 = new TaskRegistry({ db: dbResolver() });
    reg2.hydrate();
    const hydrated = reg2.get(first.task_id);
    expect(hydrated?.status).toBe('needs_input');
    expect(hydrated?.pausedConversation).toBeDefined();

    let receivedHistory: unknown[] | undefined;
    let receivedOriginal: string | undefined;
    const runner2: TaskRunner = async (args) => {
      receivedHistory = args.history;
      receivedOriginal = args.originalMessage;
      return { kind: 'completed', text: 'Booked with Sarah Chen.', conversation: [] };
    };
    const dispatcher2 = new TaskDispatcher(llm2, reg2, runner2);
    const second = await dispatcher2.resume(first.task_id, 'Chen');

    expect(second.status).toBe('completed');
    expect(second.summary).toContain('Sarah Chen');
    // The runner on the post-restart side received the SAVED buffer + the
    // clarification reply - that's the durability promise.
    expect(receivedOriginal).toBe('Chen');
    expect(Array.isArray(receivedHistory)).toBe(true);
    expect((receivedHistory as LLMMessage[]).map(m => m.role)).toEqual(['system', 'user']);
  });

  it('resume from a restarted registry roundtrips a buffer with tool calls + content blocks', async () => {
    // Realistic resume payload: the captured task-tier conversation contains
    // assistant tool_calls + their outputs, not just plain text. Anything we
    // hand back to the LLM on resume must survive JSON round-tripping.
    const richBuffer: LLMMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'find the file' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', name: 'read_file', arguments: { path: '/etc/hosts' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '127.0.0.1 localhost' },
    ];

    const llm1 = makeManager();
    const reg1 = new TaskRegistry({ db: dbResolver() });
    const runner1: TaskRunner = async () => ({
      kind: 'paused', question: 'Which file?', conversation: richBuffer,
    });
    const d1 = new TaskDispatcher(llm1, reg1, runner1);
    const first = await d1.dispatch({ tier: 'medium', template: 'general', intent: 'find file' });

    // Restart.
    const reg2 = new TaskRegistry({ db: dbResolver() });
    reg2.hydrate();

    let observed: unknown[] | undefined;
    const runner2: TaskRunner = async (args) => {
      observed = args.history;
      return { kind: 'completed', text: 'done', conversation: [] };
    };
    const d2 = new TaskDispatcher(makeManager(), reg2, runner2);
    await d2.resume(first.task_id, '/etc/hosts');

    // The buffer the post-restart runner sees must equal what was captured,
    // including the tool_calls + tool message shapes.
    expect(observed).toEqual(richBuffer);
  });

  it('a task that was running at restart is reconciled to failed and is NOT resumable', async () => {
    // Simulate: registry recorded a task as `running`, then the process died.
    // hydrate() must demote it; an attempt to resume must refuse with
    // invalid_state, not silently re-run.
    const reg1 = new TaskRegistry({ db: dbResolver() });
    const rec = reg1.create(sampleRequest, 'test');
    reg1.transition(rec.id, 'running');

    const reg2 = new TaskRegistry({ db: dbResolver() });
    reg2.hydrate();
    const restored = reg2.get(rec.id);
    expect(restored?.status).toBe('failed');
    expect(restored?.result?.error).toBe('daemon_restart');

    const runner: TaskRunner = async () => ({ kind: 'completed', text: '', conversation: [] });
    const d = new TaskDispatcher(makeManager(), reg2, runner);
    const env = await d.resume(rec.id, 'unsolicited');
    expect(env.status).toBe('failed');
    expect(env.error).toBe('invalid_state');
  });
});
