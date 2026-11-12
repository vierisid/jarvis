/**
 * A commitment runs at its due time, at most once, and a cancel holds.
 *
 * Each test here failed before the change it pins: a cancelled commitment was
 * announced again by the next sweep and ran; one closed during its window ran
 * anyway; one that was mid-run when the brain died ran again after the
 * restart; the same promise stored twice ran twice; and it could run up to
 * two minutes early.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { EmergencyController, setActiveEmergencyController } from '../authority/emergency.ts';
import {
  claimCommitmentRun, createCommitment, getCommitment, getInterruptedCommitments, updateCommitmentDue, updateCommitmentStatus,
} from '../vault/commitments.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { CANCELLED_RESULT, CommitmentExecutor, INTERRUPTED_RESULT, type CommitmentEvent } from './commitment-executor.ts';

type Internals = { fireExecution(id: string): Promise<void>; announceTimers: Map<string, unknown> };
const fire = (ex: CommitmentExecutor, id: string) => (ex as unknown as Internals).fireExecution(id);
const waitingToAnnounce = (ex: CommitmentExecutor) => [...(ex as unknown as Internals).announceTimers.keys()];
const agent = (calls: string[], reply: string | (() => Promise<string>) = 'done') =>
  ({ handleMessage: async (prompt: string) => { calls.push(prompt); return typeof reply === 'string' ? reply : reply(); } }) as never;

const executors: CommitmentExecutor[] = [];
function make(mode: 'passive' | 'moderate' | 'aggressive' = 'aggressive') {
  const ex = new CommitmentExecutor(mode);
  executors.push(ex);
  const events: CommitmentEvent[] = [];
  ex.subscribe((event) => events.push(event));
  return { ex, events, types: () => events.map((e) => e.type) };
}

beforeEach(() => { initDatabase(':memory:', { quiet: true }); });
afterEach(() => {
  for (const ex of executors.splice(0)) ex.stop();
  setActiveEmergencyController(null);
  closeDb();
});

test('a cancel is written down: the commitment is closed, and no later sweep announces or runs it', async () => {
  const calls: string[] = [];
  const { ex, types } = make();
  ex.setAgentService(agent(calls));
  const c = createCommitment('send Anna the pricing', { when_due: Date.now() - 1000 });

  ex.checkAndAnnounce();
  expect(ex.getPending().map((p) => p.commitmentId)).toEqual([c.id]);
  expect(ex.cancelExecution(c.id)).toBe(true);
  expect(getCommitment(c.id)).toMatchObject({ status: 'failed', result: CANCELLED_RESULT });

  ex.checkAndAnnounce();
  ex.checkAndAnnounce();
  expect(ex.getPending()).toEqual([]);
  await fire(ex, c.id);
  expect(calls).toEqual([]);
  expect(types()).toEqual(['announced', 'cancelled']);
  // Still closed after a restart: a new executor finds nothing to do.
  const again = make();
  again.ex.setAgentService(agent(calls));
  again.ex.checkAndAnnounce();
  expect(again.ex.getPending()).toEqual([]);
});

test('a cancel does not overwrite what someone wrote in the meantime', () => {
  const { ex } = make();
  ex.setAgentService(agent([]));
  const c = createCommitment('email the report', { when_due: Date.now() - 1000 });
  ex.checkAndAnnounce();
  updateCommitmentStatus(c.id, 'completed', 'done by hand');
  expect(ex.cancelExecution(c.id)).toBe(true);
  expect(getCommitment(c.id)).toMatchObject({ status: 'completed', result: 'done by hand' });
});

test('a task closed during its window does not run, and what was written stays', async () => {
  for (const [status, result] of [['completed', 'done by hand'], ['failed', 'cancelled by user']] as const) {
    const calls: string[] = [];
    const { ex, types } = make();
    ex.setAgentService(agent(calls, 'ran anyway'));
    const c = createCommitment(`task closed as ${status}`, { when_due: Date.now() - 1000 });
    ex.checkAndAnnounce();
    updateCommitmentStatus(c.id, status, result);
    await fire(ex, c.id);
    expect(calls).toEqual([]);
    expect(getCommitment(c.id)).toMatchObject({ status, result });
    expect(types()).toEqual(['announced', 'withdrawn']);
  }
});

test('a task moved to a later time during its window does not run on the old announcement', async () => {
  const calls: string[] = [];
  const { ex } = make();
  ex.setAgentService(agent(calls));
  const c = createCommitment('call the bank', { when_due: Date.now() - 1000 });
  ex.checkAndAnnounce();
  updateCommitmentDue(c.id, Date.now() + 3_600_000);
  await fire(ex, c.id);
  expect(calls).toEqual([]);
  expect(getCommitment(c.id)).toMatchObject({ status: 'pending', started_at: null });
});

test('what runs is the task as it reads now, not as it read when it was announced', async () => {
  const calls: string[] = [];
  const { ex } = make();
  ex.setAgentService(agent(calls));
  const c = createCommitment('send the draft', { when_due: Date.now() - 1000 });
  ex.checkAndAnnounce();
  // No store function edits the text; the row is what the executor must read.
  const { getDb } = await import('../vault/schema.ts');
  getDb().run('UPDATE commitments SET what = ? WHERE id = ?', ['send the final version', c.id]);
  await fire(ex, c.id);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('"send the final version"');
});

test('a commitment that was mid-run when the brain died is not run again: it is closed as interrupted, and said so', async () => {
  const calls: string[] = [];
  const first = make();
  first.ex.setAgentService(agent(calls, () => new Promise<string>(() => { /* the crash: never returns */ })));
  const c = createCommitment('send the wire', { when_due: Date.now() - 1000 });
  first.ex.checkAndAnnounce();
  void fire(first.ex, c.id);
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toHaveLength(1);
  const midRun = getCommitment(c.id)!;
  expect(midRun.status).toBe('active');
  expect(midRun.started_at).not.toBeNull();
  expect(getInterruptedCommitments().map((i) => i.id)).toEqual([c.id]);

  // The restarted brain: nothing in memory.
  const second = make();
  second.ex.setAgentService(agent(calls, 'second run'));
  second.ex.start();
  expect(second.ex.getPending()).toEqual([]);
  expect(calls).toHaveLength(1);
  expect(getCommitment(c.id)).toMatchObject({ status: 'failed', result: INTERRUPTED_RESULT });
  expect(second.events).toEqual([{ type: 'interrupted', commitmentId: c.id, what: 'send the wire' }]);
  // And not on any later sweep either.
  second.ex.checkAndAnnounce();
  expect(second.ex.getPending()).toEqual([]);
});

test('a brain that stops during the cancel window has run nothing: after the restart it is announced again and runs once', async () => {
  const calls: string[] = [];
  const first = make();
  first.ex.setAgentService(agent(calls));
  const c = createCommitment('send Anna the pricing', { when_due: Date.now() - 1000 });
  first.ex.checkAndAnnounce();
  first.ex.stop();
  expect(getCommitment(c.id)).toMatchObject({ status: 'pending', started_at: null });

  const second = make();
  second.ex.setAgentService(agent(calls));
  second.ex.start();
  expect(second.types()).toEqual(['announced']);
  await fire(second.ex, c.id);
  await fire(second.ex, c.id);
  expect(calls).toHaveLength(1);
  expect(getCommitment(c.id)?.status).toBe('completed');
  expect(second.types()).toEqual(['announced', 'started', 'finished']);
});

test('taking a commitment to run can only be won once', () => {
  const c = createCommitment('one run', { when_due: Date.now() - 1000 });
  expect(claimCommitmentRun(c.id)?.status).toBe('active');
  expect(claimCommitmentRun(c.id)).toBeNull();
  // Opened again by hand: whatever run it had is behind it.
  updateCommitmentStatus(c.id, 'pending');
  expect(getCommitment(c.id)?.started_at).toBeNull();
  expect(claimCommitmentRun(c.id)).not.toBeNull();
  // A run that finished stays marked as having run.
  updateCommitmentStatus(c.id, 'completed', 'ok');
  expect(getCommitment(c.id)?.started_at).not.toBeNull();
  expect(claimCommitmentRun(c.id)).toBeNull();
  expect(claimCommitmentRun('no-such-id')).toBeNull();
});

test('the same promise, due in the same minute and still open, is one commitment', async () => {
  const calls: string[] = [];
  const { ex } = make();
  ex.setAgentService(agent(calls));
  const due = Math.floor((Date.now() - 120_000) / 60_000) * 60_000 + 5_000;
  const a = createCommitment('Send Anna the pricing', { when_due: due, created_from: 'jarvis' });
  const b = createCommitment('send  anna the pricing.', { when_due: due + 20_000, created_from: 'llm_extraction' });
  expect(b.id).toBe(a.id);
  ex.checkAndAnnounce();
  expect(ex.getPending()).toHaveLength(1);
  await fire(ex, a.id);
  expect(calls).toHaveLength(1);

  // Other words, another minute, or no due time at all: not the same.
  expect(createCommitment('Send Anna the contract', { when_due: due }).id).not.toBe(a.id);
  expect(createCommitment('Send Anna the pricing', { when_due: due + 120_000 }).id).not.toBe(a.id);
  expect(createCommitment('Buy milk').id).not.toBe(createCommitment('Buy milk').id);
  // Once the first is closed, the same words are a new promise.
  expect(createCommitment('Send Anna the pricing', { when_due: due }).id).not.toBe(a.id);
});

test('it is announced one cancel window before it is due, and runs when it is due, not up to two minutes early', () => {
  const { ex, events } = make('aggressive');
  ex.setAgentService(agent([]));
  const soon = createCommitment('due in ninety seconds', { when_due: Date.now() + 90_000 });
  const now = Date.now();
  ex.checkAndAnnounce();
  expect(ex.getPending()).toEqual([]);
  expect(waitingToAnnounce(ex)).toEqual([soon.id]);
  expect(events).toEqual([]);
  // A second sweep does not schedule it twice.
  ex.checkAndAnnounce();
  expect(waitingToAnnounce(ex)).toEqual([soon.id]);

  // Closer than a window: announced now, with a full window to cancel in.
  const close = createCommitment('due in two seconds', { when_due: Date.now() + 2_000 });
  ex.checkAndAnnounce();
  const pending = ex.getPending().find((p) => p.commitmentId === close.id)!;
  expect(pending.cancelDeadline).toBeGreaterThanOrEqual(now + 5_000);
  expect(pending.cancelDeadline).toBeLessThan(now + 6_000);
  expect(events.at(-1)).toMatchObject({ type: 'announced', commitmentId: close.id, fireAt: pending.cancelDeadline });
});

test('with a long window, the run still waits for the due time', () => {
  const { ex } = make('moderate');
  ex.setAgentService(agent([]));
  const due = Date.now() + 100_000;
  const c = createCommitment('due in a hundred seconds', { when_due: due });
  // Found inside the two-minute look-ahead, 70 s before its announcement.
  ex.checkAndAnnounce();
  expect(ex.getPending()).toEqual([]);
  expect(waitingToAnnounce(ex)).toEqual([c.id]);
});

test('nothing is announced that nothing could run', () => {
  const { ex, events } = make('aggressive');
  createCommitment('no agent yet', { when_due: Date.now() - 1000 });
  ex.checkAndAnnounce();
  expect(ex.getPending()).toEqual([]);
  expect(events).toEqual([]);
});

test('a commitment whose origin has a runner is run by it, with no model turn', async () => {
  const calls: string[] = [];
  const ran: string[] = [];
  const { ex, events } = make();
  // No agent at all: only the runner.
  ex.setOriginRunner('notch_fixture', (commitment) => { ran.push(commitment.id); return 'Fixture ran.'; });
  const c = createCommitment('Notch hand test', { when_due: Date.now() - 1000, created_from: 'notch_fixture' });
  createCommitment('an ordinary task', { when_due: Date.now() - 1000 });
  ex.checkAndAnnounce();
  expect(ex.getPending().map((p) => p.commitmentId)).toEqual([c.id]);
  await fire(ex, c.id);
  await fire(ex, c.id);
  expect(ran).toEqual([c.id]);
  expect(calls).toEqual([]);
  expect(getCommitment(c.id)).toMatchObject({ status: 'completed', result: 'Fixture ran.' });
  expect(events.at(-1)).toEqual({ type: 'finished', commitmentId: c.id, what: 'Notch hand test', status: 'completed', result: 'Fixture ran.' });
});

test('while Jarvis is paused nothing is announced or run; what was announced is withdrawn, and announced again after Resume', async () => {
  const controller = new EmergencyController();
  setActiveEmergencyController(controller);
  const calls: string[] = [];
  const { ex, types } = make();
  controller.subscribe((state) => ex.onEmergency(state));
  ex.setAgentService(agent(calls));
  ex.start();
  const c = createCommitment('send Anna the pricing', { when_due: Date.now() - 1000 });
  ex.checkAndAnnounce();
  expect(types()).toEqual(['announced']);

  controller.pause();
  expect(ex.getPending()).toEqual([]);
  expect(types()).toEqual(['announced', 'withdrawn']);
  await fire(ex, c.id);
  ex.checkAndAnnounce();
  expect(calls).toEqual([]);
  expect(getCommitment(c.id)).toMatchObject({ status: 'pending', started_at: null });

  controller.resume();
  expect(types()).toEqual(['announced', 'withdrawn', 'announced']);
  await fire(ex, c.id);
  expect(calls).toHaveLength(1);
  expect(getCommitment(c.id)?.status).toBe('completed');
});

test('paused between the announcement and the run, with nobody telling the executor: it still does not run', async () => {
  const controller = new EmergencyController();
  setActiveEmergencyController(controller);
  const calls: string[] = [];
  const { ex, types } = make();
  ex.setAgentService(agent(calls));
  const c = createCommitment('send Anna the pricing', { when_due: Date.now() - 1000 });
  ex.checkAndAnnounce();
  controller.pause();
  await fire(ex, c.id);
  expect(calls).toEqual([]);
  expect(types()).toEqual(['announced', 'withdrawn']);
  expect(getCommitment(c.id)?.status).toBe('pending');
});

test('a turn that came back as error text is a failure, not a result', async () => {
  const { ex, events } = make();
  ex.setAgentService(agent([], 'Error: provider unreachable'));
  const c = createCommitment('fixture', { when_due: Date.now() - 1000 });
  ex.checkAndAnnounce();
  await fire(ex, c.id);
  expect(getCommitment(c.id)).toMatchObject({ status: 'failed', result: 'provider unreachable' });
  expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'failed' });
});

test('a turn refused because the brain is shutting down did nothing: the commitment is given back and runs after the restart', async () => {
  const calls: string[] = [];
  const first = make();
  first.ex.setAgentService(agent(calls, 'skipped: draining'));
  const c = createCommitment('send Anna the pricing', { when_due: Date.now() - 1000 });
  first.ex.checkAndAnnounce();
  await fire(first.ex, c.id);
  expect(getCommitment(c.id)).toMatchObject({ status: 'pending', started_at: null, result: null });
  expect(getInterruptedCommitments()).toEqual([]);

  const second = make();
  second.ex.setAgentService(agent(calls, 'sent'));
  second.ex.start();
  await fire(second.ex, c.id);
  expect(getCommitment(c.id)).toMatchObject({ status: 'completed', result: 'sent' });
});

test('a listener that throws does not stop the others, or the executor', async () => {
  const calls: string[] = [];
  const ex = new CommitmentExecutor('aggressive');
  executors.push(ex);
  const heard: string[] = [];
  ex.subscribe(() => { throw new Error('boom'); });
  const off = ex.subscribe((event) => heard.push(event.type));
  ex.setAgentService(agent(calls));
  const c = createCommitment('still runs', { when_due: Date.now() - 1000 });
  ex.checkAndAnnounce();
  await fire(ex, c.id);
  expect(calls).toHaveLength(1);
  expect(heard).toEqual(['announced', 'started', 'finished']);
  off();
  createCommitment('after unsubscribing', { when_due: Date.now() - 1000 });
  ex.checkAndAnnounce();
  expect(heard).toHaveLength(3);
});
