/**
 * Sidecar Launcher — Find, Launch, and Manage the Desktop Bridge
 *
 * Auto-detects the desktop-bridge.exe sidecar, launches it from WSL,
 * and polls TCP to confirm it's ready. Mirrors the pattern in
 * src/actions/browser/chrome-launcher.ts.
 */

import { spawn, type Subprocess } from 'bun';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { WSLBridge, wslInteropExtras } from '../terminal/wsl-bridge.ts';
import { modelExecEnv } from '../../util/model-exec-env.ts';
import { sanitizedEnv } from '../../util/subprocess-env.ts';

export type RunningSidecar = {
  proc: Subprocess | null; // null if externally managed
  port: number;
  host: string;
  startedAt: number;
  exePath: string;
};

const DEFAULT_PORT = 9224;

/**
 * Find the desktop-bridge.exe sidecar on disk.
 * Checks: ~/.jarvis/sidecar/ then repo build output.
 */
export function findSidecarExecutable(): string | null {
  const candidates: string[] = [];

  if (WSLBridge.isWSL()) {
    // WSL: check the Windows-side paths via /mnt/c/
    // First try USERPROFILE-based path (most common)
    try {
      // Not model-directed: a fixed command, so the allowlist plus the WSL
      // interop extras it needs to launch a Windows executable -- the same env
      // as actions/terminal/wsl-bridge.ts (#519).
      // Bounded, because every DesktopController.connect now runs this first
      // (#747) and a hung interop would otherwise hold the daemon's thread:
      // the call measured 38 to 50 ms here, so 5 s only catches a hang.
      const userProfileResult = Bun.spawnSync(['cmd.exe', '/C', 'echo', '%USERPROFILE%'], {
        env: sanitizedEnv(wslInteropExtras()),
        timeout: 5000,
      });
      const userProfile = userProfileResult.stdout.toString().trim();
      if (userProfile && !userProfile.includes('%')) {
        const drive = userProfile.charAt(0).toLowerCase();
        const rest = userProfile.slice(2).replace(/\\/g, '/');
        const wslPath = `/mnt/${drive}${rest}/.jarvis/sidecar/desktop-bridge.exe`;
        candidates.push(wslPath);
      }
    } catch {
      // Fall back to common paths
    }

    candidates.push('/mnt/c/Users/' + (process.env.USER ?? 'user') + '/.jarvis/sidecar/desktop-bridge.exe');
  } else {
    // Native Windows
    candidates.push(join(homedir(), '.jarvis', 'sidecar', 'desktop-bridge.exe'));
  }

  // Legacy build output. Kept only so a desktop-bridge.exe left on disk from
  // before 28e43ed -- which deleted the .NET project that wrote these paths --
  // is still found. Nothing in the repo produces them any more.
  const repoBase = join(import.meta.dir, '../../../sidecar/desktop-bridge');
  candidates.push(join(repoBase, 'bin', 'publish', 'desktop-bridge.exe'));
  candidates.push(join(repoBase, 'bin', 'Release', 'net10.0-windows', 'win-x64', 'publish', 'desktop-bridge.exe'));
  candidates.push(join(repoBase, 'bin', 'Release', 'net9.0-windows', 'win-x64', 'publish', 'desktop-bridge.exe'));
  candidates.push(join(repoBase, 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', 'desktop-bridge.exe'));

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

/**
 * The one host the bridge is looked for on (#800): this machine's loopback.
 *
 * On WSL this used to fall back to the first nameserver in /etc/resolv.conf,
 * which is the Windows host only on a default NAT-mode install. With a custom
 * resolv.conf -- a corporate, public or LAN resolver -- it is another machine,
 * so the ping went there, a launch adopted whatever answered, and every
 * typeText and launchApp argument followed it off the box. A probe that
 * answered there also left the connection aimed at localhost, so the host
 * that was checked was not the host that was used.
 *
 * No other derived address is safe either: the default gateway, the usual
 * alternative, is the LAN router in WSL's mirrored networking mode. So the
 * bridge is reached on loopback or not at all, which is how mirrored mode
 * (where Windows' listeners are this machine's) already worked. NAT-mode WSL,
 * where a Windows-side listener is not on WSL's loopback, can no longer reach
 * the legacy bridge; launchSidecar's error says so.
 *
 * An address, not the name `localhost` (#800 review): the name is resolved on
 * every connect, through /etc/hosts and then DNS, and resolves to ::1 first
 * here, so a listener on [::1]:9224 took the channel even while the real
 * bridge was running -- which bound IPv4 only (`IPAddress.Any`, Program.cs
 * before 28e43ed), so the two binds never conflict.
 */
export const BRIDGE_HOST = '127.0.0.1';

/**
 * Check if the sidecar is already running on the given port.
 */
export async function isSidecarRunning(port: number = DEFAULT_PORT): Promise<boolean> {
  try {
    return await pingTcp(BRIDGE_HOST, port, 2000);
  } catch {
    return false;
  }
}

/**
 * Launch the desktop-bridge sidecar.
 * Auto-detects the executable and spawns it. `exeOverride` is a test seam
 * (src/model-exec-env-sites.test.ts).
 */
export async function launchSidecar(port: number = DEFAULT_PORT, exeOverride?: string, readyTimeoutMs = 10_000): Promise<RunningSidecar> {
  const exePath = exeOverride ?? findSidecarExecutable();
  if (!exePath) {
    // There is no build command to name any more: the .NET desktop-bridge
    // project this hunts for was deleted in 28e43ed, and the Go sidecar that
    // replaced it is a different program (binary `jarvis`, shipped as the
    // @usejarvis/sidecar-* packages) speaking a different protocol. Naming a
    // script that does not exist is worse than saying where the file belongs.
    throw new Error(
      'Desktop bridge sidecar not found: no desktop-bridge.exe at any known path.\n' +
      'Expected at %USERPROFILE%\\.jarvis\\sidecar\\desktop-bridge.exe.\n' +
      'This repo no longer builds it; place the executable there to enable the sidecar.'
    );
  }

  console.log(`[SidecarLauncher] Launching: ${exePath}`);

  // Spawn the sidecar
  const proc = spawn([exePath, '--port', String(port)], {
    stdout: 'ignore',
    stderr: 'ignore',
    // desktop-bridge serves launchApp and hands its own environment to the
    // model-chosen executable, so it gets the desktop session without the
    // daemon's secrets (#514; see util/model-exec-env.ts). On WSL only the
    // WSLENV-listed names cross to Windows anyway; on native Windows this is
    // the whole environment.
    env: modelExecEnv(),
  });

  const startedAt = Date.now();

  // Poll TCP until the deadline (10s unless a test says otherwise).
  const deadline = Date.now() + readyTimeoutMs;
  let reachable = false;

  while (Date.now() < deadline) {
    try {
      if (await pingTcp(BRIDGE_HOST, port, 1000)) {
        reachable = true;
        break;
      }
    } catch {
      // Not ready yet
    }

    await Bun.sleep(300);
  }

  if (!reachable) {
    try { proc.kill(); } catch {}
    throw new Error(
      `Sidecar started but not reachable on ${BRIDGE_HOST}:${port} after ${Math.round(readyTimeoutMs / 1000)}s.\n` +
      `Binary: ${exePath}` +
      (WSLBridge.isWSL()
        ? '\nOn WSL the bridge is only looked for on loopback (127.0.0.1), which reaches Windows only with ' +
          'networkingMode=mirrored in .wslconfig; NAT mode is not supported.'
        : '')
    );
  }

  console.log(`[SidecarLauncher] Sidecar ready on ${BRIDGE_HOST}:${port} (pid ${proc.pid})`);

  return { proc, port, host: BRIDGE_HOST, startedAt, exePath };
}

/**
 * Stop a running sidecar. Sends shutdown command, then kills process.
 */
export async function stopSidecar(running: RunningSidecar): Promise<void> {
  // Try graceful shutdown via JSON-RPC
  try {
    const shutdown = JSON.stringify({ jsonrpc: '2.0', method: 'shutdown', params: {}, id: 0 }) + '\n';
    await sendTcpRaw(running.host, running.port, shutdown, 2000);
  } catch {
    // ignore
  }

  // Kill process if we spawned it
  if (running.proc) {
    try { running.proc.kill(); } catch {}

    // Wait for exit
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (running.proc.exitCode !== null) break;
      await Bun.sleep(100);
    }

    try { running.proc.kill(9); } catch {}
  }

  console.log('[SidecarLauncher] Sidecar stopped');
}

// --- TCP helpers ---

/**
 * The longest first line a ping reply may take. The bridge's reply was
 * `{"jsonrpc":"2.0","result":"pong","id":-1}` and a line end (Program.cs
 * before 28e43ed), about 45 bytes; this leaves room and no more. Without it a
 * peer could stream into the probe for its whole timeout (#800 review).
 */
const MAX_PING_REPLY_CHARS = 4096;

/**
 * Whether one reply line is the bridge's answer to this ping: its result
 * `pong`, under the ping's own id. It used to be any reply containing the
 * text "pong" anywhere. This is not authentication -- anything can send the
 * exact line -- only an end to accepting what merely mentions the word.
 */
// trim() also strips a leading U+FEFF, which a .NET writer can emit.
function isPongReply(line: string): boolean {
  try {
    const reply = JSON.parse(line.trim()) as { result?: unknown; id?: unknown } | null;
    return reply?.result === 'pong' && reply.id === -1;
  } catch {
    return false;
  }
}

function pingTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let safety: ReturnType<typeof setTimeout> | undefined;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(safety);
      socket.destroy();
      resolve(alive);
    };

    const socket = createConnection({ host, port, timeout: timeoutMs }, () => {
      // Send ping JSON-RPC
      const ping = JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {}, id: -1 }) + '\n';
      socket.write(ping);
    });

    let data = '';

    socket.on('data', (chunk) => {
      data += chunk.toString();
      const end = data.indexOf('\n');
      // Only the first line is the reply; past the cap without one, it is not.
      if (end >= 0) finish(isPongReply(data.slice(0, end)));
      else if (data.length > MAX_PING_REPLY_CHARS) finish(false);
    });

    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
    socket.on('close', () => finish(false));

    // Safety timeout
    safety = setTimeout(() => finish(false), timeoutMs + 500);
  });
}

function sendTcpRaw(host: string, port: number, data: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port, timeout: timeoutMs }, () => {
      socket.write(data, () => {
        socket.destroy();
        resolve();
      });
    });
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Timeout'));
    });
  });
}
