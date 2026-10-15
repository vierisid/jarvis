/**
 * #521: Linux launches keep Chrome's sandbox unless it provably cannot start.
 *
 * The decision logic is tested with the environment injected. The last block
 * launches a real Chromium through launchChrome -- headless (DISPLAY is
 * removed for the duration), random port, throwaway profile, killed in
 * afterAll or, if the run is killed first, by the fixture's watchdog -- and
 * checks the running browser against the decision: when the sandbox was
 * kept, the main process has no --no-sandbox and its renderers run under a
 * seccomp filter.
 */
import { describe, test, expect, afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideSandbox, linuxSandboxDecision, type ProbeResult } from './chrome-sandbox.ts';
import { findBrowserExecutable, launchChrome, stopChrome, type RunningBrowser } from './chrome-launcher.ts';
import { watchBrowser } from './fixtures/headless-chromium.ts';

function freePort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

function deps(uid: number | undefined, probe: ProbeResult | Error) {
  let probed = 0;
  return {
    get probed() { return probed; },
    getuid: () => uid,
    probe: async () => {
      probed++;
      if (probe instanceof Error) throw probe;
      return probe;
    },
  };
}

describe('decideSandbox (#521)', () => {
  // The override is read from the environment; a developer who exported it
  // must not see these fail. The override test sets it itself.
  let savedOverride: string | undefined;
  beforeEach(() => {
    savedOverride = process.env.JARVIS_BROWSER_NO_SANDBOX;
    delete process.env.JARVIS_BROWSER_NO_SANDBOX;
  });
  afterEach(() => {
    if (savedOverride === undefined) delete process.env.JARVIS_BROWSER_NO_SANDBOX;
    else process.env.JARVIS_BROWSER_NO_SANDBOX = savedOverride;
  });

  test('keeps the sandbox when a sandboxed probe starts', async () => {
    const d = deps(1000, { exitCode: 0, stderr: '', timedOut: false });
    expect(await decideSandbox('/usr/bin/chromium', d)).toEqual({ sandbox: true });
    expect(d.probed).toBe(1);
  });

  test('drops it as root without probing', async () => {
    const d = deps(0, { exitCode: 0, stderr: '', timedOut: false });
    const r = await decideSandbox('/usr/bin/chromium', d);
    expect(r.sandbox).toBe(false);
    expect(!r.sandbox && r.reason).toMatch(/root/);
    expect(d.probed).toBe(0);
  });

  test('drops it when Chrome says there is no usable sandbox, and says why', async () => {
    const stderr = '[1:1:0101/000000.000000:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+ ...\n';
    const r = await decideSandbox('/usr/bin/chromium', deps(1000, { exitCode: 133, stderr, timedOut: false }));
    expect(r.sandbox).toBe(false);
    expect(!r.sandbox && r.reason).toMatch(/^Chrome could not start its sandbox here \(No usable sandbox!/);
  });

  test('keeps it when the probe fails for an unrelated reason', async () => {
    const missingLib = 'error while loading shared libraries: libnss3.so: cannot open shared object file\n';
    expect(await decideSandbox('/usr/bin/chromium', deps(1000, { exitCode: 127, stderr: missingLib, timedOut: false }))).toEqual({ sandbox: true });
    // A timeout is not evidence about the sandbox, whatever stderr said so far.
    expect(await decideSandbox('/usr/bin/chromium', deps(1000, { exitCode: null, stderr: 'sandbox', timedOut: true }))).toEqual({ sandbox: true });
    expect(await decideSandbox('/usr/bin/chromium', deps(1000, new Error('spawn failed')))).toEqual({ sandbox: true });
  });

  test('JARVIS_BROWSER_NO_SANDBOX=1 forces it off, with that as the reason', async () => {
    process.env.JARVIS_BROWSER_NO_SANDBOX = '1';
    const d = deps(1000, { exitCode: 0, stderr: '', timedOut: false });
    expect(await decideSandbox('/usr/bin/chromium', d)).toEqual({ sandbox: false, reason: 'JARVIS_BROWSER_NO_SANDBOX=1 is set' });
    expect(d.probed).toBe(0);
  });

  test('a harmless sandbox log line on an unrelated crash does not turn it off', async () => {
    const stderr = '[1:1:0101/000000.000000:ERROR:sandbox_linux.cc(418)] InitializeSandbox() called with multiple threads in process gpu-process.\nSegmentation fault\n';
    expect(await decideSandbox('/usr/bin/chromium', deps(1000, { exitCode: 139, stderr, timedOut: false }))).toEqual({ sandbox: true });
  });

  test('probe: false (an executable launchChrome did not detect) never launches it, and keeps root and the override', async () => {
    // A caller-supplied binary -- #514's env-dumping fake Chrome -- must not
    // be run an extra time just to ask about the sandbox.
    const neverRun = '/nonexistent/fake-chrome';
    expect(await linuxSandboxDecision(neverRun, { probe: false })).toEqual(
      process.getuid?.() === 0
        ? { sandbox: false, reason: 'the daemon runs as root, and Chrome will not start its sandbox as root' }
        : { sandbox: true },
    );
    process.env.JARVIS_BROWSER_NO_SANDBOX = '1';
    expect(await linuxSandboxDecision(neverRun, { probe: false })).toEqual({ sandbox: false, reason: 'JARVIS_BROWSER_NO_SANDBOX=1 is set' });
    delete process.env.JARVIS_BROWSER_NO_SANDBOX;
    expect(await decideSandbox('/usr/bin/chromium', { getuid: () => 0, probe: null })).toMatchObject({ sandbox: false, reason: expect.stringMatching(/root/) });
  });

  test("a Windows chrome.exe reached from WSL keeps Windows' sandbox, unprobed", async () => {
    const d = deps(0, { exitCode: 1, stderr: 'No usable sandbox!', timedOut: false });
    expect(await decideSandbox('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', d)).toEqual({ sandbox: true });
    expect(d.probed).toBe(0);
  });
});

const isWSL = existsSync('/proc/version') && readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft');
const exe = process.platform === 'linux' && !isWSL ? findBrowserExecutable() : null;

/**
 * The cleanup hook below waits for Chrome's children, and that wait must stay
 * SHORTER than the hook's own budget. They used to be identical -- 50 x 100ms
 * against Bun's 5000ms default -- so exhausting the wait always failed the hook
 * at ~5000ms, reported as `(unnamed)` because hook failures carry no test name.
 * That blocked release dry run 37930279805, and `--retry=2` (added in #784 so a
 * Chromium flake could not block a release) does not retry hooks.
 *
 * Derived from the source rather than restated, so raising the loop bound
 * without raising the budget fails here instead of in a release.
 */
test('the cleanup wait is bounded below the hook budget it runs under', () => {
  const src = readFileSync(new URL(import.meta.url).pathname, 'utf-8');
  const loop = /for \(let i = 0; i < (\d+) && profileProcesses\(\)\.length > 0; i\+\+\) await Bun\.sleep\((\d+)\)/.exec(src);
  const budget = /await watch\?\.release\(\);\s*\},\s*([\d_]+)\)/.exec(src);
  const iterations = loop?.[1];
  const step = loop?.[2];
  const budgetMs = budget?.[1];
  // A throw, not an assertion: if the shapes stop matching, this test would
  // otherwise pass while measuring nothing, which is the failure mode it exists
  // to prevent.
  if (iterations === undefined || step === undefined || budgetMs === undefined) {
    throw new Error('could not read the wait or the hook budget out of this file');
  }
  const worstCaseWait = Number(iterations) * Number(step);
  const hookBudget = Number(budgetMs.replace(/_/g, ''));
  expect(worstCaseWait).toBe(5000);
  expect(hookBudget).toBeGreaterThan(worstCaseWait);
});

describe.skipIf(!exe)('launchChrome on this host (#521, real headless Chromium)', () => {
  // Asked of the kernel, not picked at random: a random port in the
  // ephemeral range can collide with another test's server, and Chrome then
  // runs on without its DevTools port, which reads as a launch failure.
  const port = freePort();
  // Created in beforeAll, not in the describe body: Bun runs the body of a
  // skipped or filtered describe but not its afterAll.
  let profile = '';
  let running: RunningBrowser | null = null;
  let watch: { release(): Promise<void> } | null = null;

  beforeAll(() => {
    profile = mkdtempSync(join(tmpdir(), 'jarvis-sandbox-launch-'));
  });

  // A SIGKILLed test run skips this afterAll. launchChrome owns the spawn, so
  // the browser cannot run under launchTestChromium's watchdog; watchBrowser
  // from the same fixture ties it to this process once it is up instead.
  // The timeout is explicit because the wait below is bounded at 50 x 100ms =
  // 5000ms, which is EXACTLY Bun's default per-hook budget. So whenever Chrome's
  // children linger long enough for that loop to run to completion, the hook was
  // guaranteed to fail at ~5000ms -- not a race with slack, the two numbers were
  // identical. It failed that way in release dry run 37930279805 at 5000.19ms,
  // and blocked the run: `--retry=2` (added in #784 so a Chromium flake could
  // not block a release) does not retry HOOK failures, which is also why the
  // failure is reported as `(unnamed)` with no attempt markers.
  afterAll(async () => {
    if (running) await stopChrome(running);
    if (!profile) return;
    // stopChrome kills the browser process; its children follow within a
    // moment. Remove the profile only once none is left to recreate files.
    for (let i = 0; i < 50 && profileProcesses().length > 0; i++) await Bun.sleep(100);
    for (const pid of profileProcesses()) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(profile, { recursive: true, force: true });
    await watch?.release();
  }, 20_000);

  function profileProcesses(): number[] {
    return readdirSync('/proc').filter(d => /^\d+$/.test(d)).map(Number)
      .filter(pid => argv(pid).some(a => a === `--user-data-dir=${profile}`));
  }

  // Chrome rewrites its process title, so /proc/<pid>/cmdline can be one
  // space-joined string rather than NUL-separated argv. Split on both.
  function argv(pid: number): string[] {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split(/[\0 ]/).filter(Boolean); } catch { return []; }
  }

  test('passes --no-sandbox only when the probe says the sandbox cannot start', async () => {
    const decision = await linuxSandboxDecision(exe!.path);
    if (!decision.sandbox) {
      // Legitimate on hosts without user namespaces (CI containers); the
      // reason must say so rather than being a generic failure.
      expect(decision.reason).toMatch(/root|sandbox/i);
    }

    // launchChrome goes headless only without a display. Never open a window
    // on a developer's desktop.
    const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      running = await launchChrome(port, profile);
      watch = watchBrowser(running.proc.pid, profile);
    } finally {
      if (saved.DISPLAY !== undefined) process.env.DISPLAY = saved.DISPLAY;
      if (saved.WAYLAND_DISPLAY !== undefined) process.env.WAYLAND_DISPLAY = saved.WAYLAND_DISPLAY;
    }

    const main = argv(running.proc.pid);
    expect(main).toContain('--headless=new');
    expect(main.includes('--no-sandbox')).toBe(!decision.sandbox);

    if (decision.sandbox) {
      // The sandbox is really on: renderers of this browser run under
      // seccomp-bpf (Seccomp: 2). With --no-sandbox they report 0.
      let renderers: number[] = [];
      for (let i = 0; i < 50 && renderers.length === 0; i++) {
        renderers = profileProcesses().filter(pid => argv(pid).includes('--type=renderer'));
        if (renderers.length === 0) await Bun.sleep(100);
      }
      expect(renderers.length).toBeGreaterThan(0);
      for (const pid of renderers) {
        const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
        expect(status).toMatch(/^Seccomp:\s+2$/m);
      }
    }
  }, 60_000);
});
