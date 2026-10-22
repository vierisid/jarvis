#!/usr/bin/env node
const { execSync } = require('child_process');
const { existsSync, writeFileSync } = require('fs');
const { join, resolve, sep } = require('path');
const os = require('os');

if (process.platform === 'win32') {
  console.error('Native Windows installs are not supported for the JARVIS daemon.');
  console.error('Use WSL2 for the Bun install, or run JARVIS with Docker on Windows.');
  console.error('The Windows sidecar is still supported separately.');
  process.exit(1);
}

// Oldest supported Bun; equal to MIN_BUN_VERSION in src/util/bun-minimum.ts and package.json engines.bun (src/cli/doctor.test.ts pins it).
const MIN_BUN = '1.3.11';

function versionAtLeast(version, min) {
  const parse = (v) => v.split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

let bunVersion = null;
try {
  bunVersion = execSync('bun --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  console.log('Bun runtime not found. Installing...');
  execSync('curl -fsSL https://bun.sh/install | bash', { stdio: 'inherit' });
}

// Warn rather than fail: an install that is already running on an older Bun
// should still finish, and `jarvis doctor` reports the same thing as a failure.
if (bunVersion && !versionAtLeast(bunVersion, MIN_BUN)) {
  console.warn(`Warning: Bun ${bunVersion} is older than ${MIN_BUN}, which Jarvis needs.`);
  console.warn('HTTPS from workflow HTTP steps and connection refresh cannot verify certificates on it.');
  console.warn('Run: bun upgrade');
}

// ── Stamp install-method marker for global installs ─────────────────
//
// When `bun install -g @usejarvis/brain` runs, the package root usually ends
// up under ~/.bun/install/global. The uninstall/update commands (and usage
// telemetry) need to know this later so update/uninstall dispatch correctly
// and telemetry reports "bun-global" rather than "unknown".
//
// Two signals mark a global install:
//   1. Package root under the default ~/.bun/install/global path.
//   2. npm_config_global=true — set by bun/npm for lifecycle scripts of a
//      `-g` install. This catches custom BUN_INSTALL / npm-prefix locations
//      that the path check in (1) misses (those previously detected as the
//      "unknown" install method).
//
// We deliberately skip writing during Docker builds (the Dockerfile stamps
// its own `docker` marker) and dev checkouts (which have a .git dir and are
// meant to detect as `dev` with no marker), and never clobber an existing
// marker (e.g. the one install.sh writes for script installs).
const packageRoot = resolve(__dirname, '..');
const bunGlobalRoot = resolve(join(os.homedir(), '.bun', 'install', 'global'));
const underBunGlobalPath =
  packageRoot === bunGlobalRoot ||
  packageRoot.startsWith(bunGlobalRoot + sep);
const isGlobalInstall =
  underBunGlobalPath || process.env.npm_config_global === 'true';
const isDevCheckout = existsSync(join(packageRoot, '.git'));
const markerPath = join(packageRoot, '.install-method');

if (
  isGlobalInstall &&
  !isDevCheckout &&
  !process.env.JARVIS_INSTALL_METHOD &&
  !existsSync(markerPath)
) {
  const marker = {
    method: 'bun-global',
    installedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(markerPath, JSON.stringify(marker) + '\n');
  } catch {
    // Non-fatal: detection falls back to path inference if the marker
    // can't be written (e.g. read-only filesystem).
  }
}
