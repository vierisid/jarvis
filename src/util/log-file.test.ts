import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLogFileSink } from './log-file.ts';

let DIR: string;
let LOG: string;
let uninstall: (() => void) | null = null;

beforeEach(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'jarvis-test-logfile-'));
  LOG = join(DIR, 'logs', 'jarvis.log');
});

afterEach(async () => {
  // Restore the process' writes before anything else, or a failed assertion
  // would leave every later test in the file writing through a dead sink.
  uninstall?.();
  uninstall = null;
  await rm(DIR, { recursive: true, force: true });
});

function read(): string {
  return readFileSync(LOG, 'utf8');
}

describe('installLogFileSink', () => {
  test('writes console output as timestamped lines and creates the parent dir', () => {
    uninstall = installLogFileSink({ path: LOG });
    console.log('hello from the daemon');
    console.error('and from stderr');
    uninstall();
    uninstall = null;

    const lines = read().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z hello from the daemon$/);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z and from stderr$/);
  });

  test('strips ANSI escapes (src/cli/helpers.ts colours unconditionally)', () => {
    uninstall = installLogFileSink({ path: LOG });
    process.stdout.write('\x1b[36mJ.A.R.V.I.S.\x1b[0m \x1b[2mv0.13.0\x1b[0m\n');
    uninstall();
    uninstall = null;

    const body = read();
    expect(body).toContain('J.A.R.V.I.S. v0.13.0');
    expect(body).not.toContain('\x1b');
    expect(body).not.toContain('[36m');
  });

  test('redacts credential-shaped material before it reaches disk', () => {
    uninstall = installLogFileSink({ path: LOG });
    console.error('proxy rejected sk-uj-AAAAAAAAAAAAAAAAAAAAAAAA');
    console.error('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
    uninstall();
    uninstall = null;

    const body = read();
    expect(body).not.toContain('sk-uj-AAAA');
    expect(body).not.toContain('abcdefghijklmnop');
    expect(body).toContain('***redacted***');
  });

  test("captures console.* even though bun's console bypasses process.stdout.write", () => {
    // Regression guard for the whole feature: on bun 1.3.8 console.log writes
    // straight to fd 1, so a stream-only patch records none of jarvis's ~1150
    // console.* call sites. If this ever passes with the console wrapper
    // removed, the runtime changed and the wrapper can go.
    const seenByStream: string[] = [];
    const realWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string') seenByStream.push(chunk);
      return (realWrite as (...a: unknown[]) => boolean).apply(process.stdout, [chunk, ...rest]);
    }) as typeof process.stdout.write;

    try {
      uninstall = installLogFileSink({ path: LOG });
      console.log('tier %s picked in %dms', 'medium', 12);
      console.log('an object:', { id: 7 });
      uninstall();
      uninstall = null;
    } finally {
      process.stdout.write = realWrite;
    }

    const body = read();
    expect(body).toContain('tier medium picked in 12ms');
    expect(body).toContain('an object: { id: 7 }');
    // Exactly once, not once per capture path.
    expect(body.split('\n').filter((l) => l.includes('tier medium'))).toHaveLength(1);
  });

  test('reassembles a line split across writes, and flushes the tail on uninstall', () => {
    uninstall = installLogFileSink({ path: LOG });
    process.stdout.write('one ');
    process.stdout.write('line ');
    process.stdout.write('in three writes\n');
    // No terminator: this must survive as a whole line, not be lost.
    process.stdout.write('unterminated tail');
    uninstall();
    uninstall = null;

    const lines = read().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEndWith('one line in three writes');
    expect(lines[1]).toEndWith('unterminated tail');
  });

  test('stdout and stderr partial lines do not splice into each other', () => {
    uninstall = installLogFileSink({ path: LOG });
    process.stdout.write('OUT-head ');
    process.stderr.write('ERR-whole\n');
    process.stdout.write('OUT-tail\n');
    uninstall();
    uninstall = null;

    const lines = read().trimEnd().split('\n');
    expect(lines[0]).toEndWith('ERR-whole');
    expect(lines[1]).toEndWith('OUT-head OUT-tail');
  });

  test('the cap holds under a multi-MB burst, dropping the oldest lines first', () => {
    const total = 20_000;
    const maxBytes = 64 * 1024;
    // Swallow the burst on the way to the terminal: the sink captures whatever
    // write it finds installed, and 4 MB of filler in the test output helps
    // nobody.
    const realWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      uninstall = installLogFileSink({ path: LOG, maxBytes });

      // ~4 MB of output through a 64 KiB window: ~64 compactions.
      const filler = 'x'.repeat(200);
      for (let i = 0; i < total; i++) process.stdout.write(`line ${i} ${filler}\n`);

      uninstall();
      uninstall = null;
    } finally {
      process.stdout.write = realWrite;
    }

    const size = statSync(LOG).size;
    expect(size).toBeLessThanOrEqual(maxBytes * 1.25);
    // Sanity floor: the window should be nearly full, not a handful of lines.
    expect(size).toBeGreaterThan(maxBytes / 2);

    const body = read();
    // The newest line is always present; the oldest are long gone.
    expect(body).toContain(`line ${total - 1} `);
    expect(body).not.toContain('line 0 ');
    expect(body).not.toContain('line 100 ');
    // And the file still starts on a line boundary: the ring only ever holds
    // whole lines, so a rewrite can never begin mid-line.
    expect(body.split('\n')[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z line \d+ x+$/);
  });

  test('the original write still receives everything, unmodified', () => {
    const captured: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string') captured.push(chunk);
      return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    const spy = process.stdout.write;

    try {
      uninstall = installLogFileSink({ path: LOG });
      process.stdout.write('\x1b[31msk-uj-AAAAAAAAAAAAAAAAAAAAAAAA\x1b[0m\n');
      uninstall();
      uninstall = null;
    } finally {
      // installLogFileSink restored the spy; drop it too.
      expect(process.stdout.write).toBe(spy);
      process.stdout.write = realWrite;
    }

    // Terminal / journal output is untouched: escapes intact, no redaction,
    // no timestamp. Only the FILE is sanitised.
    expect(captured.join('')).toBe('\x1b[31msk-uj-AAAAAAAAAAAAAAAAAAAAAAAA\x1b[0m\n');
    expect(read()).toContain('***redacted***');
  });

  test('uninstall restores the exact write functions it replaced', () => {
    const beforeOut = process.stdout.write;
    const beforeErr = process.stderr.write;
    const stop = installLogFileSink({ path: LOG });
    expect(process.stdout.write).not.toBe(beforeOut);
    expect(process.stderr.write).not.toBe(beforeErr);
    stop();
    expect(process.stdout.write).toBe(beforeOut);
    expect(process.stderr.write).toBe(beforeErr);
  });

  test('installing twice leaves exactly one sink (no double-written lines)', () => {
    const before = process.stdout.write;
    const beforeLog = console.log;
    const first = installLogFileSink({ path: LOG });
    uninstall = installLogFileSink({ path: LOG });
    console.log('only once please');
    uninstall();
    uninstall = null;
    first(); // idempotent: the second install already uninstalled this one

    expect(process.stdout.write).toBe(before);
    expect(console.log).toBe(beforeLog);
    const hits = read().split('\n').filter((l) => l.includes('only once please'));
    expect(hits).toHaveLength(1);
  });

  test('an unopenable path degrades to no sink instead of throwing', async () => {
    const blocker = join(DIR, 'not-a-dir');
    await writeFile(blocker, 'i am a regular file');
    const bad = join(blocker, 'nested', 'jarvis.log');

    const errs: string[] = [];
    const realErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      if (typeof chunk === 'string') errs.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    const spyErr = process.stderr.write;

    // A holder rather than a `let`: TS narrows a plain local to `null` when the
    // only assignment happens inside a callback.
    const stop: { fn: (() => void) | null } = { fn: null };
    try {
      expect(() => {
        stop.fn = installLogFileSink({ path: bad });
      }).not.toThrow();
      // Bailed out before patching anything, so the daemon keeps logging
      // exactly as it did before.
      expect(process.stderr.write).toBe(spyErr);
      console.log('still alive');
    } finally {
      stop.fn?.();
      process.stderr.write = realErr;
    }

    expect(errs.join('')).toContain('[LogFile]');
    expect(errs.join('')).toContain('continuing without a log file');
  });
});
