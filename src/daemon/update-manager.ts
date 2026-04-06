import { join } from 'node:path';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { getSetting, setSetting } from '../vault/settings.ts';
import { getJarvisVersion } from '../cli/update.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const RELEASES_LATEST_URL = 'https://api.github.com/repos/vierisid/jarvis/releases/latest';
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const RELEASE_CHECK_TIMEOUT_MS = 10_000;
let updateJobStarting = false;

function isWindows(): boolean {
  return process.platform === 'win32';
}

type LatestRelease = {
  version: string;
  name: string;
  url: string;
  publishedAt: string | null;
  notes: string | null;
};

export type UpdateStatusPayload = {
  current_version: string;
  latest_version: string | null;
  latest_name: string | null;
  latest_url: string | null;
  latest_published_at: string | null;
  has_update: boolean;
  popup_visible: boolean;
  dismissed_version: string | null;
  last_checked_at: number | null;
  check_error: string | null;
  update_status: string;
  update_message: string | null;
  update_started_at: number | null;
  update_completed_at: number | null;
};

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

function parseVersion(version: string): { core: number[]; prerelease: string[] } {
  const normalized = normalizeVersion(version);
  const [coreRaw = '0', prereleaseRaw] = normalized.split('-', 2);
  const core = coreRaw.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const prerelease = prereleaseRaw ? prereleaseRaw.split('.') : [];
  return { core, prerelease };
}

export function compareVersions(a: string, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  const maxLen = Math.max(av.core.length, bv.core.length);
  for (let i = 0; i < maxLen; i += 1) {
    const ai = av.core[i] ?? 0;
    const bi = bv.core[i] ?? 0;
    if (ai !== bi) return ai > bi ? 1 : -1;
  }

  if (av.prerelease.length === 0 && bv.prerelease.length > 0) return 1;
  if (av.prerelease.length > 0 && bv.prerelease.length === 0) return -1;

  const maxPreLen = Math.max(av.prerelease.length, bv.prerelease.length);
  for (let i = 0; i < maxPreLen; i += 1) {
    const aPart = av.prerelease[i];
    const bPart = bv.prerelease[i];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    const aNum = Number(aPart);
    const bNum = Number(bPart);
    const bothNumeric = Number.isFinite(aNum) && Number.isFinite(bNum);
    if (bothNumeric && aNum !== bNum) return aNum > bNum ? 1 : -1;
    if (!bothNumeric && aPart !== bPart) return aPart > bPart ? 1 : -1;
  }

  return 0;
}

async function fetchLatestRelease(): Promise<LatestRelease> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RELEASE_CHECK_TIMEOUT_MS);

  try {
    const res = await fetch(RELEASES_LATEST_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'jarvis-update-checker',
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub release check failed (${res.status})`);
    }

    const body = await res.json() as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      published_at?: string;
      body?: string;
    };

    if (!body.tag_name) {
      throw new Error('GitHub release payload did not include a tag name');
    }

    const version = normalizeVersion(body.tag_name);
    const release: LatestRelease = {
      version,
      name: body.name?.trim() || `v${version}`,
      url: body.html_url?.trim() || 'https://github.com/vierisid/jarvis/releases',
      publishedAt: body.published_at ?? null,
      notes: body.body ?? null,
    };

    setSetting('jarvis.update.latest_version', release.version);
    setSetting('jarvis.update.latest_name', release.name);
    setSetting('jarvis.update.latest_url', release.url);
    setSetting('jarvis.update.latest_published_at', release.publishedAt ?? '');
    setSetting('jarvis.update.last_checked_at', String(Date.now()));
    setSetting('jarvis.update.check_error', '');

    return release;
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const message = isAbort
      ? 'Timed out while checking for updates'
      : (err instanceof Error ? err.message : 'Unknown error while checking for updates');
    setSetting('jarvis.update.last_checked_at', String(Date.now()));
    setSetting('jarvis.update.check_error', message);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getCachedLatestRelease(): LatestRelease | null {
  const version = getSetting('jarvis.update.latest_version');
  if (!version) return null;

  return {
    version,
    name: getSetting('jarvis.update.latest_name') || `v${version}`,
    url: getSetting('jarvis.update.latest_url') || 'https://github.com/vierisid/jarvis/releases',
    publishedAt: getSetting('jarvis.update.latest_published_at') || null,
    notes: null,
  };
}

async function resolveLatestRelease(forceRefresh: boolean): Promise<LatestRelease | null> {
  const lastCheckedAt = Number.parseInt(getSetting('jarvis.update.last_checked_at') ?? '', 10);
  const isFresh = Number.isFinite(lastCheckedAt) && (Date.now() - lastCheckedAt) < CHECK_INTERVAL_MS;

  if (!forceRefresh && isFresh) {
    return getCachedLatestRelease();
  }

  try {
    return await fetchLatestRelease();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setSetting('jarvis.update.check_error', message);
    setSetting('jarvis.update.last_checked_at', String(Date.now()));
    return getCachedLatestRelease();
  }
}

export async function getUpdateStatus(forceRefresh = false): Promise<UpdateStatusPayload> {
  const currentVersion = getJarvisVersion();
  const latest = await resolveLatestRelease(forceRefresh);
  const latestVersion = latest?.version ?? null;
  const dismissedVersion = getSetting('jarvis.update.dismissed_version');
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;
  const popupVisible = hasUpdate && dismissedVersion !== latestVersion;

  return {
    current_version: currentVersion,
    latest_version: latestVersion,
    latest_name: latest?.name ?? null,
    latest_url: latest?.url ?? null,
    latest_published_at: latest?.publishedAt ?? null,
    has_update: hasUpdate,
    popup_visible: popupVisible,
    dismissed_version: dismissedVersion,
    last_checked_at: Number.parseInt(getSetting('jarvis.update.last_checked_at') ?? '', 10) || null,
    check_error: getSetting('jarvis.update.check_error'),
    update_status: getSetting('jarvis.update.status') || 'idle',
    update_message: getSetting('jarvis.update.message'),
    update_started_at: Number.parseInt(getSetting('jarvis.update.started_at') ?? '', 10) || null,
    update_completed_at: Number.parseInt(getSetting('jarvis.update.completed_at') ?? '', 10) || null,
  };
}

export function dismissUpdate(version: string): void {
  setSetting('jarvis.update.dismissed_version', normalizeVersion(version));
}

export async function startUpdateJob(): Promise<{ ok: boolean; message: string }> {
  if (updateJobStarting) {
    return { ok: false, message: 'An update is already being scheduled.' };
  }

  const status = getSetting('jarvis.update.status');
  if (status === 'queued' || status === 'in_progress') {
    return { ok: false, message: 'An update is already in progress.' };
  }

  updateJobStarting = true;
  try {
    const currentVersion = getJarvisVersion();
    const latest = await resolveLatestRelease(false);

    // Guard against stale UI state or direct API calls when already current.
    if (!latest?.version || compareVersions(latest.version, currentVersion) <= 0) {
      const message = `Already on the latest version (${currentVersion}).`;
      setSetting('jarvis.update.status', 'success');
      setSetting('jarvis.update.message', message);
      setSetting('jarvis.update.started_at', String(Date.now()));
      setSetting('jarvis.update.completed_at', String(Date.now()));
      return { ok: true, message };
    }

    setSetting('jarvis.update.status', 'queued');
    setSetting('jarvis.update.message', latest?.version ? `Scheduling update to ${latest.version}...` : 'Scheduling update...');
    setSetting('jarvis.update.started_at', String(Date.now()));
    setSetting('jarvis.update.completed_at', '');

    const logsDir = join(PACKAGE_ROOT, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, 'update.log');
    const logFd = openSync(logPath, 'a');

    try {
      const targetVersionArg = latest?.version ? `--target-version=${latest.version}` : '';
      const isDocker = existsSync('/.dockerenv');
      const dockerArg = isDocker ? '--in-docker' : '';
      const allArgs = [targetVersionArg, dockerArg].filter(Boolean).join(' ');
      const child = isWindows()
        ? spawn(
          'powershell.exe',
          ['-NoProfile', '-Command', `Start-Sleep -Seconds 1; bun run src/cli/update.ts ${allArgs}`],
          {
            cwd: PACKAGE_ROOT,
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env },
          },
        )
        : spawn(
          'bash',
          ['-lc', `sleep 1; bun run src/cli/update.ts ${allArgs}`],
          {
            cwd: PACKAGE_ROOT,
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env },
          },
        );
      child.unref();
    } finally {
      closeSync(logFd);
    }

    return {
      ok: true,
      message: latest?.version
        ? `Starting update to ${latest.version}. The dashboard will reconnect after JARVIS restarts.`
        : 'Starting update. The dashboard will reconnect after JARVIS restarts.',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to schedule update.';
    setSetting('jarvis.update.status', 'error');
    setSetting('jarvis.update.message', message);
    setSetting('jarvis.update.completed_at', String(Date.now()));
    return { ok: false, message };
  } finally {
    updateJobStarting = false;
  }
}
