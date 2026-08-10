/**
 * Standalone device (sidecar) management CLIs:
 *
 *   jarvis enroll <name> [--json]    mint + store an enrollment JWT (upsert by name)
 *   jarvis sidecars list [--json]    list enrolled devices
 *   jarvis revoke <sid> [--json]     revoke a device
 *
 * These run WITHOUT the daemon: they open the vault DB directly and share the
 * enrollment module with the daemon's SidecarManager. That is what lets a
 * hosting server mint the first device's JWT while the brain is still
 * booting (ONBOARDING flow), and manage devices over SSH afterwards. The
 * daemon (WAL mode, per-connect DB reads) picks changes up live.
 *
 * stdout is machine-readable (the token, or JSON with --json); progress goes
 * to stderr so provisioning can capture stdout verbatim.
 */

import { loadConfig } from '../config/loader.ts';
import { initDatabase, getDb } from '../vault/schema.ts';
import { enrollDevice } from '../sidecar/enrollment.ts';
import type { SidecarRecord } from '../sidecar/types.ts';
import { resolveExternalOrigin } from '../util/external-origin.ts';

interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

async function openVault(io: CliIo): Promise<{ dataDir: string; brainUrl: string }> {
  const config = await loadConfig();
  initDatabase(config.daemon.db_path, { quiet: true });
  const resolved = resolveExternalOrigin(config);
  for (const warning of resolved.warnings) io.err(`warning: ${warning}`);
  const brainUrl = resolved.httpOrigin;
  if (resolved.source === 'fallback' && resolved.warnings.length === 0) {
    io.err(
      'warning: daemon.public_url is not set; tokens will point at ' +
        `localhost:${config.daemon.port} and only work for sidecars on this machine.`,
    );
  }
  return { dataDir: config.daemon.data_dir, brainUrl };
}

export async function cmdEnroll(args: string[], io: CliIo = defaultIo): Promise<number> {
  const json = args.includes('--json');
  const rotate = args.includes('--rotate');
  const name = args.filter((a) => !a.startsWith('--'))[0];
  if (!name) {
    io.err('usage: jarvis enroll <device-name> [--json] [--rotate]');
    return 2;
  }

  try {
    const { dataDir, brainUrl } = await openVault(io);
    const result = await enrollDevice(dataDir, brainUrl, name, { onExisting: 'upsert', rotate });
    if (json) {
      io.out(
        JSON.stringify({
          token: result.token,
          sid: result.sidecar.id,
          name: result.sidecar.name,
          created: result.created,
        }),
      );
    } else {
      io.err(
        result.created
          ? `enrolled "${result.sidecar.name}" (${result.sidecar.id})`
          : `re-minted token for existing device "${result.sidecar.name}" (${result.sidecar.id}); previous tokens REMAIN VALID (use --rotate to invalidate them)`,
      );
      io.out(result.token);
    }
    return 0;
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function cmdSidecars(args: string[], io: CliIo = defaultIo): Promise<number> {
  const sub = args.filter((a) => !a.startsWith('--'))[0] ?? 'list';
  const json = args.includes('--json');
  if (sub !== 'list') {
    io.err('usage: jarvis sidecars list [--json]');
    return 2;
  }

  try {
    await openVault(io);
    const rows = getDb()
      .query('SELECT * FROM sidecars ORDER BY enrolled_at DESC')
      .all() as SidecarRecord[];
    const devices = rows.map((r) => ({
      sid: r.id,
      name: r.name,
      status: r.status,
      enrolled_at: r.enrolled_at,
      last_seen_at: r.last_seen_at,
      // The hosting server reads this (follow-the-night scheduling); null
      // until the device's sidecar first registers.
      timezone: r.timezone ?? null,
    }));
    if (json) {
      io.out(JSON.stringify({ devices }));
    } else if (devices.length === 0) {
      io.out('no enrolled devices');
    } else {
      for (const d of devices) {
        io.out(`${d.sid}  ${d.status.padEnd(8)}  ${d.name}  (enrolled ${d.enrolled_at}, last seen ${d.last_seen_at ?? 'never'})`);
      }
    }
    return 0;
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function cmdRevoke(args: string[], io: CliIo = defaultIo): Promise<number> {
  const json = args.includes('--json');
  const sid = args.filter((a) => !a.startsWith('--'))[0];
  if (!sid) {
    io.err('usage: jarvis revoke <sid> [--json]');
    return 2;
  }

  try {
    await openVault(io);
    // Deletes the enrollment row: new connections are rejected immediately,
    // and a running daemon severs any LIVE session for this sid within ~30s
    // (its revocation sweep re-checks enrollment; this CLI is a separate
    // process and cannot close the daemon's sockets itself). Idempotent:
    // revoking an unknown/already-revoked sid reports revoked=false, exit 0.
    const result = getDb().run('DELETE FROM sidecars WHERE id = ? AND status = ?', [sid, 'enrolled']);
    const revoked = result.changes > 0;
    if (json) io.out(JSON.stringify({ sid, revoked }));
    else io.out(revoked ? `revoked ${sid}` : `nothing to revoke for ${sid}`);
    return 0;
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
