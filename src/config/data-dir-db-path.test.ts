import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeDataDirArg } from '../cli/lifecycle.ts';

/**
 * Where the database lives when a data dir is chosen (`--data-dir`, or
 * `daemon.data_dir`) and `daemon.db_path` is not set: `<data dir>/jarvis.db`.
 * It used to stay at ~/.jarvis/jarvis.db whatever the data dir was. An install
 * that already has its database there keeps using it, and every command that
 * opens the database (daemon, first-run hint, export, doctor) agrees on which
 * file that is.
 *
 * Each probe runs in its own process so HOME and JARVIS_HOME are exactly what
 * a `jarvis` command started with that environment would see.
 */
const SRC = join(import.meta.dir, '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-data-dir-db-'));
  scratch.push(dir);
  return dir;
}

/** A real (non-empty) SQLite database, which export can snapshot. */
function realDb(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec('CREATE TABLE marker (x TEXT)');
  db.close();
}

/** Saved state in a data dir: what a daemon that has booted there leaves. */
function installState(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'workspace-id'), 'b2a6c1d0-0000-4000-8000-000000000000\n');
}

/** What an install from before workspace-id left in its --data-dir: no file the db-guard counts. */
function olderInstallState(dataDir: string): void {
  mkdirSync(join(dataDir, 'observers'), { recursive: true });
}

interface Probe {
  dbPath: string;
  oldDbKept: { newPath: string } | null;
  notice: string[] | null;
  configDbPath: string;
  doctorDbPath: string;
  doctorChecks: Array<{ name: string; status: string }>;
  hint: boolean;
  exportCode?: number;
  exportLog?: string;
}

async function probe(home: string, opts: { dataDir?: string; jarvisHome?: string; config?: string; exportTo?: string } = {}): Promise<Probe> {
  mkdirSync(join(home, '.jarvis'), { recursive: true });
  if (opts.config !== undefined) writeFileSync(join(home, '.jarvis', 'config.yaml'), opts.config);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'JARVIS_HOME') env[k] = v;
  env.HOME = home;
  env.JARVIS_SECRETS_DIR = join(home, 'secrets'); // never the real keychain
  if (opts.jarvisHome) env.JARVIS_HOME = opts.jarvisHome;
  const dataDir = JSON.stringify(opts.dataDir);
  const code = `
    const loader = await import(${JSON.stringify(join(SRC, 'config', 'loader.ts'))});
    const { doctorDatabase } = await import(${JSON.stringify(join(SRC, 'cli', 'doctor.ts'))});
    const { firstRunHintFor } = await import(${JSON.stringify(join(SRC, 'cli', 'lifecycle.ts'))});
    const cfg = await loader.loadConfig(undefined, { quiet: true });
    const paths = loader.resolveDataPaths(cfg.daemon, { dataDir: ${dataDir} });
    const doctor = await doctorDatabase(cfg.daemon, ${dataDir});
    const hint = await firstRunHintFor({ dataDir: ${dataDir}, openUrl: null });
    const out = {
      dbPath: paths.dbPath, oldDbKept: paths.oldDbKept ?? null, notice: loader.oldDbKeptNotice(paths),
      configDbPath: cfg.daemon.db_path, doctorDbPath: doctor.dbPath,
      doctorChecks: doctor.checks.map((c) => ({ name: c.name, status: c.status })), hint: hint !== null,
    };
    ${opts.exportTo ? `
    const { cmdExport } = await import(${JSON.stringify(join(SRC, 'cli', 'backup.ts'))});
    const log = [];
    const io = { out: (l) => log.push(l), err: (l) => log.push(l), writeStdout: () => {} };
    out.exportCode = await cmdExport(['--out', ${JSON.stringify(opts.exportTo)}, '--no-secrets', ...(${dataDir} ? ['--data-dir', ${dataDir}] : [])], io);
    out.exportLog = log.join('\\n');` : ''}
    console.log(JSON.stringify(out));
  `;
  const proc = Bun.spawn(['bun', '-e', code], { env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) throw new Error(err);
  return JSON.parse(out.trim().split('\n').pop()!) as Probe;
}

describe('the database follows the data dir', () => {
  test('--data-dir without JARVIS_HOME puts a fresh database in the data dir, and every reader agrees', async () => {
    const home = tempHome();
    const data = join(home, 'custom');
    // Another install's database at the old default must not be picked up.
    realDb(join(home, '.jarvis', 'jarvis.db'));
    const p = await probe(home, { dataDir: data });
    expect(p.dbPath).toBe(join(data, 'jarvis.db'));
    expect(p.oldDbKept).toBeNull();
    expect(p.doctorDbPath).toBe(p.dbPath);
    expect(p.hint).toBe(true); // nothing in the data dir yet: a first run
    expect(p.doctorChecks).toEqual([{ name: 'Database', status: 'warn' }]);
  });

  test('a daemon.data_dir in config.yaml with no db_path puts the database there too', async () => {
    const home = tempHome();
    const data = join(home, 'from-config');
    const p = await probe(home, { config: `daemon:\n  data_dir: ${data}\n` });
    expect(p.configDbPath).toBe(join(data, 'jarvis.db'));
    expect(p.dbPath).toBe(join(data, 'jarvis.db'));
  });

  test('JARVIS_HOME (Docker) is unchanged', async () => {
    const home = tempHome();
    const data = join(home, 'data');
    const p = await probe(home, { jarvisHome: data });
    expect(p.dbPath).toBe(join(data, 'jarvis.db'));
    expect(p.configDbPath).toBe(join(data, 'jarvis.db'));
  });

  test('an explicit db_path is respected, with or without --data-dir', async () => {
    const home = tempHome();
    const own = join(home, 'elsewhere', 'mine.db');
    const config = `daemon:\n  db_path: ${own}\n`;
    expect((await probe(home, { config })).dbPath).toBe(own);
    expect((await probe(home, { config, dataDir: join(home, 'custom') })).dbPath).toBe(own);
    // A relative one names a file inside the data dir.
    expect((await probe(home, { config: 'daemon:\n  db_path: mine.db\n', dataDir: join(home, 'custom') })).dbPath)
      .toBe(join(home, 'custom', 'mine.db'));
  });

  test('an existing --data-dir install keeps its database at the old place, says how to move it, and is not a first run', async () => {
    const home = tempHome();
    const data = join(home, 'custom');
    const old = join(home, '.jarvis', 'jarvis.db');
    realDb(old);
    installState(data);
    const p = await probe(home, { dataDir: data });
    expect(p.dbPath).toBe(old);
    expect(p.oldDbKept).toEqual({ newPath: join(data, 'jarvis.db') });
    expect(p.notice!.join('\n')).toContain(`move ${old} to ${join(data, 'jarvis.db')}`);
    expect(p.doctorDbPath).toBe(old);
    expect(p.doctorChecks).toEqual([{ name: 'Database', status: 'ok' }, { name: 'Database Location', status: 'warn' }]);
    expect(p.hint).toBe(false);

    // Once moved, the data dir's own file is used and the notice is gone.
    realDb(join(data, 'jarvis.db'));
    const moved = await probe(home, { dataDir: data });
    expect(moved.dbPath).toBe(join(data, 'jarvis.db'));
    expect(moved.oldDbKept).toBeNull();
  });

  test('an install from before workspace-id keeps its database at the old place too', async () => {
    const home = tempHome();
    const data = join(home, 'custom');
    realDb(join(home, '.jarvis', 'jarvis.db'));
    olderInstallState(data);
    const p = await probe(home, { dataDir: data });
    expect(p.dbPath).toBe(join(home, '.jarvis', 'jarvis.db'));
    expect(p.oldDbKept).toEqual({ newPath: join(data, 'jarvis.db') });
  });

  test('an empty data dir is a new install', async () => {
    const home = tempHome();
    const data = join(home, 'custom');
    realDb(join(home, '.jarvis', 'jarvis.db'));
    mkdirSync(data, { recursive: true });
    expect((await probe(home, { dataDir: data })).dbPath).toBe(join(data, 'jarvis.db'));
  });

  test('an existing daemon.data_dir install keeps its database at the old place too', async () => {
    const home = tempHome();
    const data = join(home, 'from-config');
    realDb(join(home, '.jarvis', 'jarvis.db'));
    installState(data);
    const p = await probe(home, { config: `daemon:\n  data_dir: ${data}\n` });
    expect(p.configDbPath).toBe(join(home, '.jarvis', 'jarvis.db'));
    expect(p.oldDbKept).toEqual({ newPath: join(data, 'jarvis.db') });
  });

  test('export snapshots the same database doctor checks', async () => {
    for (const existing of [false, true]) {
      const home = tempHome();
      const data = join(home, 'custom');
      if (existing) { realDb(join(home, '.jarvis', 'jarvis.db')); installState(data); }
      else realDb(join(data, 'jarvis.db'));
      const p = await probe(home, { dataDir: data, exportTo: join(home, 'backup.tar') });
      expect(p.exportCode).toBe(0);
      expect(p.exportLog).toContain(`Snapshotting database (${p.doctorDbPath})`);
      expect(p.doctorDbPath).toBe(existing ? join(home, '.jarvis', 'jarvis.db') : join(data, 'jarvis.db'));
    }
  });
});

describe('takeDataDirArg', () => {
  const none = () => undefined;
  test('takes --data-dir out of the arguments, in either spelling', () => {
    expect(takeDataDirArg(['--out', 'x.tar', '--data-dir', '/d'], { running: none })).toEqual({ dataDir: '/d', rest: ['--out', 'x.tar'] });
    expect(takeDataDirArg(['--data-dir=/d', 'name'], { running: none })).toEqual({ dataDir: '/d', rest: ['name'] });
  });

  test('a missing value or one that looks like a flag is an error', () => {
    expect(takeDataDirArg(['--data-dir'], { running: none }).error).toBeDefined();
    expect(takeDataDirArg(['--data-dir', '--json'], { running: none }).error).toBeDefined();
  });

  test('without the flag, the running daemon\'s data dir is used', () => {
    expect(takeDataDirArg(['--json'], { running: () => '/running' })).toEqual({ dataDir: '/running', rest: ['--json'] });
    expect(takeDataDirArg(['--data-dir', '/given'], { running: () => '/running' }).dataDir).toBe('/given');
  });
});
