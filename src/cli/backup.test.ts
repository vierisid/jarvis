import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { cmdExport, cmdRestore, EXPORT_FORMAT, type ExportManifest } from './backup.ts';
import { acquireLockAt } from '../daemon/pid.ts';

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
  db.close();

  mkdirSync(join(dataDir, 'pieces', 'my-piece'), { recursive: true });
  Bun.write(join(dataDir, 'pieces', 'my-piece', 'index.ts'), 'export const piece = 1;\n');
  mkdirSync(join(dataDir, 'content'), { recursive: true });
  Bun.write(join(dataDir, 'content', 'note.md'), '# hello\n');
  Bun.write(join(dataDir, 'realtime-budget.json'), '{"spent":0}\n');
  Bun.write(join(dataDir, 'google-tokens.json'), '{"refresh_token":"secret"}\n');
  mkdirSync(join(dataDir, 'sidecar-keys'), { recursive: true });
  Bun.write(join(dataDir, 'sidecar-keys', 'private.pem'), 'FAKE KEY\n');
  Bun.write(join(dataDir, '.secrets.enc'), 'ENCRYPTED-KEYCHAIN\n');
  Bun.write(join(dataDir, '.secrets.key'), 'deadbeef\n');
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-backup-test-'));
  dataDir = join(root, 'data');
  seedDataDir(dataDir);
  prevHome = process.env.JARVIS_HOME;
  process.env.JARVIS_HOME = dataDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.JARVIS_HOME;
  else process.env.JARVIS_HOME = prevHome;
  rmSync(root, { recursive: true, force: true });
});

describe('jarvis export', () => {
  test('default export curates user data and EXCLUDES secrets + config + logs', async () => {
    const { out, io } = capture();
    const archive = join(root, 'default.tar');
    expect(await cmdExport(['--out', archive], io)).toBe(0);

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
    expect(entries).not.toContain('config.yaml');
    expect(entries).not.toContain('logs');
    expect(entries).not.toContain('jarvis.db-wal');
    // Export staging is cleaned up from the data dir.
    const debris = (await Array.fromAsync(new Bun.Glob('.export-*').scan({ cwd: dataDir, onlyFiles: false }))) as string[];
    expect(debris).toEqual([]);
  });

  test('--full additionally includes the OS-level secrets and the keychain pair', async () => {
    const { io } = capture();
    const archive = join(root, 'full.tar');
    expect(await cmdExport(['--out', archive, '--full'], io)).toBe(0);
    const entries = await tarEntries(archive);
    expect(entries).toContain('google-tokens.json');
    expect(entries).toContain('sidecar-keys');
    expect(entries).toContain('.secrets.enc');
    expect(entries).toContain('.secrets.key');
    expect(entries).not.toContain('config.yaml');
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
    rmSync(join(dataDir, 'pieces'), { recursive: true });
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
    rmSync(join(dataDir, 'jarvis.db-wal'));

    // Everything the instance had before the attempt is still there.
    const db = new Database(join(dataDir, 'jarvis.db'), { readonly: true });
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

describe('bin dispatch (subprocess)', () => {
  test('jarvis export --out - streams a valid tar to stdout', async () => {
    const repoRoot = join(import.meta.dir, '..', '..');
    const proc = Bun.spawn(['bun', join(repoRoot, 'bin', 'jarvis.ts'), 'export', '--out', '-', '--full'], {
      env: { ...process.env, JARVIS_HOME: dataDir },
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
