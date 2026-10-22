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
import { sanitizedEnv } from '../util/subprocess-env.ts';

const DAEMON_MODULE = join(import.meta.dir, 'index.ts');
const ROOT = mkdtempSync(join(tmpdir(), 'jarvis-exit-code-'));

afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
});

/**
 * How long the daemon import may take before the attempt is abandoned (#906).
 *
 * Measured with the daemon module on the dev machine: 1486 of 1500
 * imports at 16 at a time finished in at most 451ms (p99 409ms), 594 of 600
 * one at a time in at most 231ms. The rest -- about 1 in 100 on Bun 1.3.8 --
 * never finished at all: one Bun thread-pool worker spins in mimalloc's
 * bitmap search (mi_bbitmap_try_find_and_clear8) while the JS thread idles in
 * its event loop. That is a runtime defect, not slowness under load: 0 of
 * 1500 hung on Bun 1.4.2 (what CI runs), and a trivial import never hung.
 * 10s is over 20 times the slowest import that finished.
 */
const IMPORT_TIMEOUT_MS = 10_000;

/** A child exits with this when its import never finished, so nothing under test ran. */
const IMPORT_HUNG_EXIT = 91;

/** What the child prints when the guard fires; the retry matches on it. */
const IMPORT_HUNG_MESSAGE = '[fixture] daemon import did not finish';

/**
 * Attempts per fixture. Only an import that never finished is retried: the
 * trigger, and so every handler this file asserts on, runs only after it.
 * So a green run here says nothing about import health: an import that hangs
 * now and then for a reason of our own would only show as the warning below.
 */
const IMPORT_ATTEMPTS = 3;

type FixtureOptions = { module?: string; importTimeoutMs?: number };

/**
 * Run a child that imports the daemon (handlers only), then does `trigger`.
 * The safety exit is a code no assertion expects, so a fixture that neither
 * crashes nor shuts down fails loudly instead of hanging the suite.
 *
 * The import guard is armed BEFORE the import (#906). It used to be armed
 * after it, so an import that never finished had nothing bounding it and the
 * test sat until bun's own 90s timeout, with no word on where it was stuck.
 */
async function runFixture(name: string, trigger: string, opts: FixtureOptions = {}): Promise<{ exitCode: number | null; output: string; attempts: number }> {
  const module = opts.module ?? DAEMON_MODULE;
  const importTimeoutMs = opts.importTimeoutMs ?? IMPORT_TIMEOUT_MS;
  const home = join(ROOT, name);
  const fixture = join(ROOT, `${name}.ts`);
  writeFileSync(fixture, `
process.env.JARVIS_HOME = ${JSON.stringify(home)};
const importStarted = performance.now();
const importGuard = setTimeout(() => {
  console.error(${JSON.stringify(IMPORT_HUNG_MESSAGE)} + ' within ${importTimeoutMs}ms');
  process.exit(${IMPORT_HUNG_EXIT});
}, ${importTimeoutMs});
await import(${JSON.stringify(module)});
clearTimeout(importGuard);
console.error('[fixture] daemon imported in ' + Math.round(performance.now() - importStarted) + 'ms');
const safety = setTimeout(() => { console.error('[fixture] nothing exited'); process.exit(90); }, 60_000);
${trigger}
`, 'utf-8');

  const outputs: string[] = [];
  for (let attempt = 1; attempt <= IMPORT_ATTEMPTS; attempt++) {
    const proc = Bun.spawn([process.execPath, fixture], {
      stdout: 'pipe',
      stderr: 'pipe',
      // The allowlisted environment, not the parent's: the pre-commit hook leaks
      // GIT_* into tests, and nothing here needs a credential. JARVIS_HOME is
      // not an allowlisted extra, so it is added on top (the fixture also sets
      // it itself before the import).
      env: { ...sanitizedEnv(), JARVIS_HOME: home },
    });
    try {
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const exitCode = await proc.exited;
      const output = `${out}\n${err}`;
      outputs.push(output);
      if (exitCode !== IMPORT_HUNG_EXIT || !output.includes(IMPORT_HUNG_MESSAGE)) {
        return { exitCode, output, attempts: attempt };
      }
      console.warn(`[exit-code.test] ${name}: attempt ${attempt} never finished importing the daemon; nothing under test ran${attempt < IMPORT_ATTEMPTS ? ', retrying' : ''}`);
    } finally {
      // Belt and braces for a read that throws. A test killed by bun's own
      // timeout does not unwind this, so the fixture's own guards above are
      // what actually bound a runaway child.
      proc.kill();
    }
  }
  throw new Error(`${name}: the daemon import did not finish within ${importTimeoutMs}ms on any of ${IMPORT_ATTEMPTS} attempts, so the handlers were never exercised\n${outputs.join('\n----\n')}`);
}

describe('the fixture itself (#906)', () => {
  // A stand-in for the daemon module whose import never finishes the first
  // time it is loaded, the way the 1-in-100 Bun hang looks from the JS thread:
  // idle in the event loop, the module promise never settling.
  const hangsOnce = (label: string) => {
    const marker = join(ROOT, `${label}.marker`);
    const stub = join(ROOT, `${label}.stub.ts`);
    rmSync(marker, { force: true });
    writeFileSync(stub, `
import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, '');
  await new Promise(() => {});
}
process.on('SIGTERM', () => { console.log('stub handled SIGTERM'); process.exit(0); });
`, 'utf-8');
    return stub;
  };

  test('an import that never finishes is bounded, reported, and retried', async () => {
    const { exitCode, output, attempts } = await runFixture('import-hangs-once', `
process.kill(process.pid, 'SIGTERM');
`, { module: hangsOnce('import-hangs-once'), importTimeoutMs: 1_000 });
    expect(attempts).toBe(2);
    expect(exitCode).toBe(0);
    expect(output).toContain('stub handled SIGTERM');
  }, 30_000);

  test('an import that never finishes on any attempt fails with that reason, not a test timeout', async () => {
    const stub = join(ROOT, 'import-always-hangs.stub.ts');
    writeFileSync(stub, 'await new Promise(() => {});\n', 'utf-8');
    const started = performance.now();
    const failure = await runFixture('import-always-hangs', '', { module: stub, importTimeoutMs: 1_000 }).then(() => null, (e: unknown) => e);
    expect(String(failure)).toContain('did not finish within 1000ms on any of 3 attempts');
    expect(String(failure)).toContain('[fixture] daemon import did not finish within 1000ms');
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 30_000);

  test('a fixture whose trigger exits 91 by itself is not retried', async () => {
    const stub = join(ROOT, 'exits-91.stub.ts');
    writeFileSync(stub, 'export {};\n', 'utf-8');
    const { exitCode, attempts } = await runFixture('exits-91', 'process.exit(91);', { module: stub, importTimeoutMs: 1_000 });
    expect(exitCode).toBe(91);
    expect(attempts).toBe(1);
  }, 30_000);
});

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
