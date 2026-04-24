import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import os from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { readLockedPort } from '../daemon/pid.ts';

export const DEFAULT_DAEMON_PORT = 3142;

function parsePidList(output: string, currentPid: number): number[] {
  return [...new Set(
    output
      .split(/\r?\n/)
      .flatMap((line) => line.match(/\d+/g) ?? [])
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0 && value !== currentPid)
  )];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !isPidAlive(pid);
}

async function captureOutput(command: string[], quiet = true): Promise<string> {
  const proc = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: quiet ? 'ignore' : 'pipe',
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output;
}

async function findListeningPids(port: number, currentPid: number): Promise<number[]> {
  if (os.platform() === 'win32') {
    const output = await captureOutput([
      'powershell.exe',
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess) -join "\\n"`,
    ]);
    return parsePidList(output, currentPid);
  }

  const lsofOutput = await captureOutput([
    'bash',
    '-lc',
    `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null || true`,
  ]);
  const lsofPids = parsePidList(lsofOutput, currentPid);
  if (lsofPids.length > 0) return lsofPids;

  const ssOutput = await captureOutput([
    'bash',
    '-lc',
    `ss -ltnp '( sport = :${port} )' 2>/dev/null || true`,
  ]);
  return [...new Set(
    Array.from(ssOutput.matchAll(/pid=(\d+)/g))
      .map((match) => Number.parseInt(match[1]!, 10))
      .filter((value) => Number.isInteger(value) && value > 0 && value !== currentPid)
  )];
}

export async function ensurePortReleased(
  port: number,
  currentPid: number = process.pid,
): Promise<{ released: boolean; terminated: number[]; forced: number[] }> {
  const initialPids = await findListeningPids(port, currentPid);
  if (initialPids.length === 0) {
    return { released: true, terminated: [], forced: [] };
  }

  const terminated: number[] = [];
  const forced: number[] = [];

  for (const pid of initialPids) {
    if (!isPidAlive(pid)) continue;

    try {
      process.kill(pid, 'SIGTERM');
      if (await waitForExit(pid, 2000)) {
        terminated.push(pid);
        continue;
      }
    } catch {
      // Fall through to final verification and force-kill path.
    }

    if (!isPidAlive(pid)) {
      terminated.push(pid);
      continue;
    }

    try {
      process.kill(pid, 'SIGKILL');
      if (await waitForExit(pid, 1000)) {
        forced.push(pid);
      }
    } catch {
      // Ignore individual kill failures and verify final port state below.
    }
  }

  return {
    released: (await findListeningPids(port, currentPid)).length === 0,
    terminated,
    forced,
  };
}

/**
 * Read `daemon.port` from the YAML config.
 * Returns null when the file is absent, invalid, or the field is missing
 * — callers decide what default to apply.
 */
export function readConfiguredPort(configPath = join(homedir(), '.jarvis', 'config.yaml')): number | null {
  try {
    if (!existsSync(configPath)) return null;
    const text = readFileSync(configPath, 'utf-8');
    const doc = YAML.parseDocument(text, { merge: true });
    if (doc.errors.length > 0) return null;
    const parsed = doc.toJS() as { daemon?: { port?: unknown } } | null;
    const port = parsed?.daemon?.port;
    return typeof port === 'number' && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Backwards-compatible: returns the configured port or the hardcoded default.
 * Prefer `readConfiguredPort` + explicit fallback where the caller needs to
 * distinguish "config said X" from "nothing was configured".
 */
export function getConfiguredPort(configPath?: string): number {
  return readConfiguredPort(configPath) ?? DEFAULT_DAEMON_PORT;
}

function validPort(value: unknown): number | null {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export type StopPortSource = 'lockfile' | 'env' | 'cli' | 'config' | 'default';

export type StopPortResolution = {
  port: number;
  source: StopPortSource;
};

/**
 * Resolve which port `jarvis stop` should verify.
 *
 * Precedence (highest first):
 *   1. The port the running daemon recorded in its lockfile (authoritative).
 *   2. `JARVIS_PORT` env var (matches `applyEnvOverrides` in the config loader).
 *   3. An explicit `--port N` passed on the stop command line.
 *   4. `daemon.port` from `~/.jarvis/config.yaml`.
 *   5. The hardcoded default (3142).
 *
 * The lockfile wins over everything because it reflects the port the daemon
 * actually bound to, not what config/env said at some point in the past. The
 * env var beats `--port` so a user with a persistent `JARVIS_PORT` in their
 * shell doesn't get caught out by forgetting to pass the flag.
 */
export function resolveStopPort(options?: {
  cliPort?: unknown;
  configPath?: string;
  env?: Record<string, string | undefined>;
}): StopPortResolution {
  const env = options?.env ?? process.env;

  const locked = validPort(readLockedPort());
  if (locked !== null) return { port: locked, source: 'lockfile' };

  const fromEnv = validPort(env.JARVIS_PORT);
  if (fromEnv !== null) return { port: fromEnv, source: 'env' };

  const fromCli = validPort(options?.cliPort);
  if (fromCli !== null) return { port: fromCli, source: 'cli' };

  const fromConfig = readConfiguredPort(options?.configPath);
  if (fromConfig !== null) return { port: fromConfig, source: 'config' };

  return { port: DEFAULT_DAEMON_PORT, source: 'default' };
}
