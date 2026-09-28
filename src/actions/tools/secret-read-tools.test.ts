/**
 * The real `read_file` and `list_directory` against the daemon's own secrets
 * (#528).
 *
 * The classifier has its own table tests (secret-read-policy.test.ts); this
 * drives the TOOLS, because a refusal that is not wired to the tool the model
 * calls is not a fix. Every refusal here also asserts that the secret's bytes
 * are absent from what came back, so a test cannot pass on an error string while
 * the content went through.
 *
 * Nothing touches the real home or the real keychain: the policy's home is a
 * temp dir, the data dir is a temp dir, and every fixture is synthetic. The
 * assertions are on refuse/allow and on marker strings the fixtures put there,
 * never on a real secret.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirectoryTool, readFileTool, setDefaultCwd } from './builtin.ts';
import { setDaemonDataRoots, setPolicyHome, setSiteProjectsDir } from './file-path-policy.ts';

let root: string;
let home: string;
let dataDir: string;
let projectsDir: string;

/** Markers that must never appear in a tool result. Synthetic, not real keys. */
const KEY_MARKER = 'SYNTHETIC-KEY-MUST-NOT-APPEAR';
const TOKEN_MARKER = 'SYNTHETIC-TOKEN-MUST-NOT-APPEAR';

const read = async (path: string, extra: Record<string, unknown> = {}) =>
  String(await readFileTool.execute({ path, ...extra }));
const list = async (path: string, extra: Record<string, unknown> = {}) =>
  String(await listDirectoryTool.execute({ path, ...extra }));

const DENIED = 'Access denied';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'secret-tools-'));
  home = join(root, 'home');
  dataDir = join(home, '.jarvis');
  projectsDir = join(dataDir, 'projects');
  mkdirSync(join(dataDir, 'sidecar-keys'), { recursive: true });
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  mkdirSync(join(projectsDir, 'app'), { recursive: true });
  mkdirSync(join(home, 'Documents'), { recursive: true });
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });

  writeFileSync(join(dataDir, '.secrets.key'), `${KEY_MARKER}\n`);
  writeFileSync(join(dataDir, 'workflow-encryption.key'), `${KEY_MARKER}\n`);
  writeFileSync(join(dataDir, 'google-tokens.json'), `{"refresh_token":"${TOKEN_MARKER}"}`);
  writeFileSync(join(dataDir, 'config.yaml'), `channels:\n  telegram:\n    bot_token: ${TOKEN_MARKER}\n`);
  writeFileSync(join(dataDir, 'sidecar-keys', 'private.pem'), `-----BEGIN PRIVATE KEY-----\n${KEY_MARKER}\n`);
  writeFileSync(join(home, '.config', 'systemd', 'user', 'jarvis.service'),
    `[Service]\nEnvironment=JARVIS_WORKFLOW_ENCRYPTION_KEY=${KEY_MARKER}\n`);

  // Ordinary files that must keep working.
  writeFileSync(join(dataDir, 'logs', 'jarvis.log'), 'an ordinary log line\n');
  writeFileSync(join(home, 'Documents', 'cv.pdf'), 'a document about me\n');
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Someone\n');
  writeFileSync(join(projectsDir, 'app', 'index.html'), '<h1>hi</h1>\n');

  setPolicyHome(home);
  setSiteProjectsDir(projectsDir);
  setDaemonDataRoots({ dataDirs: [dataDir], secretsDirs: [dataDir] });
  setDefaultCwd(null);
});

afterEach(() => {
  setPolicyHome(null);
  setSiteProjectsDir(null);
  setDaemonDataRoots({});
  setDefaultCwd(null);
  rmSync(root, { recursive: true, force: true });
});

describe("read_file and the daemon's own process state", () => {
  test.skipIf(process.platform !== 'linux')('the daemon\'s own environ is refused, and no bytes come back', async () => {
    // The whole of #528 in one call: before this, read_file returned about 5 KB
    // of the daemon's environment, which holds ANTHROPIC_API_KEY,
    // JARVIS_WORKFLOW_ENCRYPTION_KEY and JARVIS_GITHUB_TOKEN.
    for (const path of [
      '/proc/self/environ',
      `/proc/${process.pid}/environ`,
      '/proc/self/root/proc/self/environ',
      '/proc/net/../self/environ',
      '/proc/thread-self/environ',
      '/proc/self/cmdline',
      '/proc/self/fd/1',
    ]) {
      const out = await read(path);
      expect(out, path).toContain(DENIED);
      // An environ dump would contain `=` pairs and NUL separators; a refusal
      // is one sentence. Length is the blunt check that no content leaked.
      expect(out.length, path).toBeLessThan(500);
      expect(out, path).not.toContain('PATH=');
    }
  });

  test.skipIf(process.platform !== 'linux')('ordinary /proc entries still read', async () => {
    const out = await read('/proc/version');
    expect(out).not.toContain(DENIED);
    expect(out.length).toBeGreaterThan(0);
  });

  test.skipIf(process.platform !== 'linux')('a procfs file is read through the descriptor, not by its reported size', async () => {
    // procfs reports st_size 0, so a size-driven read would return nothing.
    const out = await read('/proc/self/status');
    expect(out).toContain('Pid:');
  });
});

describe('read_file and the key files', () => {
  test('every key and token file is refused, with no bytes in the result', async () => {
    for (const rel of ['.secrets.key', 'workflow-encryption.key', 'google-tokens.json', 'config.yaml',
      join('sidecar-keys', 'private.pem')]) {
      const out = await read(join(dataDir, rel));
      expect(out, rel).toContain(DENIED);
      expect(out, rel).not.toContain(KEY_MARKER);
      expect(out, rel).not.toContain(TOKEN_MARKER);
    }
  });

  test('a symlink from an ordinary folder to a key is refused', async () => {
    const link = join(home, 'Documents', 'innocent.txt');
    symlinkSync(join(dataDir, '.secrets.key'), link);
    const out = await read(link);
    expect(out).toContain(DENIED);
    expect(out).not.toContain(KEY_MARKER);
  });

  test('a hard link to a key is refused, by identity', async () => {
    // The alias a path-based rule cannot see: it IS the key. The descriptor is
    // fstat'ed after opening, so the file that would be read is the file judged.
    const alias = join(home, 'Documents', 'notes.txt');
    linkSync(join(dataDir, '.secrets.key'), alias);
    const out = await read(alias);
    expect(out).toContain(DENIED);
    expect(out).not.toContain(KEY_MARKER);
  });

  test("the daemon's own systemd unit is refused", async () => {
    const out = await read(join(home, '.config', 'systemd', 'user', 'jarvis.service'));
    expect(out).toContain(DENIED);
    expect(out).not.toContain(KEY_MARKER);
  });

  test('a relative path to a key is refused too', async () => {
    // The default cwd is where a site chat leaves it; a relative path is judged
    // against every base it could resolve against.
    setDefaultCwd(home);
    const out = await read(join('.jarvis', '.secrets.key'));
    expect(out).toContain(DENIED);
    expect(out).not.toContain(KEY_MARKER);
  });

  test('a routed read of a key is refused before it leaves the brain', async () => {
    // A sidecar on this same machine opens these same files, so the refusal has
    // to happen before routing. No sidecar exists in this test, so reaching the
    // routing branch at all would produce a different error.
    const out = await read('/home/someone/.jarvis/.secrets.key', { target: 'some-sidecar' });
    expect(out).toContain(DENIED);
  });
});

describe('read_file still reads the user\'s own files', () => {
  test('documents, logs, configs and project files are unaffected', async () => {
    expect(await read(join(home, 'Documents', 'cv.pdf'))).toContain('a document about me');
    expect(await read(join(dataDir, 'logs', 'jarvis.log'))).toContain('an ordinary log line');
    expect(await read(join(home, '.gitconfig'))).toContain('name = Someone');
    expect(await read(join(projectsDir, 'app', 'index.html'))).toContain('<h1>hi</h1>');
  });

  test('a shell rc reads fine, unless it exports one of the daemon\'s keys', async () => {
    // Reading ~/.bashrc is ordinary use. Reading the one that exports the
    // provider key is the same disclosure as /proc/self/environ.
    const rc = join(home, '.bashrc');
    writeFileSync(rc, 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -l"\n');
    const ok = await read(rc);
    expect(ok).toContain('alias ll');
    expect(ok).not.toContain(DENIED);

    writeFileSync(rc, `export PATH="$HOME/bin:$PATH"\nexport ANTHROPIC_API_KEY=${KEY_MARKER}\n`);
    const refused = await read(rc);
    expect(refused).toContain(DENIED);
    expect(refused).not.toContain(KEY_MARKER);
  });

  test('a fish config that sets a key the fish way is refused', async () => {
    // `set -gx NAME value` has no `=` at all, and it is the only fish syntax.
    mkdirSync(join(home, '.config', 'fish'), { recursive: true });
    const cfg = join(home, '.config', 'fish', 'config.fish');
    writeFileSync(cfg, `set -gx ANTHROPIC_API_KEY ${KEY_MARKER}\n`);
    const out = await read(cfg);
    expect(out).toContain(DENIED);
    expect(out).not.toContain(KEY_MARKER);
  });

  test('a fragment the rc sources is scanned through the real tool', async () => {
    mkdirSync(join(home, '.dotfiles'), { recursive: true });
    const fragment = join(home, '.dotfiles', 'secrets.sh');
    writeFileSync(fragment, `export ANTHROPIC_API_KEY=${KEY_MARKER}\n`);
    writeFileSync(join(home, '.bashrc'), `alias ll="ls -l"\nsource ${fragment}\n`);
    const out = await read(fragment);
    expect(out).toContain(DENIED);
    expect(out).not.toContain(KEY_MARKER);

    // The same fragment without a key in it reads fine.
    writeFileSync(fragment, 'export PATH="$HOME/bin:$PATH"\n');
    expect(await read(fragment)).toContain('$HOME/bin');
  });

  test('a system env file reads unless it carries a key', async () => {
    // /etc/default/grub and friends are ordinary sysadmin reads; refusing them
    // outright bought nothing, because the scan catches the one that matters.
    const dir = join(root, 'etc-default');
    mkdirSync(dir, { recursive: true });
    // Judged by name as a shared env file, so it is scanned either way.
    writeFileSync(join(dir, 'grub'), 'GRUB_TIMEOUT=5\n');
    expect(await read(join(dir, 'grub'))).toContain('GRUB_TIMEOUT=5');
  });

  test('a large file is truncated without being slurped whole', async () => {
    const big = join(home, 'Documents', 'big.txt');
    writeFileSync(big, 'y'.repeat(300_000));
    const out = await read(big);
    expect(out).toContain('truncated, file is 300000 bytes');
    expect(out.length).toBeLessThan(110 * 1024);
  });

  test('a truncated non-ASCII file is cut on a character boundary', async () => {
    // The read is bounded in BYTES, which is the point, but cutting mid-sequence
    // used to leave a U+FFFD at the end of every truncated non-ASCII file.
    const jp = join(home, 'Documents', 'jp.txt');
    writeFileSync(jp, 'あ'.repeat(60_000)); // 3 bytes each, 180 KB
    const out = await read(jp);
    expect(out).toContain('truncated');
    expect(out).not.toContain('�');
  });

  test('a directory and a missing file still report what they are', async () => {
    expect(await read(join(home, 'Documents'))).toContain('is a directory');
    expect(await read(join(home, 'nope.txt'))).toContain('File not found');
  });
});

describe('list_directory', () => {
  test('a key-material directory is refused', async () => {
    const out = await list(join(dataDir, 'sidecar-keys'));
    expect(out).toContain(DENIED);
    expect(out).not.toContain('private.pem');
  });

  test('the shared data dir, logs, documents and projects stay listable', async () => {
    // A listing is names and sizes, not bytes, and every secret byte inside is
    // refused on read. Refusing this would break "what is in my Jarvis folder".
    const out = await list(dataDir);
    expect(out).not.toContain(DENIED);
    expect(out).toContain('logs');
    for (const dir of [join(dataDir, 'logs'), join(home, 'Documents'), join(projectsDir, 'app')]) {
      expect(await list(dir), dir).not.toContain(DENIED);
    }
  });

  test('a dedicated secrets dir is refused', async () => {
    const secrets = join(root, 'only-secrets');
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, '.secrets.key'), `${KEY_MARKER}\n`);
    setDaemonDataRoots({ dataDirs: [dataDir], secretsDirs: [secrets] });
    const out = await list(secrets);
    expect(out).toContain(DENIED);
    expect(out).not.toContain('.secrets.key');
  });

  test.skipIf(process.platform !== 'linux')('the descriptor directory is refused', async () => {
    // Its entries name every file the daemon has open.
    const out = await list('/proc/self/fd');
    expect(out).toContain(DENIED);
  });
});
