#!/usr/bin/env bun
/**
 * Build the desktop-bridge sidecar executable.
 * Requires .NET SDK installed on Windows (accessible as dotnet.exe from WSL).
 *
 * Usage: bun run scripts/build-sidecar.ts
 */

import { spawnSync } from 'bun';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WSLBridge } from '../src/actions/terminal/wsl-bridge.ts';

const SIDECAR_DIR = join(import.meta.dir, '../sidecar/desktop-bridge');

async function build() {
  if (!WSLBridge.isWSL()) {
    console.error('[build-sidecar] This script must be run from WSL.');
    process.exit(1);
  }

  // Check dotnet.exe is available
  const dotnetCheck = spawnSync(['dotnet.exe', '--version']);
  if (dotnetCheck.exitCode !== 0) {
    console.error('[build-sidecar] dotnet.exe not found. Install .NET SDK on Windows:');
    console.error('  https://dot.net/download');
    process.exit(1);
  }
  console.log(`[build-sidecar] .NET SDK: ${dotnetCheck.stdout.toString().trim()}`);

  // Get Windows user profile for output path
  const bridge = new WSLBridge();
  const winHome = bridge.getWindowsHome();

  // Convert sidecar dir to Windows path for dotnet.exe
  const winProjectPath = await bridge.convertToWindowsPath(SIDECAR_DIR);
  console.log(`[build-sidecar] Project: ${winProjectPath}`);

  // Determine output directory (fallback: next to the project). Create it
  // first: wslpath fails on a path that does not exist yet, and the conversion
  // throws on that rather than handing dotnet an empty -o.
  const outputPath = winHome ? join(winHome, '.jarvis', 'sidecar') : join(SIDECAR_DIR, 'bin', 'publish');
  mkdirSync(outputPath, { recursive: true });
  const outputDir = await bridge.convertToWindowsPath(outputPath);
  console.log(`[build-sidecar] Output: ${outputDir}`);

  // Run dotnet publish directly (dotnet.exe handles Windows paths)
  console.log('[build-sidecar] Running dotnet publish...');
  const result = spawnSync([
    'dotnet.exe', 'publish', winProjectPath,
    '-c', 'Release',
    '-r', 'win-x64',
    '--self-contained',
    '/p:PublishSingleFile=true',
    '/p:PublishTrimmed=false',
    '-o', outputDir,
  ], {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (result.exitCode !== 0) {
    console.error(`[build-sidecar] Build failed (exit code ${result.exitCode})`);
    process.exit(1);
  }

  // Set execute permission (needed when running from WSL)
  const { chmodSync, existsSync } = await import('node:fs');
  const exePath = join(SIDECAR_DIR, 'bin', 'publish', 'desktop-bridge.exe');
  if (existsSync(exePath)) {
    chmodSync(exePath, 0o755);
    console.log(`[build-sidecar] Set execute permission on ${exePath}`);
  }

  console.log('[build-sidecar] Build complete!');
}

build().catch((err) => {
  console.error('[build-sidecar] Error:', err);
  process.exit(1);
});
