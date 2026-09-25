/**
 * Per-call-site leak probe for #514. Run as a CHILD process by
 * src/model-exec-env-sites.test.ts, for the reason given in
 * spawn-env-sites-probe.ts: Bun spawns an inheriting child from the
 * environment snapshot taken at process start, so a canary assigned to
 * `process.env` inside `bun test` is invisible to exactly the spawns that
 * inherit -- and two of the sites here (launchApp, launchChrome) inherited by
 * omitting `env`. The test launches this file with the canaries and the user
 * variables already in its real startup environment.
 *
 * Each site is pointed at a fake executable the test wrote into `<workDir>/bin`
 * that dumps the environment it received. The fake browser and fake sidecar
 * then hand over to model-exec-fake-server.ts, so that launchChrome and
 * launchSidecar see the port they poll for and return normally.
 *
 * argv: <site> <workDir>
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { TerminalExecutor } from '../actions/terminal/executor.ts';
import { LinuxAppController } from '../actions/app-control/linux.ts';
import { defaultExec } from '../actions/app-control/native-exec.ts';
import { launchChrome, stopChrome } from '../actions/browser/chrome-launcher.ts';
import { launchSidecar, stopSidecar } from '../actions/app-control/sidecar-launcher.ts';
import { sendDesktopNotificationWithReceipt } from '../comms/desktop-notify.ts';

const site = process.argv[2]!;
const workDir = process.argv[3]!;
const bin = (name: string) => join(workDir, 'bin', name);

/** launchApp returns before its child has run; wait for the dump to land. */
async function waitForDump(prefix: string): Promise<void> {
  const { readdirSync } = await import('node:fs');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (readdirSync(join(workDir, 'dumps')).some(f => f.startsWith(`${prefix}.`) && f.endsWith('.env'))) return;
    await Bun.sleep(50);
  }
  throw new Error(`no ${prefix} dump within 10s`);
}

/** A port nothing is listening on, for the fake browser and sidecar to take. */
function freePort(): number {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = s;
  s.stop(true);
  return port;
}

switch (site) {
  // Positive control: the same fake, spawned with an INHERITED env through
  // both APIs the sites use. If canaries do not show up here, the harness is
  // blind and every other result is meaningless.
  case 'control': {
    const p = Bun.spawn([bin('fake-app'), 'control-bun'], { stdout: 'ignore', stderr: 'ignore' });
    await p.exited;
    spawnSync(bin('fake-app'), ['control-node'], { stdio: 'ignore' });
    break;
  }

  // executor.ts: run_command's `$SHELL -c <command>`. No shell option, so the
  // shell comes from SHELL exactly as in production (builtin.ts).
  case 'executor-execute': {
    const result = await new TerminalExecutor().execute('echo model command');
    if (result.exitCode !== 0) throw new Error(`fake shell exited ${result.exitCode}`);
    break;
  }

  // executor.ts: the streaming variant.
  case 'executor-stream': {
    for await (const _ of new TerminalExecutor().stream('echo model command')) { /* drain */ }
    break;
  }

  // linux.ts: desktop_launch_app on Linux, a model-chosen executable.
  case 'linux-launch-app': {
    await new LinuxAppController().launchApp(bin('fake-app'), 'linux-launch-app --flag');
    await waitForDump('linux-launch-app');
    break;
  }

  // native-exec.ts: the seam behind Windows `launch-app` (powershell
  // Start-Process) and macOS `open -a`, and every other fallback script.
  case 'native-exec': {
    const r = defaultExec([bin('fake-app'), 'native-exec'], '');
    if (r.status !== 0) throw new Error(`defaultExec exited ${r.status}: ${r.stderr}`);
    break;
  }

  // chrome-launcher.ts: the browser the model drives over CDP.
  case 'chrome': {
    const running = await launchChrome(freePort(), join(workDir, 'profile'), { kind: 'chromium', path: bin('fake-chrome') });
    await stopChrome(running);
    break;
  }

  // sidecar-launcher.ts: desktop-bridge, which launches apps for the model
  // on Windows and hands them its own environment.
  case 'sidecar': {
    const running = await launchSidecar(freePort(), bin('fake-sidecar'));
    await stopSidecar(running);
    break;
  }

  // desktop-notify.ts: the PowerShell toast, where model- or workflow-authored
  // text is interpolated into a script. The test puts a fake `which` (no
  // notify-send, yes powershell.exe) and a fake powershell.exe first on PATH,
  // which is how this path is chosen on WSL.
  case 'desktop-notify': {
    if (!await sendDesktopNotificationWithReceipt('model title', 'model body')) throw new Error('toast not accepted');
    break;
  }

  default:
    throw new Error(`unknown site: ${site}`);
}

process.exit(0);
