import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installLogFileSink, logFileIsProcessStdio } from './log-file.ts';

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
  try {
    // A test that chmod'ed the log dir read-only to force a failure would
    // otherwise make the cleanup fail too.
    chmodSync(dirname(LOG), 0o755);
  } catch {
    // Directory may not exist. Nothing to relax.
  }
  await rm(DIR, { recursive: true, force: true });
});

function read(): string {
  return readFileSync(LOG, 'utf8');
}

/** Lines of the log file that carry `needle`, timestamp prefix stripped. */
function linesWith(needle: string): string[] {
  return read()
    .split('\n')
    .filter((l) => l.includes(needle));
}

/**
 * Run `fn` with stderr captured, returning what the sink wrote to it. The
 * sink's warnings go to the ORIGINAL stderr write on purpose (console.warn
 * would recurse through the patched stream), so a plain spy sees them.
 */
function withCapturedStderr(fn: () => void): string {
  const errs: string[] = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    if (typeof chunk === 'string') errs.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = realErr;
  }
  return errs.join('');
}

/** Swallow stdout while a burst runs: 4 MB of filler in the test log helps nobody. */
function quietStdout<T>(fn: () => T): T {
  const realWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return fn();
  } finally {
    process.stdout.write = realWrite;
  }
}

describe('installLogFileSink', () => {
  test('writes console output as timestamped lines and creates the parent dir', () => {
    uninstall = installLogFileSink({ path: LOG });
    console.log('hello from the daemon');
    console.error('and from stderr');
    uninstall();
    uninstall = null;

    // Match the lines we wrote rather than counting every line in the file:
    // bun's own reporter can write to stdout mid-test, and an exact count made
    // this fail for reasons that had nothing to do with the sink.
    const out = linesWith('hello from the daemon');
    const err = linesWith('and from stderr');
    expect(out).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect(out[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z hello from the daemon$/);
    expect(err[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z and from stderr$/);
  });

  test('strips ANSI escapes (src/cli/helpers.ts colours unconditionally)', () => {
    uninstall = installLogFileSink({ path: LOG });
    process.stdout.write('\x1b[36mJ.A.R.V.I.S.\x1b[0m \x1b[2mv0.13.0\x1b[0m\n');
    // OSC (a terminal title / hyperlink), an 8-bit CSI and a charset
    // designation: the tightened, ReDoS-proof pattern has to keep covering
    // every shape the loose ansi-regex one did.
    process.stdout.write('\x1b]0;jarvis\x07\x9b1mbold\x9b0m \x1b(Bplain\n');
    uninstall();
    uninstall = null;

    const body = read();
    expect(body).toContain('J.A.R.V.I.S. v0.13.0');
    expect(body).toContain('bold plain');
    expect(body).not.toContain('\x1b');
    expect(body).not.toContain('\x9b');
    expect(body).not.toContain('[36m');
  });

  test('a pathological escape run does not stall the sink (CVE-2021-3807 shape)', () => {
    // The ansi-regex pattern this replaced took 200-400ms on ONE line of
    // `ESC` + 10-20k semicolons, and log lines carry text jarvis echoes back.
    const elapsed = quietStdout(() => {
      uninstall = installLogFileSink({ path: LOG });
      const started = performance.now();
      for (let i = 0; i < 20; i++) process.stdout.write(`\x1b${';'.repeat(20_000)} evil\n`);
      const took = performance.now() - started;
      uninstall!();
      uninstall = null;
      return took;
    });

    expect(linesWith('evil')).toHaveLength(20);
    // Generous by 20x against the ~4s the old pattern needed for 20 lines.
    expect(elapsed).toBeLessThan(2000);
  });

  test('redacts credential-shaped material before it reaches disk', () => {
    uninstall = installLogFileSink({ path: LOG });
    console.error('proxy rejected sk-uj-AAAAAAAAAAAAAAAAAAAAAAAA');
    console.error('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
    // The shapes a log file specifically exposes: every telegram.ts request
    // URL carries a bot token, and an operator gets handed this file.
    console.error('GET https://api.telegram.org/bot7123456789:AAHfK3n2xYz-QwErTyUiOpAsDfGhJkLzXcV/getMe');
    console.error('gh auth ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AB');
    console.error('callback ?token=Zk9vQmFyQmF6UXV4MTIzNDU2Nzg5MA&state=x');
    uninstall();
    uninstall = null;

    const body = read();
    expect(body).not.toContain('sk-uj-AAAA');
    expect(body).not.toContain('abcdefghijklmnop');
    expect(body).not.toContain('AAHfK3n2xYz');
    expect(body).not.toContain('ghp_AbCdEfGh');
    expect(body).not.toContain('Zk9vQmFyQmF6');
    expect(body).toContain('***redacted***');
  });

  test("captures console.* even though bun's console bypasses process.stdout.write", () => {
    // Regression guard for the whole feature: on bun 1.3.8 console.log writes
    // straight to fd 1, so a stream-only patch records none of jarvis's ~1150
    // console.* call sites. The stacked spy below is what installLogFileSink
    // captures as its "original" write, so anything console.* routed through
    // the stream would land in `seenByStream`.
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
      process.stdout.write('RAW-OUT\n');
      uninstall();
      uninstall = null;
    } finally {
      process.stdout.write = realWrite;
    }

    const body = read();
    expect(body).toContain('tier medium picked in 12ms');
    expect(body).toContain('an object: { id: 7 }');
    // Exactly once, not once per capture path.
    expect(linesWith('tier medium')).toHaveLength(1);

    // The claim this test is named for: an explicit stream write IS seen by a
    // stacked stream patch, and console.log is NOT. If the second assertion
    // ever fails, bun started routing console through the stream and the
    // console wrapper in log-file.ts can go.
    expect(seenByStream.join('')).toContain('RAW-OUT');
    expect(seenByStream.join('')).not.toContain('tier medium');
  });

  test('console.trace is captured (its native stack frames are not)', () => {
    // console.trace goes to stderr and is in CONSOLE_METHODS, so the message
    // lands. Bun renders the stack itself, below the formatted args, so the
    // frames never reach `format(...)` and are terminal-only. Documented
    // rather than fixed: the message is what makes the line searchable.
    uninstall = installLogFileSink({ path: LOG });
    console.trace('drain took the slow path');
    uninstall();
    uninstall = null;

    expect(linesWith('drain took the slow path')).toHaveLength(1);
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

    expect(linesWith('one line in three writes')).toHaveLength(1);
    expect(linesWith('unterminated tail')).toHaveLength(1);
  });

  test('decodes Uint8Array writes, including a multi-byte char split across two', () => {
    // The Buffer path had no coverage at all. A chunked write can cut a UTF-8
    // sequence in half, and decoding each chunk on its own would put a U+FFFD
    // where the accented letter was - StringDecoder holds the tail back.
    uninstall = installLogFileSink({ path: LOG });
    const bytes = Buffer.from('caffè latte\n', 'utf8');
    process.stdout.write(bytes.subarray(0, 5));
    process.stdout.write(bytes.subarray(5));
    // A typed array that is a view into a larger buffer must not drag its
    // neighbours in: the sink slices by byteOffset/byteLength.
    const backing = Buffer.from('XXXsecond line\nYYY', 'utf8');
    process.stdout.write(new Uint8Array(backing.buffer, backing.byteOffset + 3, 12));
    uninstall();
    uninstall = null;

    const body = read();
    expect(body).toContain('caffè latte');
    expect(body).not.toContain('�');
    expect(linesWith('second line')).toHaveLength(1);
    expect(body).not.toContain('XXX');
    expect(body).not.toContain('YYY');
  });

  test('\\r\\n ends one line, and a bare \\r flushes instead of buffering forever', () => {
    // A progress renderer redraws with `\r` and may never emit `\n`. Holding
    // those grew `pending` without bound: 20k frames made one 649 KB string,
    // +52 MB of heap and seconds of rescanning, with nothing on disk.
    uninstall = installLogFileSink({ path: LOG });
    process.stdout.write('crlf line\r\nnext line\n');
    process.stdout.write('\rframe 1\rframe 2\rframe 3\n');
    const whileSpinning = statSync(LOG).size;
    uninstall();
    uninstall = null;

    expect(linesWith('crlf line')).toHaveLength(1);
    expect(read()).not.toContain('\r');
    expect(linesWith('next line')).toHaveLength(1);
    expect(linesWith('frame 1')).toHaveLength(1);
    expect(linesWith('frame 2')).toHaveLength(1);
    expect(linesWith('frame 3')).toHaveLength(1);
    // The bare `\r` before "frame 1" is a redraw of an empty frame, not a
    // blank line the process logged.
    expect(read().split('\n').filter((l) => /Z $/.test(l))).toHaveLength(0);
    expect(whileSpinning).toBeGreaterThan(0);
  });

  test('a terminator-free stream is flushed at the pending cap, not buffered forever', () => {
    const beforeUninstall = quietStdout(() => {
      uninstall = installLogFileSink({ path: LOG });
      // 96 KiB with no newline anywhere: past the 64 KiB pending budget.
      for (let i = 0; i < 96; i++) process.stdout.write('z'.repeat(1024));
      const size = statSync(LOG).size;
      uninstall!();
      uninstall = null;
      return size;
    });

    // Flushed while the stream was still running, not only at uninstall.
    expect(beforeUninstall).toBeGreaterThan(0);
    expect(read()).toContain('zzzz');
  });

  test('stdout and stderr partial lines do not splice into each other', () => {
    uninstall = installLogFileSink({ path: LOG });
    process.stdout.write('OUT-head ');
    process.stderr.write('ERR-whole\n');
    process.stdout.write('OUT-tail\n');
    uninstall();
    uninstall = null;

    expect(linesWith('ERR-whole')).toHaveLength(1);
    expect(linesWith('OUT-head OUT-tail')).toHaveLength(1);
  });

  test('the cap holds under a multi-MB burst, dropping the oldest lines first', () => {
    const total = 20_000;
    const maxBytes = 64 * 1024;
    quietStdout(() => {
      uninstall = installLogFileSink({ path: LOG, maxBytes });

      // ~4 MB of output through a 64 KiB window: ~64 compactions.
      const filler = 'x'.repeat(200);
      for (let i = 0; i < total; i++) process.stdout.write(`line ${i} ${filler}\n`);

      uninstall();
      uninstall = null;
    });

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

  test('one oversized line is truncated instead of evicting the whole window', () => {
    // The eviction loop stops at `ring.length > 1`, so a single
    // `console.log(JSON.stringify(big))` used to leave the file holding that
    // one line and nothing else - and the line after it left the file at 37
    // bytes. The context around a huge payload is the useful part.
    quietStdout(() => {
      uninstall = installLogFileSink({ path: LOG, maxBytes: 4096 });
      process.stdout.write('small-before\n');
      process.stdout.write(`${'B'.repeat(20_000)}\n`);
      process.stdout.write('small-after\n');
      uninstall();
      uninstall = null;
    });

    const body = read();
    expect(body).toContain('small-before');
    expect(body).toContain('small-after');
    expect(body).toContain('truncated by the log sink');
    // 4096 / 4 is the per-line budget, so nothing close to 20 KB survives.
    expect(body).not.toContain('B'.repeat(2000));
    expect(statSync(LOG).size).toBeLessThanOrEqual(4096 * 1.25);
  });

  test('a restart keeps the previous run\'s tail (the ring is seeded from disk)', () => {
    // The ring started empty while the byte counter started at the existing
    // file's size, so the first compaction after a restart replaced the file
    // with only the new session's lines. A crash loop erased the healthy run
    // - confirmed gone by restart 4 - which is exactly the log an operator
    // needs.
    mkdirSync(dirname(LOG), { recursive: true });
    const history = Array.from({ length: 100 }, (_, i) => `preexisting ${i} ${'h'.repeat(24)}`).join('\n');
    writeFileSync(LOG, `${history}\n`);
    const before = statSync(LOG).size;

    quietStdout(() => {
      uninstall = installLogFileSink({ path: LOG, maxBytes: 4096 });
      // Enough to push past compactAt (4096 * 1.25) and force a rewrite.
      for (let i = 0; i < 20; i++) process.stdout.write(`session2 ${i} ${'n'.repeat(40)}\n`);
      uninstall();
      uninstall = null;
    });

    const body = read();
    expect(before).toBeGreaterThan(4096 * 0.9);
    expect(body).toContain('session2 19 ');
    // The newest history survived the rewrite; only the oldest was evicted.
    expect(body).toContain('preexisting 99 ');
    expect(body).not.toContain('preexisting 0 ');
    expect(statSync(LOG).size).toBeLessThanOrEqual(4096 * 1.25);
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
    expect(linesWith('only once please')).toHaveLength(1);
  });

  test('an unopenable path degrades to no sink instead of throwing', async () => {
    const blocker = join(DIR, 'not-a-dir');
    await writeFile(blocker, 'i am a regular file');
    const bad = join(blocker, 'nested', 'jarvis.log');

    // A holder rather than a `let`: TS narrows a plain local to `null` when the
    // only assignment happens inside a callback.
    const stop: { fn: (() => void) | null } = { fn: null };
    let spyErr: typeof process.stderr.write | null = null;
    const errs = withCapturedStderr(() => {
      spyErr = process.stderr.write;
      expect(() => {
        stop.fn = installLogFileSink({ path: bad });
      }).not.toThrow();
      // Bailed out before patching anything, so the daemon keeps logging
      // exactly as it did before.
      expect(process.stderr.write).toBe(spyErr!);
      console.log('still alive');
    });
    stop.fn?.();

    expect(errs).toContain('[LogFile]');
    expect(errs).toContain('continuing without a log file');
  });

  test('refuses a FIFO at log_file_path instead of hanging the daemon forever', () => {
    // `openSync(fifo, 'a')` blocks until a reader appears, and the sink is
    // installed before anything else boots - so startDaemon never returned and
    // no supervisor restarted it, because nothing had crashed. Jarvis runs
    // shell commands as its own user, so `mkfifo ~/.jarvis/logs/jarvis.log` is
    // inside the threat model.
    mkdirSync(dirname(LOG), { recursive: true });
    const made = Bun.spawnSync(['mkfifo', LOG]);
    expect(made.exitCode).toBe(0);

    const before = process.stdout.write;
    const stop: { fn: (() => void) | null } = { fn: null };
    const errs = withCapturedStderr(() => {
      stop.fn = installLogFileSink({ path: LOG });
    });
    stop.fn?.();

    expect(process.stdout.write).toBe(before);
    expect(errs).toContain('is not a regular file');
    expect(errs).toContain('continuing without a log file');
  });

  test('refuses a symlink at log_file_path (the hosted reader will not follow one either)', () => {
    mkdirSync(dirname(LOG), { recursive: true });
    const target = join(DIR, 'elsewhere.log');
    writeFileSync(target, '');
    symlinkSync(target, LOG);

    const before = process.stdout.write;
    const stop: { fn: (() => void) | null } = { fn: null };
    const errs = withCapturedStderr(() => {
      stop.fn = installLogFileSink({ path: LOG });
    });
    stop.fn?.();

    expect(process.stdout.write).toBe(before);
    expect(errs).toContain('is not a regular file');
  });

  test('the cap is clamped at both ends (it is an in-memory ring, so also an RSS budget)', () => {
    const tiny = withCapturedStderr(() => {
      installLogFileSink({ path: LOG, maxBytes: 10 })();
    });
    expect(tiny).toContain('out of range');
    expect(tiny).toContain('using 4096');

    // `log_file_max_bytes: .inf` is legal YAML and gave maxBytes = Infinity:
    // the ring then never compacted and grew until the daemon was OOM-killed.
    const infinite = withCapturedStderr(() => {
      installLogFileSink({ path: LOG, maxBytes: Number.POSITIVE_INFINITY })();
    });
    expect(infinite).toContain('out of range');
    expect(infinite).toContain('using 1048576');

    // 1e12 asks for a 1 TB resident buffer.
    const huge = withCapturedStderr(() => {
      installLogFileSink({ path: LOG, maxBytes: 1e12 })();
    });
    expect(huge).toContain('out of range');
    expect(huge).toContain(`using ${64 * 1024 * 1024}`);

    // A value inside the range is used as-is and says nothing.
    const fine = withCapturedStderr(() => {
      installLogFileSink({ path: LOG, maxBytes: 65_536 })();
    });
    expect(fine).toBe('');
  });

  test('a compaction failure warns once and recovers when the path works again', () => {
    // A transient failure used to disable the sink for the life of the
    // process: one `rm -rf ~/.jarvis/logs` or one ENOSPC meant no log file
    // until the next restart.
    const logDir = dirname(LOG);
    mkdirSync(logDir, { recursive: true });
    const line = `filler ${'f'.repeat(100)}`;

    const maxBytes = 64 * 1024;
    const errs = withCapturedStderr(() => {
      quietStdout(() => {
        uninstall = installLogFileSink({ path: LOG, maxBytes });
        // Read-only directory: the compaction temp file cannot be created.
        chmodSync(logDir, 0o500);
        for (let i = 0; i < 700; i++) process.stdout.write(`down ${i} ${line}\n`);
        chmodSync(logDir, 0o755);
        // More than the retry throttle, so the sink reopens and replays the ring.
        for (let i = 0; i < 300; i++) process.stdout.write(`back ${i} ${line}\n`);
        uninstall!();
        uninstall = null;
      });
    });

    expect(errs).toContain('[LogFile]');
    expect(errs).toContain('could not rewrite');
    expect(errs).toContain('retrying in the background');
    // Warned ONCE, not once per failed compaction.
    expect(errs.split('[LogFile]').length - 1).toBe(1);

    expect(existsSync(LOG)).toBe(true);
    const body = read();
    expect(body).toContain('back 299 ');
    // The ring kept filling while the file was unwritable, so the recovered
    // file carries lines from the outage - they are not lost with it.
    expect(body).toContain('down 699 ');
    expect(statSync(LOG).size).toBeLessThanOrEqual(maxBytes * 1.25);
  });

  test('cleans stale <path>.<pid>.tmp siblings left by a crash mid-compaction', () => {
    mkdirSync(dirname(LOG), { recursive: true });
    const mine = `${LOG}.${process.pid}.tmp`;
    // pid 1 always exists (init / launchd), so this one belongs to a live
    // process and must be left alone.
    const live = `${LOG}.1.tmp`;
    const unrelated = `${LOG}.keep`;
    writeFileSync(mine, 'x');
    writeFileSync(live, 'x');
    writeFileSync(unrelated, 'x');

    uninstall = installLogFileSink({ path: LOG });
    uninstall();
    uninstall = null;

    const left = readdirSync(dirname(LOG));
    expect(left).not.toContain(`jarvis.log.${process.pid}.tmp`);
    expect(left).toContain('jarvis.log.1.tmp');
    expect(left).toContain('jarvis.log.keep');
  });
});

describe('logFileIsProcessStdio', () => {
  test('matches on dev+ino, so a launcher redirect is detected by any spelling', () => {
    // Without this the sink installs on a file the launcher already has open
    // as fds 1/2, and the first compaction's rename leaves those descriptors
    // writing into an unlinked inode that grows forever and that `ls` cannot
    // show (measured: 4 KB visible, 226 KB orphaned, nlink=0).
    mkdirSync(dirname(LOG), { recursive: true });
    writeFileSync(LOG, '');
    const other = join(DIR, 'other.log');
    writeFileSync(other, '');

    const onLog = openSync(LOG, 'a');
    const onOther = openSync(other, 'a');
    try {
      expect(logFileIsProcessStdio(LOG, [onLog])).toBe(true);
      expect(logFileIsProcessStdio(LOG, [onOther])).toBe(false);
      // Any of the fds matching is enough: launchd redirects stdout and
      // stderr to two different files.
      expect(logFileIsProcessStdio(LOG, [onOther, onLog])).toBe(true);
      // A symlinked spelling of the same file is the same inode, which a
      // string compare in each launcher would have missed.
      const alias = join(DIR, 'alias.log');
      symlinkSync(LOG, alias);
      expect(logFileIsProcessStdio(alias, [onLog])).toBe(true);
    } finally {
      closeSync(onLog);
      closeSync(onOther);
    }

    // Nothing at the path yet: nothing can be open on it.
    expect(logFileIsProcessStdio(join(DIR, 'never-written.log'))).toBe(false);
    // A closed descriptor number must not throw or match.
    expect(logFileIsProcessStdio(LOG, [9999])).toBe(false);
    // The test runner's real stdout is not this file.
    expect(logFileIsProcessStdio(LOG)).toBe(false);
  });
});
