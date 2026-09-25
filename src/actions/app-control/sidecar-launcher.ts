/**
 * Sidecar Launcher — Find, Launch, and Manage the Desktop Bridge
 *
 * Auto-detects the desktop-bridge.exe sidecar, launches it from WSL,
 * and polls TCP to confirm it's ready. Mirrors the pattern in
 * src/actions/browser/chrome-launcher.ts.
 */

import { spawn, type Subprocess } from 'bun';
import { existsSync, readFileSync } from 'node:fs';
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
      const userProfileResult = Bun.spawnSync(['cmd.exe', '/C', 'echo', '%USERPROFILE%'], {
        env: sanitizedEnv(wslInteropExtras()),
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

  // Also check repo build output (both custom -o path and default dotnet publish path)
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
 * Get the Windows host IP when WSL2 doesn't have mirrored networking.
 * Parses /etc/resolv.conf for the nameserver entry.
 */
export function getWSLHostIP(): string {
  try {
    const resolv = readFileSync('/etc/resolv.conf', 'utf-8');
    const match = resolv.match(/nameserver\s+(\d+\.\d+\.\d+\.\d+)/);
    if (match) {
      return match[1]!;
    }
  } catch {
    // ignore
  }
  return 'localhost';
}

/**
 * Determine the host to connect to the sidecar.
 * With WSL2 mirrored networking, localhost works.
 * Without it, we use the Windows host IP.
 */
function getSidecarHost(): string {
  if (!WSLBridge.isWSL()) {
    return 'localhost';
  }

  // Check if mirrored networking is active (localhost works)
  // WSL2 mirrored mode sets networkingMode in .wslconfig
  // Simplest check: if localhost resolves to Windows, it's mirrored
  // For now, try localhost first; the connect logic handles fallback
  return 'localhost';
}

/**
 * Check if the sidecar is already running on the given port.
 */
export async function isSidecarRunning(port: number = DEFAULT_PORT): Promise<boolean> {
  const host = getSidecarHost();
  const hosts = [host];

  // If on WSL and host is localhost, also try the WSL host IP as fallback
  if (WSLBridge.isWSL() && host === 'localhost') {
    const hostIP = getWSLHostIP();
    if (hostIP !== 'localhost') {
      hosts.push(hostIP);
    }
  }

  for (const h of hosts) {
    try {
      const alive = await pingTcp(h, port, 2000);
      if (alive) return true;
    } catch {
      // Try next host
    }
  }

  return false;
}

/**
 * Launch the desktop-bridge sidecar.
 * Auto-detects the executable and spawns it. `exeOverride` is a test seam
 * (src/model-exec-env-sites.test.ts).
 */
export async function launchSidecar(port: number = DEFAULT_PORT, exeOverride?: string): Promise<RunningSidecar> {
  const exePath = exeOverride ?? findSidecarExecutable();
  if (!exePath) {
    throw new Error(
      'Desktop bridge sidecar not found.\n' +
      'Build it with: bun run scripts/build-sidecar.ts\n' +
      'Requires .NET 8 SDK on Windows.'
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
  const host = getSidecarHost();

  // Poll TCP for up to 10s
  const deadline = Date.now() + 10_000;
  let reachable = false;
  let connectedHost = host;

  while (Date.now() < deadline) {
    try {
      if (await pingTcp(host, port, 1000)) {
        reachable = true;
        connectedHost = host;
        break;
      }
    } catch {
      // Not ready yet
    }

    // Also try WSL host IP if localhost fails
    if (WSLBridge.isWSL() && host === 'localhost') {
      const hostIP = getWSLHostIP();
      if (hostIP !== 'localhost') {
        try {
          if (await pingTcp(hostIP, port, 1000)) {
            reachable = true;
            connectedHost = hostIP;
            break;
          }
        } catch {
          // Not ready
        }
      }
    }

    await Bun.sleep(300);
  }

  if (!reachable) {
    try { proc.kill(); } catch {}
    throw new Error(
      `Sidecar started but not reachable on port ${port} after 10s.\n` +
      `Binary: ${exePath}`
    );
  }

  console.log(`[SidecarLauncher] Sidecar ready on ${connectedHost}:${port} (pid ${proc.pid})`);

  return { proc, port, host: connectedHost, startedAt, exePath };
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

function pingTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs }, () => {
      // Send ping JSON-RPC
      const ping = JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {}, id: -1 }) + '\n';
      socket.write(ping);
    });

    let data = '';

    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('pong')) {
        socket.destroy();
        resolve(true);
      }
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    // Safety timeout
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs + 500);
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
