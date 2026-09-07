/**
 * In-process, size-capped, redacted log-file sink.
 *
 * Jarvis only ever had a log file in two launch modes: `jarvis start -d`
 * (bin/jarvis.ts redirects the detached child's fds at spawn) and launchd.
 * Under systemd - how the hosted fleet runs it, and `files/jarvis@.service`
 * carries no `StandardOutput=` - and under Docker there is no file at all, so
 * the only log is journald or the container runtime and the hosting control
 * plane has nothing stable per instance to read (docs/LOGS.md, "The brain's
 * side"). This gives every launch mode the same file, driven by
 * `daemon.log_file_path`.
 *
 * We hook at the STREAM level - `process.stdout.write` / `process.stderr.write`
 * - so direct write callers and any dependency that writes on its own are
 * caught, not just our own logging. The original write is always called
 * through, so the terminal and the journal see everything unchanged.
 *
 * The stream hook alone is not enough on Bun. Node's `console.*` is a thin
 * wrapper over `process.stdout.write`, but Bun's console is native and writes
 * to the file descriptors directly: with only the stream patch installed,
 * every one of jarvis's ~1150 `console.*` call sites is invisible to the sink
 * (verified on bun 1.3.8 - a patched `process.stdout.write` sees `RAW-OUT`
 * from an explicit write and nothing at all from `console.log`). So `console.*`
 * is wrapped too. The wrapper calls the REAL console method for the terminal,
 * then feeds the formatted text to the sink itself, with the stream hook
 * suppressed for the duration - on a runtime where console DOES route through
 * the stream (node, and bun's own test reporter) that suppression is what
 * keeps a line from being recorded twice.
 *
 * KNOWN LIMITATION: the ~80 subprocess spawns that use `stdio: 'inherit'` hand
 * the child our raw file descriptors, and the child then writes to them from
 * another process. No JS-level patch can observe that, so subprocess output
 * reaches the terminal and journald but never this file. Deliberately out of
 * scope: capturing it would mean piping and re-emitting every spawn site.
 */

import { closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { format } from 'node:util';
import { redactSecrets } from './redact.ts';

/** Default cap. Matches docs/LOGS.md and the control plane's 1 MiB read cap. */
export const DEFAULT_LOG_FILE_MAX_BYTES = 1024 * 1024;

/**
 * Floor for the cap. Below this a compaction rewrite costs more than it saves,
 * and a single stack trace would blow the whole window away.
 */
const MIN_LOG_FILE_MAX_BYTES = 4096;

/**
 * How far past the cap the file is allowed to grow before it is rewritten.
 * The slack is what makes appends O(1): without it every line past the cap
 * would rewrite the whole file. At 1.25 the file settles at ~1 MiB, never
 * exceeds ~1.25 MiB, and one rewrite buys ~256 KiB of plain appends.
 */
const COMPACT_RATIO = 1.25;

/**
 * ANSI escape sequences: CSI (colours, cursor moves) and OSC (title sets,
 * hyperlinks). src/cli/helpers.ts exports `c` with hardcoded escapes and no
 * TTY detection, so anything routed through the CLI helpers carries them even
 * when stdout is a file - they would otherwise land in the log as mojibake an
 * operator has to read around.
 */
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g;

export type LogFileSinkOptions = {
  /** Absolute path of the file to write. Its parent is created if missing. */
  path: string;
  /** Ring size in bytes. Defaults to 1 MiB; values under 4 KiB are raised. */
  maxBytes?: number;
};

type StreamWrite = typeof process.stdout.write;

/**
 * Only one sink can be installed at a time: a second patch over the first
 * would write every line twice and the uninstalls would restore in the wrong
 * order. Installing again replaces the active sink.
 */
let active: (() => void) | null = null;

/**
 * Install the file sink. Returns an uninstall function that flushes any
 * buffered partial line, restores the original writes, and closes the file.
 *
 * Never throws and never blocks: a path that cannot be opened or written
 * degrades to "no file sink" with a single warning on the real stderr. The
 * daemon must not die because its log file is unavailable.
 */
export function installLogFileSink(opts: LogFileSinkOptions): () => void {
  active?.();
  active = null;

  // Kept UNBOUND on purpose: uninstall must restore the very same function
  // object it replaced, so a caller that stacked its own wrapper underneath us
  // (tests do; so does anything that patched stdout before boot) gets it back
  // by identity rather than as a fresh bound copy.
  const originalStdoutWrite = process.stdout.write as StreamWrite;
  const originalStderrWrite = process.stderr.write as StreamWrite;

  let warned = false;
  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    // Straight to the original write: console.warn would route through the
    // patched stderr and recurse back into the code that is already failing.
    try {
      originalStderrWrite.call(process.stderr, `[LogFile] ${message}\n`);
    } catch {
      // Even stderr is gone. Nothing left to say it with.
    }
  };

  const maxBytes = Math.max(
    MIN_LOG_FILE_MAX_BYTES,
    Math.floor(opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_LOG_FILE_MAX_BYTES),
  );
  const compactAt = Math.floor(maxBytes * COMPACT_RATIO);
  const filePath = opts.path;
  const tmpPath = `${filePath}.${process.pid}.tmp`;

  let fd: number;
  let fileBytes = 0;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    // 0600: the lines are redacted, but a log still describes what the user
    // did and nothing else on the box needs to read it.
    fd = openSync(filePath, 'a', 0o600);
    try {
      // Append, so a restart adds to what is there. The size counts toward the
      // cap from the start: an already-oversized file left by a previous run
      // is rewritten down to this session's lines on the first compaction,
      // which is the point of a cap.
      fileBytes = statSync(filePath).size;
    } catch {
      fileBytes = 0;
    }
  } catch (err) {
    warnOnce(`could not open ${filePath}: ${err instanceof Error ? err.message : String(err)}; continuing without a log file`);
    return () => {};
  }

  /**
   * The last `maxBytes` of output, as whole lines. This is what the file is
   * rewritten from, so dropping the oldest entry IS dropping on a line
   * boundary - the file can never start mid-line.
   */
  let ring: Buffer[] = [];
  let ringBytes = 0;

  let disabled = false;
  /**
   * Re-entrancy guard. Anything this sink writes itself (a warning, a stray
   * console.* from a dependency reached through our own stack) must pass
   * straight through to the original write instead of being processed again.
   */
  let inSink = false;

  /** Partial trailing line per stream. Writes do not arrive line-aligned, and
   * splicing stdout's tail onto stderr's head would invent lines that were
   * never logged - so each stream carries its own. */
  const pending = { out: '', err: '' };

  /**
   * Byte chunks are not codepoint-aligned either: a Buffer write can split a
   * multi-byte character down the middle, and decoding each chunk on its own
   * would put a U+FFFD in the log where an accented letter was. StringDecoder
   * holds the incomplete sequence until the rest lands.
   */
  const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };

  const closeFd = (): void => {
    try {
      closeSync(fd);
    } catch {
      // Already closed, or the fd went away with the file. Nothing to do.
    }
  };

  const fail = (what: string, err: unknown): void => {
    disabled = true;
    closeFd();
    warnOnce(`${what}: ${err instanceof Error ? err.message : String(err)}; continuing without a log file`);
  };

  const appendToFile = (buf: Buffer): void => {
    let offset = 0;
    // writeSync is allowed to write short. Looping is the only way to know the
    // line actually landed whole.
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }
    fileBytes += buf.length;
  };

  /**
   * Rewrite the file from the in-memory ring: write a sibling temp file, then
   * rename it over the target. rename(2) is atomic, so a reader (the host's
   * `fetch-logs`, or `tail`) sees either the old file or the new one, never a
   * half-truncated one. The inode changes, which is why `jarvis logs -f` uses
   * `tail -F` rather than `tail -f`.
   */
  const compact = (): void => {
    try {
      writeFileSync(tmpPath, ring.length === 1 ? ring[0]! : Buffer.concat(ring, ringBytes), { mode: 0o600 });
      renameSync(tmpPath, filePath);
      closeFd();
      fd = openSync(filePath, 'a', 0o600);
      fileBytes = ringBytes;
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // The temp file may never have been created. Either way we are done.
      }
      fail(`could not rewrite ${filePath}`, err);
    }
  };

  const writeLine = (line: string): void => {
    const clean = redactSecrets(line.replace(ANSI_PATTERN, ''));
    const buf = Buffer.from(`${new Date().toISOString()} ${clean}\n`, 'utf8');

    ring.push(buf);
    ringBytes += buf.length;
    while (ringBytes > maxBytes && ring.length > 1) {
      ringBytes -= ring.shift()!.length;
    }

    appendToFile(buf);
    if (fileBytes > compactAt) compact();
  };

  const consume = (stream: 'out' | 'err', text: string): void => {
    if (!text) return;
    const buffered = pending[stream] + text;
    let nl = buffered.indexOf('\n');
    if (nl === -1) {
      // No terminator yet. Hold it: the rest of this line is coming in a
      // later write (process.stdout.write callers chunk mid-line freely).
      pending[stream] = buffered;
      return;
    }
    let start = 0;
    while (nl !== -1) {
      // \r\n and a bare \r-driven progress redraw both leave a stray \r.
      writeLine(buffered.slice(start, nl).replace(/\r$/, ''));
      if (disabled) return;
      start = nl + 1;
      nl = buffered.indexOf('\n', start);
    }
    pending[stream] = buffered.slice(start);
  };

  const patch = (stream: 'out' | 'err', original: StreamWrite): StreamWrite => {
    return function patchedWrite(this: unknown, ...args: unknown[]): boolean {
      // The terminal / journal is served first and unconditionally: whatever
      // the file sink does or fails to do, the process' own output is intact.
      const target = stream === 'out' ? process.stdout : process.stderr;
      const result = (original as (...a: unknown[]) => boolean).apply(target, args);
      if (disabled || inSink) return result;
      inSink = true;
      try {
        const chunk = args[0];
        const text =
          typeof chunk === 'string'
            ? chunk
            : chunk instanceof Uint8Array
              ? decoders[stream].write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
              : null;
        if (text !== null) consume(stream, text);
      } catch (err) {
        fail('log sink write failed', err);
      } finally {
        inSink = false;
      }
      return result;
    } as StreamWrite;
  };

  process.stdout.write = patch('out', originalStdoutWrite);
  process.stderr.write = patch('err', originalStderrWrite);

  /**
   * Which stream each console method belongs to, matching node/bun: log, info
   * and debug go to stdout; warn, error and trace to stderr.
   */
  const CONSOLE_METHODS = {
    log: 'out',
    info: 'out',
    debug: 'out',
    warn: 'err',
    error: 'err',
    trace: 'err',
  } as const;

  type ConsoleMethod = keyof typeof CONSOLE_METHODS;
  const originalConsole = {} as Record<ConsoleMethod, (...args: unknown[]) => void>;

  for (const name of Object.keys(CONSOLE_METHODS) as ConsoleMethod[]) {
    const original = console[name] as (...args: unknown[]) => void;
    if (typeof original !== 'function') continue;
    originalConsole[name] = original;
    const stream = CONSOLE_METHODS[name];
    console[name] = (...args: unknown[]): void => {
      // Terminal first, through the real console: its own formatting and
      // colouring stay byte-for-byte what they were without the sink.
      const wasInSink = inSink;
      inSink = true;
      try {
        original.apply(console, args);
      } finally {
        inSink = wasInSink;
      }
      if (disabled || wasInSink) return;
      inSink = true;
      try {
        // `format` is node's console formatter (%s/%d substitution, object
        // inspection), so the file records the same text the terminal shows.
        consume(stream, `${format(...(args as [unknown, ...unknown[]]))}\n`);
      } catch (err) {
        fail('log sink write failed', err);
      } finally {
        inSink = false;
      }
    };
  }

  const uninstall = (): void => {
    if (active === uninstall) active = null;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    for (const name of Object.keys(originalConsole) as ConsoleMethod[]) {
      console[name] = originalConsole[name];
    }
    if (disabled) return;
    inSink = true;
    try {
      // Flush whatever never got its newline, so a crash message that was
      // still mid-line is not the one thing missing from the log.
      for (const stream of ['out', 'err'] as const) {
        const rest = pending[stream];
        pending[stream] = '';
        if (rest) writeLine(rest);
      }
    } catch {
      // Best effort: we are on the way out.
    } finally {
      inSink = false;
      disabled = true;
      ring = [];
      ringBytes = 0;
      closeFd();
    }
  };

  active = uninstall;
  return uninstall;
}
