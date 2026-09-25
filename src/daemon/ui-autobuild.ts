/**
 * Build the dashboard UI at daemon start when `ui/dist` is missing.
 *
 * Its own module so the spawn can be driven by a test (#512): inline in
 * daemon/index.ts it could only be reached by booting the whole daemon.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { sanitizedEnv } from '../util/subprocess-env.ts';

export type UiAutobuildResult = 'present' | 'built' | 'failed';

export function ensureUiBuilt(
  repoRoot: string,
  log: (message: string) => void,
): UiAutobuildResult {
  const uiIndexPath = path.join(repoRoot, 'ui', 'dist', 'index.html');
  if (existsSync(uiIndexPath)) return 'present';

  log('Dashboard UI not built — building automatically...');
  const buildResult = Bun.spawnSync(['bun', 'run', 'build:ui'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    // Only repo code runs here, but nothing in it needs a secret, and what it
    // produces is the dashboard bundle this daemon serves over HTTP: a
    // bundler that inlines env would put whatever it was given into a public
    // asset. PATH/HOME/TMPDIR are what `bun build` and the `cp`-based
    // prebuild step need, and the allowlist keeps them. NODE_ENV is passed
    // through as before, because `bun build` inlines it: a daemon run with
    // NODE_ENV=production has always auto-built a production dashboard.
    // Not covered: bun loads a `.env` from the repo root into `bun run` and the
    // nested `bun build` regardless of this env (`--no-env-file` here would
    // only reach the outer one). An install has no such file; a checkout with
    // one gets it back in the build.
    env: sanitizedEnv({ NODE_ENV: process.env.NODE_ENV }),
  });
  if (buildResult.exitCode === 0) {
    log('Dashboard UI built successfully');
    return 'built';
  }
  const stderr = buildResult.stderr.toString().trim();
  console.warn(`[Daemon] UI build failed (dashboard may not load): ${stderr.slice(0, 200)}`);
  return 'failed';
}
