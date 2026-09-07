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
 * The cap is an IN-MEMORY ring, not a file scan: `log_file_max_bytes` is an
 * RSS budget as much as a disk budget, which is why it is clamped at both ends
 * (see MIN/MAX_LOG_FILE_MAX_BYTES).
 *
 * KNOWN LIMITATION: the ~80 subprocess spawns that use `stdio: 'inherit'` hand
 * the child our raw file descriptors, and the child then writes to them from
 * another process. No JS-level patch can observe that, so subprocess output
 * reaches the terminal and journald but never this file. Deliberately out of
 * scope: capturing it would mean piping and re-emitting every spawn site.
 */

import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
 * Ceiling for the cap. The window is held in memory, so the cap is an RSS
 * budget: `log_file_max_bytes: .inf` (legal YAML, and what a `.inf` typo
 * produces) gave `maxBytes = Infinity`, which means the ring never compacts
 * and grows until the daemon is OOM-killed, and `1e12` asks for a 1 TB
 * resident buffer. 64 MiB is far past any useful debugging window and still
 * survivable on the 1 GB hosted boxes.
 */
const MAX_LOG_FILE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * How far past the cap the file is allowed to grow before it is rewritten.
 * The slack is what makes appends O(1): without it every line past the cap
 * would rewrite the whole file. At 1.25 the file settles at ~1 MiB, never
 * exceeds ~1.25 MiB, and one rewrite buys ~256 KiB of plain appends.
 */
const COMPACT_RATIO = 1.25;

/**
 * A single line may take at most this fraction of the window. Without it one
 * `console.log(JSON.stringify(bigObject))` or one long stack trace evicts
 * EVERY other line (the eviction loop stops at `ring.length > 1`), so the file
 * ends up holding that one line and nothing else, and the line after it leaves
 * the file at 37 bytes. Truncating instead keeps the surrounding context,
 * which is the part an operator actually needs.
 */
const MAX_LINE_FRACTION = 4;

/**
 * How often to retry a file that went away under us. A failed write used to
 * disable the sink for the life of the process, so an `rm -rf ~/.jarvis/logs`
 * or a transient ENOSPC meant no log file until the next restart. Retrying on
 * every line would turn a permanently broken path into a syscall storm, so the
 * retry is throttled to one attempt per this many lines.
 */
const RECOVER_EVERY_LINES = 200;

/**
 * Force a "line" out at this size even with no terminator in sight. A writer
 * that only ever emits `\r` (progress redraws) or one that streams a huge
 * payload with no newline used to grow `pending` without bound: 20k `\r`
 * frames built a single 649 KB string, +52 MB of heap and 2.1s of repeated
 * scanning, with nothing written to the file the whole time.
 */
const MAX_PENDING_CHARS = 64 * 1024;

/**
 * ANSI escape sequences: CSI (colours, cursor moves) and OSC (title sets,
 * hyperlinks). src/cli/helpers.ts exports `c` with hardcoded escapes and no
 * TTY detection, so anything routed through the CLI helpers carries them even
 * when stdout is a file - they would otherwise land in the log as mojibake an
 * operator has to read around.
 *
 * Every quantifier is bounded on purpose. The obvious pattern here is the
 * `ansi-regex` one, which is CVE-2021-3807: its nested unbounded groups make
 * `ESC` followed by 10-20k `;` cost 200-400ms per line, and log lines are
 * attacker-influenced (anything jarvis echoes back). Bounded repetition over
 * character classes that cannot overlap gives linear scanning instead.
 */
const ANSI_PATTERN =
  /\u001B\][^\u0007\u001B]{0,2048}(?:\u0007|\u001B\\)|[\u001B\u009B]\[[0-9;:<=>?]{0,64}[ -\/]{0,8}[@-~]|\u009B[0-9;:<=>?]{0,64}[ -\/]{0,8}[@-~]|\u001B[ -\/]{1,4}[0-~]|\u001B[0-9A-Za-z=><]/g;

/** Matches the `<pid>.tmp` suffix compaction leaves on its sibling temp file. */
const TMP_SUFFIX_PATTERN = /^\.(\d+)\.tmp$/;

export type LogFileSinkOptions = {
  /** Absolute path of the file to write. Its parent is created if missing. */
  path: string;
  /**
   * Ring size in bytes, held in memory as well as on disk. Defaults to 1 MiB;
   * values under 4 KiB are raised, values over 64 MiB (and non-finite ones)
   * are lowered.
   */
  maxBytes?: number;
};

type StreamWrite = typeof process.stdout.write;

/**
 * True when one of `fds` is already open on the very file `path` names.
 *
 * This is the guard against the worst failure this sink can cause. A launcher
 * that redirects the daemon's fds 1/2 into the log file (`jarvis start -d`,
 * `restartDaemonDetached` in src/cli/update.ts, the launchd plist's
 * `StandardOutPath`, a `StandardOutput=append:` in someone's unit file) hands
 * the process a descriptor bound to an INODE. The first compaction renames a
 * fresh file over that path, so the descriptor keeps pointing at the old,
 * now-unlinked inode: it grows forever, `ls` cannot see it, and only a reboot
 * or a restart frees the space. Confirmed - after 2000 lines through a 4 KiB
 * cap the named file was 4 KB and the orphan behind fd 1 was 226 KB with
 * nlink=0.
 *
 * Checking dev+ino here rather than comparing path strings in each launcher is
 * what makes it total: it catches every launcher, including ones added later
 * and ones written by the operator, and it is immune to symlinks, bind mounts
 * and `$JARVIS_HOME` spellings of the same file.
 */
export function logFileIsProcessStdio(path: string, fds: readonly number[] = [1, 2]): boolean {
  let target: ReturnType<typeof statSync>;
  try {
    target = statSync(path);
  } catch {
    // Nothing at that path yet, so nothing can already be open on it.
    return false;
  }
  for (const fd of fds) {
    try {
      const st = fstatSync(fd);
      if (st.dev === target.dev && st.ino === target.ino) return true;
    } catch {
      // Closed or not a real descriptor. Not our file either way.
    }
  }
  return false;
}

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

  // Straight to the original write: console.warn would route through the
  // patched stderr and recurse back into the code that is already failing.
  const say = (message: string): void => {
    try {
      originalStderrWrite.call(process.stderr, `[LogFile] ${message}\n`);
    } catch {
      // Even stderr is gone. Nothing left to say it with.
    }
  };

  let warned = false;
  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    say(message);
  };

  // Validate before clamping so the operator is told their value was ignored.
  // `.inf` and `1e12` are both legal YAML and both used to sail straight
  // through: `Math.floor(Infinity)` is Infinity, so the ring never compacted.
  const requested = opts.maxBytes;
  const usable = typeof requested === 'number' && Number.isFinite(requested) && requested > 0;
  const maxBytes = usable
    ? Math.min(MAX_LOG_FILE_MAX_BYTES, Math.max(MIN_LOG_FILE_MAX_BYTES, Math.floor(requested)))
    : DEFAULT_LOG_FILE_MAX_BYTES;
  if (requested !== undefined && (!usable || maxBytes !== Math.floor(requested as number))) {
    say(
      `log_file_max_bytes=${String(requested)} is out of range (${MIN_LOG_FILE_MAX_BYTES}..${MAX_LOG_FILE_MAX_BYTES} bytes, held in memory); using ${maxBytes}`,
    );
  }
  const compactAt = Math.floor(maxBytes * COMPACT_RATIO);
  const maxLineBytes = Math.max(1024, Math.floor(maxBytes / MAX_LINE_FRACTION));
  const filePath = opts.path;
  const tmpPath = `${filePath}.${process.pid}.tmp`;

  // A FIFO at this path hangs the whole daemon: `openSync(fifo, 'a')` blocks
  // until a reader shows up, and it is called before anything else boots, so
  // startDaemon simply never returns and no supervisor restarts it because
  // nothing crashed. Jarvis runs shell commands as its own user, so
  // `mkfifo ~/.jarvis/logs/jarvis.log` is inside the threat model. lstat (not
  // stat) so a symlink is refused too, matching the hosting side's reader
  // (infra/vps-scripts/bin/fetch-logs --source instance), which will not
  // follow one either.
  try {
    const existing = lstatSync(filePath);
    if (!existing.isFile()) {
      warnOnce(`${filePath} is not a regular file; continuing without a log file`);
      return () => {};
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnOnce(`could not stat ${filePath}: ${err instanceof Error ? err.message : String(err)}; continuing without a log file`);
      return () => {};
    }
  }

  /** -1 means "no open descriptor": either not opened yet, or lost mid-run. */
  let fd = -1;
  let fileBytes = 0;

  const closeFd = (): void => {
    if (fd < 0) return;
    // Clear FIRST. `compact` closes the fd and then may throw on the reopen,
    // and the error path used to close the same NUMBER a second time - by
    // which point bun's helper threads can have handed it to something else.
    const doomed = fd;
    fd = -1;
    try {
      closeSync(doomed);
    } catch {
      // Already closed, or the fd went away with the file. Nothing to do.
    }
  };

  const openFile = (): Error | null => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      // 0600: the lines are redacted, but a log still describes what the user
      // did and nothing else on the box needs to read it.
      fd = openSync(filePath, 'a', 0o600);
      try {
        fileBytes = statSync(filePath).size;
      } catch {
        fileBytes = 0;
      }
      return null;
    } catch (err) {
      fd = -1;
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  const openErr = openFile();
  if (openErr) {
    warnOnce(`could not open ${filePath}: ${openErr.message}; continuing without a log file`);
    return () => {};
  }

  /**
   * The last `maxBytes` of output, as whole lines. This is what the file is
   * rewritten from, so dropping the oldest entry IS dropping on a line
   * boundary - the file can never start mid-line.
   */
  let ring: Buffer[] = [];
  let ringBytes = 0;

  /**
   * Seed the ring from the tail of whatever is already on disk.
   *
   * Without this the ring started empty while `fileBytes` started at the
   * existing file's size, so the FIRST compaction after a restart replaced the
   * file with only the current session's lines. A crash loop therefore erased
   * the healthy run's log - the one thing an operator needs - within a few
   * restarts (confirmed: gone by restart 4).
   */
  const seedRing = (): void => {
    let rfd = -1;
    try {
      const size = statSync(filePath).size;
      if (size <= 0) return;
      const want = Math.min(size, maxBytes);
      const buf = Buffer.alloc(want);
      rfd = openSync(filePath, 'r');
      let got = 0;
      while (got < want) {
        const n = readSync(rfd, buf, got, want - got, size - want + got);
        if (n <= 0) break;
        got += n;
      }
      let start = 0;
      if (want < size) {
        // We cut into the middle of a line. Drop the fragment: the ring holds
        // whole lines only, and the file is rewritten from it.
        const nl = buf.indexOf(0x0a, 0);
        if (nl === -1) return;
        start = nl + 1;
      }
      let from = start;
      for (let i = start; i < got; i++) {
        if (buf[i] !== 0x0a) continue;
        const line = buf.subarray(from, i + 1);
        ring.push(line);
        ringBytes += line.length;
        from = i + 1;
      }
      if (from < got) {
        // Previous run died mid-line. Terminate it so the ring stays line-shaped.
        const line = Buffer.concat([buf.subarray(from, got), Buffer.from('\n')]);
        ring.push(line);
        ringBytes += line.length;
      }
      while (ringBytes > maxBytes && ring.length > 1) {
        ringBytes -= ring.shift()!.length;
      }
    } catch {
      // Unreadable history is not worth failing a boot over. Start empty.
      ring = [];
      ringBytes = 0;
    } finally {
      if (rfd >= 0) {
        try {
          closeSync(rfd);
        } catch {
          // Nothing to do.
        }
      }
    }
  };
  seedRing();

  /**
   * Remove `<path>.<pid>.tmp` siblings left by a crash between the temp write
   * and the rename. Nothing ever cleaned them up, so a box that OOM-killed the
   * daemon mid-compaction accumulated one near-full-window file per crash. A
   * tmp file whose pid is still alive belongs to a running process, so leave it.
   */
  const cleanStaleTmp = (): void => {
    try {
      const dir = dirname(filePath);
      const base = basename(filePath);
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(base) || name.length === base.length) continue;
        const m = TMP_SUFFIX_PATTERN.exec(name.slice(base.length));
        if (!m) continue;
        const pid = Number(m[1]);
        if (pid !== process.pid) {
          let alive = true;
          try {
            process.kill(pid, 0);
          } catch (err) {
            // EPERM means it exists and is someone else's; ESRCH means gone.
            alive = (err as NodeJS.ErrnoException).code === 'EPERM';
          }
          if (alive) continue;
        }
        try {
          unlinkSync(join(dir, name));
        } catch {
          // Raced with another cleaner, or not ours to delete.
        }
      }
    } catch {
      // Directory listing is a nicety; never let it stop the sink.
    }
  };
  cleanStaleTmp();

  let disabled = false;
  let recoverIn = 0;
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

  /**
   * Lose the file but keep the sink. This used to set a permanent "disabled"
   * flag, so one transient failure - `rm -rf ~/.jarvis/logs`, a full disk that
   * emptied a minute later - meant no log file until the daemon restarted.
   * The ring keeps filling in memory and `writeLine` retries the open.
   */
  const degrade = (what: string, err: unknown): void => {
    closeFd();
    recoverIn = RECOVER_EVERY_LINES;
    warnOnce(`${what}: ${err instanceof Error ? err.message : String(err)}; retrying in the background`);
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
   * `tail -F` rather than `tail -f` - and why the sink refuses to install when
   * a launcher already has fds 1/2 open on this file (logFileIsProcessStdio).
   */
  const compact = (): void => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
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
      degrade(`could not rewrite ${filePath}`, err);
    }
  };

  /**
   * Cap one line's contribution to the window. Cut on the buffer, not the
   * string, and decode the head with a StringDecoder so a multi-byte character
   * straddling the cut is dropped rather than turned into U+FFFD.
   */
  const truncateLine = (line: string): string => {
    if (Buffer.byteLength(line, 'utf8') <= maxLineBytes) return line;
    const buf = Buffer.from(line, 'utf8');
    const head = new StringDecoder('utf8').write(buf.subarray(0, maxLineBytes));
    return `${head}... [truncated by the log sink: ${buf.length - maxLineBytes} more bytes]`;
  };

  const writeLine = (line: string): void => {
    const clean = truncateLine(redactSecrets(line.replace(ANSI_PATTERN, '')));
    const buf = Buffer.from(`${new Date().toISOString()} ${clean}\n`, 'utf8');

    ring.push(buf);
    ringBytes += buf.length;
    while (ringBytes > maxBytes && ring.length > 1) {
      ringBytes -= ring.shift()!.length;
    }

    if (fd < 0) {
      // File is gone. Retry occasionally; a successful reopen replays the ring
      // through `compact`, so the recovered file carries what it missed.
      if (--recoverIn > 0) return;
      recoverIn = RECOVER_EVERY_LINES;
      compact();
      return;
    }

    try {
      appendToFile(buf);
    } catch (err) {
      degrade(`could not write to ${filePath}`, err);
      return;
    }
    if (fileBytes > compactAt) compact();
  };

  const consume = (stream: 'out' | 'err', text: string): void => {
    if (!text) return;
    const buffered = pending[stream] + text;
    pending[stream] = '';

    // `\r` terminates a line too. Progress renderers redraw with a bare `\r`
    // and never emit `\n`, and holding those forever meant a growing `pending`
    // string and nothing on disk. Both indices are tracked and only the
    // consumed one is re-searched, so the whole scan stays linear.
    let nl = buffered.indexOf('\n');
    let cr = buffered.indexOf('\r');
    let start = 0;
    while (nl !== -1 || cr !== -1) {
      const at = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
      const isCr = at === cr;
      const crlf = isCr && buffered.charCodeAt(at + 1) === 10;
      const segment = buffered.slice(start, at);
      // A bare `\r` with nothing before it is a redraw of an empty frame, not
      // a blank line the process logged. `\r\n` and `\n` keep their blanks.
      if (segment.length > 0 || !isCr || crlf) writeLine(segment);
      start = crlf ? at + 2 : at + 1;
      if (nl !== -1 && nl < start) nl = buffered.indexOf('\n', start);
      if (cr !== -1 && cr < start) cr = buffered.indexOf('\r', start);
    }

    let rest = buffered.slice(start);
    if (rest.length > MAX_PENDING_CHARS) {
      // No terminator in sight and the buffer is past its budget. Flush it as
      // a line rather than growing forever.
      writeLine(rest);
      rest = '';
    }
    pending[stream] = rest;
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
        degrade('log sink write failed', err);
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
        degrade('log sink write failed', err);
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
