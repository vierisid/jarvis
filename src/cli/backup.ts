/**
 * Instance export/restore CLIs:
 *
 *   jarvis export [--out <path>|-] [--no-secrets]   consistent archive of user data
 *   jarvis restore <archive|-> [--allow-missing-keys]   validate + replace data from an archive
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
 * The default archive is COMPLETE: it also carries the plaintext secrets
 * (google-tokens.json, the sidecar signing keys, workflow-encryption.key (the
 * only thing that can read the encrypted app_connection rows the DB snapshot
 * already carries), and the keychain pair (.secrets.enc/.secrets.key) that
 * holds the LLM provider credentials and the STT/TTS API keys) plus the
 * installed-pieces manifest (`pieces/installed.json`; the daemon reinstalls
 * the packages from it on boot), so a restore gives a working install. Because
 * it holds secrets the archive file is written 0600. `--full` is accepted and
 * means the same as the default. `--no-secrets` leaves the secrets out for an
 * archive that is meant to be shared; restoring one that has encrypted
 * workflow connections is refused unless the key is supplied some other way
 * (`restore --allow-missing-keys`).
 *
 * The keychain pair is staged from wherever `keychainDir()` resolves — the
 * data dir on a JARVIS_HOME install the daemon has migrated, ~/.jarvis
 * otherwise — because it is now the ONLY place any API key exists and an
 * archive missing it restores to a brain with no credentials. The remaining
 * secret entries are still ~/.jarvis-only; the legacy-root warning further
 * down covers them.
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
 * age gives confidentiality, not sender authenticity, and `pieces/installed.json`
 * names npm packages the daemon installs and runs on its next boot (restore
 * holds each entry to the shape the Library writes, but a valid package name
 * is still code). Anyone able to substitute an archive in the backup bucket
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
  writeFileSync,
  readFileSync,
  copyFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import { loadConfig } from '../config/loader.ts';
import { acquireLockAt, lockPathFor } from '../daemon/pid.ts';
import { keychainDir, migrateKeychain } from '../vault/keychain.ts';
import {
  ENCRYPTED_VALUE_SQL,
  KEY_FILE_NAME as WORKFLOW_KEY_FILE,
  decryptBoundJson,
  migrateWorkflowEncryptionKey,
  setEncryptionKey,
  resolveKeyFile as resolveWorkflowKeyFile,
  workflowKeyTarget,
} from '../workflows/db/encryption.ts';
import { piecesBaseDir, SAFE_PACKAGE_NAME } from '../workflows/pieces-library/installer.ts';
import { catalogById } from '../workflows/pieces-library/catalog.ts';
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
const BASE_ENTRIES = ['content', 'realtime-budget.json'];

/**
 * Installed library pieces. The packages live under piecesBaseDir() (which is
 * `~/.jarvis/pieces` and NOT necessarily under data_dir), so the archive
 * carries only the manifest, `pieces/installed.json`; the daemon runs
 * `bun install` from it on the next boot. Restore puts it back at
 * piecesBaseDir(), never into data_dir.
 */
const PIECES_ENTRY = 'pieces';
const PIECES_MANIFEST = 'installed.json';
const SECRET_ENTRIES = [
  'google-tokens.json',
  'sidecar-keys',
  '.secrets.enc',
  '.secrets.key',
  // The AES key for the encrypted `app_connection.value` rows the DB snapshot
  // already carries. Without it a restore brings back every workflow
  // credential as undecryptable ciphertext, silently. It is a single name at
  // the data-dir root like the rest of this list because it MOVED there -- it
  // used to live under `cache/`, which this export excludes as ephemeral.
  WORKFLOW_KEY_FILE,
];

/** Entries restored with tightened modes (plaintext secrets). */
const SECRET_MODES: Record<string, { dir?: number; file: number }> = {
  'google-tokens.json': { file: 0o600 },
  'sidecar-keys': { dir: 0o700, file: 0o600 },
  '.secrets.enc': { file: 0o600 },
  '.secrets.key': { file: 0o600 },
  [WORKFLOW_KEY_FILE]: { file: 0o600 },
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
  // Complete by default. `--full` is the old spelling of the default.
  const full = !args.includes('--no-secrets');
  let out: string | undefined;
  const outIdx = args.indexOf('--out');
  if (outIdx !== -1) {
    out = args[outIdx + 1];
    if (!out || (out.startsWith('--') && out !== '-')) {
      io.err('usage: jarvis export [--out <path>|-] [--no-secrets]');
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

      // The keychain is RESOLVED, not assumed: it sits in the data dir once
      // the daemon has migrated it there, and in ~/.jarvis before that. Taking
      // it from wherever it actually is keeps `--full` complete either way —
      // and it is now the only place any API key exists.
      const secretsDir = keychainDir();
      // Same treatment for the workflow encryption key: it normally sits at
      // the data-dir root, but an install this version has not booted yet
      // still has it under `cache/` (or, on a JARVIS_HOME install, under
      // ~/.jarvis/cache). Take it from wherever it resolves so `--full` is
      // complete before AND after the relocation.
      const workflowKeyDir = dirname(resolveWorkflowKeyFile());
      const sourceDir = (entry: string): string => {
        if (entry === '.secrets.enc' || entry === '.secrets.key') return secretsDir;
        if (entry === WORKFLOW_KEY_FILE) return workflowKeyDir;
        return dataDir;
      };

      const entries = [...BASE_ENTRIES, ...(full ? SECRET_ENTRIES : [])].filter((e) =>
        existsSync(join(sourceDir(e), e)),
      );
      const piecesManifest = join(piecesBaseDir(), PIECES_MANIFEST);
      const hasPieces = existsSync(piecesManifest);
      if (hasPieces) entries.unshift(PIECES_ENTRY);

      // The remaining secrets (google tokens, sidecar keys) are still written
      // to the legacy `~/.jarvis` root even when data_dir points elsewhere.
      // Silently producing a "--full" archive that is missing them would only
      // be discovered during a real restore — warn.
      if (full) {
        const legacyRoot = join(homedir(), '.jarvis');
        if (dataDir !== legacyRoot) {
          for (const entry of SECRET_ENTRIES) {
            if (sourceDir(entry) !== dataDir) continue; // resolved above
            if (!existsSync(join(dataDir, entry)) && existsSync(join(legacyRoot, entry))) {
              io.err(
                `warning: '${entry}' exists at ${legacyRoot} but not in ${dataDir} — it will NOT be in this archive`,
              );
            }
          }
        }
      }

      if (hasPieces) {
        mkdirSync(join(staging, PIECES_ENTRY));
        cpSync(piecesManifest, join(staging, PIECES_ENTRY, PIECES_MANIFEST), { dereference: true });
      }

      for (const entry of entries) {
        if (entry === PIECES_ENTRY) continue;
        try {
          cpSync(join(sourceDir(entry), entry), join(staging, entry), { recursive: true, dereference: true });
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
      io.err(`Archiving ${manifest.files.length} entries${full ? ' (secrets included)' : ' (no secrets: cannot restore saved keys)'}...`);
      if (!toStdout) {
        // The archive can hold plaintext keys: it must never exist with the
        // default 0644. Create it 0600 BEFORE tar writes to it (tar keeps the
        // mode of an existing file) and set the mode again afterwards, so a
        // pre-existing looser file is tightened too. A directory made for it
        // is 0700.
        mkdirSync(dirname(outPath!), { recursive: true, mode: 0o700 });
        writeFileSync(outPath!, '', { mode: 0o600 });
        chmodSync(outPath!, 0o600);
      }
      await runTar(tarArgs, io, toStdout ? { stdout: 'inherit' } : {});

      if (!toStdout) {
        chmodSync(outPath!, 0o600);
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


interface ArchiveCheck {
  encryptedConnections: number;
  /**
   * Which key was proven to open every saved connection: the archive's, the
   * one already on this machine, none needed, or not checked
   * (`--allow-missing-keys`).
   */
  keySource: 'archive' | 'install' | 'none' | 'unchecked';
  /** Library apps used by workflows that the archive's manifest does not list. */
  missingPieces: string[];
  /** Library apps the restored install will reinstall on its next start. */
  piecesToInstall: number;
}

/**
 * Read the staged database and the staged key material to decide what the
 * restore can and cannot deliver. Throws a plain-English refusal when the
 * restore could never start; returns counts for the summary otherwise.
 */
function checkArchive(staging: string, snapPath: string, hasPieces: boolean, allowMissingKeys: boolean): ArchiveCheck {
  const db = new Database(snapPath, { readonly: true });
  let rows: Array<{ id: string; project_id: string; piece_name: string; external_id: string; value: string }> = [];
  const used = new Set<string>();
  try {
    const hasTable = (name: string) =>
      db.query("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
    if (hasTable('app_connection')) {
      rows = db
        .query(`SELECT id, project_id, piece_name, external_id, value FROM app_connection WHERE ${ENCRYPTED_VALUE_SQL}`)
        .all() as typeof rows;
    }
    if (hasTable('flow_version')) {
      for (const { trigger } of db.query('SELECT trigger FROM flow_version').all() as Array<{ trigger: string }>) {
        for (const m of String(trigger).matchAll(/"pieceName"\s*:\s*"([^"]+)"/g)) used.add(m[1]!);
      }
    }
  } finally {
    db.close();
  }

  // Which key the restored install will decrypt with: the archive's own, or
  // (an archive without one: `--no-secrets`, or one older than the key moving
  // into the archive) the key this install already resolves, which restore
  // leaves in place. Restoring in place over the same install must not be
  // refused just because the archive does not repeat a key the machine has.
  let keySource: ArchiveCheck['keySource'] = rows.length === 0 ? 'none' : 'unchecked';
  if (rows.length > 0 && !allowMissingKeys) {
    const keyFile = join(staging, WORKFLOW_KEY_FILE);
    const noun = rows.length === 1 ? 'saved connection' : 'saved connections';
    const archiveHasKey = existsSync(keyFile);
    const hex = archiveHasKey ? readFileSyncText(keyFile).trim() : installKeyHex();
    if (hex === null) {
      throw new Error(
        `this archive has ${rows.length} ${noun} but not the key that unlocks them, so restoring it would give you a Jarvis that cannot start. `
        + 'Nothing was changed. Make a new backup with "jarvis export" (it includes the key), or if you keep the key somewhere else, restore again with --allow-missing-keys.',
      );
    }
    const failed = countUndecryptable(rows, hex);
    if (failed > 0) {
      throw new Error(
        archiveHasKey
          ? `the key in this archive does not unlock ${failed} of its ${rows.length} ${noun}. Nothing was changed. `
            + 'The archive is damaged or mixes files from two backups. Use a different backup, or restore again with --allow-missing-keys to continue without those connections working.'
          : `this archive has ${rows.length} ${noun} but not the key that unlocks them, and the key on this machine does not unlock ${failed} of them. `
            + 'Nothing was changed. Make a new backup with "jarvis export" (it includes the key), or if you keep the key somewhere else, restore again with --allow-missing-keys.',
      );
    }
    keySource = archiveHasKey ? 'archive' : 'install';
  }

  let installed = new Set<string>();
  let piecesToInstall = 0;
  const manifestFile = join(staging, PIECES_ENTRY, PIECES_MANIFEST);
  if (hasPieces && existsSync(manifestFile)) {
    const list = parsePiecesManifest(readFileSyncText(manifestFile));
    piecesToInstall = list.length;
    installed = new Set(list.map((p) => p.npmPackage));
  }
  const library = new Set([...catalogById().values()].map((e) => e.npmPackage));
  const missingPieces = [...used].filter((name) => library.has(name) && !installed.has(name)).sort();
  return { encryptedConnections: rows.length, keySource, missingPieces, piecesToInstall };
}

/** How many of `rows` the 64-hex key `hex` does not decrypt (all of them for a malformed key). */
function countUndecryptable(
  rows: Array<{ id: string; project_id: string; piece_name: string; external_id: string; value: string }>,
  hex: string,
): number {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return rows.length;
  let failed = 0;
  setEncryptionKey(Buffer.from(hex, 'hex'));
  try {
    for (const r of rows) {
      try {
        decryptBoundJson(r.value, { id: r.id, projectId: r.project_id, pieceName: r.piece_name, externalId: r.external_id });
      } catch {
        failed++;
      }
    }
  } finally {
    setEncryptionKey(null);
  }
  return failed;
}

/**
 * The workflow key this install resolves today WITHOUT generating one (the
 * env var, else the first key file that exists), or null. Read only: restore
 * never creates a key.
 */
function installKeyHex(): string | null {
  const env = process.env['JARVIS_WORKFLOW_ENCRYPTION_KEY'];
  if (env) return env.trim();
  const file = resolveWorkflowKeyFile();
  if (!existsSync(file)) return null;
  try {
    return readFileSyncText(file).trim();
  } catch {
    return null;
  }
}

/**
 * The archive's installed-apps list, held to the shape the Library writes.
 * The daemon `bun install`s every entry on its next boot, so an entry the
 * Library could not have written (a path, a git or file: spec, a name that
 * is not an npm package name) is refused here rather than handed to bun.
 */
function parsePiecesManifest(text: string): Array<{ npmPackage: string }> {
  const refuse = (why: string): never => {
    throw new Error(`the archive's list of installed apps ${why}. Nothing was changed. Use a different backup.`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse('is unreadable');
  }
  const m = parsed as { version?: unknown; pieces?: unknown } | null;
  if (!m || typeof m !== 'object' || m.version !== 1 || !Array.isArray(m.pieces)) return refuse('has an unexpected shape');
  return m.pieces.map((p) => {
    const e = p as Record<string, unknown> | null;
    if (
      !e
      || typeof e !== 'object'
      || typeof e['id'] !== 'string'
      || typeof e['npmPackage'] !== 'string'
      || typeof e['versionRange'] !== 'string'
      || typeof e['resolvedVersion'] !== 'string'
      || typeof e['installedAt'] !== 'number'
    ) {
      return refuse('has an entry with an unexpected shape');
    }
    if (!SAFE_PACKAGE_NAME.test(e['npmPackage']) || /[:/\\]/.test(e['versionRange'])) {
      return refuse(`has an entry that is not a Library app version (${JSON.stringify(e['id'])})`);
    }
    return { npmPackage: e['npmPackage'] };
  });
}

const KEY_SOURCE_NOTE: Record<ArchiveCheck['keySource'], string> = {
  archive: ' with their key',
  install: ' (opened by the key already on this machine)',
  none: '',
  unchecked: ' (key NOT checked)',
};

function readFileSyncText(path: string): string {
  return readFileSync(path, 'utf8');
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
    io.err('usage: jarvis restore <archive|-> [--allow-missing-keys]');
    return 2;
  }
  const fromStdin = archive === '-';
  const allowMissingKeys = args.includes('--allow-missing-keys');

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
        // `pieces` is handled apart: only its manifest, and into piecesBaseDir().
        const piecesSource = join(staging, PIECES_ENTRY);
        let hasPieces = false;
        if (existsSync(piecesSource)) {
          assertPlainEntry(piecesSource, PIECES_ENTRY);
          if (lstatSync(piecesSource).isDirectory() && existsSync(join(piecesSource, PIECES_MANIFEST))) {
            assertPlainEntry(join(piecesSource, PIECES_MANIFEST), `${PIECES_ENTRY}/${PIECES_MANIFEST}`);
            hasPieces = true;
          }
        }
        const check = checkArchive(staging, snapPath, hasPieces, allowMissingKeys);

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
          // The restored database is private to its owner, like the original.
          chmodSync(dbPath, 0o600);
          if (hasPieces) {
            // piecesBaseDir() need not share a filesystem with data_dir (a
            // JARVIS_HOME on another disk), and rename cannot cross one: copy
            // the small list next to its target first, and set the old one
            // aside in the same directory, so both moves stay renames there.
            const piecesBase = piecesBaseDir();
            mkdirSync(piecesBase, { recursive: true });
            const incoming = join(piecesBase, `.${PIECES_MANIFEST}.restore-${process.pid}`);
            const aside = join(piecesBase, `.${PIECES_MANIFEST}.pre-restore-${process.pid}`);
            copyFileSync(join(piecesSource, PIECES_MANIFEST), incoming);
            try {
              swaps.push(swapIn(incoming, join(piecesBase, PIECES_MANIFEST), aside));
            } catch (e) {
              rmSync(incoming, { force: true });
              throw e;
            }
            restored.push(PIECES_ENTRY);
            failPoint(PIECES_ENTRY);
          }
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

        // The daemon resolves the keychain independently of data_dir (its own
        // dir when JARVIS_HOME is set, ~/.jarvis otherwise), so a pair restored
        // into data_dir can land where nothing will ever read it — a brain with
        // no credentials, discovered only when the first LLM call fails. Put it
        // where the daemon looks; migrateKeychain copies, verifies and only then
        // removes, so a data dir on another filesystem is fine.
        // Never fatal: the data is already restored and committed by now, so a
        // keychain that cannot be moved (foreign key, unwritable target) is a
        // warning to act on, not a reason to fail a completed restore.
        const secretsTarget = keychainDir();
        // A key or keychain left where the daemon does not read it is NOT a
        // complete restore: say so in the to-do list, not only as a warning.
        let keychainStranded = false;
        let workflowKeyStranded = false;
        if (secretsTarget !== dataDir && existsSync(join(dataDir, '.secrets.enc'))) {
          try {
            if (migrateKeychain(dataDir, secretsTarget)) {
              io.err(`Keychain placed at ${secretsTarget} (where the daemon reads it).`);
            } else {
              keychainStranded = true;
              io.err(
                `warning: the restored keychain stayed in ${dataDir} — ${secretsTarget} already holds one and was left untouched`,
              );
            }
          } catch (e) {
            keychainStranded = true;
            io.err(
              `warning: the restored keychain stayed in ${dataDir} and will not be read from there `
              + `(moving it to ${secretsTarget} failed: ${e instanceof Error ? e.message : String(e)})`,
            );
          }
        }

        // Same for the workflow encryption key: the daemon resolves it from its
        // own secrets dir, which is data_dir on a JARVIS_HOME install but can
        // be ~/.jarvis (or JARVIS_SECRETS_DIR) otherwise. A key restored into
        // data_dir where nothing reads it is a brain whose workflow
        // credentials are all undecryptable ciphertext. Never fatal, for the
        // same reason as the keychain above: the data is already committed.
        const workflowKeyTargetPath = workflowKeyTarget();
        const restoredWorkflowKey = join(dataDir, WORKFLOW_KEY_FILE);
        if (workflowKeyTargetPath !== restoredWorkflowKey && existsSync(restoredWorkflowKey)) {
          try {
            if (migrateWorkflowEncryptionKey(restoredWorkflowKey, workflowKeyTargetPath)) {
              io.err(`Workflow encryption key placed at ${workflowKeyTargetPath} (where the daemon reads it).`);
            } else {
              workflowKeyStranded = true;
              io.err(
                `warning: the restored workflow encryption key stayed at ${restoredWorkflowKey} -- `
                + `${workflowKeyTargetPath} already holds one and was left untouched`,
              );
            }
          } catch (e) {
            workflowKeyStranded = true;
            io.err(
              `warning: the restored workflow encryption key stayed at ${restoredWorkflowKey} and will not be `
              + `read from there (moving it to ${workflowKeyTargetPath} failed: ${e instanceof Error ? e.message : String(e)})`,
            );
          }
        }

        // Say what came back and what did not. Anything the founder has to do
        // is a numbered-free plain line; "complete" is only claimed when the
        // install can start.
        const todo: string[] = [];
        if (!existsSync(join(dataDir, '.secrets.enc')) && !existsSync(join(secretsTarget, '.secrets.enc'))) {
          todo.push('No saved AI provider keys came with this backup. Add them again in Settings.');
        }
        if (keychainStranded) {
          todo.push(`The restored AI provider keys are in ${dataDir}, not ${secretsTarget} where Jarvis reads them. Move them there (see the warning above).`);
        }
        if (workflowKeyStranded) {
          todo.push(`The restored workflow key is at ${restoredWorkflowKey}, not ${workflowKeyTargetPath} where Jarvis reads it. Saved connections will not open until it is moved there (see the warning above).`);
        }
        if (check.keySource === 'unchecked') {
          todo.push(`This backup's ${check.encryptedConnections} saved connection(s) were not checked against a key (--allow-missing-keys). Make the key available before starting Jarvis.`);
        }
        if (!restored.includes('sidecar-keys')) {
          todo.push('Connected devices did not come with this backup. Connect them again.');
        }
        if (check.missingPieces.length > 0) {
          todo.push(
            `${check.missingPieces.length} app(s) used by your workflows are not in this backup's app list `
            + `(${check.missingPieces.join(', ')}). Install them again from the Library.`,
          );
        }
        io.out(
          JSON.stringify({
            restored: true,
            brainVersion: manifest.brainVersion,
            files: restored,
            connections: check.encryptedConnections,
            apps: check.piecesToInstall,
            todo,
          }),
        );
        io.err(
          `Restored: ${check.encryptedConnections} saved connection(s)${KEY_SOURCE_NOTE[check.keySource]}, ${check.piecesToInstall} installed app(s) `
          + '(they reinstall when Jarvis starts, which needs internet).',
        );
        for (const line of todo) io.err(`Still to do: ${line}`);
        io.err(
          todo.length > 0
            ? 'Restore complete, with the items above still to do. Start the daemon with: jarvis start'
            : 'Restore complete. Start the daemon with: jarvis start',
        );
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
