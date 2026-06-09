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

try {
  execSync('bun --version', { stdio: 'ignore' });
} catch {
  console.log('Bun runtime not found. Installing...');
  execSync('curl -fsSL https://bun.sh/install | bash', { stdio: 'inherit' });
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
