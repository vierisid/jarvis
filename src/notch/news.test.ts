import { describe, expect, test } from 'bun:test';
import { NotchInbox } from './inbox.ts';
import { attachNotchNews } from './news.ts';
import type { NotchOpenFailure } from './news.ts';
import type { NotchLine, NotchToPage } from './protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness(open: NotchOpenFailure[] | (() => NotchOpenFailure[]) = []) {
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
  const news = attachNotchNews(inbox, { openFailures: () => (failures ?? (open as () => NotchOpenFailure[])()), log: (line) => logs.push(line) });
  const line = (): NotchLine | null => surface.current().line;
  return {
    news, inbox, logs, failures: failures!, line,
    said: (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join(''),
    count: (): number => surface.current().count,
    async done(): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act: 'done' }); await settle(); },
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
  });

  test('one that fails says so', async () => {
    const h = harness();
    h.news.taskEnded('fail', { id: 't2', agentName: '', task: 'Book the flight' });
    await settle();
    expect(h.said()).toBe('An agent could not finish: Book the flight');
    expect(h.line()).toMatchObject({ mark: 'fail' });
  });
});
