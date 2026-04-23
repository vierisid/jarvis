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
// When `bun install -g @usejarvis/brain` runs, the package root ends up
// under ~/.bun/install/global. The uninstall/update commands need to know
// this later so they can dispatch to `bun uninstall -g` rather than
// deleting files by hand. During Docker builds and dev checkouts this
// check is false, so no marker is written — the Dockerfile stamps its
// own `docker` marker, and dev checkouts intentionally have no marker.
const packageRoot = resolve(__dirname, '..');
const bunGlobalRoot = resolve(join(os.homedir(), '.bun', 'install', 'global'));
const isBunGlobal =
  packageRoot === bunGlobalRoot ||
  packageRoot.startsWith(bunGlobalRoot + sep);

if (isBunGlobal) {
  const markerPath = join(packageRoot, '.install-method');
  if (!existsSync(markerPath)) {
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
}
