import { describe, expect, it } from 'bun:test';
import { TaskRegistry } from './task-registry.ts';
import type { TaskRequest } from './task-envelope.ts';

const sampleRequest: TaskRequest = {
  tier: 'medium',
  template: 'research',
  intent: 'Find the latest news on X',
};

describe('TaskRegistry', () => {
  it('create() returns a task with queued status', () => {
    const reg = new TaskRegistry();
    const rec = reg.create(sampleRequest, 'test_subsystem');
    expect(rec.status).toBe('queued');
    expect(rec.id).toBeDefined();
    expect(rec.request).toEqual(sampleRequest);
  });

  it('transition() updates status and result', () => {
    const reg = new TaskRegistry();
    const rec = reg.create(sampleRequest, 'test');
    reg.transition(rec.id, 'running');
    expect(reg.get(rec.id)?.status).toBe('running');

    reg.transition(rec.id, 'completed', {
      task_id: rec.id,
      status: 'completed',
      summary: 'Done',
    });
    expect(reg.get(rec.id)?.status).toBe('completed');
    expect(reg.get(rec.id)?.result?.summary).toBe('Done');
  });

  it('inFlight() lists only running/queued/needs_input', () => {
    const reg = new TaskRegistry();
    const a = reg.create(sampleRequest, 'test');
    const b = reg.create(sampleRequest, 'test');
    reg.transition(a.id, 'running');
    reg.transition(b.id, 'completed', { task_id: b.id, status: 'completed', summary: '' });

    const inFlight = reg.inFlight();
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]!.id).toBe(a.id);
  });

  it('recentResults() returns completed/failed/cancelled, newest first', () => {
    const reg = new TaskRegistry();
    const a = reg.create(sampleRequest, 'test');
    const b = reg.create(sampleRequest, 'test');
    reg.transition(a.id, 'completed', { task_id: a.id, status: 'completed', summary: 'a' });
    // ensure b has a later updatedAt
    const orig = Date.now;
    Date.now = () => orig() + 1000;
    reg.transition(b.id, 'failed', { task_id: b.id, status: 'failed', summary: 'b' });
    Date.now = orig;

    const recent = reg.recentResults();
    expect(recent[0]!.id).toBe(b.id);
    expect(recent[1]!.id).toBe(a.id);
  });

  it('subscribe() fires on every transition', () => {
    const reg = new TaskRegistry();
    const events: string[] = [];
    const unsub = reg.subscribe(rec => events.push(rec.status));
    const rec = reg.create(sampleRequest, 'test');
    reg.transition(rec.id, 'running');
    reg.transition(rec.id, 'completed', { task_id: rec.id, status: 'completed', summary: '' });
    unsub();
    reg.transition(rec.id, 'cancelled', { task_id: rec.id, status: 'cancelled', summary: '' });
    expect(events).toEqual(['queued', 'running', 'completed']);
  });

  it('abort() signals the attached AbortController', () => {
    const reg = new TaskRegistry();
    const rec = reg.create(sampleRequest, 'test');
    const ctrl = new AbortController();
    reg.setAbortController(rec.id, ctrl);
    expect(reg.abort(rec.id)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('abort() returns false for unknown task', () => {
    const reg = new TaskRegistry();
    expect(reg.abort('nonexistent')).toBe(false);
  });

  it('evicts old completed records past the keep window', () => {
    const reg = new TaskRegistry({ maxKeepCompleted: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const rec = reg.create(sampleRequest, 'test');
      ids.push(rec.id);
      reg.transition(rec.id, 'completed', { task_id: rec.id, status: 'completed', summary: '' });
    }
    const recent = reg.recentResults(10);
    expect(recent).toHaveLength(2);
    // Oldest IDs should be evicted
    expect(reg.get(ids[0]!)).toBeUndefined();
    expect(reg.get(ids[4]!)).toBeDefined();
  });
});
