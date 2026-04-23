/**
 * Autostart Setup for J.A.R.V.I.S.
 *
 * Installs/uninstalls keepalive daemon autostart:
 * - Linux: systemd user service
 * - macOS: launchd user agent
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { c, printOk, printErr, printWarn } from './helpers.ts';

function canSpawnBinary(binary: string): boolean {
  try {
    return Boolean(Bun.which(binary));
  } catch {
    return false;
  }
}

function spawnDetachedShell(command: string, requiredBinaries: string[]): boolean {
  if (!requiredBinaries.every(canSpawnBinary)) {
    return false;
  }

  try {
    const child = spawn('bash', ['-lc', command], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    if (child.pid == null) {
      return false;
    }
    child.once('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function getBunPath(): string {
  try {
    return Bun.which('bun') ?? 'bun';
  } catch {
    return 'bun';
  }
}

function getJarvisPath(): string {
  // When installed globally, import.meta.dir points to the package
  return join(import.meta.dir, '../../bin/jarvis.ts');
}

export type SpawnResultLike = {
  exitCode: number;
  stdout?: Uint8Array | ArrayBuffer | null;
  stderr?: Uint8Array | ArrayBuffer | null;
};

export type SpawnSyncFn = (cmd: string[], opts?: { stdout?: 'ignore'; stderr?: 'ignore' }) => SpawnResultLike;

const defaultSpawnSync: SpawnSyncFn = (cmd, opts) => Bun.spawnSync(cmd, opts as never) as unknown as SpawnResultLike;

export type SystemdProbeResult = { supported: boolean; reason?: string };

function firstNonEmpty(...outputs: (Uint8Array | ArrayBuffer | null | undefined)[]): string {
  for (const o of outputs) {
    const text = decodeLaunchctlOutput(o).trim();
    if (text) return text.split('\n')[0]!.slice(0, 200);
  }
  return '';
}

export function probeSystemdUserService(spawnSync: SpawnSyncFn = defaultSpawnSync): SystemdProbeResult {
  try {
    const version = spawnSync(['systemctl', '--user', '--version']);
    if (version.exitCode !== 0) {
      return { supported: false, reason: firstNonEmpty(version.stderr, version.stdout) || 'systemctl --user not available' };
    }

    const state = spawnSync(['systemctl', '--user', 'is-system-running']);
    // "running" exits 0, degraded/offline can still manage units and usually exits non-zero.
    // We only need the user manager to be reachable, not fully healthy.
    if (state.exitCode === 0) return { supported: true };

    const env = spawnSync(['systemctl', '--user', 'show-environment']);
    if (env.exitCode === 0) return { supported: true };

    return {
      supported: false,
      reason: firstNonEmpty(env.stderr, env.stdout, state.stderr, state.stdout) || 'user systemd manager unreachable',
    };
  } catch (err) {
    return { supported: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function canUseSystemdUserService(spawnSync: SpawnSyncFn = defaultSpawnSync): boolean {
  return probeSystemdUserService(spawnSync).supported;
}

// ── systemd (Linux) ──────────────────────────────────────────────────

const SYSTEMD_DIR = join(homedir(), '.config', 'systemd', 'user');
const SYSTEMD_SERVICE = join(SYSTEMD_DIR, 'jarvis.service');

function generateSystemdUnit(): string {
  const bunPath = getBunPath();
  const jarvisPath = getJarvisPath();

  return `[Unit]
Description=J.A.R.V.I.S. Daemon
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} ${jarvisPath} start --foreground
Restart=on-failure
RestartSec=5
Environment=HOME=${homedir()}

[Install]
WantedBy=default.target
`;
}

async function installSystemd(): Promise<boolean> {
  try {
    if (!existsSync(SYSTEMD_DIR)) {
      mkdirSync(SYSTEMD_DIR, { recursive: true });
    }

    writeFileSync(SYSTEMD_SERVICE, generateSystemdUnit(), 'utf-8');

    // Reload systemd and enable
    const reload = Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);
    if (reload.exitCode !== 0) {
      printErr('Failed to reload systemd. You may need to run: systemctl --user daemon-reload');
      return false;
    }

    const enable = Bun.spawnSync(['systemctl', '--user', 'enable', 'jarvis.service']);
    if (enable.exitCode !== 0) {
      printErr('Failed to enable service. You may need to run: systemctl --user enable jarvis.service');
      return false;
    }

    // Enable lingering so the service runs even when not logged in
    const lingering = Bun.spawnSync(['loginctl', 'enable-linger', process.env.USER ?? '']);
    if (lingering.exitCode !== 0) {
      printWarn('Could not enable lingering. Service may stop when you log out.');
    }

    printOk(`Installed systemd service: ${SYSTEMD_SERVICE}`);
    printOk('Service will restart automatically and start on boot.');
    return true;
  } catch (err) {
    printErr(`Failed to install systemd service: ${err}`);
    return false;
  }
}

async function startSystemdService(): Promise<boolean> {
  try {
    const start = Bun.spawnSync(['systemctl', '--user', 'start', 'jarvis.service']);
    if (start.exitCode !== 0) {
      printErr('Failed to start systemd service. You may need to run: systemctl --user start jarvis.service');
      return false;
    }

    printOk('JARVIS keepalive service is running.');
    return true;
  } catch (err) {
    printErr(`Failed to start systemd service: ${err}`);
    return false;
  }
}

export function scheduleSystemdRestart(spawnSync: SpawnSyncFn = defaultSpawnSync): boolean {
  // --no-block returns immediately; systemd queues the restart through its own
  // lifecycle, so the calling HTTP handler can return before the unit cycles.
  try {
    const res = spawnSync(['systemctl', '--user', '--no-block', 'restart', 'jarvis.service']);
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

async function uninstallSystemd(): Promise<boolean> {
  try {
    Bun.spawnSync(['systemctl', '--user', 'stop', 'jarvis.service']);
    Bun.spawnSync(['systemctl', '--user', 'disable', 'jarvis.service']);

    if (existsSync(SYSTEMD_SERVICE)) {
      unlinkSync(SYSTEMD_SERVICE);
    }

    Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);
    printOk('Uninstalled systemd service.');
    return true;
  } catch (err) {
    printErr(`Failed to uninstall systemd service: ${err}`);
    return false;
  }
}

function isSystemdInstalled(): boolean {
  return existsSync(SYSTEMD_SERVICE);
}

// ── launchd (macOS) ──────────────────────────────────────────────────

const LAUNCHD_DIR = join(homedir(), 'Library', 'LaunchAgents');
const LAUNCHD_PLIST = join(LAUNCHD_DIR, 'ai.jarvis.daemon.plist');

function generateLaunchdPlist(): string {
  const bunPath = getBunPath();
  const jarvisPath = getJarvisPath();
  const logDir = join(homedir(), '.jarvis', 'logs');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.jarvis.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${jarvisPath}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/jarvis.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/jarvis-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${join(homedir(), '.bun', 'bin')}</string>
  </dict>
</dict>
</plist>
`;
}

async function installLaunchd(): Promise<boolean> {
  try {
    if (!existsSync(LAUNCHD_DIR)) {
      mkdirSync(LAUNCHD_DIR, { recursive: true });
    }

    // Ensure log directory exists
    const logDir = join(homedir(), '.jarvis', 'logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    writeFileSync(LAUNCHD_PLIST, generateLaunchdPlist(), 'utf-8');

    printOk(`Installed launchd plist: ${LAUNCHD_PLIST}`);
    printOk('Service will restart automatically and stay running after the terminal closes.');
    return true;
  } catch (err) {
    printErr(`Failed to install launchd plist: ${err}`);
    return false;
  }
}

const utf8Decoder = new TextDecoder('utf-8');

export function decodeLaunchctlOutput(output: Uint8Array | ArrayBuffer | null | undefined): string {
  if (!output) {
    return '';
  }

  try {
    return utf8Decoder.decode(output);
  } catch {
    return '';
  }
}

export function isLaunchdAlreadyLoaded(result: SpawnResultLike): boolean {
  if (result.exitCode === 0) {
    return false;
  }

  const combinedOutput = `${decodeLaunchctlOutput(result.stdout)}\n${decodeLaunchctlOutput(result.stderr)}`.toLowerCase();
  return (
    combinedOutput.includes('already loaded') ||
    combinedOutput.includes('service already loaded') ||
    combinedOutput.includes('already bootstrapped') ||
    combinedOutput.includes('service already exists')
  );
}

function launchctlReason(result: SpawnResultLike): string {
  const combined = `${decodeLaunchctlOutput(result.stderr)}\n${decodeLaunchctlOutput(result.stdout)}`.trim();
  const first = combined.split('\n').find((line) => line.trim().length > 0);
  return (first ?? `exit ${result.exitCode}`).slice(0, 200);
}

async function startLaunchdService(): Promise<boolean> {
  try {
    const getuid = process.getuid;
    const uid = typeof getuid === 'function' ? getuid.call(process) : undefined;

    let bootstrapReason: string | null = null;
    if (typeof uid === 'number') {
      const bootstrap = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, LAUNCHD_PLIST]);
      if (bootstrap.exitCode === 0 || isLaunchdAlreadyLoaded(bootstrap)) {
        printOk('JARVIS launch agent is running.');
        return true;
      }
      bootstrapReason = launchctlReason(bootstrap);
    } else {
      bootstrapReason = 'could not determine current user UID';
      printWarn('Skipping launchctl bootstrap — no UID; falling back to launchctl load.');
    }

    const load = Bun.spawnSync(['launchctl', 'load', LAUNCHD_PLIST]);
    if (load.exitCode !== 0 && !isLaunchdAlreadyLoaded(load)) {
      const loadReason = launchctlReason(load);
      printWarn(
        `Installed launchd plist, but could not start it immediately. It should start on next login. ` +
          `(bootstrap: ${bootstrapReason}; load: ${loadReason})`,
      );
      return false;
    }

    printOk('JARVIS launch agent is running.');
    return true;
  } catch (err) {
    printWarn(`Installed launchd plist, but could not start it immediately: ${err}`);
    return false;
  }
}

function scheduleLaunchdRestart(): boolean {
  const uid = process.getuid?.();
  const command = uid != null
    ? `sleep 1; launchctl kickstart -k gui/${uid}/ai.jarvis.daemon >/dev/null 2>&1`
    : `sleep 1; launchctl kickstart -k gui/$(id -u)/ai.jarvis.daemon >/dev/null 2>&1`;
  return spawnDetachedShell(command, ['bash', 'launchctl']);
}

async function uninstallLaunchd(): Promise<boolean> {
  try {
    if (existsSync(LAUNCHD_PLIST)) {
      Bun.spawnSync(['launchctl', 'unload', LAUNCHD_PLIST]);
      unlinkSync(LAUNCHD_PLIST);
    }

    printOk('Uninstalled launchd plist.');
    return true;
  } catch (err) {
    printErr(`Failed to uninstall launchd plist: ${err}`);
    return false;
  }
}

function isLaunchdInstalled(): boolean {
  return existsSync(LAUNCHD_PLIST);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Install autostart for the current platform.
 */
export async function installAutostart(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return installLaunchd();
  }
  return installSystemd();
}

/**
 * Start the installed autostart service for the current platform.
 */
export async function startAutostartService(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return startLaunchdService();
  }
  return startSystemdService();
}

/**
 * Schedule a restart of the installed autostart service without blocking
 * the current process. Useful when the API call is served by that service.
 */
export function scheduleAutostartRestart(): boolean {
  if (process.platform === 'darwin') {
    return scheduleLaunchdRestart();
  }
  if (process.platform === 'linux') {
    return scheduleSystemdRestart();
  }
  return false;
}

/**
 * Uninstall autostart for the current platform.
 */
export async function uninstallAutostart(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return uninstallLaunchd();
  }
  return uninstallSystemd();
}

/**
 * Check if autostart is installed for the current platform.
 */
export function isAutostartInstalled(): boolean {
  if (process.platform === 'darwin') {
    return isLaunchdInstalled();
  }
  return isSystemdInstalled();
}

/**
 * Check whether the current platform can use the keepalive manager.
 * Linux and WSL2 require a reachable user systemd instance.
 */
export function isAutostartSupported(): boolean {
  return checkAutostartSupport().supported;
}

/**
 * Like isAutostartSupported, but returns why it isn't when the answer is no —
 * useful for surfacing real diagnostics (e.g., WSL2 bus unreachable) in onboarding.
 */
export function checkAutostartSupport(): SystemdProbeResult {
  if (process.platform === 'darwin') {
    return { supported: true };
  }
  return probeSystemdUserService();
}

/**
 * Get the name of the autostart mechanism for the current platform.
 */
export function getAutostartName(): string {
  if (process.platform === 'darwin') {
    return 'launchd (User Agent)';
  }
  return 'systemd (User Service)';
}
