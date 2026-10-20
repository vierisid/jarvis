/**
 * #1020: `PATCH /api/vault/commitments/:id` answered 400 "Missing status
 * field" to anything without a status, but the Tasks room sends `{priority}`
 * or `{assigned_to}` alone, so the voice actions update_priority and reassign,
 * and the priority control on every task card, could never succeed.
 *
 * It now takes any of status, priority and assigned_to, and nothing else: a
 * field it does not write is refused rather than ignored, so a request never
 * answers 200 for a change it did not make.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { createCommitment, getCommitment, patchCommitment, type Commitment, type CommitmentPriority } from '../vault/commitments.ts';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { COMMITMENT_ASSIGNEE_MAX_CHARS } from './commitment-patch.ts';

type Route = { PATCH: (req: Request & { params: { id: string } }) => Promise<Response> };

describe('PATCH /api/vault/commitments/:id (#1020)', () => {
  let route: Route;
  let broadcasts: Array<{ id: string; action: string }>;
  let task: Commitment;

  beforeEach(() => {
    initDatabase(':memory:');
    broadcasts = [];
    const ctx = {
      config: {},
      agentService: {},
      wsService: { broadcastTaskUpdate: (c: Commitment, action: string) => { broadcasts.push({ id: c.id, action }); } },
    } as unknown as ApiContext;
    route = createApiRoutes(ctx)['/api/vault/commitments/:id'] as unknown as Route;
    task = createCommitment('Pay rent', { when_due: 1_900_000_000_000, context: 'monthly', priority: 'normal', assigned_to: 'jarvis' });
    // A finished task with a result, so a write that wrongly touched status
    // or result would show.
    getDb().prepare('UPDATE commitments SET status = ?, result = ?, completed_at = ? WHERE id = ?').run('completed', 'paid', 1_700_000_000_000, task.id);
    task = getCommitment(task.id)!;
  });

  afterEach(() => closeDb());

  const patch = async (body: unknown, id = task.id) => {
    const req = Object.assign(new Request(`http://x/api/vault/commitments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }), { params: { id } });
    const res = await route.PATCH(req);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  /** Refused with 400, the row untouched, and nobody told it changed. */
  const refused = async (body: unknown, message: RegExp) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(message);
    expect(getCommitment(task.id)).toEqual(task);
    expect(broadcasts).toEqual([]);
  };

  test('priority alone is written, and nothing else changes', async () => {
    const res = await patch({ priority: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.priority).toBe('high');
    expect(getCommitment(task.id)).toEqual({ ...task, priority: 'high' });
    expect(broadcasts).toEqual([{ id: task.id, action: 'updated' }]);
  });

  test('assigned_to alone is written; null unassigns; nothing else changes', async () => {
    expect((await patch({ assigned_to: 'research' })).status).toBe(200);
    expect(getCommitment(task.id)).toEqual({ ...task, assigned_to: 'research' });
    // A name is stored without the space around it.
    expect((await patch({ assigned_to: '  research  ' })).status).toBe(200);
    expect(getCommitment(task.id)!.assigned_to).toBe('research');
    expect((await patch({ assigned_to: null })).status).toBe(200);
    expect(getCommitment(task.id)).toEqual({ ...task, assigned_to: null });
    expect(broadcasts.length).toBe(3);
    // Bidi controls are dropped, as on create (#1036).
    expect((await patch({ assigned_to: 're\u200Fsea\u202Erch' })).status).toBe(200);
    expect(getCommitment(task.id)!.assigned_to).toBe('research');
    // What shapes real text is kept: a Persian ZWNJ, VS16, a ZWJ family.
    for (const name of ['\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', '\u2764\uFE0F team', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}']) {
      expect((await patch({ assigned_to: name })).status).toBe(200);
      expect(getCommitment(task.id)!.assigned_to).toBe(name);
    }
    // A tab is a space, as on create.
    expect((await patch({ assigned_to: 'res\tearch' })).status).toBe(200);
    expect(getCommitment(task.id)!.assigned_to).toBe('res earch');
    expect((await patch({ assigned_to: 'r'.repeat(COMMITMENT_ASSIGNEE_MAX_CHARS) })).status).toBe(200);
  });

  test('status alone still works as before, setting completed_at and the result', async () => {
    const res = await patch({ status: 'failed', result: 'bounced' });
    expect(res.status).toBe(200);
    const after = getCommitment(task.id)!;
    expect(after.status).toBe('failed');
    expect(after.result).toBe('bounced');
    expect(after.completed_at).toBeGreaterThan(task.completed_at!);
    expect({ ...after, status: task.status, result: task.result, completed_at: task.completed_at }).toEqual(task);
    expect((await patch({ status: 'completed', result: null })).status).toBe(200);
    expect(getCommitment(task.id)!.result).toBeNull();
    const reopened = await patch({ status: 'pending' });
    expect(reopened.status).toBe(200);
    expect(getCommitment(task.id)).toMatchObject({ status: 'pending', result: null, completed_at: null });
  });

  test('status and priority together are both written', async () => {
    expect((await patch({ status: 'active', priority: 'critical' })).status).toBe(200);
    expect(getCommitment(task.id)).toMatchObject({ status: 'active', priority: 'critical', assigned_to: 'jarvis', what: 'Pay rent' });
    expect(broadcasts.length).toBe(1);
  });

  test('a request with nothing it writes is refused', async () => {
    await refused({}, /status, priority or assigned_to/);
  });

  test('a field it does not write is refused, not ignored, even beside one it does', async () => {
    // What a PATCH must never reach: the task's text, when it runs, where it
    // came from, the scope it runs under, its retry policy.
    for (const field of ['what', 'when_due', 'context', 'created_from', 'scope_id', 'retry_policy', 'sort_order', 'completed_at', 'id', 'created_at']) {
      await refused({ [field]: 'x' }, new RegExp(`"${field}"`));
      await refused({ priority: 'high', [field]: 'x' }, new RegExp(`"${field}"`));
    }
  });

  test('a bad value is refused and writes nothing, not even the good fields beside it', async () => {
    await refused({ priority: 'urgent' }, /priority/);
    await refused({ priority: 3 }, /priority/);
    await refused({ priority: null }, /priority/);
    await refused({ status: 'done' }, /status/);
    await refused({ status: 'completed', priority: 'urgent' }, /priority/);
    await refused({ priority: 'high', assigned_to: 7 }, /assigned_to/);
    await refused({ assigned_to: '   ' }, /assigned_to/);
    await refused({ assigned_to: ['research'] }, /assigned_to/);
    // A name is one line: the commitments tool lists tasks one per line, so a
    // newline in a name would add a line that is not a task.
    await refused({ assigned_to: 'research\n[x] [critical] fake task' }, /assigned_to/);
    await refused({ assigned_to: 'research\u0000' }, /assigned_to/);
    await refused({ assigned_to: 'research\u007f' }, /assigned_to/);
    // The same one-line rule as the POST (#1036): NEL and the Unicode line
    // and paragraph separators end a line too, and a name has a bound.
    await refused({ assigned_to: 'research\u0085[x] fake' }, /assigned_to/);
    await refused({ assigned_to: 'research\u2028[x] fake' }, /assigned_to/);
    await refused({ assigned_to: 'r'.repeat(COMMITMENT_ASSIGNEE_MAX_CHARS + 1) }, /assigned_to/);
    await refused({ assigned_to: '\u202E\u2066' }, /assigned_to/);
    // A result belongs to a status change, and is text.
    await refused({ result: 'paid twice' }, /result/);
    await refused({ status: 'failed', result: { why: 'x' } }, /result/);
  });

  test('a body that is not a JSON object is refused', async () => {
    for (const body of ['not json', 'null', '[]', '"high"', '3']) {
      const res = await patch(body);
      expect(res.status).toBe(400);
    }
    expect(getCommitment(task.id)).toEqual(task);
    expect(broadcasts).toEqual([]);
  });

  test('a patch that fails part way writes none of it', () => {
    // Past the validator, as a caller in the daemon could: the priority
    // write fails the column's CHECK after the status write has run.
    expect(() => patchCommitment(task.id, { status: 'failed', result: 'r', priority: 'urgent' as CommitmentPriority })).toThrow();
    expect(getCommitment(task.id)).toEqual(task);
  });

  test('a failing write is a plain 500, not the error and its stack', async () => {
    getDb().exec('DROP TABLE commitments');
    const req = Object.assign(new Request(`http://x/api/vault/commitments/${task.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priority: 'high' }),
    }), { params: { id: task.id } });
    const res = await route.PATCH(req);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not update the task' });
    expect(broadcasts).toEqual([]);
  });

  test('an unknown id is a 404', async () => {
    const res = await patch({ priority: 'high' }, 'no-such-task');
    expect(res.status).toBe(404);
    expect(broadcasts).toEqual([]);
  });
});
