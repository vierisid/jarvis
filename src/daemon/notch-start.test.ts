/**
 * The notch is optional (./notch-start.ts): a part of it that cannot be made
 * does not end the brain's start, the dashboard is told once, and the brain
 * stops the notch on its way down.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizedEnv } from '../util/subprocess-env.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { listUnreadDashboardNotifications, markDashboardNotificationRead } from '../vault/dashboard-notifications.ts';
import { NOTCH_FAILED_NOTICE, holdNotch, notchDashboardNotice, startNotchPart, stopNotch } from './notch-start.ts';

describe('a part of the notch that cannot be made', () => {
  test('ends there: null comes back, the log says why, what was set is put back, and the dashboard is told', () => {
    const logs: string[] = [];
    const told: string[] = [];
    let undone = 0;
    const made = startNotchPart('the notch', (): { stop(): void } => { throw new Error('no such table: notch_settings'); }, {
      say: NOTCH_FAILED_NOTICE, undo: () => { undone++; }, notice: (message) => told.push(message), log: (line) => logs.push(line),
    });
    expect(made).toBeNull();
    expect(logs).toEqual(['[notch] the notch could not be started, and the brain goes on without it: no such table: notch_settings']);
    expect(undone).toBe(1);
    expect(told).toEqual([NOTCH_FAILED_NOTICE]);
  });

  test('a part that is made is handed back, and nothing is said or put back', () => {
    const told: string[] = [];
    let undone = 0;
    const part = { stop() {} };
    expect(startNotchPart('the notch', () => part, { say: NOTCH_FAILED_NOTICE, undo: () => { undone++; }, notice: (message) => told.push(message), log: () => {} })).toBe(part);
    expect([told, undone]).toEqual([[], 0]);
  });

  test('putting back or telling that fails itself is logged and goes no further', () => {
    const logs: string[] = [];
    const made = startNotchPart('the notch', (): number => { throw new Error('first'); }, {
      say: NOTCH_FAILED_NOTICE, undo: () => { throw new Error('second'); }, notice: () => { throw new Error('third'); }, log: (line) => logs.push(line),
    });
    expect(made).toBeNull();
    expect(logs.map((line) => line.split(': ').pop())).toEqual(['first', 'second', 'third']);
  });
});

describe('the notice on the dashboard', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:', { quiet: true }); });
  afterEach(() => closeDb());

  test('is kept for the dashboard that opens next, with a title of its own, and shown at once in one that is open', () => {
    const live: { message: string; id: string }[] = [];
    notchDashboardNotice(NOTCH_FAILED_NOTICE, (message, id) => live.push({ message, id }));
    const unread = listUnreadDashboardNotifications();
    expect(unread.map((row) => [row.message, row.priority])).toEqual([[NOTCH_FAILED_NOTICE, 'normal']]);
    expect(live).toEqual([{ message: NOTCH_FAILED_NOTICE, id: unread[0]!.id }]);
    // The dashboard takes a leading bold line that ends the line as the title (ui/src/hooks/useWebSocket.ts, proactiveNotice).
    expect(/^\*\*(.+?)\*\*:?[ \t]*(?:\r?\n|$)/.exec(NOTCH_FAILED_NOTICE)?.[1]).toBe('The notch did not start');
  });

  test('is said once while it is unread, however often the brain is started, and again once it was read', () => {
    const live: string[] = [];
    for (let start = 0; start < 3; start++) startNotchPart('the notch', (): number => { throw new Error('still broken'); }, {
      say: NOTCH_FAILED_NOTICE, notice: (message) => notchDashboardNotice(message, (_text, id) => live.push(id)), log: () => {},
    });
    const [only, ...more] = listUnreadDashboardNotifications();
    expect(more).toEqual([]);
    expect(live).toEqual([only!.id]);
    markDashboardNotificationRead(only!.id);
    notchDashboardNotice(NOTCH_FAILED_NOTICE);
    expect(listUnreadDashboardNotifications()).toHaveLength(1);
  });
});

describe('the notch on the brain\'s way down', () => {
  afterEach(() => holdNotch(null));

  test('the one that runs is stopped once, and a stop that throws goes no further', () => {
    let stops = 0;
    holdNotch({ stop() { stops++; } });
    stopNotch();
    stopNotch();
    expect(stops).toBe(1);
    const logs: string[] = [];
    holdNotch({ stop() { throw new Error('a part is stuck'); } });
    expect(() => stopNotch((line) => logs.push(line))).not.toThrow();
    expect(logs).toEqual(['[notch] the notch did not stop cleanly: a part is stuck']);
    // With none running there is nothing to do.
    expect(() => stopNotch()).not.toThrow();
  });

  const ROOT = mkdtempSync(join(tmpdir(), 'jarvis-notch-start-'));
  afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* left for the system to clear */ } });

  // The real handler of src/daemon/index.ts, in a process of its own, as ./exit-code.test.ts runs it: importing
  // the module registers the handlers and starts nothing, and a handler that ends in process.exit() cannot be
  // run in this one. An import that never ends (Bun 1.3.8, about 1 in 100) is given up on and tried again.
  test('SIGTERM stops the notch before the turns are waited for, and the brain still leaves with 0', async () => {
    const home = join(ROOT, 'home');
    const fixture = join(ROOT, 'sigterm.ts');
    writeFileSync(fixture, `
process.env.JARVIS_HOME = ${JSON.stringify(home)};
const guard = setTimeout(() => { console.error('[fixture] import hung'); process.exit(91); }, 10_000);
await import(${JSON.stringify(join(import.meta.dir, 'index.ts'))});
const { holdNotch } = await import(${JSON.stringify(join(import.meta.dir, 'notch-start.ts'))});
clearTimeout(guard);
setTimeout(() => { console.error('[fixture] nothing exited'); process.exit(90); }, 60_000);
holdNotch({ stop() { console.log('[fixture] the notch was stopped'); } });
process.kill(process.pid, 'SIGTERM');
`, 'utf-8');
    let exitCode: number | null = null;
    let output = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const proc = Bun.spawn([process.execPath, fixture], { stdout: 'pipe', stderr: 'pipe', env: { ...sanitizedEnv(), JARVIS_HOME: home } });
      try {
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        exitCode = await proc.exited;
        output = `${out}\n${err}`;
      } finally {
        proc.kill();
      }
      if (exitCode !== 91) break;
    }
    expect(output).toContain('[fixture] the notch was stopped');
    expect(output).toContain('Received SIGTERM');
    expect(output.indexOf('[fixture] the notch was stopped')).toBeLessThan(output.indexOf('Received SIGTERM'));
    expect(exitCode).toBe(0);
  }, 90_000);
});

describe('where the daemon makes the notch', () => {
  const source = readFileSync(join(import.meta.dir, 'index.ts'), 'utf-8');

  test('both places are made as parts that may fail, and the one that runs is held for the way down', () => {
    // The surface, and the real things on it: each made once, and only inside startNotchPart.
    expect(source.split('new NotchSurface(').length - 1).toBe(1);
    expect(source).toContain("notchSurface = startNotchPart('the notch', () => {\n        const surface = new NotchSurface(sidecarManager);");
    expect(source.split('attachNotchReal(').length - 1).toBe(1);
    expect(source).toContain("notchReal = startNotchPart('the notch', () => attachNotchReal(notchPage, {");
    expect(source).toContain('holdNotch(notchReal);');
    // And the way down stops it before it waits for anything.
    const down = source.slice(source.indexOf('async function handleShutdown('));
    expect(down.indexOf('stopNotch();')).toBeGreaterThan(0);
    expect(down.indexOf('stopNotch();')).toBeLessThan(down.indexOf('await '));
  });
});
