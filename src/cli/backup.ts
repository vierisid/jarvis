/**
 * Instance export/restore CLIs:
 *
 *   jarvis export [--out <path>|-] [--full]   consistent archive of user data
 *   jarvis restore <archive|->                validate + replace data from an archive
 *
 * Export produces a PLAIN tar (compression/encryption are the caller's job —
 * the hosting pipeline pipes through `zstd | age`, a self-hoster can redirect
 * to a file). Content: a hot-consistent SQLite snapshot (`VACUUM INTO`, safe
 * against concurrent WAL writers) that must pass `PRAGMA integrity_check`,
 * plus the curated persistent files. The DB snapshot is point-in-time
 * consistent; the other entries are copied into staging right after it (so
 * they may lag the snapshot by moments, but tar never reads a live file and
 * cannot fail on "file changed as we read it"). Symlinked entries are
 * dereferenced — the archive always contains the real data, never a link.
 * Ephemeral state (logs, caches, browser profiles, pidfile) and the
 * server-authored config.yaml are never included.
 *
 * `--full` additionally includes the plaintext secrets: google-tokens.json,
 * the sidecar signing keys, and the keychain pair (.secrets.enc/.secrets.key)
 * that holds the LLM provider credentials — so a restore works without
 * re-connecting anything. That is the variant hosting backups use; the
 * default keeps the archive far less sensitive for user-facing downloads.
 *
 * Restore is stop-before-restore: it acquires the daemon's own flock (which
 * is JARVIS_HOME-aware, same resolution the daemon uses) plus the data dir's,
 * and HOLDS them until the swap is done — a running daemon makes restore
 * refuse, and a daemon cannot start mid-restore. Files are staged under the
 * data dir (same filesystem) and swapped in with renames; any failure before
 * or during the swap rolls back to the pre-restore state. A `db_path` on a
 * different filesystem than `data_dir` is unsupported: restore fails cleanly
 * before touching the database (renames cannot cross filesystems).
 *
 * Trust model: tar's own defaults (GNU/bsdtar refuse `..` members and strip
 * absolute paths; busybox tar is weaker — don't use it) plus the top-level
 * type-checks below guard extraction, but archives are NOT authenticated:
 * age gives confidentiality, not sender authenticity, and `pieces` contains
 * executable code. Anyone able to substitute an archive in the backup bucket
 * can run code — authenticity has to come from the pipeline (e.g. signing),
 * not from these checks.
 *
 * Like devices.ts: these run WITHOUT the daemon, stdout is machine-readable
 * (the tar stream in `--out -` mode, a JSON summary otherwise) and progress
 * goes to stderr so provisioning can capture stdout verbatim.
 */

import { join, dirname } from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  chmodSync,
  cpSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import { loadConfig } from '../config/loader.ts';
import { acquireLockAt, lockPathFor } from '../daemon/pid.ts';
import { getInstalledVersion } from './version.ts';

interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Archive format version — bump on any breaking layout change. */
export const EXPORT_FORMAT = 1;

export interface ExportManifest {
  format: number;
  brainVersion: string;
  createdAt: string;
  full: boolean;
  /** Top-level tar entry names actually included (existing paths only). */
  files: string[];
}

/**
 * The curated data-dir entries, relative to data_dir. Order matters only for
 * readability of the manifest. `config.yaml` is deliberately absent: it is
 * server-authored on hosting (write-config regenerates it on the restore
 * target) and machine-specific on self-host.
 */
const BASE_ENTRIES = ['pieces', 'content', 'realtime-budget.json'];
const SECRET_ENTRIES = ['google-tokens.json', 'sidecar-keys', '.secrets.enc', '.secrets.key'];

/** Entries restored with tightened modes (plaintext secrets). */
const SECRET_MODES: Record<string, { dir?: number; file: number }> = {
  'google-tokens.json': { file: 0o600 },
  'sidecar-keys': { dir: 0o700, file: 0o600 },
  '.secrets.enc': { file: 0o600 },
  '.secrets.key': { file: 0o600 },
};

function sqliteQuotePath(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

/**
 * Write a consistent snapshot of the DB to `outPath` and verify it. VACUUM
 * INTO takes a read transaction, so it is safe while the daemon is writing
 * (WAL); the result is a compact single file (no -wal/-shm sidecars).
 */
function snapshotDb(dbPath: string, outPath: string): void {
  const src = new Database(dbPath, { readonly: true });
  try {
    src.exec(`VACUUM INTO ${sqliteQuotePath(outPath)}`);
  } finally {
    src.close();
  }

  const snap = new Database(outPath, { readonly: true });
  try {
    const row = snap.query('PRAGMA integrity_check').get() as { integrity_check?: string } | null;
    if (row?.integrity_check !== 'ok') {
      throw new Error(`snapshot failed integrity_check: ${JSON.stringify(row)}`);
    }
  } finally {
    snap.close();
  }
}

async function runTar(args: string[], io: CliIo, stdio: { stdin?: 'inherit'; stdout?: 'inherit' } = {}): Promise<void> {
  const proc = Bun.spawn(['tar', ...args], {
    stdin: stdio.stdin ?? 'ignore',
    stdout: stdio.stdout ?? 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    if (stderr.trim()) io.err(stderr.trim());
    throw new Error(`tar exited ${code}`);
  }
}

/** Parse a leading `x.y.z` out of a version string, or null. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v?.trim?.() ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewerVersion(candidate: string, baseline: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(baseline);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

export async function cmdExport(args: string[], io: CliIo = defaultIo): Promise<number> {
  const full = args.includes('--full');
  let out: string | undefined;
  const outIdx = args.indexOf('--out');
  if (outIdx !== -1) {
    out = args[outIdx + 1];
    if (!out || (out.startsWith('--') && out !== '-')) {
      io.err('usage: jarvis export [--out <path>|-] [--full]');
      return 2;
    }
  }
  // Bare `-` positional is accepted as shorthand for `--out -`.
  if (!out && args.includes('-')) out = '-';
  const toStdout = out === '-';
  const outPath = toStdout
    ? undefined
    : out ?? `jarvis-export-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.tar`;

  try {
    const config = await loadConfig();
    const dataDir = config.daemon.data_dir;
    const dbPath = config.daemon.db_path;
    if (!existsSync(dbPath)) {
      io.err(`error: no database at ${dbPath} — nothing to export`);
      return 1;
    }

    // Everything is staged under the data dir before tarring: tar never races
    // the live daemon over a mutating file, and the (possibly large) snapshot
    // stays off tmpfs on memory-constrained hosts. Disk is the cheap resource
    // here; the copies are deleted in the finally.
    const staging = mkdtempSync(join(dataDir, '.export-'));
    try {
      io.err(`Snapshotting database (${dbPath})...`);
      snapshotDb(dbPath, join(staging, 'jarvis.db'));

      const entries = [...BASE_ENTRIES, ...(full ? SECRET_ENTRIES : [])].filter((e) =>
        existsSync(join(dataDir, e)),
      );

      // Some components write secrets to the legacy `~/.jarvis` root even when
      // data_dir points elsewhere. Silently producing a "--full" archive that
      // is missing them would only be discovered during a real restore — warn.
      if (full) {
        const legacyRoot = join(homedir(), '.jarvis');
        if (dataDir !== legacyRoot) {
          for (const entry of SECRET_ENTRIES) {
            if (!existsSync(join(dataDir, entry)) && existsSync(join(legacyRoot, entry))) {
              io.err(
                `warning: '${entry}' exists at ${legacyRoot} but not in ${dataDir} — it will NOT be in this archive`,
              );
            }
          }
        }
      }

      for (const entry of entries) {
        try {
          cpSync(join(dataDir, entry), join(staging, entry), { recursive: true, dereference: true });
        } catch (e) {
          throw new Error(
            `staging '${entry}' failed: ${e instanceof Error ? e.message : String(e)} (a broken symlink inside it cannot be archived)`,
          );
        }
      }

      const manifest: ExportManifest = {
        format: EXPORT_FORMAT,
        brainVersion: getInstalledVersion(join(import.meta.dir, '..', '..')),
        createdAt: new Date().toISOString(),
        full,
        files: ['manifest.json', 'jarvis.db', ...entries],
      };
      await Bun.write(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

      const tarArgs = ['-cf', toStdout ? '-' : outPath!, '-C', staging, ...manifest.files];
      io.err(`Archiving ${manifest.files.length} entries${full ? ' (full: secrets included)' : ''}...`);
      await runTar(tarArgs, io, toStdout ? { stdout: 'inherit' } : {});

      if (!toStdout) {
        const sizeBytes = statSync(outPath!).size;
        io.out(JSON.stringify({ path: outPath, sizeBytes, full, files: manifest.files }));
      }
      io.err('Export complete.');
      return 0;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (e) {
    io.err(`export failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/**
 * Move `source` onto `target`, setting the previous target aside rather than
 * deleting it. Destroy-then-place would be unrecoverable: if the rename then
 * failed (EXDEV when db_path lives on another filesystem, a transient EACCES),
 * the old copy is already gone AND the staging dir gets cleaned up in the
 * caller's `finally` — losing both. The aside copies are only discarded once
 * every entry has swapped; `undo` puts them back if one doesn't.
 */
function swapIn(source: string, target: string, aside: string): { undo: () => void; commit: () => void } {
  const hadTarget = existsSync(target);
  if (hadTarget) renameSync(target, aside);
  try {
    renameSync(source, target);
  } catch (e) {
    if (hadTarget) renameSync(aside, target); // put it back before rethrowing
    throw e;
  }
  return {
    undo: () => {
      rmSync(target, { recursive: true, force: true });
      if (hadTarget) renameSync(aside, target);
    },
    commit: () => {
      if (hadTarget) rmSync(aside, { recursive: true, force: true });
    },
  };
}

/**
 * Move `target` out of the way with no replacement (same aside/undo/commit
 * contract as `swapIn`). Used for the old DB's WAL/SHM sidecars: they must
 * not survive next to the restored snapshot (a stale WAL would replay over
 * it), but they cannot be deleted outright either — a SIGKILL'd daemon may
 * have committed transactions that exist ONLY in the WAL, and a rollback has
 * to put them back alongside the old database.
 */
function retireEntry(target: string, aside: string): { undo: () => void; commit: () => void } {
  const hadTarget = existsSync(target);
  if (hadTarget) renameSync(target, aside);
  return {
    undo: () => {
      if (hadTarget) renameSync(aside, target);
    },
    commit: () => {
      if (hadTarget) rmSync(aside, { recursive: true, force: true });
    },
  };
}

/**
 * Reject anything that is not a plain file or a real directory. tar itself
 * refuses `..` members and won't extract through a symlink, so this guards the
 * remaining case: an archive whose `pieces`/`content`/`sidecar-keys` entry IS
 * a symlink. Swapping that in would point the brain (and the recursive chmod
 * below) at a path outside the data dir. (Top-level only — see the trust-model
 * note in the header: this is a hardening layer, not an authenticity check.)
 */
function assertPlainEntry(path: string, entry: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`archive entry '${entry}' is a symlink — refusing to restore it`);
  if (!st.isFile() && !st.isDirectory()) {
    throw new Error(`archive entry '${entry}' is neither a file nor a directory — refusing to restore it`);
  }
}

/** Recursively tighten modes on a restored secret entry (tar was created and
 * extracted as the same user, but the archive may have transited systems with
 * a looser umask — restat defensively). Uses lstat and never follows a link:
 * chmod'ing through one would target whatever it points at. */
function tightenModes(path: string, modes: { dir?: number; file: number }): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSync(path, modes.dir ?? 0o700);
    for (const name of readdirSync(path)) {
      tightenModes(join(path, name), modes);
    }
  } else {
    chmodSync(path, modes.file);
  }
}

export async function cmdRestore(
  args: string[],
  io: CliIo = defaultIo,
  /** Test-only fault injection: throw right after the named entry has swapped
   * in, so tests can drive the rollback path deterministically (rename gives
   * no natural same-filesystem failure hook). Never set in production. */
  _hooks: { failAfterSwap?: string } = {},
): Promise<number> {
  const archive = args.filter((a) => !a.startsWith('--'))[0];
  if (!archive) {
    io.err('usage: jarvis restore <archive|->');
    return 2;
  }
  const fromStdin = archive === '-';

  try {
    const config = await loadConfig();
    const dataDir = config.daemon.data_dir;
    const dbPath = config.daemon.db_path;

    if (!fromStdin && !existsSync(archive)) {
      io.err(`error: no archive at ${archive}`);
      return 1;
    }

    // Stop-before-restore: ACQUIRE the daemon's own lock (JARVIS_HOME-aware —
    // the same path resolution the daemon uses) plus the data dir's, and hold
    // both until the swap is done. A running daemon makes this fail; holding
    // the locks means one also cannot START mid-restore, and two concurrent
    // restores cannot interleave.
    mkdirSync(dataDir, { recursive: true });
    const lockPaths = [...new Set([lockPathFor(), lockPathFor(dataDir)])];
    const heldLocks: Array<{ release: () => void }> = [];
    for (const lockPath of lockPaths) {
      const lock = acquireLockAt(lockPath, process.pid);
      if (!lock) {
        for (const held of heldLocks) held.release();
        io.err('error: the daemon is running — stop it first (jarvis stop)');
        return 1;
      }
      heldLocks.push(lock);
    }

    try {
      // Stage on the SAME filesystem as the data dir so the final swaps are
      // renames, not copies (and never partial on failure).
      const staging = mkdtempSync(join(dataDir, '.restore-'));
      try {
        io.err('Extracting archive...');
        await runTar(
          fromStdin ? ['-xf', '-', '-C', staging] : ['-xf', archive, '-C', staging],
          io,
          fromStdin ? { stdin: 'inherit' } : {},
        );

        const manifestPath = join(staging, 'manifest.json');
        if (!existsSync(manifestPath)) throw new Error('archive has no manifest.json');
        const manifest = JSON.parse(await Bun.file(manifestPath).text()) as ExportManifest;
        if (manifest.format !== EXPORT_FORMAT) {
          throw new Error(`unsupported archive format ${manifest.format} (this brain reads ${EXPORT_FORMAT})`);
        }
        // EXPORT_FORMAT covers the archive layout, not the DB schema: an
        // archive from a newer brain can carry migrations this brain has never
        // seen, which would otherwise surface only as daemon-boot failures.
        const installed = getInstalledVersion(join(import.meta.dir, '..', '..'));
        if (isNewerVersion(manifest.brainVersion, installed)) {
          io.err(
            `warning: archive was created by brain ${manifest.brainVersion} but this brain is ${installed} — its database schema may be newer than this brain understands`,
          );
        }
        const snapPath = join(staging, 'jarvis.db');
        if (!existsSync(snapPath)) throw new Error('archive has no jarvis.db');
        const snap = new Database(snapPath, { readonly: true });
        try {
          const row = snap.query('PRAGMA integrity_check').get() as { integrity_check?: string } | null;
          if (row?.integrity_check !== 'ok') throw new Error('archived database fails integrity_check');
        } finally {
          snap.close();
        }

        // Type-check every entry BEFORE anything is moved, so a crafted archive
        // fails while the existing data is still fully intact.
        assertPlainEntry(snapPath, 'jarvis.db');
        const present = [...BASE_ENTRIES, ...SECRET_ENTRIES].filter((entry) => {
          const source = join(staging, entry);
          if (!existsSync(source)) return false;
          assertPlainEntry(source, entry);
          return true;
        });

        // All validation passed — swap in. Only KNOWN entry names are ever
        // moved (a crafted archive can't plant arbitrary files).
        //
        // Each move sets the old copy aside instead of deleting it; a failure
        // partway rolls every completed move back, so the data dir is never
        // left half-restored (new DB + old content, or an entry lost entirely).
        io.err('Swapping restored data into place...');
        mkdirSync(dirname(dbPath), { recursive: true });
        const asideDir = mkdtempSync(join(dataDir, '.pre-restore-'));
        const swaps: Array<{ undo: () => void; commit: () => void }> = [];
        const restored: string[] = ['jarvis.db'];
        const failPoint = (name: string) => {
          if (_hooks.failAfterSwap === name) throw new Error(`injected failure after swapping '${name}'`);
        };
        try {
          swaps.push(retireEntry(`${dbPath}-wal`, join(asideDir, 'jarvis.db-wal')));
          swaps.push(retireEntry(`${dbPath}-shm`, join(asideDir, 'jarvis.db-shm')));
          swaps.push(swapIn(snapPath, dbPath, join(asideDir, 'jarvis.db')));
          failPoint('jarvis.db');
          for (const entry of present) {
            swaps.push(swapIn(join(staging, entry), join(dataDir, entry), join(asideDir, entry)));
            const modes = SECRET_MODES[entry];
            if (modes) tightenModes(join(dataDir, entry), modes);
            restored.push(entry);
            failPoint(entry);
          }
        } catch (e) {
          let rollbackFailed = false;
          for (const swap of swaps.reverse()) {
            try {
              swap.undo();
            } catch {
              /* keep undoing the rest; the aside dir is preserved below */
              rollbackFailed = true;
            }
          }
          if (rollbackFailed) {
            // The aside dir now holds the ONLY copy of whatever didn't make it
            // back — deleting it here would be the exact double-loss the aside
            // mechanism exists to prevent. Leave it for manual recovery.
            io.err(`rollback incomplete — pre-restore copies kept at ${asideDir}`);
          } else {
            rmSync(asideDir, { recursive: true, force: true });
          }
          throw e;
        }
        for (const swap of swaps) swap.commit();
        rmSync(asideDir, { recursive: true, force: true });

        io.out(JSON.stringify({ restored: true, brainVersion: manifest.brainVersion, files: restored }));
        io.err('Restore complete. Start the daemon with: jarvis start');
        return 0;
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    } finally {
      for (const held of heldLocks) held.release();
    }
  } catch (e) {
    io.err(`restore failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
