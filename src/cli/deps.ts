/**
 * System Dependency Checker & Installer
 *
 * Detects and offers to install system dependencies during onboard:
 * - Chromium/Chrome browser (all platforms)
 * - Linux X11 tools: xdotool, xprop, imagemagick (Linux/WSL)
 * - Google OAuth tokens (optional, all platforms)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'bun';
import { c, printOk, printWarn, printErr, printInfo, askYesNo, ask, askSecret, startSpinner, detectPlatform } from './helpers.ts';
import { LINUX_BROWSER_PATHS, MACOS_BROWSER_PATHS, type BrowserExecutable } from '../actions/browser/chrome-launcher.ts';

export type DepStatus = {
  name: string;
  found: boolean;
  path?: string;
  message: string;
  installable: boolean;
};

type PackageManager = 'apt' | 'dnf' | 'pacman' | 'brew';

type CoreToolSpec = {
  name: string;
  command: string;
  description: string;
  packageNames: Partial<Record<PackageManager, string>>;
};

// ── Detection ─────────────────────────────────────────────────────────

/**
 * Check if a Chromium-based browser is installed.
 */
export function checkBrowser(): DepStatus {
  const platform = detectPlatform();

  const candidates: BrowserExecutable[] =
    platform === 'macos' ? MACOS_BROWSER_PATHS : LINUX_BROWSER_PATHS;

  for (const c of candidates) {
    if (existsSync(c.path)) {
      return {
        name: 'Browser (Chrome/Chromium)',
        found: true,
        path: c.path,
        message: `${c.kind} at ${c.path}`,
        installable: false,
      };
    }
  }

  // On WSL, also check Windows-side browsers
  if (platform === 'wsl') {
    const wslPaths = [
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    ];
    for (const p of wslPaths) {
      if (existsSync(p)) {
        return {
          name: 'Browser (Chrome/Chromium)',
          found: true,
          path: p,
          message: `Windows browser at ${p}`,
          installable: false,
        };
      }
    }
  }

  return {
    name: 'Browser (Chrome/Chromium)',
    found: false,
    message: 'Not found',
    installable: true,
  };
}

function commandExists(command: string): { found: boolean; path?: string } {
  const result = spawnSync(['which', command], { stdout: 'pipe', stderr: 'pipe' });
  const found = result.exitCode === 0;
  return {
    found,
    path: found ? result.stdout.toString().trim() : undefined,
  };
}

export function getCoreToolSpecs(platform: ReturnType<typeof detectPlatform>): CoreToolSpec[] {
  const specs: CoreToolSpec[] = [
    {
      name: 'git',
      command: 'git',
      description: 'site builder git operations and repository workflows',
      packageNames: { apt: 'git', dnf: 'git', pacman: 'git', brew: 'git' },
    },
    {
      name: 'curl',
      command: 'curl',
      description: 'network downloads and setup flows',
      packageNames: { apt: 'curl', dnf: 'curl', pacman: 'curl', brew: 'curl' },
    },
  ];

  if (platform === 'wsl') {
    specs.push({
      name: 'wslview',
      command: 'wslview',
      description: 'open OAuth links in the Windows browser from WSL',
      packageNames: { apt: 'wslu', dnf: 'wslu', pacman: 'wslu' },
    });
  } else if (platform === 'linux') {
    specs.push({
      name: 'xdg-open',
      command: 'xdg-open',
      description: 'open OAuth links in your desktop browser',
      packageNames: { apt: 'xdg-utils', dnf: 'xdg-utils', pacman: 'xdg-utils' },
    });
  }

  return specs;
}

/**
 * Check for core CLI tools JARVIS relies on for common workflows.
 */
export function checkCoreTools(): DepStatus[] {
  const platform = detectPlatform();
  return getCoreToolSpecs(platform).map((tool) => {
    const result = commandExists(tool.command);
    return {
      name: tool.name,
      found: result.found,
      path: result.path,
      message: result.found ? result.path! : `Not installed (${tool.description})`,
      installable: true,
    };
  });
}

/**
 * Check for Linux X11 tools needed for app control.
 */
export function checkLinuxTools(): DepStatus[] {
  const platform = detectPlatform();
  if (platform === 'macos') return []; // Not needed on macOS

  const tools = [
    { name: 'xdotool', pkg: 'xdotool', desc: 'keyboard/mouse automation' },
    { name: 'xprop', pkg: 'x11-utils', desc: 'window property inspection' },
    { name: 'import (ImageMagick)', cmd: 'import', pkg: 'imagemagick', desc: 'screenshot capture' },
  ];

  return tools.map(tool => {
    const cmd = tool.cmd ?? tool.name;
    const result = spawnSync(['which', cmd], { stdout: 'pipe', stderr: 'pipe' });
    const found = result.exitCode === 0;
    const path = found ? result.stdout.toString().trim() : undefined;

    return {
      name: tool.name,
      found,
      path,
      message: found ? path! : `Not installed (${tool.desc})`,
      installable: true,
    };
  });
}

/**
 * Check if Google OAuth tokens exist.
 */
export function checkGoogleAuth(): DepStatus {
  const tokensPath = join(homedir(), '.jarvis', 'google-tokens.json');
  const found = existsSync(tokensPath);

  return {
    name: 'Google OAuth',
    found,
    path: found ? tokensPath : undefined,
    message: found ? 'Tokens exist' : 'Not configured (optional, for Gmail/Calendar)',
    installable: true,
  };
}

// ── Installation ──────────────────────────────────────────────────────

/**
 * Detect the system package manager.
 */
function detectPackageManager(): PackageManager | null {
  if (spawnSync(['which', 'apt'], { stdout: 'pipe' }).exitCode === 0) return 'apt';
  if (spawnSync(['which', 'dnf'], { stdout: 'pipe' }).exitCode === 0) return 'dnf';
  if (spawnSync(['which', 'pacman'], { stdout: 'pipe' }).exitCode === 0) return 'pacman';
  if (spawnSync(['which', 'brew'], { stdout: 'pipe' }).exitCode === 0) return 'brew';
  return null;
}

export function resolveCorePackages(
  pm: PackageManager | null,
  platform: ReturnType<typeof detectPlatform>,
  missing: string[],
): string[] {
  return resolveCoreInstallPlan(pm, platform, missing).packages;
}

export function resolveCoreInstallPlan(
  pm: PackageManager | null,
  platform: ReturnType<typeof detectPlatform>,
  missing: string[],
): { packages: string[]; unresolved: string[] } {
  if (!pm) {
    return { packages: [], unresolved: [...new Set(missing)] };
  }

  const packageMap = new Map(
    getCoreToolSpecs(platform).map((tool) => [tool.name, tool.packageNames[pm] ?? null]),
  );

  const packages = [...new Set(
    missing
      .map((name) => packageMap.get(name) ?? null)
      .filter(Boolean) as string[],
  )];

  const unresolved = missing.filter((name) => !packageMap.get(name));

  return { packages, unresolved };
}

function runPackageInstall(pm: PackageManager, packages: string[]): boolean {
  if (packages.length === 0) return true;

  if (pm === 'apt') {
    console.log(c.dim(`  Running: sudo apt install -y ${packages.join(' ')}`));
    const result = spawnSync(['sudo', 'apt', 'install', '-y', ...packages], {
      stdout: 'inherit', stderr: 'inherit',
    });
    return result.exitCode === 0;
  }

  if (pm === 'dnf') {
    console.log(c.dim(`  Running: sudo dnf install -y ${packages.join(' ')}`));
    const result = spawnSync(['sudo', 'dnf', 'install', '-y', ...packages], {
      stdout: 'inherit', stderr: 'inherit',
    });
    return result.exitCode === 0;
  }

  if (pm === 'pacman') {
    console.log(c.dim(`  Running: sudo pacman -S --noconfirm ${packages.join(' ')}`));
    const result = spawnSync(['sudo', 'pacman', '-S', '--noconfirm', ...packages], {
      stdout: 'inherit', stderr: 'inherit',
    });
    return result.exitCode === 0;
  }

  console.log(c.dim(`  Running: brew install ${packages.join(' ')}`));
  const result = spawnSync(['brew', 'install', ...packages], {
    stdout: 'inherit', stderr: 'inherit',
  });
  return result.exitCode === 0;
}

/**
 * Install a Chromium-based browser.
 */
export async function installBrowser(): Promise<boolean> {
  const platform = detectPlatform();
  const pm = detectPackageManager();

  if (platform === 'macos') {
    if (pm === 'brew') {
      console.log(c.dim('  Running: brew install --cask google-chrome'));
      const result = spawnSync(['brew', 'install', '--cask', 'google-chrome'], {
        stdout: 'inherit', stderr: 'inherit',
      });
      return result.exitCode === 0;
    }
    printInfo('Install Chrome from: https://www.google.com/chrome/');
    return false;
  }

  // Linux / WSL — install a Linux browser (preferred for CDP)
  if (pm === 'apt') {
    // Try chromium-browser first (most common on Ubuntu/Debian), then chromium
    console.log(c.dim('  Running: sudo apt install -y chromium-browser'));
    let result = spawnSync(['sudo', 'apt', 'install', '-y', 'chromium-browser'], {
      stdout: 'inherit', stderr: 'inherit',
    });
    if (result.exitCode === 0) return true;

    console.log(c.dim('  Trying: sudo apt install -y chromium'));
    result = spawnSync(['sudo', 'apt', 'install', '-y', 'chromium'], {
      stdout: 'inherit', stderr: 'inherit',
    });
    return result.exitCode === 0;
  }

  if (pm === 'dnf') {
    console.log(c.dim('  Running: sudo dnf install -y chromium'));
    const result = spawnSync(['sudo', 'dnf', 'install', '-y', 'chromium'], {
      stdout: 'inherit', stderr: 'inherit',
    });
    return result.exitCode === 0;
  }

  if (pm === 'pacman') {
    console.log(c.dim('  Running: sudo pacman -S --noconfirm chromium'));
    const result = spawnSync(['sudo', 'pacman', '-S', '--noconfirm', 'chromium'], {
      stdout: 'inherit', stderr: 'inherit',
    });
    return result.exitCode === 0;
  }

  printInfo('Install Chromium manually for your distribution.');
  return false;
}

/**
 * Install missing Linux X11 tools.
 */
export async function installLinuxTools(missing: string[]): Promise<boolean> {
  const pm = detectPackageManager();

  // Map tool names to package names
  const pkgMap: Record<string, Record<string, string>> = {
    apt: { xdotool: 'xdotool', xprop: 'x11-utils', 'import (ImageMagick)': 'imagemagick' },
    dnf: { xdotool: 'xdotool', xprop: 'xprop', 'import (ImageMagick)': 'ImageMagick' },
    pacman: { xdotool: 'xdotool', xprop: 'xorg-xprop', 'import (ImageMagick)': 'imagemagick' },
  };

  if (!pm || pm === 'brew') {
    printInfo('Install manually: ' + missing.join(', '));
    return false;
  }

  const packages = missing
    .map(name => pkgMap[pm]?.[name])
    .filter(Boolean) as string[];

  if (packages.length === 0) return true;

  const unique = [...new Set(packages)];
  return runPackageInstall(pm, unique);
}

/**
 * Install missing core CLI tools.
 */
export async function installCoreTools(missing: string[]): Promise<boolean> {
  const platform = detectPlatform();
  const pm = detectPackageManager();
  if (!pm) {
    printInfo('Install manually: ' + missing.join(', '));
    return false;
  }

  const { packages, unresolved } = resolveCoreInstallPlan(pm, platform, missing);

  if (packages.length === 0) {
    printInfo('Install manually: ' + missing.join(', '));
    return false;
  }

  if (unresolved.length > 0) {
    printInfo(`No ${pm} package mapping for: ${[...new Set(unresolved)].join(', ')}`);
  }

  const installed = runPackageInstall(pm, packages);

  if (unresolved.length > 0) {
    printInfo(`Install manually: ${[...new Set(unresolved)].join(', ')}`);
  }

  return installed && unresolved.length === 0;
}

/**
 * Run inline Google OAuth setup flow.
 */
export async function setupGoogleOAuth(config: any): Promise<boolean> {
  let clientId = config.google?.client_id ?? '';
  let clientSecret = config.google?.client_secret ?? '';

  if (!clientId || !clientSecret) {
    printInfo('Google OAuth requires OAuth2 credentials from Google Cloud Console.');
    printInfo('1. Go to https://console.cloud.google.com/apis/credentials');
    printInfo('2. Create an OAuth2 client ID (Web application)');
    printInfo('3. Add redirect URI: http://localhost:3142/api/auth/google/callback');
    console.log('');

    clientId = await ask('Google OAuth Client ID (or press Enter to skip)');
    if (!clientId) return false;

    clientSecret = await askSecret('Google OAuth Client Secret');
    if (!clientSecret) return false;

    // Save credentials to config
    config.google = { ...config.google, client_id: clientId, client_secret: clientSecret };
  }

  // Import GoogleAuth and start inline flow
  const { GoogleAuth } = await import('../integrations/google-auth.ts');
  const auth = new GoogleAuth(clientId, clientSecret);

  if (auth.isAuthenticated()) {
    printOk('Already authenticated with Google!');
    return true;
  }

  const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
  ];

  const authUrl = auth.getAuthUrl(SCOPES);

  console.log('');
  printInfo('Opening browser for Google authorization...');
  console.log(c.dim(`  ${authUrl}`));
  console.log('');

  // Try to open browser
  try {
    const platform = detectPlatform();
    if (platform === 'macos') {
      spawnSync(['open', authUrl], { stdout: 'ignore', stderr: 'ignore' });
    } else if (platform === 'wsl') {
      spawnSync(['wslview', authUrl], { stdout: 'ignore', stderr: 'ignore' });
    } else {
      spawnSync(['xdg-open', authUrl], { stdout: 'ignore', stderr: 'ignore' });
    }
  } catch {
    // User can open manually
  }

  // Start temporary callback server for OAuth redirect
  printInfo('Waiting for authorization callback on port 3142...');

  return new Promise<boolean>((resolve) => {
    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({
        port: 3142,
        async fetch(req) {
          const url = new URL(req.url);

          if (url.pathname === '/api/auth/google/callback') {
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
              clearTimeout(timeout);
              printErr(`Authorization denied: ${error}`);
              setTimeout(() => { server.stop(); resolve(false); }, 300);
              return new Response(
                '<html><body><h1>Authorization Denied</h1><p>You can close this tab.</p></body></html>',
                { headers: { 'Content-Type': 'text/html' } }
              );
            }

            if (!code) {
              return new Response('Missing code', { status: 400 });
            }

            try {
              await auth.exchangeCode(code);
              clearTimeout(timeout);
              printOk('Google OAuth configured! Tokens saved.');
              setTimeout(() => { server.stop(); resolve(true); }, 300);
              return new Response(
                '<html><body><h1>JARVIS Google Authorization Complete!</h1><p>You can close this tab.</p></body></html>',
                { headers: { 'Content-Type': 'text/html' } }
              );
            } catch (err) {
              clearTimeout(timeout);
              printErr(`Token exchange failed: ${err}`);
              setTimeout(() => { server.stop(); resolve(false); }, 300);
              return new Response(
                `<html><body><h1>Token Exchange Failed</h1><pre>${err}</pre></body></html>`,
                { headers: { 'Content-Type': 'text/html' }, status: 500 }
              );
            }
          }

          return new Response('Not found', { status: 404 });
        },
      });
    } catch (err) {
      printErr(`Could not start OAuth callback server on port 3142 (port in use?)`);
      printInfo('Stop the JARVIS daemon first, or run later with: bun run setup:google');
      resolve(false);
      return;
    }

    const timeout = setTimeout(() => {
      server.stop();
      printWarn('Timeout waiting for Google authorization (60s).');
      printInfo('Run later with: bun run setup:google');
      resolve(false);
    }, 60_000);
  });
}

// ── Main Step Runner ──────────────────────────────────────────────────

/**
 * Run the full dependency check + install flow.
 * Called as Step 3 of the onboard wizard.
 */
export async function runDependencyCheck(config: any): Promise<void> {
  // Collect all dependency statuses
  const deps: DepStatus[] = [];

  const coreTools = checkCoreTools();
  deps.push(...coreTools);

  deps.push(checkBrowser());

  const linuxTools = checkLinuxTools();
  deps.push(...linuxTools);

  deps.push(checkGoogleAuth());

  // Display status table
  console.log('');
  for (const dep of deps) {
    const icon = dep.found ? c.green('\u2713') : c.red('\u2717');
    const name = dep.name.padEnd(26);
    const detail = dep.found
      ? c.dim(dep.path ?? dep.message)
      : c.yellow(dep.message);
    console.log(`  ${icon} ${name} ${detail}`);
  }
  console.log('');

  const missing = deps.filter(d => !d.found && d.installable);

  if (missing.length === 0) {
    printOk('All system dependencies are satisfied!');
    return;
  }

  printInfo(`${missing.length} ${missing.length === 1 ? 'dependency' : 'dependencies'} not found.`);
  console.log('');

  const missingCore = missing.filter(d => coreTools.some(core => core.name === d.name));
  if (missingCore.length > 0) {
    const names = missingCore.map(d => d.name).join(', ');
    const install = await askYesNo(`Install core system tools (${names})?`, true);
    if (install) {
      const ok = await installCoreTools(missingCore.map(d => d.name));
      if (ok) printOk('Core system tools installed!');
      else printWarn('Some core tools may not have installed. Check manually.');
    } else {
      printInfo(`Skip. Install later with your package manager (${names}).`);
    }
  }

  // Offer to install each missing dependency
  // Group: browser
  const missingBrowser = missing.find(d => d.name.includes('Browser'));
  if (missingBrowser) {
    const install = await askYesNo('Install a Chromium-based browser?', true);
    if (install) {
      const ok = await installBrowser();
      if (ok) printOk('Browser installed!');
      else printWarn('Browser install incomplete. Install manually later.');
    } else {
      printInfo('Skip. Install later: sudo apt install chromium-browser');
    }
  }

  // Group: Linux tools (batch install)
  const missingLinux = missing.filter(d =>
    d.name === 'xdotool' || d.name === 'xprop' || d.name === 'import (ImageMagick)'
  );
  if (missingLinux.length > 0) {
    const names = missingLinux.map(d => d.name).join(', ');
    const install = await askYesNo(`Install Linux tools (${names})?`, true);
    if (install) {
      const ok = await installLinuxTools(missingLinux.map(d => d.name));
      if (ok) printOk('Linux tools installed!');
      else printWarn('Some tools may not have installed. Check manually.');
    } else {
      printInfo('Skip. Install later: sudo apt install xdotool x11-utils imagemagick');
    }
  }

  // Group: Google OAuth (special — only if user has google config or wants to set up)
  const missingGoogle = missing.find(d => d.name === 'Google OAuth');
  if (missingGoogle) {
    const install = await askYesNo('Set up Google OAuth for Gmail/Calendar? (optional)', false);
    if (install) {
      await setupGoogleOAuth(config);
    } else {
      printInfo('Skip. Set up later with: bun run setup:google');
    }
  }
}
