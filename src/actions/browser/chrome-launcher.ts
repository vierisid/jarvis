/**
 * Chrome Launcher — Auto-detect and launch Chrome/Chromium
 *
 * Finds the system's Chrome installation (Chrome, Brave, Edge, Chromium),
 * launches it with CDP enabled and an isolated profile, and waits for
 * the debug port to become reachable.
 *
 * Works on Linux, macOS, Windows, and WSL2 (calls Windows Chrome from Linux).
 */

import { spawn, type Subprocess } from 'bun';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type BrowserKind = 'chrome' | 'brave' | 'edge' | 'chromium';

export type BrowserExecutable = {
  kind: BrowserKind;
  path: string;
};

export type RunningBrowser = {
  proc: Subprocess;
  exe: BrowserExecutable;
  cdpPort: number;
  userDataDir: string;
  startedAt: number;
};

/**
 * Detect the default Chromium-based browser on this system.
 * Checks common install paths for Chrome, Brave, Edge, Chromium.
 */
export function findBrowserExecutable(): BrowserExecutable | null {
  const platform = process.platform;

  if (platform === 'linux') {
    // Always try Linux-native browsers first — they share the network
    // namespace so CDP on 127.0.0.1 works directly. On WSL2, Linux GUI
    // apps display natively via WSLg.
    const linuxCandidates = findLinuxCandidates();
    for (const c of linuxCandidates) {
      if (existsSync(c.path)) return c;
    }

    // On WSL2, fall back to Windows Chrome if no Linux browser found
    const isWSL = existsSync('/proc/version') &&
      readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft');

    if (isWSL) {
      const wslCandidates = findWSLCandidates();
      for (const c of wslCandidates) {
        if (existsSync(c.path)) return c;
      }
    }
  }

  if (platform === 'darwin') {
    const macCandidates = findMacCandidates();
    for (const c of macCandidates) {
      if (existsSync(c.path)) return c;
    }
  }

  if (platform === 'win32') {
    const winCandidates = findWindowsCandidates();
    for (const c of winCandidates) {
      if (existsSync(c.path)) return c;
    }
  }

  return null;
}

function findWSLCandidates(): BrowserExecutable[] {
  // Windows Chrome accessible from WSL via /mnt/c/...
  return [
    { kind: 'chrome', path: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe' },
    { kind: 'chrome', path: '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe' },
    { kind: 'edge', path: '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
    { kind: 'edge', path: '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe' },
    { kind: 'brave', path: '/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe' },
    { kind: 'brave', path: '/mnt/c/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe' },
  ];
}

/** Exported for reuse by deps.ts dependency checker. */
export const LINUX_BROWSER_PATHS: BrowserExecutable[] = [
  { kind: 'chrome', path: '/usr/bin/google-chrome' },
  { kind: 'chrome', path: '/usr/bin/google-chrome-stable' },
  { kind: 'chrome', path: '/usr/bin/chrome' },
  { kind: 'brave', path: '/usr/bin/brave-browser' },
  { kind: 'brave', path: '/usr/bin/brave-browser-stable' },
  { kind: 'edge', path: '/usr/bin/microsoft-edge' },
  { kind: 'edge', path: '/usr/bin/microsoft-edge-stable' },
  { kind: 'chromium', path: '/usr/bin/chromium' },
  { kind: 'chromium', path: '/usr/bin/chromium-browser' },
  { kind: 'chromium', path: '/snap/bin/chromium' },
];

/** Exported for reuse by deps.ts dependency checker. */
export const MACOS_BROWSER_PATHS: BrowserExecutable[] = [
  { kind: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { kind: 'chrome', path: join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome') },
  { kind: 'brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
  { kind: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
  { kind: 'chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
];

function findLinuxCandidates(): BrowserExecutable[] {
  return LINUX_BROWSER_PATHS;
}

function findMacCandidates(): BrowserExecutable[] {
  return MACOS_BROWSER_PATHS;
}

function findWindowsCandidates(): BrowserExecutable[] {
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  const candidates: BrowserExecutable[] = [];

  if (localAppData) {
    candidates.push(
      { kind: 'chrome', path: join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { kind: 'brave', path: join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
      { kind: 'edge', path: join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    );
  }

  candidates.push(
    { kind: 'chrome', path: join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { kind: 'chrome', path: join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { kind: 'edge', path: join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { kind: 'edge', path: join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { kind: 'brave', path: join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
  );

  return candidates;
}

/**
 * Launch Chrome with CDP enabled and an isolated user profile.
 * Returns when the CDP port is reachable.
 */
export async function launchChrome(port: number = 9222, profileDir?: string): Promise<RunningBrowser> {
  const exe = findBrowserExecutable();
  if (!exe) {
    throw new Error(
      'No Chrome/Brave/Edge/Chromium found on this system.\n' +
      'Install Chrome or set the path in config.'
    );
  }

  // Isolated profile — doesn't touch the user's real browser data
  const userDataDir = profileDir ?? join(homedir(), '.jarvis', 'browser', 'profile');
  mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--password-store=basic',
    '--disable-blink-features=AutomationControlled', // stealth
  ];

  // Linux-specific (also applies to WSL2)
  if (process.platform === 'linux') {
    args.push('--disable-dev-shm-usage');
    args.push('--no-sandbox'); // Required for Chromium in containers/WSL2
    args.push('--window-size=1280,900');
    args.push('--window-position=100,100');

    // WSL2: force X11 display backend for WSLg visibility
    const isWSL = existsSync('/proc/version') &&
      readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft');
    if (isWSL) {
      args.push('--ozone-platform=x11');
    }
  }

  // Open a blank tab so a target exists
  args.push('about:blank');

  console.log(`[ChromeLauncher] Launching ${exe.kind} from ${exe.path}`);

  const proc = spawn([exe.path, ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const startedAt = Date.now();

  // Wait for CDP to become reachable (up to 15s)
  const deadline = Date.now() + 15_000;
  let reachable = false;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        reachable = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await Bun.sleep(200);
  }

  if (!reachable) {
    proc.kill();
    throw new Error(
      `Chrome started but CDP not reachable on port ${port} after 15s.\n` +
      `Binary: ${exe.path}`
    );
  }

  console.log(`[ChromeLauncher] ${exe.kind} ready on port ${port} (pid ${proc.pid})`);

  return { proc, exe, cdpPort: port, userDataDir, startedAt };
}

/**
 * Stop a running Chrome instance gracefully.
 */
export async function stopChrome(running: RunningBrowser): Promise<void> {
  try {
    running.proc.kill();
  } catch {
    // Already dead
  }

  // Wait for process to exit (up to 3s)
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (running.proc.exitCode !== null) break;
    await Bun.sleep(100);
  }

  // Force kill if still running
  try {
    running.proc.kill(9);
  } catch {
    // ignore
  }

  console.log(`[ChromeLauncher] Chrome stopped`);
}
