import { getInstalledVersion } from '../cli/version.ts';
import { detectInstallMethod } from '../cli/install-method.ts';
import { computeAnonId } from './anon-id.ts';
import { telemetryEndpoint } from './constants.ts';

export type TelemetryPayload = {
  anon_id: string;
  app_version: string;
  install_method: string;
  /** "<platform>/<arch>", e.g. "linux/x64", "darwin/arm64". */
  os: string;
};

export type SendOutcome = {
  ok: boolean;
  reason?: 'unconfigured' | 'http' | 'network' | 'timeout';
  status?: number;
  error?: string;
};

export function buildPayload(packageRoot: string): TelemetryPayload {
  return {
    anon_id: computeAnonId(),
    app_version: getInstalledVersion(packageRoot),
    install_method: detectInstallMethod(packageRoot).method,
    os: `${process.platform}/${process.arch}`,
  };
}

export async function sendPing(
  payload: TelemetryPayload,
  opts: { timeoutMs?: number; endpoint?: { url: string; key: string } | null } = {},
): Promise<SendOutcome> {
  const endpoint = opts.endpoint !== undefined ? opts.endpoint : telemetryEndpoint();
  if (!endpoint) return { ok: false, reason: 'unconfigured' };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? 5000);

  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: endpoint.key,
        Authorization: `Bearer ${endpoint.key}`,
        // PostgREST: don't bother returning the inserted row.
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, reason: 'http', status: res.status };
  } catch (err) {
    if (timedOut) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network', error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
