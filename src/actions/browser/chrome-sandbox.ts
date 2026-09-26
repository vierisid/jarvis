/**
 * Whether a Linux Chrome launch can keep Chrome's sandbox (#521).
 *
 * Every Linux launch used to pass `--no-sandbox` ("Required for Chromium in
 * containers/WSL2", added with the first browser milestone and never
 * revisited). Without the sandbox a renderer exploit on any page the model
 * visits runs with the daemon user's full privileges -- its files, its
 * ~/.jarvis, its credentials. On an ordinary desktop the sandbox just works,
 * so it is now kept unless it provably cannot start.
 *
 * When it cannot, it is one of two things:
 *   - Running as root. Chrome refuses to start sandboxed as root ("Running as
 *     root without --no-sandbox is not supported").
 *   - No usable sandbox. Chrome's Linux sandbox needs unprivileged user
 *     namespaces, or the setuid `chrome-sandbox` helper as a fallback. Both
 *     are missing in a container with the default seccomp profile, and on
 *     Ubuntu 23.10+ when AppArmor restricts user namespaces and this Chrome
 *     has no AppArmor profile. Chrome then exits at startup with "No usable
 *     sandbox!".
 *
 * Rather than re-derive Chrome's own checks from sysctls, seccomp and AppArmor
 * state -- which differ per distro and per Chrome build -- this asks Chrome: a
 * short headless run with the sandbox on. If it starts, the sandbox works. If
 * it dies naming the sandbox, it does not, and the reason is logged. Any other
 * failure keeps the sandbox: `--no-sandbox` would not fix it, and the real
 * launch will report it. The answer is cached per executable for the life of
 * the process, so the probe runs once, not per launch.
 *
 * Escape hatch: JARVIS_BROWSER_NO_SANDBOX=1 forces `--no-sandbox` without a
 * probe, for a host where the probe passes but the real launch still cannot
 * start sandboxed. It is logged like any other reason.
 *
 * Windows and macOS are not probed: their sandboxes need nothing from the
 * environment, and `--no-sandbox` was never passed there. Neither is a Windows
 * chrome.exe launched from WSL, which is sandboxed by Windows.
 */

import { spawn } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizedEnv } from '../../util/subprocess-env.ts';

export type SandboxDecision =
  | { sandbox: true }
  | { sandbox: false; reason: string };

export type ProbeResult = { exitCode: number | null; stderr: string; timedOut: boolean };

export type SandboxDeps = {
  getuid: () => number | undefined;
  /** null: do not probe (see linuxSandboxDecision's `probe` option). */
  probe: ((exePath: string) => Promise<ProbeResult>) | null;
};

const PROBE_TIMEOUT_MS = 20_000;
/** After the browser exits, how long to wait for its stderr to reach EOF. */
const STDERR_GRACE_MS = 2_000;

/**
 * What Chrome prints when it cannot start sandboxed and exits. Deliberately
 * narrow: Chrome logs harmless lines that mention the sandbox too (e.g.
 * "InitializeSandbox() called with multiple threads"), and a crash for some
 * other reason must not turn the sandbox off.
 */
const SANDBOX_FATAL = /No usable sandbox|--no-sandbox is not supported|SUID sandbox helper|setuid sandbox|Failed to move to new namespace/i;

const cache = new Map<string, Promise<SandboxDecision>>();

/**
 * Decide once per executable; see the module comment.
 *
 * `probe: false` skips the probe launch, keeping the sandbox unless running as
 * root or overridden. launchChrome passes it for an executable it did not
 * detect itself -- a caller-supplied binary (a test seam) is not a Chrome, and
 * running it an extra time to ask about the sandbox would be a second launch
 * nobody asked for.
 */
export function linuxSandboxDecision(exePath: string, opts: { probe?: boolean } = {}): Promise<SandboxDecision> {
  if (opts.probe === false) {
    return decideSandbox(exePath, { getuid: () => process.getuid?.(), probe: null });
  }
  let decision = cache.get(exePath);
  if (!decision) {
    decision = decideSandbox(exePath);
    cache.set(exePath, decision);
  }
  return decision;
}

/** Exported for tests, with the environment injected. */
export async function decideSandbox(
  exePath: string,
  deps: SandboxDeps = { getuid: () => process.getuid?.(), probe: probeSandboxedLaunch },
): Promise<SandboxDecision> {
  // A Windows chrome.exe reached through WSL interop: Windows sandboxes it.
  if (exePath.toLowerCase().endsWith('.exe')) return { sandbox: true };

  if (process.env.JARVIS_BROWSER_NO_SANDBOX === '1') {
    return { sandbox: false, reason: 'JARVIS_BROWSER_NO_SANDBOX=1 is set' };
  }

  if (deps.getuid() === 0) {
    return { sandbox: false, reason: 'the daemon runs as root, and Chrome will not start its sandbox as root' };
  }

  if (!deps.probe) return { sandbox: true };

  let result: ProbeResult;
  try {
    result = await deps.probe(exePath);
  } catch (err) {
    console.warn(`[ChromeLauncher] Sandbox probe could not run (${err instanceof Error ? err.message : String(err)}); keeping the sandbox`);
    return { sandbox: true };
  }
  if (result.exitCode === 0) return { sandbox: true };

  const line = result.stderr
    .split('\n')
    .find(l => SANDBOX_FATAL.test(l));
  if (!result.timedOut && line) {
    return {
      sandbox: false,
      reason: `Chrome could not start its sandbox here (${line.replace(/^\[[^\]]*\]\s*/, '').trim().slice(0, 300)})`,
    };
  }
  console.warn(
    `[ChromeLauncher] Sandbox probe failed for another reason (${result.timedOut ? 'timed out' : `exit ${result.exitCode}`}); ` +
    'keeping the sandbox',
  );
  return { sandbox: true };
}

/**
 * Start Chrome headless, sandboxed, on an empty page with a throwaway profile,
 * and report how it exited. Loads nothing from the network or the disk.
 *
 * It runs in its own process group, and the whole group is killed on the way
 * out: a SIGKILL to the browser alone would leave its zygote, renderers or
 * crash handler orphaned to PID 1. Waiting is bounded twice over -- the
 * timeout for the browser, a short grace for stderr -- because a surviving
 * child can hold the stderr pipe open indefinitely, and the answer is cached,
 * so a hang here would hang every later launch.
 */
async function probeSandboxedLaunch(exePath: string): Promise<ProbeResult> {
  const profile = mkdtempSync(join(tmpdir(), 'jarvis-sandbox-probe-'));
  const proc = spawn([
    exePath,
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--dump-dom',
    'about:blank',
  ], {
    stdout: 'ignore',
    stderr: 'pipe',
    // Fixed argv, no model input; nothing here needs the daemon's secrets.
    env: sanitizedEnv(),
    detached: true,
  });
  const killGroup = () => {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* group already gone */ }
    try { proc.kill(9); } catch { /* already gone */ }
  };
  let stderr = '';
  const stderrDone = new Response(proc.stderr).text().then(t => { stderr = t; }, () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      new Promise<boolean>(res => { timer = setTimeout(() => res(true), PROBE_TIMEOUT_MS); }),
    ]);
    // Whatever is left of the group goes now, which also closes the pipe.
    killGroup();
    await Promise.race([stderrDone, Bun.sleep(STDERR_GRACE_MS)]);
    return { exitCode: timedOut ? null : proc.exitCode, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    killGroup();
    rmSync(profile, { recursive: true, force: true });
  }
}
