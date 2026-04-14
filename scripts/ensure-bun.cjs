#!/usr/bin/env node
const { execSync } = require('child_process');

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
