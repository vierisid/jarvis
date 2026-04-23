/**
 * Install-method detection.
 *
 * JARVIS ships through three install paths — a published bun/npm package,
 * a git-clone installer script, and a Docker image — plus a fourth "developer
 * checkout" case. `jarvis update` and `jarvis uninstall` need different
 * behavior for each, so they both call detectInstallMethod() to decide.
 *
 * Resolution order:
 *   1. Docker (env var or /.dockerenv) — checked first because a Docker
 *      container may have a marker file left over from the source checkout.
 *   2. Explicit marker file at <packageRoot>/.install-method.
 *   3. Path-based inference as fallback for legacy installs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export type InstallMethod = 'docker' | 'bun-global' | 'script' | 'dev' | 'unknown';

export const INSTALL_METHODS: readonly InstallMethod[] = [
  'docker',
  'bun-global',
  'script',
  'dev',
  'unknown',
] as const;

export const MARKER_FILENAME = '.install-method';

export interface InstallMethodInfo {
  method: InstallMethod;
  /** Human-readable explanation of how the method was determined. */
  reason: string;
  /** Where the marker file was read from, if any. */
  markerPath?: string;
}

export interface DetectOptions {
  /** Overridable for testing. Defaults to '/.dockerenv'. */
  dockerEnvPath?: string;
  /** Overridable for testing. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Overridable for testing. Defaults to os.homedir(). */
  homeDir?: string;
}

interface MarkerContent {
  method: InstallMethod;
  installedAt?: string;
}

function normalize(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(candidate: string, parent: string): boolean {
  const c = normalize(candidate);
  const p = normalize(parent);
  return c === p || c.startsWith(p + sep);
}

function readMarker(packageRoot: string): { content: MarkerContent; path: string } | null {
  const markerPath = join(packageRoot, MARKER_FILENAME);
  if (!existsSync(markerPath)) return null;

  try {
    const raw = readFileSync(markerPath, 'utf-8').trim();
    const parsed = JSON.parse(raw) as Partial<MarkerContent>;
    if (!parsed.method || !INSTALL_METHODS.includes(parsed.method)) return null;
    return { content: parsed as MarkerContent, path: markerPath };
  } catch {
    return null;
  }
}

/**
 * Detect how JARVIS was installed. Pure function — all environmental inputs
 * can be injected via options for testing.
 */
export function detectInstallMethod(
  packageRoot: string,
  options: DetectOptions = {},
): InstallMethodInfo {
  const dockerEnvPath = options.dockerEnvPath ?? '/.dockerenv';
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const resolvedRoot = resolve(packageRoot);

  // 1. Docker takes precedence — a container may carry a stale marker from
  //    the source checkout baked into the image at build time.
  if (env.JARVIS_INSTALL_METHOD === 'docker') {
    return { method: 'docker', reason: 'JARVIS_INSTALL_METHOD=docker' };
  }
  if (existsSync(dockerEnvPath)) {
    return { method: 'docker', reason: `${dockerEnvPath} present` };
  }

  // 2. Explicit marker file.
  const marker = readMarker(resolvedRoot);
  if (marker) {
    return {
      method: marker.content.method,
      reason: `marker file at ${marker.path}`,
      markerPath: marker.path,
    };
  }

  // 3. Path-based inference for legacy installs written before markers existed.
  const bunGlobalRoot = join(home, '.bun', 'install', 'global');
  if (isWithin(resolvedRoot, bunGlobalRoot)) {
    return {
      method: 'bun-global',
      reason: `package root under ${bunGlobalRoot}`,
    };
  }

  const scriptInstallRoot = join(home, '.jarvis', 'daemon');
  const hasGit = existsSync(join(resolvedRoot, '.git'));
  if (normalize(resolvedRoot) === normalize(scriptInstallRoot) && hasGit) {
    return {
      method: 'script',
      reason: `package root is ${scriptInstallRoot} with .git`,
    };
  }

  if (hasGit) {
    return {
      method: 'dev',
      reason: `git checkout at ${resolvedRoot}`,
    };
  }

  return {
    method: 'unknown',
    reason: `no marker, no .git, package root ${resolvedRoot} not under a known install location`,
  };
}

/**
 * Human-readable one-liner for the given method. Used by `jarvis doctor`.
 */
export function describeInstallMethod(info: InstallMethodInfo): string {
  const labels: Record<InstallMethod, string> = {
    docker: 'Docker container',
    'bun-global': 'Bun global install (@usejarvis/brain)',
    script: 'install.sh (git clone under ~/.jarvis/daemon)',
    dev: 'Developer checkout',
    unknown: 'Unknown',
  };
  return labels[info.method];
}

export interface MethodCommands {
  update: string;
  uninstall: string;
}

/**
 * Canonical update and uninstall commands for the given install method.
 * `jarvis update` / `jarvis uninstall` delegate to these internally — the
 * point of surfacing them here is so users can run them directly (e.g.
 * from a doctor report) and understand what the CLI would do on their
 * behalf.
 */
export function getMethodCommands(method: InstallMethod): MethodCommands {
  switch (method) {
    case 'docker':
      return {
        update: 'docker pull <image> && docker rm -f jarvis && docker run -d ... <image>',
        uninstall: 'docker rm -f jarvis   # and `docker volume rm jarvis-data` to delete data',
      };
    case 'bun-global':
      return {
        update: 'jarvis update   # runs `bun update -g @usejarvis/brain`',
        uninstall: 'jarvis uninstall   # runs `bun uninstall -g @usejarvis/brain` and cleans up',
      };
    case 'script':
      return {
        update: 'jarvis update   # runs `git pull` + `bun install`',
        uninstall: 'jarvis uninstall   # removes ~/.jarvis and the CLI wrapper',
      };
    case 'dev':
      return {
        update: 'git pull && bun install   # manage your dev checkout yourself',
        uninstall: 'rm -rf <your checkout>   # `jarvis uninstall` only cleans side effects',
      };
    case 'unknown':
      return {
        update: '(install method unknown — see `jarvis doctor`)',
        uninstall: '(install method unknown — see `jarvis doctor`)',
      };
  }
}
