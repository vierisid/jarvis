/**
 * Test fixture: a throwaway headless Chromium for the browser integration
 * tests, which cannot leak or collide with another run.
 *
 * The tests used to spawn Chromium straight from `Bun.spawn` on a fixed CDP
 * port (9777, 9778) and kill it in `afterAll` (#524). `bun test --bail` exits
 * without running the remaining `afterAll` hooks, and a SIGKILLed runner runs
 * none, so every bailed run left a browser reparented to init, still holding
 * the port. The next run's Chromium then failed to bind, the readiness poll
 * found the ORPHAN answering on the port, and the tests drove a stranger's
 * browser -- which made them flaky, which made them bail, which leaked
 * another one.
 *
 * Two independent fixes, so neither has to be perfect:
 *
 *  - No fixed port. Chromium picks a free one (`--remote-debugging-port=0`)
 *    and writes it to `<profile>/DevToolsActivePort`. The profile dir is a
 *    fresh mkdtemp, so the port read from it can only be this browser's. An
 *    orphan from an older checkout cannot be mistaken for ours.
 *
 *  - A parent-death watchdog. Chromium runs under a small `sh` whose stdin is
 *    a pipe from this process. However this process ends -- `afterAll`, a
 *    bail, an uncaught error, SIGKILL -- the kernel closes the write end, the
 *    shell's `read` sees EOF, and it stops Chromium (TERM, then KILL after a
 *    grace) and removes the profile dir. No polling, and it does not depend on
 *    any JS running at exit, which is the part that fails today.
 *
 * The browser gets `sanitizedEnv()`, the same allowlist as every other spawn:
 * no API keys, and no DISPLAY or WAYLAND_DISPLAY -- `--headless=new` does not
 * need them, and a test browser has no business near the developer's real
 * desktop.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizedEnv } from '../../../util/subprocess-env.ts';

const CHROMIUM_CANDIDATES = [
  process.env.CHROME_PATH,
  '/snap/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean) as string[];

/** The Chromium to test against, or undefined to skip the suite. */
export const chromiumExe: string | undefined =
  process.platform === 'win32' ? undefined : CHROMIUM_CANDIDATES.find((p) => existsSync(p));

/**
 * The watchdog. `$1` is the profile dir, the rest is the Chromium argv. It
 * prints Chromium's pid so the owner can fail fast when the browser dies at
 * startup and, as a last resort, kill it directly.
 *
 * The traps come first, before Chromium exists, so there is no window in
 * which a signal kills the shell and orphans the browser. `trap :` keeps
 * TERM/INT/HUP from killing the shell: depending on the shell, `read` is
 * either interrupted and the cleanup runs at once, or it resumes and the
 * cleanup runs at EOF. Either way the browser goes with it. PIPE is ignored so
 * the `echo` cannot kill the shell if the owner is already gone.
 *
 * What Chromium inherits: TERM and HUP are caught here, and a caught signal
 * resets to default on exec. INT and QUIT do not: a non-interactive shell
 * starts every `&` list with them ignored (bash and dash alike), and an
 * ignored signal stays ignored across exec. PIPE is inherited ignored too.
 * None of that matters, because the watchdog and close() only use TERM and
 * KILL.
 *
 * When `$c` is reaped depends on the shell. bash reaps it asynchronously, even
 * while blocked in `read`; dash only reaps when it next waits, so a browser
 * that died at startup stays a zombie until the cleanup below runs its first
 * `sleep` (which is also why the owner's liveness check must treat a zombie as
 * dead). Once reaped, the kills could in principle reach a recycled pid. That
 * needs the pid space to wrap within one test run; accepted.
 */
const WATCHDOG = `
trap : TERM INT HUP
trap '' PIPE
profile=$1; shift
"$@" </dev/null >/dev/null 2>&1 &
c=$!
echo "$c"
read -r _ || :
kill -TERM "$c" 2>/dev/null
i=0
while kill -0 "$c" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
kill -KILL "$c" 2>/dev/null
wait "$c" 2>/dev/null
[ -n "$profile" ] && rm -rf -- "$profile"
`;

export interface TestChromium {
  /** The CDP port this browser chose. */
  port: number;
  /** Chromium's own pid (the browser process, not the watchdog). */
  pid: number;
  profileDir: string;
  /** Stop the browser and remove its profile. Idempotent. */
  close(): Promise<void>;
}

async function waitFor<T>(deadline: number, probe: () => Promise<T | null>): Promise<T | null> {
  while (Date.now() < deadline) {
    const v = await probe();
    if (v !== null) return v;
    await Bun.sleep(100);
  }
  return null;
}

/**
 * Whether `pid` is a running process. A zombie still answers kill(pid, 0),
 * but it has exited and holds nothing, so it counts as dead: under dash the
 * watchdog leaves a browser that died at startup unreaped for as long as it
 * sits in `read`, and treating that zombie as alive turned a fast failure
 * into a wait for the whole startup deadline. Where there is no /proc, fall
 * back to kill(pid, 0).
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    // Exited between the two checks, or no /proc on this platform.
    return process.platform !== 'linux';
  }
  // The state follows the parenthesised command name, which may contain ')'.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
}

/**
 * Start a headless Chromium on a free CDP port and wait until it answers.
 * `startupMs` bounds the whole start: on a loaded CI runner a headless
 * Chromium can take well over 15s to come up. `executable` overrides the
 * detected browser (tests use it to start one that dies at once).
 */
export async function launchTestChromium(opts: {
  profilePrefix: string;
  startupMs?: number;
  executable?: string;
}): Promise<TestChromium> {
  const exe = opts.executable ?? chromiumExe;
  if (!exe) throw new Error('no Chromium executable found');
  const profileDir = mkdtempSync(join(tmpdir(), opts.profilePrefix));
  const deadline = Date.now() + (opts.startupMs ?? 45_000);

  let watchdog: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'ignore'>> | null = null;
  let pid = 0;
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (watchdog) {
        try { watchdog.stdin.end(); } catch { /* already closed */ }
        // The watchdog's own grace is 5s; allow for it before going direct.
        const exited = await Promise.race([watchdog.exited.then(() => true), Bun.sleep(8_000).then(() => false)]);
        if (!exited) {
          try { watchdog.kill('SIGKILL'); } catch { /* gone */ }
          if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        }
      }
      // Normally already gone (the watchdog removes it). A browser still
      // dying after a SIGKILL can race this; never let that mask a result.
      try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
    })();
    return closing;
  };

  try {
    watchdog = Bun.spawn(['sh', '-c', WATCHDOG, 'sh', profileDir,
      exe,
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-sandbox',
      '--no-first-run',
      '--disable-dev-shm-usage',
      // Nothing near the desktop session: no keyring (the tests type a
      // password), no crash uploads.
      '--password-store=basic',
      '--disable-breakpad',
      'about:blank',
    ], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: sanitizedEnv() });

    const reader = watchdog.stdout.getReader();
    const first = await Promise.race([reader.read(), Bun.sleep(5_000).then(() => null)]);
    reader.releaseLock();
    pid = first && !first.done ? Number.parseInt(new TextDecoder().decode(first.value), 10) : 0;
    if (!pid) throw new Error('Chromium watchdog did not report a pid');

    // Fail fast rather than wait out the deadline when the browser exits at
    // startup (bad CHROME_PATH, a missing library).
    const died = () => new Error(`Chromium (pid ${pid}) exited during startup`);

    const port = await waitFor(deadline, async () => {
      if (!processAlive(pid)) throw died();
      try {
        // Written as "<port>\n<browser path>"; wait for the newline so a
        // partially written first line is never parsed.
        const [first, ...rest] = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n');
        const n = rest.length > 0 ? Number.parseInt(first!, 10) : NaN;
        return n > 0 ? n : null;
      } catch {
        return null;
      }
    });
    if (!port) throw new Error('Chromium never wrote DevToolsActivePort');

    const up = await waitFor(deadline, async () => {
      if (!processAlive(pid)) throw died();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
        return res.ok ? true : null;
      } catch {
        return null;
      }
    });
    if (!up) throw new Error(`Chromium CDP did not come up on port ${port}`);

    return { port, pid, profileDir, close };
  } catch (err) {
    await close();
    throw err;
  }
}
