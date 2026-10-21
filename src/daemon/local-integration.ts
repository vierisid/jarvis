import { isAbsolute, dirname, basename, join, resolve } from 'node:path';
import { copyFileSync, existsSync } from 'node:fs';
import type { JarvisConfig } from '../config/types';
import { isHostedInstall } from './usejarvis-ai';

/** Developer acceptance on a separate self-hosted vault; never a release receipt. */
export function localIntegrationEnabled(config: JarvisConfig, env: Record<string, string | undefined> = process.env): boolean {
  if (env.JARVIS_LOCAL_INTEGRATION !== '1') return false;
  const home = env.HOME, data = env.JARVIS_HOME;
  if (!home || !data || !isAbsolute(home) || !isAbsolute(data)
    || basename(home) !== 'home' || basename(data) !== 'data' || dirname(resolve(home)) !== dirname(resolve(data))
    || resolve(config.daemon.data_dir) !== resolve(data) || resolve(config.daemon.db_path) !== join(resolve(data), 'jarvis.db')) {
    throw Error('Local integration requires the isolated home/data layout from bun run dev');
  }
  const origin = new URL(config.daemon.public_url ?? 'invalid:');
  if (isHostedInstall(config) || config.auth?.insecure_open_access === true || config.daemon.listen
    || origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || Number(origin.port || 80) !== config.daemon.port) throw Error('Local integration requires authenticated self-hosted loopback access');
  return true;
}

/** Separate output keeps ordinary dev and production builds inactive. */
export function buildLocalIntegrationUi(repoRoot: string): string {
  const out = join(repoRoot, 'ui', 'dist-local-integration');
  const result = Bun.spawnSync([process.execPath, '--no-env-file', 'build', 'ui/local-integration.html', 'ui/pebble.html', '--outdir', out], {
    cwd: repoRoot, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp' },
    stdout: 'pipe', stderr: 'pipe',
  });
  if (result.exitCode !== 0 || !existsSync(join(out, 'local-integration.html'))) throw Error('Local integration UI build failed: ' + result.stderr.toString());
  copyFileSync(join(out, 'local-integration.html'), join(out, 'index.html'));
  return out;
}
