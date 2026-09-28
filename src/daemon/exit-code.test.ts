/**
 * #543: the status the daemon leaves behind is the only thing a supervisor
 * sees. The generated systemd unit uses `Restart=on-failure`
 * (src/cli/autostart.ts), so a crash that exited 0 left Jarvis down until
 * someone restarted it by hand.
 *
 * These run the REAL handlers registered at the top level of
 * src/daemon/index.ts, in a child process: importing that module registers
 * them without booting anything (its `import.meta.main` guard), and a
 * handler that ends in `process.exit()` cannot be exercised in-process.
 * JARVIS_HOME points at a temp dir so no child can reach the developer's
 * ~/.jarvis lock, log or database.
 */
import { test, expect, describe, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

const DAEMON_MODULE = join(import.meta.dir, 'index.ts');
const ROOT = mkdtempSync(join(tmpdir(), 'jarvis-exit-code-'));

afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
});

/**
 * Run a child that imports the daemon (handlers only), then does `trigger`.
 * The safety exit is a code no assertion expects, so a fixture that neither
 * crashes nor shuts down fails loudly instead of hanging the suite.
 */
async function runFixture(name: string, trigger: string): Promise<{ exitCode: number | null; output: string }> {
  const home = join(ROOT, name);
  const fixture = join(ROOT, `${name}.ts`);
  writeFileSync(fixture, `
process.env.JARVIS_HOME = ${JSON.stringify(home)};
await import(${JSON.stringify(DAEMON_MODULE)});
const safety = setTimeout(() => { console.error('[fixture] nothing exited'); process.exit(90); }, 60_000);
${trigger}
`, 'utf-8');

  const proc = Bun.spawn([process.execPath, fixture], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, JARVIS_HOME: home },
  });
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: await proc.exited, output: `${out}\n${err}` };
  } finally {
    // Belt and braces for a read that throws. A test killed by bun's own
    // timeout does not unwind this, so the fixture's 60s safety exit above is
    // what actually bounds a runaway child.
    proc.kill();
  }
}

describe('daemon exit status', () => {
  test('an uncaught exception exits non-zero', async () => {
    const { exitCode, output } = await runFixture('uncaught', `
setTimeout(() => { throw new Error('fixture uncaught boom'); }, 10);
`);
    // Non-zero is what Restart=on-failure needs; 3 is the engine's code for
    // this reason (engine/src/main.ts), asserted so the two stay in step.
    expect(exitCode).toBe(3);
    expect(output).toContain('Uncaught exception');
  }, 90_000);

  test('an unhandled rejection exits non-zero', async () => {
    const { exitCode, output } = await runFixture('rejection', `
Promise.reject(new Error('fixture rejected'));
`);
    expect(exitCode).toBe(4);
    expect(output).toContain('Unhandled rejection');
  }, 90_000);

  test('SIGTERM still exits 0', async () => {
    // `jarvis stop` and `jarvis drain` signal the daemon directly and report
    // success on a clean exit, and the systemd unit deliberately leaves a
    // cleanly stopped daemon stopped. Neither may see a failure status.
    const { exitCode, output } = await runFixture('sigterm', `
process.kill(process.pid, 'SIGTERM');
`);
    expect(exitCode).toBe(0);
    expect(output).toContain('Received SIGTERM');
    expect(output).toContain('Shutdown complete');
  }, 90_000);

  test('SIGINT still exits 0', async () => {
    const { exitCode } = await runFixture('sigint', `
process.kill(process.pid, 'SIGINT');
`);
    expect(exitCode).toBe(0);
  }, 90_000);

  test('an ignored browser rejection does not exit at all', async () => {
    // The unhandledRejection handler drops browser/CDP timeouts on purpose.
    // Those must not become a non-zero exit either: the daemon keeps running.
    const { exitCode, output } = await runFixture('browser-timeout', `
Promise.reject(new Error('Timeout waiting for selector #nope'));
setTimeout(() => { clearTimeout(safety); console.log('[fixture] still running'); process.exit(7); }, 2_000);
`);
    expect(exitCode).toBe(7);
    expect(output).toContain('Non-fatal browser error');
    expect(output).toContain('still running');
  }, 90_000);

  // The two invariants a refactor would break silently, leaving #543 fixed only
  // on paper: the drain must not be able to hang instead of exiting, and a crash
  // on the way out of a shutdown we asked for must still exit 0. Both wedge the
  // drain by replacing the process-wide ActiveTurns singleton's drain(), which
  // the daemon module holds the same instance of.
  const ACTIVE_TURNS = JSON.stringify(join(import.meta.dir, 'active-turns.ts'));

  test('a drain that hangs still exits non-zero, bounded', async () => {
    const { exitCode, output } = await runFixture('hanging-drain', `
const { activeTurns } = await import(${ACTIVE_TURNS});
activeTurns.drain = () => new Promise(() => {});
setTimeout(() => { throw new Error('fixture uncaught boom'); }, 10);
`);
    // Not 90 (the fixture's own safety exit) and not 0: the watchdog armed
    // before the drain forced the exit. It must not be unref'd either, or an
    // empty loop would exit 0 out from under it.
    expect(exitCode).toBe(3);
    expect(output).toContain('shutdown did not finish within');
  }, 90_000);

  test('a second signal force-quits with 0, so systemd leaves it stopped', async () => {
    // `jarvis drain` can legitimately take 85s; a `jarvis stop` during it sends
    // the second SIGTERM. A failure status here would have Restart=on-failure
    // bring JARVIS back five seconds after the CLI reported it stopped.
    const { exitCode, output } = await runFixture('second-signal', `
const { activeTurns } = await import(${ACTIVE_TURNS});
activeTurns.drain = async () => { await Bun.sleep(5_000); return { drained: true, remaining: 0 }; };
process.kill(process.pid, 'SIGTERM');
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300);
`);
    expect(exitCode).toBe(0);
    expect(output).toContain('Second signal');
  }, 90_000);

  test('a teardown that throws on SIGTERM still exits 0', async () => {
    // Same reason: the user asked for the stop, and it is going down. The error
    // is logged; it must not read as a crash to the supervisor.
    const { exitCode, output } = await runFixture('teardown-throws', `
const { activeTurns } = await import(${ACTIVE_TURNS});
activeTurns.drain = () => { throw new Error('fixture teardown boom'); };
process.kill(process.pid, 'SIGTERM');
`);
    expect(exitCode).toBe(0);
    expect(output).toContain('Error during shutdown');
  }, 90_000);

  test('a teardown that throws on a crash still exits non-zero', async () => {
    const { exitCode } = await runFixture('teardown-throws-fatal', `
const { activeTurns } = await import(${ACTIVE_TURNS});
activeTurns.drain = () => { throw new Error('fixture teardown boom'); };
setTimeout(() => { throw new Error('fixture uncaught boom'); }, 10);
`);
    expect(exitCode).toBe(3);
  }, 90_000);

  test('a crash during a deliberate drain still exits 0', async () => {
    // A stray rejection from a still-streaming turn must not turn `jarvis stop`
    // into a failure, and must not abort the drain either.
    const { exitCode, output } = await runFixture('crash-during-drain', `
const { activeTurns } = await import(${ACTIVE_TURNS});
activeTurns.drain = async () => { await Bun.sleep(3_000); return { drained: true, remaining: 0 }; };
process.kill(process.pid, 'SIGTERM');
setTimeout(() => { throw new Error('fixture boom mid-drain'); }, 300);
`);
    expect(exitCode).toBe(0);
    expect(output).toContain('during drain (ignored; drain continues)');
    expect(output).toContain('Shutdown complete');
  }, 90_000);
});
