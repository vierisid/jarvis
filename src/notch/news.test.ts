import { describe, expect, test } from 'bun:test';
import { NotchInbox } from './inbox.ts';
import { attachNotchNews } from './news.ts';
import type { NotchOpenFailure } from './news.ts';
import type { NotchLine, NotchToPage } from './protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness(open: NotchOpenFailure[] | (() => NotchOpenFailure[]) = [], more: Partial<Parameters<typeof attachNotchNews>[1]> = {}) {
  const pushed: NotchToPage[] = [];
  const logs: string[] = [];
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const surface = new NotchSurface(port, () => {});
  const inbox = new NotchInbox(surface, { log: (line) => logs.push(line) });
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  const failures = Array.isArray(open) ? [...open] : null;
  const news = attachNotchNews(inbox, { openFailures: () => (failures ?? (open as () => NotchOpenFailure[])()), log: (line) => logs.push(line), ...more });
  const line = (): NotchLine | null => surface.current().line;
  return {
    news, inbox, logs, failures: failures!, line,
    said: (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join(''),
    count: (): number => surface.current().count,
    async done(): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act: 'done' }); await settle(); },
    async answer(act: string): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act }); await settle(); },
  };
}

describe('failures', () => {
  test('what was already open when the notch came up is not news', async () => {
    const h = harness([{ key: 'old', headline: 'An old failure.' }]);
    h.news.sync();
    h.news.sync();
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('a failure that opens afterwards is said once, in the product\'s own sentence', async () => {
    const h = harness([]);
    h.news.sync();
    h.failures.push({ key: 'k1', headline: 'The step "Send email" did not run: its approval was denied.' });
    h.news.sync();
    await settle();
    expect(h.said()).toBe('The step "Send email" did not run: its approval was denied.');
    expect(h.line()).toMatchObject({ kind: 'say', mark: 'fail' });
    await h.done();
    expect(h.line()).toBeNull();
    // Still open in the dashboard, and not said again.
    h.news.sync();
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('two at once: one is said, the other waits in the count', async () => {
    const h = harness([]);
    h.news.sync();
    h.failures.push({ key: 'k1', headline: 'First.' }, { key: 'k2', headline: 'Second.' });
    h.news.sync();
    await settle();
    expect(h.said()).toBe('First.');
    expect(h.count()).toBe(1);
  });

  test('a list that cannot be read is logged, and the next look works', async () => {
    let broken = true;
    const list: NotchOpenFailure[] = [];
    const h = harness(() => { if (broken) throw new Error('database is locked'); return list; });
    h.news.sync();
    expect(h.logs.some((l) => l.includes('could not be read: database is locked'))).toBe(true);
    broken = false;
    h.news.sync();
    list.push({ key: 'k1', headline: 'Now it failed.' });
    h.news.sync();
    await settle();
    expect(h.said()).toBe('Now it failed.');
  });
});

describe('finished work', () => {
  test('a background task that completes is one line, with its text cut to fit', async () => {
    const h = harness();
    h.news.taskEnded('complete', { id: 't1', agentName: 'Researcher', task: `Compare ${'three vendors and their prices '.repeat(6)}` });
    await settle();
    expect(h.said()).toMatch(/^Researcher finished: Compare three vendors/);
    expect(h.said().length).toBeLessThan(130);
    expect(h.line()).toMatchObject({ kind: 'say', mark: 'check' });
    // Pass 12: an agent that is done comes hopping along the edge.
    expect(h.line()).toMatchObject({ arrive: 'hop', unasked: true });
  });

  test('one that fails says so', async () => {
    const h = harness();
    h.news.taskEnded('fail', { id: 't2', agentName: '', task: 'Book the flight' });
    await settle();
    expect(h.said()).toBe('An agent could not finish: Book the flight');
    expect(h.line()).toMatchObject({ mark: 'fail' });
  });
});

// The prototype: "Otto stopped. Stripe wants you to sign in again.", and yes signs in.
describe('an agent that stopped has a way out, when the product names a safe one', () => {
  const EXPIRED: NotchOpenFailure = { key: 'k9', headline: 'The step "Send the numbers" could not continue. A connection it uses has expired.', flowId: 'flow-1', steps: ['connect'] };
  /** The owner's agents, the Connections sheet, and what was run. */
  function world(failure: NotchOpenFailure, options: { run?: { ok: true } | { ok: false; why: string }; paused?: boolean; noConnections?: boolean; noRun?: boolean } = {}) {
    const did: string[] = [];
    const h = harness([], {
      agent: (flowId) => (flowId === 'flow-1' ? { name: 'Tony' } : null),
      ...(options.noConnections ? {} : { connections: async (stage) => { did.push('connections'); await stage.sheet(['Connections'], [{ kind: 'note', say: ['Gmail: sign in again.'] }]); } }),
      ...(options.noRun ? {} : { run: (flowId) => { did.push(`run ${flowId}`); return options.run ?? { ok: true }; } }),
      paused: () => options.paused === true,
    });
    h.news.sync();
    h.failures.push(failure);
    h.news.sync();
    return { ...h, did };
  }

  test('it is said as the agent\'s own, with the product\'s sentence, and yes opens the way to the sign-in', async () => {
    const h = world(EXPIRED);
    await settle();
    expect(h.said()).toBe('Tony stopped. The step "Send the numbers" could not continue. A connection it uses has expired.');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'sign in', mark: 'fail', mood: 'worried', who: 'Tony' });
    expect(h.did).toEqual([]);
    await h.answer('yes');
    expect(h.did).toEqual(['connections']);
    expect(h.said()).toBe('Connections');
    // The sign-in is theirs to do. When the Connections are closed, the run is offered: it is not taken for granted.
    await h.answer('no');
    expect(h.said()).toBe('Run Tony again now?');
    expect(h.did).toEqual(['connections']);
    await h.answer('yes');
    expect(h.did).toEqual(['connections', 'run flow-1']);
    expect(h.said()).toBe('Tony is running again.');
    await h.done();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('after the Connections, a no to the run runs nothing', async () => {
    const h = world(EXPIRED);
    await settle();
    await h.answer('yes');
    await h.answer('no');
    await h.answer('no');
    expect(h.did).toEqual(['connections']);
    expect(h.line()).toBeNull();
  });

  test('when the product says it is safe to run again, yes runs it', async () => {
    const h = world({ key: 'k8', headline: 'The step "Fetch the numbers" did not run: the service did not answer.', flowId: 'flow-1', steps: ['run_again', 'open_details'] });
    await settle();
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'run again', who: 'Tony' });
    await h.answer('yes');
    expect(h.did).toEqual(['run flow-1']);
    expect(h.said()).toBe('Tony is running again.');
  });

  test('a run that cannot start says why, and with everything stopped nothing is run', async () => {
    const no = world({ ...EXPIRED, steps: ['run_again'] }, { run: { ok: false, why: 'the workflow is switched off.' } });
    await settle();
    await no.answer('yes');
    expect(no.said()).toBe('Tony could not start: the workflow is switched off.');
    const stopped = world({ ...EXPIRED, steps: ['run_again'] }, { paused: true });
    await settle();
    await stopped.answer('yes');
    expect(stopped.said()).toBe('Everything is stopped. Wake me first.');
    expect(stopped.did).toEqual([]);
  });

  test('a failure with no step the notch can take is said with the agent\'s name, and asks nothing', async () => {
    for (const steps of [['open_details'], ['wait_and_run_again'], ['check_before_running_again'], [], undefined]) {
      const h = world({ ...EXPIRED, steps });
      await settle();
      expect(h.said()).toBe('Tony stopped. The step "Send the numbers" could not continue. A connection it uses has expired.');
      expect(h.line()).toMatchObject({ kind: 'say', mark: 'fail', who: 'Tony' });
    }
    // Where there is no way to the Connections, or to a run, the step is not one the notch can take.
    const noWay = world(EXPIRED, { noConnections: true });
    await settle();
    expect(noWay.line()).toMatchObject({ kind: 'say' });
    const noRun = world({ ...EXPIRED, steps: ['run_again'] }, { noRun: true });
    await settle();
    expect(noRun.line()).toMatchObject({ kind: 'say' });
    // And with a sign-in but no way to run, the Connections are opened and nothing is offered after them.
    const only = world(EXPIRED, { noRun: true });
    await settle();
    await only.answer('yes');
    await only.answer('no');
    expect(only.line()).toBeNull();
  });

  test('a run of a workflow that is no agent is said as before, in the product\'s sentence alone', async () => {
    const h = world({ ...EXPIRED, flowId: 'flow-77' });
    await settle();
    expect(h.said()).toBe('The step "Send the numbers" could not continue. A connection it uses has expired.');
    expect(h.line()).toMatchObject({ kind: 'say' });
  });

  test('Esc is a no and it does not come back; left alone it waits in the count', async () => {
    const no = world(EXPIRED);
    await settle();
    await no.answer('no');
    expect(no.line()).toBeNull();
    expect(no.count()).toBe(0);
    no.news.sync();
    await settle();
    expect(no.line()).toBeNull();
    const left = world(EXPIRED);
    await settle();
    await left.answer('fold');
    expect(left.line()).toBeNull();
    expect(left.count()).toBe(1);
  });

  test('one that was settled elsewhere while it waited offers nothing', async () => {
    const h = world(EXPIRED);
    await settle();
    await h.answer('fold');
    expect(h.count()).toBe(1);
    // Fixed in the dashboard: it is no longer open.
    h.failures.length = 0;
    h.inbox.open();
    await settle();
    expect(h.said()).not.toContain('Tony stopped');
    expect(h.did).toEqual([]);
  });

  test('what was run and whether it started is logged, never what failed', async () => {
    const h = world({ ...EXPIRED, steps: ['run_again'] });
    await settle();
    await h.answer('yes');
    expect(h.logs.some((entry) => entry.includes('run again (started)'))).toBe(true);
    for (const entry of h.logs) expect(entry).not.toContain('Send the numbers');
  });
});

