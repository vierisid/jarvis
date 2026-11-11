import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { cmdExport, cmdRestore, EXPORT_FORMAT, type ExportManifest } from './backup.ts';
import { acquireLockAt } from '../daemon/pid.ts';
import { getSecret, setSecrets } from '../vault/keychain.ts';
import { assertEncryptionKeyForStoredCredentials } from '../workflows/db/index.ts';
import {
  decryptBoundJson,
  encryptBoundJson,
  isEncrypted,
  isRowBound,
  setEncryptionKey,
} from '../workflows/db/encryption.ts';

/**
 * Obviously-fake workflow encryption key: 32 bytes of 0xC3, in the hex form
 * the key file stores. The DB snapshot below carries one row-bound `enc1a:`
 * connection encrypted with it, so the round-trip test can prove the restored
 * archive actually yields a readable credential rather than just a file of
 * the right length.
 */
const WORKFLOW_KEY_HEX = Buffer.alloc(32, 0xc3).toString('hex');
const WORKFLOW_SECRET = 'SENTINEL_WORKFLOW_CONNECTION_VALUE';
/** The row identity the ciphertext below is sealed against. */
const WORKFLOW_BINDING = {
  id: 'conn-1',
  projectId: 'jrv_proj_default',
  pieceName: 'sentinel-piece',
  externalId: 'sentinel-external',
};

/**
 * cmdExport/cmdRestore resolve the data dir through loadConfig(), which honors
 * JARVIS_HOME — each test gets a throwaway data dir through that seam, exactly
 * how the hosted wrappers and self-host users drive it.
 */

interface CapturedIo {
  out: string[];
  err: string[];
  io: { out: (l: string) => void; err: (l: string) => void };
}

function capture(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

function seedDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'jarvis.db'), { create: true });
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE facts (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  db.exec("INSERT INTO facts (body) VALUES ('the-user-likes-tea'), ('meeting-at-nine')");
  // One encrypted workflow connection, so a restore can be checked for
  // "credential readable" and not merely "file present". Only the columns the
  // ciphertext is bound to; the real schema lives in the workflow db tests.
  db.exec(`CREATE TABLE app_connection (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    piece_name TEXT NOT NULL, external_id TEXT NOT NULL, value TEXT NOT NULL)`);
  setEncryptionKey(Buffer.from(WORKFLOW_KEY_HEX, 'hex'));
  try {
    db.run(
      'INSERT INTO app_connection (id, project_id, piece_name, external_id, value) VALUES (?, ?, ?, ?, ?)',
      [
        WORKFLOW_BINDING.id,
        WORKFLOW_BINDING.projectId,
        WORKFLOW_BINDING.pieceName,
        WORKFLOW_BINDING.externalId,
        encryptBoundJson({ secret: WORKFLOW_SECRET }, WORKFLOW_BINDING),
      ],
    );
  } finally {
    setEncryptionKey(null);
  }
  db.close();

  mkdirSync(join(dataDir, 'content'), { recursive: true });
  Bun.write(join(dataDir, 'content', 'note.md'), '# hello\n');
  Bun.write(join(dataDir, 'realtime-budget.json'), '{"spent":0}\n');
  Bun.write(join(dataDir, 'google-tokens.json'), '{"refresh_token":"secret"}\n');
  mkdirSync(join(dataDir, 'sidecar-keys'), { recursive: true });
  Bun.write(join(dataDir, 'sidecar-keys', 'private.pem'), 'FAKE KEY\n');
  Bun.write(join(dataDir, '.secrets.enc'), 'ENCRYPTED-KEYCHAIN\n');
  Bun.write(join(dataDir, '.secrets.key'), 'deadbeef\n');
  Bun.write(join(dataDir, 'workflow-encryption.key'), `${WORKFLOW_KEY_HEX}\n`);
  // Never exported: server-authored config + ephemeral state.
  Bun.write(join(dataDir, 'config.yaml'), 'daemon:\n  port: 3142\n');
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  Bun.write(join(dataDir, 'logs', 'jarvis.log'), 'log line\n');
}

async function tarEntries(archive: string): Promise<string[]> {
  const proc = Bun.spawn(['tar', '-tf', archive], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  // Normalize to top-level entry names (tar lists dir contents too).
  return [...new Set(out.trim().split('\n').map((l) => l.replace(/\/.*$/, '').replace(/\/$/, '')))];
}

let root: string;
let dataDir: string;
let prevHome: string | undefined;
let prevSecretsDir: string | undefined;
let prevPiecesDir: string | undefined;
let piecesDir: string;

/** Two installed library apps; the packages themselves are not in the archive. */
const PIECES_MANIFEST_JSON = JSON.stringify({
  version: 1,
  pieces: [
    { id: 'gmail', npmPackage: '@activepieces/piece-gmail', versionRange: '0.12.3', resolvedVersion: '0.12.3', installedAt: 1 },
    { id: 'clickup', npmPackage: '@activepieces/piece-clickup', versionRange: '0.3.0', resolvedVersion: '0.3.0', installedAt: 2 },
  ],
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-backup-test-'));
  dataDir = join(root, 'data');
  seedDataDir(dataDir);
  prevHome = process.env.JARVIS_HOME;
  process.env.JARVIS_HOME = dataDir;
  // Pin the keychain to the throwaway dir as well: export resolves it rather
  // than assuming data_dir, and must never reach the real ~/.jarvis store.
  prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
  process.env.JARVIS_SECRETS_DIR = dataDir;
  // Installed pieces live under piecesBaseDir(), NOT under data_dir. Pin it so
  // a test can never read or write the real ~/.jarvis/pieces.
  prevPiecesDir = process.env.JARVIS_PIECES_DIR;
  piecesDir = join(root, 'pieces-home');
  process.env.JARVIS_PIECES_DIR = piecesDir;
  mkdirSync(join(piecesDir, 'node_modules', 'big'), { recursive: true });
  writeFileSync(join(piecesDir, 'node_modules', 'big', 'index.js'), 'x');
  writeFileSync(join(piecesDir, 'installed.json'), PIECES_MANIFEST_JSON);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.JARVIS_HOME;
  else process.env.JARVIS_HOME = prevHome;
  if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
  else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
  if (prevPiecesDir === undefined) delete process.env.JARVIS_PIECES_DIR;
  else process.env.JARVIS_PIECES_DIR = prevPiecesDir;
  rmSync(root, { recursive: true, force: true });
});

describe('jarvis export', () => {
  test('--no-secrets curates user data and EXCLUDES secrets + config + logs', async () => {
    const { out, io } = capture();
    const archive = join(root, 'default.tar');
    expect(await cmdExport(['--out', archive, '--no-secrets'], io)).toBe(0);

    const summary = JSON.parse(out.at(-1)!) as { path: string; sizeBytes: number; files: string[] };
    expect(summary.path).toBe(archive);
    expect(summary.sizeBytes).toBeGreaterThan(0);

    const entries = await tarEntries(archive);
    expect(entries).toContain('manifest.json');
    expect(entries).toContain('jarvis.db');
    expect(entries).toContain('pieces');
    expect(entries).toContain('content');
    expect(entries).toContain('realtime-budget.json');
    expect(entries).not.toContain('google-tokens.json');
    expect(entries).not.toContain('sidecar-keys');
    expect(entries).not.toContain('.secrets.enc');
    expect(entries).not.toContain('.secrets.key');
    expect(entries).not.toContain('workflow-encryption.key');
    expect(entries).not.toContain('config.yaml');
    expect(entries).not.toContain('logs');
    expect(entries).not.toContain('jarvis.db-wal');
    // Export staging is cleaned up from the data dir.
    const debris = (await Array.fromAsync(new Bun.Glob('.export-*').scan({ cwd: dataDir, onlyFiles: false }))) as string[];
    expect(debris).toEqual([]);
  });

  test('the DEFAULT export is complete: keys, keychain and the installed-apps list', async () => {
    const { io } = capture();
    const archive = join(root, 'default-full.tar');
    expect(await cmdExport(['--out', archive], io)).toBe(0);
    const entries = await tarEntries(archive);
    for (const e of ['workflow-encryption.key', '.secrets.enc', '.secrets.key', 'sidecar-keys', 'google-tokens.json', 'pieces']) {
      expect(entries).toContain(e);
    }
    const extractTo = join(root, 'default-extracted');
    mkdirSync(extractTo);
    expect(await Bun.spawn(['tar', '-xf', archive, '-C', extractTo]).exited).toBe(0);
    // The manifest only, never the installed packages.
    expect(readFileSync(join(extractTo, 'pieces', 'installed.json'), 'utf8')).toBe(PIECES_MANIFEST_JSON);
    expect(existsSync(join(extractTo, 'pieces', 'node_modules'))).toBe(false);
    expect((JSON.parse(readFileSync(join(extractTo, 'manifest.json'), 'utf8')) as ExportManifest).full).toBe(true);
  });

  test('the archive file is 0600, with or without secrets, and a looser existing file is tightened', async () => {
    const a = join(root, 'out', 'nested', 'a.tar');
    expect(await cmdExport(['--out', a], capture().io)).toBe(0);
    expect(statSync(a).mode & 0o777).toBe(0o600);
    // The directory made for it is private too.
    expect(statSync(join(root, 'out', 'nested')).mode & 0o077).toBe(0);

    const b = join(root, 'b.tar');
    writeFileSync(b, 'old', { mode: 0o644 });
    expect(await cmdExport(['--out', b, '--no-secrets'], capture().io)).toBe(0);
    expect(statSync(b).mode & 0o777).toBe(0o600);
  });

  test('--full still works and means the default', async () => {
    const { io } = capture();
    const archive = join(root, 'full.tar');
    expect(await cmdExport(['--out', archive, '--full'], io)).toBe(0);
    const entries = await tarEntries(archive);
    expect(entries).toContain('google-tokens.json');
    expect(entries).toContain('sidecar-keys');
    expect(entries).toContain('.secrets.enc');
    expect(entries).toContain('.secrets.key');
    // The DB snapshot carries encrypted app_connection rows; without this the
    // archive restores every workflow credential as unreadable ciphertext.
    expect(entries).toContain('workflow-encryption.key');
    expect(entries).not.toContain('config.yaml');
  });

  test('--full picks the keychain up from where it actually lives, not from data_dir', async () => {
    // An install the daemon has not relocated yet keeps its keychain outside
    // the data dir. Since it is the only place any API key exists, an archive
    // without it restores to a brain with no credentials.
    rmSync(join(dataDir, '.secrets.enc'), { force: true });
    rmSync(join(dataDir, '.secrets.key'), { force: true });
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    // The secrets dir holds the workflow key too: without it the archive could
    // not unlock the seeded connection and restore would refuse.
    writeFileSync(join(elsewhere, 'workflow-encryption.key'), `${WORKFLOW_KEY_HEX}\n`, { mode: 0o600 });
    process.env.JARVIS_SECRETS_DIR = elsewhere;
    setSecrets({ 'llm.provider.openai.api_key': 'sk-elsewhere' });

    const archive = join(root, 'resolved.tar');
    expect(await cmdExport(['--out', archive, '--full'], capture().io)).toBe(0);
    expect(await tarEntries(archive)).toContain('.secrets.enc');

    // ...and restore puts it where the daemon reads it, not merely into
    // data_dir: a keychain restored somewhere unread is a brain with no
    // credentials, discovered when the first LLM call fails.
    const readAt = join(root, 'read-at');
    mkdirSync(readAt, { recursive: true });
    process.env.JARVIS_SECRETS_DIR = readAt;
    expect(await cmdRestore([archive], capture().io)).toBe(0);
    expect(getSecret('llm.provider.openai.api_key')).toBe('sk-elsewhere');
    expect(existsSync(join(dataDir, '.secrets.enc'))).toBe(false);
  });

  test('restore leaves an existing keychain alone and says so', async () => {
    const archive = join(root, 'full.tar');
    expect(await cmdExport(['--out', archive, '--full'], capture().io)).toBe(0);

    const readAt = join(root, 'occupied');
    mkdirSync(readAt, { recursive: true });
    await Bun.write(join(readAt, '.secrets.enc'), 'ALREADY-HERE\n');
    process.env.JARVIS_SECRETS_DIR = readAt;

    const { err } = capture();
    const io = { out: () => {}, err: (l: string) => err.push(l) };
    expect(await cmdRestore([archive], io)).toBe(0);

    expect(await Bun.file(join(readAt, '.secrets.enc')).text()).toBe('ALREADY-HERE\n');
    expect(err.join('\n')).toContain('warning: the restored keychain stayed in');
    // Not "complete" without saying the keys are not where they are read from.
    expect(err.join('\n')).toContain('Still to do: The restored AI provider keys are in');
  });

  test('a symlinked entry is dereferenced: the archive holds real data', async () => {
    // A self-hoster pointing `content` at a bigger disk must still get their
    // actual files into the backup — an archived symlink would be an empty
    // (and unrestorable) backup discovered only at restore time.
    const real = join(root, 'real-content');
    mkdirSync(real, { recursive: true });
    await Bun.write(join(real, 'big.md'), '# on the big disk\n');
    rmSync(join(dataDir, 'content'), { recursive: true });
    symlinkSync(real, join(dataDir, 'content'));

    const archive = join(root, 'deref.tar');
    expect(await cmdExport(['--out', archive], capture().io)).toBe(0);

    const extractTo = join(root, 'deref-extracted');
    mkdirSync(extractTo);
    const proc = Bun.spawn(['tar', '-xf', archive, '-C', extractTo]);
    expect(await proc.exited).toBe(0);
    expect(lstatSync(join(extractTo, 'content')).isSymbolicLink()).toBe(false);
    expect(await Bun.file(join(extractTo, 'content', 'big.md')).text()).toBe('# on the big disk\n');
  });

  test('--out immediately followed by another flag is a usage error', async () => {
    const { io } = capture();
    expect(await cmdExport(['--out', '--full'], io)).toBe(2);
  });

  test('missing entries are skipped, not fatal', async () => {
    rmSync(join(piecesDir, 'installed.json'));
    rmSync(join(dataDir, 'realtime-budget.json'));
    const { out, io } = capture();
    const archive = join(root, 'sparse.tar');
    expect(await cmdExport(['--out', archive, '--full'], io)).toBe(0);
    const manifest = JSON.parse(out.at(-1)!) as { files: string[] };
    expect(manifest.files).not.toContain('pieces');
    expect(manifest.files).toContain('content');
  });

  test('snapshot is consistent: uncommitted writes are not captured', async () => {
    // A writer holds an open transaction with uncommitted rows while the
    // export snapshots — the archive must contain only committed state.
    const writer = new Database(join(dataDir, 'jarvis.db'));
    writer.exec('BEGIN');
    writer.exec("INSERT INTO facts (body) VALUES ('uncommitted-secret')");

    const { io } = capture();
    const archive = join(root, 'hot.tar');
    expect(await cmdExport(['--out', archive], io)).toBe(0);
    writer.exec('ROLLBACK');
    writer.close();

    const extractTo = join(root, 'hot-extracted');
    mkdirSync(extractTo);
    const proc = Bun.spawn(['tar', '-xf', archive, '-C', extractTo]);
    expect(await proc.exited).toBe(0);
    const snap = new Database(join(extractTo, 'jarvis.db'), { readonly: true });
    const bodies = snap.query('SELECT body FROM facts ORDER BY id').all() as { body: string }[];
    snap.close();
    expect(bodies.map((r) => r.body)).toEqual(['the-user-likes-tea', 'meeting-at-nine']);
  });

  test('fails with exit 1 when there is no database', async () => {
    rmSync(join(dataDir, 'jarvis.db'));
    const { err, io } = capture();
    expect(await cmdExport(['--out', join(root, 'x.tar')], io)).toBe(1);
    expect(err.join('\n')).toContain('no database');
  });

  test('the manifest records format, variant, and file list', async () => {
    const { io } = capture();
    const archive = join(root, 'm.tar');
    expect(await cmdExport(['--out', archive, '--full'], io)).toBe(0);
    const extractTo = join(root, 'm-extracted');
    mkdirSync(extractTo);
    const proc = Bun.spawn(['tar', '-xf', archive, '-C', extractTo, 'manifest.json']);
    expect(await proc.exited).toBe(0);
    const manifest = JSON.parse(await Bun.file(join(extractTo, 'manifest.json')).text()) as ExportManifest;
    expect(manifest.format).toBe(EXPORT_FORMAT);
    expect(manifest.full).toBe(true);
    expect(manifest.files).toContain('sidecar-keys');
  });
});

describe('jarvis restore', () => {
  test('round-trip: export --full, wipe, restore recovers db + files + modes', async () => {
    const archive = join(root, 'rt.tar');
    expect(await cmdExport(['--out', archive, '--full'], capture().io)).toBe(0);

    // Simulate a fresh instance: new empty data dir with only a config.yaml.
    rmSync(dataDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    Bun.write(join(dataDir, 'config.yaml'), 'daemon:\n  brain_domain: fresh.example\n');

    const { out, io } = capture();
    expect(await cmdRestore([archive], io)).toBe(0);
    const summary = JSON.parse(out.at(-1)!) as { restored: boolean; files: string[] };
    expect(summary.restored).toBe(true);

    const db = new Database(join(dataDir, 'jarvis.db'), { readonly: true });
    const rows = db.query('SELECT body FROM facts ORDER BY id').all() as { body: string }[];
    db.close();
    expect(rows.map((r) => r.body)).toEqual(['the-user-likes-tea', 'meeting-at-nine']);

    expect(await Bun.file(join(dataDir, 'content', 'note.md')).text()).toBe('# hello\n');
    expect(await Bun.file(join(dataDir, 'google-tokens.json')).text()).toContain('secret');
    // The untouched, server-authored config survives.
    expect(await Bun.file(join(dataDir, 'config.yaml')).text()).toContain('fresh.example');
    // Secret modes are tightened.
    expect(statSync(join(dataDir, 'google-tokens.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, 'sidecar-keys')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, 'sidecar-keys', 'private.pem')).mode & 0o777).toBe(0o600);
    // The keychain pair (LLM provider credentials) comes back too — a --full
    // restore must work without re-connecting anything.
    expect(await Bun.file(join(dataDir, '.secrets.enc')).text()).toBe('ENCRYPTED-KEYCHAIN\n');
    expect(statSync(join(dataDir, '.secrets.key')).mode & 0o777).toBe(0o600);
  });

  test('round-trip: the workflow encryption key comes back and its credential decrypts', async () => {
    // The point of #480: `--full` snapshots the encrypted app_connection rows,
    // so it has to carry the only thing that can read them. A restore that
    // brings back the ciphertext and not the key loses every workflow
    // credential permanently, with no error at restore time.
    const archive = join(root, 'wf.tar');
    expect(await cmdExport(['--out', archive, '--full'], capture().io)).toBe(0);

    rmSync(dataDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    expect(await cmdRestore([archive], capture().io)).toBe(0);

    const keyPath = join(dataDir, 'workflow-encryption.key');
    expect(existsSync(keyPath)).toBe(true);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const restoredHex = (await Bun.file(keyPath).text()).trim();
    expect(restoredHex).toBe(WORKFLOW_KEY_HEX);

    // Decrypt the restored row with the restored key -- end to end.
    const db = new Database(join(dataDir, 'jarvis.db'), { readonly: true });
    const stored = (db.query('SELECT value FROM app_connection WHERE id = ?')
      .get(WORKFLOW_BINDING.id) as { value: string }).value;
    db.close();
    expect(isEncrypted(stored)).toBe(true);
    expect(isRowBound(stored)).toBe(true);
    setEncryptionKey(Buffer.from(restoredHex, 'hex'));
    try {
      expect(decryptBoundJson(stored, WORKFLOW_BINDING)).toEqual({ secret: WORKFLOW_SECRET });
    } finally {
      setEncryptionKey(null);
    }
  });

  test('--full picks the workflow key up from cache/ on an install that has not been relocated yet', async () => {
    // Before this brain relocated it, the key lived under the data dir's
    // `cache/` -- a directory export excludes as ephemeral. Take it from
    // wherever it resolves, and restore it to the root where it belongs.
    rmSync(join(dataDir, 'workflow-encryption.key'), { force: true });
    mkdirSync(join(dataDir, 'cache'), { recursive: true });
    await Bun.write(join(dataDir, 'cache', 'workflow-encryption.key'), `${WORKFLOW_KEY_HEX}\n`);

    const archive = join(root, 'wf-legacy.tar');
    expect(await cmdExport(['--out', archive, '--full'], capture().io)).toBe(0);
    expect(await tarEntries(archive)).toContain('workflow-encryption.key');

    rmSync(dataDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    expect(await cmdRestore([archive], capture().io)).toBe(0);
    expect((await Bun.file(join(dataDir, 'workflow-encryption.key')).text()).trim())
      .toBe(WORKFLOW_KEY_HEX);
    expect(existsSync(join(dataDir, 'cache'))).toBe(false);
  });

  test('refuses while the daemon holds its lock', async () => {
    // With JARVIS_HOME set, `dataDir/jarvis.pid` IS the daemon's own lock path
    // (pid.ts resolves it from the same env) — this simulates a real running
    // daemon, not just a lock backup.ts happens to probe.
    const archive = join(root, 'locked.tar');
    expect(await cmdExport(['--out', archive], capture().io)).toBe(0);
    const lock = acquireLockAt(join(dataDir, 'jarvis.pid'), process.pid);
    expect(lock).not.toBeNull();
    try {
      const { err, io } = capture();
      expect(await cmdRestore([archive], io)).toBe(1);
      expect(err.join('\n')).toContain('daemon is running');
    } finally {
      lock!.release();
    }
  });

  test('rejects a garbage archive and leaves existing data untouched', async () => {
    const bogus = join(root, 'bogus.tar');
    await Bun.write(bogus, 'this is not a tar archive');
    const { io } = capture();
    expect(await cmdRestore([bogus], io)).toBe(1);
    // Original data intact.
    const db = new Database(join(dataDir, 'jarvis.db'), { readonly: true });
    const n = db.query('SELECT COUNT(*) AS n FROM facts').get() as { n: number };
    db.close();
    expect(n.n).toBe(2);
    // No staging debris left behind.
    const debris = (await Array.fromAsync(new Bun.Glob('.restore-*').scan({ cwd: dataDir, onlyFiles: false }))) as string[];
    expect(debris).toEqual([]);
  });

  test('rejects an archive with a corrupt database', async () => {
    // Build a tar whose jarvis.db is garbage but whose manifest is valid.
    const forge = join(root, 'forge');
    mkdirSync(forge, { recursive: true });
    await Bun.write(
      join(forge, 'manifest.json'),
      JSON.stringify({ format: EXPORT_FORMAT, brainVersion: '0.0.0', createdAt: '', full: false, files: ['manifest.json', 'jarvis.db'] }),
    );
    await Bun.write(join(forge, 'jarvis.db'), 'garbage bytes, not sqlite');
    const bad = join(root, 'bad.tar');
    const proc = Bun.spawn(['tar', '-cf', bad, '-C', forge, 'manifest.json', 'jarvis.db']);
    expect(await proc.exited).toBe(0);

    const { err, io } = capture();
    expect(await cmdRestore([bad], io)).toBe(1);
    expect(err.join('\n')).toMatch(/integrity_check|not a database|restore failed/);
    const db = new Database(join(dataDir, 'jarvis.db'), { readonly: true });
    expect((db.query('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n).toBe(2);
    db.close();
  });

  test('rejects an unsupported manifest format', async () => {
    const forge = join(root, 'forge2');
    mkdirSync(forge, { recursive: true });
    await Bun.write(
      join(forge, 'manifest.json'),
      JSON.stringify({ format: 999, brainVersion: '9.9.9', createdAt: '', full: false, files: [] }),
    );
    const db = new Database(join(forge, 'jarvis.db'), { create: true });
    db.exec('CREATE TABLE t (x)');
    db.close();
    const bad = join(root, 'future.tar');
    const proc = Bun.spawn(['tar', '-cf', bad, '-C', forge, 'manifest.json', 'jarvis.db']);
    expect(await proc.exited).toBe(0);

    const { err, io } = capture();
    expect(await cmdRestore([bad], io)).toBe(1);
    expect(err.join('\n')).toContain('unsupported archive format');
  });

  test('an archive whose entry is a SYMLINK is refused, data untouched', async () => {
    // age gives confidentiality, not sender authenticity: anyone who can write
    // the bucket could substitute a valid archive. A symlinked `content` would
    // otherwise be renamed into the data dir and then chmod'd through.
    const forge = join(root, 'forge-link');
    mkdirSync(forge, { recursive: true });
    await Bun.write(
      join(forge, 'manifest.json'),
      JSON.stringify({ format: EXPORT_FORMAT, brainVersion: '0.0.0', createdAt: '', full: true, files: [] }),
    );
    const db = new Database(join(forge, 'jarvis.db'), { create: true });
    db.exec('CREATE TABLE t (x)');
    db.close();
    symlinkSync('/etc', join(forge, 'content'));
    const evil = join(root, 'evil.tar');
    // -h would dereference; we want the symlink itself in the archive.
    const proc = Bun.spawn(['tar', '-cf', evil, '-C', forge, 'manifest.json', 'jarvis.db', 'content']);
    expect(await proc.exited).toBe(0);

    const { err, io } = capture();
    expect(await cmdRestore([evil], io)).toBe(1);
    expect(err.join('\n')).toContain('symlink');
    // The pre-existing content dir is still the real one, and /etc is intact.
    expect(await Bun.file(join(dataDir, 'content', 'note.md')).text()).toBe('# hello\n');
    expect(lstatSync(join(dataDir, 'content')).isSymbolicLink()).toBe(false);
  });

  test('a failed swap rolls back: no half-restored data dir, WAL preserved', async () => {
    const archive = join(root, 'rollback.tar');
    expect(await cmdExport(['--out', archive, '--full'], capture().io)).toBe(0);

    // Local state diverges after the export: a DB row, a content edit, and a
    // WAL file as a SIGKILL'd daemon would leave behind (committed frames the
    // main DB file doesn't have yet). ALL of it must survive the failed
    // restore — the WAL especially, since it is retired before the DB swap.
    const contentDir = join(dataDir, 'content');
    await Bun.write(join(contentDir, 'note.md'), '# LOCAL EDIT\n');
    const dbBefore = new Database(join(dataDir, 'jarvis.db'));
    dbBefore.exec("INSERT INTO facts (body) VALUES ('written-after-the-export')");
    dbBefore.close();
    rmSync(join(dataDir, 'jarvis.db-wal'), { force: true });
    await Bun.write(join(dataDir, 'jarvis.db-wal'), 'SENTINEL-WAL-FRAMES');

    // Inject a failure right after `content` swapped in: the DB, `pieces` and
    // `content` swaps have all completed and must every one be undone. (A test
    // hook, because rename gives no natural same-filesystem failure to arrange:
    // the old chmod-the-data-dir approach failed while CREATING the staging
    // dir, so the swap/rollback machinery never ran at all.)
    const { err, io } = capture();
    const code = await cmdRestore([archive], io, { failAfterSwap: 'content' });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('injected failure');

    // The WAL is back in place, byte-identical — then clear it so SQLite
    // doesn't try to read the sentinel as real frames.
    expect(await Bun.file(join(dataDir, 'jarvis.db-wal')).text()).toBe('SENTINEL-WAL-FRAMES');
    // Clear BOTH sidecars: the sentinel is not real WAL frames, and an -shm
    // left beside it describes a WAL index that no longer matches.
    rmSync(join(dataDir, 'jarvis.db-wal'));
    rmSync(join(dataDir, 'jarvis.db-shm'), { force: true });

    // Everything the instance had before the attempt is still there.
    //
    // Read-write, not `{ readonly: true }`: this asserts the ROWS survived the
    // rollback, and a readonly connection cannot be relied on to open a WAL
    // database whose -shm is absent — SQLite has to build the WAL index, which
    // needs write access. That is a real difference, not a hypothetical: this
    // assertion failed only on macOS. Verified on a macOS runner that the
    // rollback itself is sound — integrity_check ok, every row present, and
    // `jarvis export` (which does open readonly) returns 0.
    const db = new Database(join(dataDir, 'jarvis.db'));
    const bodies = (db.query('SELECT body FROM facts ORDER BY id').all() as { body: string }[]).map((r) => r.body);
    db.close();
    expect(bodies).toContain('written-after-the-export');
    expect(await Bun.file(join(contentDir, 'note.md')).text()).toBe('# LOCAL EDIT\n');
    // And no debris.
    const debris = (await Array.fromAsync(
      new Bun.Glob('.pre-restore-*').scan({ cwd: dataDir, onlyFiles: false }),
    )) as string[];
    expect(debris).toEqual([]);
  });

  test('warns when the archive comes from a newer brain', async () => {
    const forge = join(root, 'forge-newer');
    mkdirSync(forge, { recursive: true });
    await Bun.write(
      join(forge, 'manifest.json'),
      JSON.stringify({ format: EXPORT_FORMAT, brainVersion: '999.0.0', createdAt: '', full: false, files: ['manifest.json', 'jarvis.db'] }),
    );
    const db = new Database(join(forge, 'jarvis.db'), { create: true });
    db.exec('CREATE TABLE t (x)');
    db.close();
    const newer = join(root, 'newer.tar');
    const proc = Bun.spawn(['tar', '-cf', newer, '-C', forge, 'manifest.json', 'jarvis.db']);
    expect(await proc.exited).toBe(0);

    const { err, io } = capture();
    expect(await cmdRestore([newer], io)).toBe(0);
    expect(err.join('\n')).toContain('newer than this brain');
  });

  test('usage error without an archive argument', async () => {
    const { io } = capture();
    expect(await cmdRestore([], io)).toBe(2);
  });
});

/** What a fresh instance sees: an empty data dir and an empty pieces dir. */
function freshInstance(): void {
  rmSync(dataDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  rmSync(piecesDir, { recursive: true });
}

describe('restore completeness', () => {
  test('a DEFAULT export restores into an install that can start: the boot key check passes', async () => {
    const archive = join(root, 'd.tar');
    expect(await cmdExport(['--out', archive], capture().io)).toBe(0);
    freshInstance();
    const { err, io } = capture();
    expect(await cmdRestore([archive], io)).toBe(0);

    const db = new Database(join(dataDir, 'jarvis.db'), { readonly: true });
    try {
      // The exact guard the daemon runs at boot ("Refusing to start with a
      // freshly generated key"). It threw for every default archive before.
      expect(() => assertEncryptionKeyForStoredCredentials(db)).not.toThrow();
    } finally {
      db.close();
    }
    expect(err.join('\n')).toContain('1 saved connection(s) with their key');
    expect(err.join('\n')).toContain('Restore complete.');
    expect(statSync(join(dataDir, 'jarvis.db')).mode & 0o777).toBe(0o600);
  });

  test('installed library apps survive a restore (the list comes back, packages reinstall on boot)', async () => {
    const archive = join(root, 'p.tar');
    expect(await cmdExport(['--out', archive], capture().io)).toBe(0);
    freshInstance();
    const { out, io } = capture();
    expect(await cmdRestore([archive], io)).toBe(0);
    expect(readFileSync(join(piecesDir, 'installed.json'), 'utf8')).toBe(PIECES_MANIFEST_JSON);
    // Never planted in data_dir, where nothing reads it.
    expect(existsSync(join(dataDir, 'pieces'))).toBe(false);
    const summary = JSON.parse(out.at(-1)!) as { apps: number; files: string[] };
    expect(summary.apps).toBe(2);
    expect(summary.files).toContain('pieces');
  });

  test('an archive without the workflow key is refused on an install with no key, and nothing changes', async () => {
    const archive = join(root, 'nk.tar');
    expect(await cmdExport(['--out', archive, '--no-secrets'], capture().io)).toBe(0);
    // A fresh install with a database of its own but no workflow key.
    freshInstance();
    const fresh = new Database(join(dataDir, 'jarvis.db'), { create: true });
    fresh.exec('CREATE TABLE marker (x INTEGER)');
    fresh.close();
    const before = readFileSync(join(dataDir, 'jarvis.db'));
    const { err, io } = capture();
    expect(await cmdRestore([archive], io)).toBe(1);
    const text = err.join('\n');
    expect(text).toContain('restore failed:');
    expect(text).toContain('1 saved connection but not the key');
    expect(text).toContain('Nothing was changed');
    expect(text).not.toContain('Restore complete');
    expect(readFileSync(join(dataDir, 'jarvis.db')).equals(before)).toBe(true);
  });

  test('a key-less archive restored over the SAME install is accepted: the key already there opens it', async () => {
    // The in-place case: a --no-secrets archive (or one older than the key
    // moving into the archive) put back on the machine that made it. The key
    // stays where it is and opens every connection, so refusing would be wrong.
    const archive = join(root, 'same.tar');
    expect(await cmdExport(['--out', archive, '--no-secrets'], capture().io)).toBe(0);
    const { err, out, io } = capture();
    expect(await cmdRestore([archive], io)).toBe(0);
    expect(err.join('\n')).toContain('opened by the key already on this machine');
    expect(readFileSync(join(dataDir, 'workflow-encryption.key'), 'utf8').trim()).toBe(WORKFLOW_KEY_HEX);
    const db = new Database(join(dataDir, 'jarvis.db'), { readonly: true });
    try {
      expect(() => assertEncryptionKeyForStoredCredentials(db)).not.toThrow();
    } finally {
      db.close();
    }
    expect((JSON.parse(out.at(-1)!) as { connections: number }).connections).toBe(1);
  });

  test('a key-less archive is refused when the key on this machine is a different one', async () => {
    const archive = join(root, 'other.tar');
    expect(await cmdExport(['--out', archive, '--no-secrets'], capture().io)).toBe(0);
    writeFileSync(join(dataDir, 'workflow-encryption.key'), `${Buffer.alloc(32, 0x22).toString('hex')}\n`, { mode: 0o600 });
    const before = readFileSync(join(dataDir, 'jarvis.db'));
    const { err, io } = capture();
    expect(await cmdRestore([archive], io)).toBe(1);
    expect(err.join('\n')).toContain('the key on this machine does not unlock 1 of them');
    expect(readFileSync(join(dataDir, 'jarvis.db')).equals(before)).toBe(true);
  });

  test('an installed-apps list the Library could not have written is refused, nothing changes', async () => {
    for (const piece of [
      { id: 'x', npmPackage: 'evil', versionRange: 'git+https://example.invalid/evil.git', resolvedVersion: '1.0.0', installedAt: 1 },
      { id: 'x', npmPackage: 'evil', versionRange: 'file:../../evil', resolvedVersion: '1.0.0', installedAt: 1 },
      { id: 'x', npmPackage: '../evil', versionRange: '^1.0.0', resolvedVersion: '1.0.0', installedAt: 1 },
      { id: 'x', npmPackage: 'evil' },
    ]) {
      writeFileSync(join(piecesDir, 'installed.json'), JSON.stringify({ version: 1, pieces: [piece] }));
      const archive = join(root, 'bad-apps.tar');
      rmSync(archive, { force: true });
      expect(await cmdExport(['--out', archive], capture().io)).toBe(0);
      writeFileSync(join(piecesDir, 'installed.json'), PIECES_MANIFEST_JSON);
      const before = readFileSync(join(dataDir, 'jarvis.db'));
      const { err, io } = capture();
      expect(await cmdRestore([archive], io), JSON.stringify(piece)).toBe(1);
      expect(err.join('\n')).toContain("the archive's list of installed apps");
      expect(err.join('\n')).toContain('Nothing was changed');
      expect(readFileSync(join(piecesDir, 'installed.json'), 'utf8')).toBe(PIECES_MANIFEST_JSON);
      expect(readFileSync(join(dataDir, 'jarvis.db')).equals(before)).toBe(true);
    }
  });

  test('--allow-missing-keys lets a key-less archive through, and still warns about what is missing', async () => {
    const archive = join(root, 'nk2.tar');
    expect(await cmdExport(['--out', archive, '--no-secrets'], capture().io)).toBe(0);
    freshInstance();
    const { err, io } = capture();
    expect(await cmdRestore([archive, '--allow-missing-keys'], io)).toBe(0);
    const text = err.join('\n');
    expect(text).toContain('No saved AI provider keys');
    expect(text).toContain('Connected devices');
    expect(text).toContain('key NOT checked');
    expect(text).toContain('were not checked against a key');
    expect(text).toContain('with the items above still to do');
  });

  test('a key that does not unlock the saved connections is refused', async () => {
    const archive = join(root, 'wk.tar');
    expect(await cmdExport(['--out', archive], capture().io)).toBe(0);
    // Swap the key inside the archive for a different one.
    const x = join(root, 'wk-x');
    mkdirSync(x);
    expect(await Bun.spawn(['tar', '-xf', archive, '-C', x]).exited).toBe(0);
    writeFileSync(join(x, 'workflow-encryption.key'), `${Buffer.alloc(32, 0x11).toString('hex')}\n`);
    const bad = join(root, 'wk-bad.tar');
    const files = (JSON.parse(readFileSync(join(x, 'manifest.json'), 'utf8')) as ExportManifest).files;
    expect(await Bun.spawn(['tar', '-cf', bad, '-C', x, ...files]).exited).toBe(0);
    freshInstance();
    const { err, io } = capture();
    expect(await cmdRestore([bad], io)).toBe(1);
    expect(err.join('\n')).toContain('does not unlock 1 of its 1 saved connection');
    expect(existsSync(join(dataDir, 'jarvis.db'))).toBe(false);
  });

  test('workflows that use a library app the archive does not list are named in the summary', async () => {
    const db = new Database(join(dataDir, 'jarvis.db'));
    db.exec('CREATE TABLE flow_version (id TEXT PRIMARY KEY, trigger TEXT NOT NULL)');
    db.run('INSERT INTO flow_version VALUES (?, ?)', [
      'v1',
      JSON.stringify({ settings: { pieceName: '@activepieces/piece-stripe' }, nextAction: { settings: { pieceName: '@activepieces/piece-gmail' } } }),
    ]);
    db.close();
    const archive = join(root, 'mp.tar');
    expect(await cmdExport(['--out', archive], capture().io)).toBe(0);
    freshInstance();
    const { err, out, io } = capture();
    expect(await cmdRestore([archive], io)).toBe(0);
    const summary = JSON.parse(out.at(-1)!) as { todo: string[] };
    // gmail is listed in the archive; stripe is not.
    expect(summary.todo.join(' ')).toContain('piece-stripe');
    expect(summary.todo.join(' ')).not.toContain('piece-gmail');
    expect(err.join('\n')).toContain('Install them again from the Library');
  });
});

describe('bin dispatch (subprocess)', () => {
  test('jarvis export --out - streams a valid tar to stdout', async () => {
    const repoRoot = join(import.meta.dir, '..', '..');
    const proc = Bun.spawn(['bun', join(repoRoot, 'bin', 'jarvis.ts'), 'export', '--out', '-', '--full'], {
      env: { ...process.env, JARVIS_HOME: dataDir, JARVIS_SECRETS_DIR: dataDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    expect(await proc.exited).toBe(0);
    expect(bytes.byteLength).toBeGreaterThan(0);

    const streamed = join(root, 'streamed.tar');
    await Bun.write(streamed, bytes);
    const entries = await tarEntries(streamed);
    expect(entries).toContain('jarvis.db');
    expect(entries).toContain('google-tokens.json');
  });
});
