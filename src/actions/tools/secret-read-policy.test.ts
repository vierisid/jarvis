/**
 * The classifier that keeps the daemon's own credentials out of the model's
 * context (#528), table-tested against the evasion shapes.
 *
 * Nothing here touches the real home or the real keychain: the policy's home is
 * a temp dir (setPolicyHome; Bun's homedir() ignores a HOME changed at runtime),
 * the data and secrets dirs are registered as temp dirs, and every fixture is
 * synthetic. Assertions are on NAMES and on refuse/allow, never on a value.
 *
 * The evasion shapes, one test each:
 *   - every /proc spelling of the daemon's own environ (self, thread-self,
 *     task/<tid>, root/, cwd/, fd/N, //, /./, ../);
 *   - a descriptor named as a path, which no path rule can judge;
 *   - a symlink from an ordinary directory to a key;
 *   - a HARD LINK to a key, which no resolver can see through;
 *   - the daemon's own leftover `<key>.<pid>.<hex>.tmp` hard link;
 *   - the legacy `cache/workflow-encryption.key`, whose first path component is
 *     the deliberately-allowed `cache`;
 *   - a relocated JARVIS_SECRETS_DIR and an explicit key file anywhere;
 *   - a sidecar-routed read, judged by name because the brain cannot stat it;
 *   - the environment's SOURCE files: the systemd unit, the launchd plist, and a
 *     shell rc that does or does not export a provider key;
 *   - and, for each, that the user's own equivalents still read fine.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SECRET_ENV_NAMES, scanForDaemonSecrets, secretListRefusal, secretRead, secretReadRefusal,
  setDaemonDataRoots, setPolicyHome, setSiteProjectsDir,
} from './file-path-policy.ts';
import { DAEMON_SECRET_ENV_NAMES } from '../../util/model-exec-env.ts';

let root: string;
let home: string;
let dataDir: string;
let projectsDir: string;

/** A synthetic key file. The bytes are a placeholder, never a real key. */
const FAKE_HEX = `${'0'.repeat(63)}1`;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['JARVIS_SECRETS_DIR', 'JARVIS_HOME', 'JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE'];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'secret-read-'));
  home = join(root, 'home');
  dataDir = join(home, '.jarvis');
  projectsDir = join(dataDir, 'projects');
  mkdirSync(join(dataDir, 'cache'), { recursive: true });
  mkdirSync(join(dataDir, 'sidecar-keys'), { recursive: true });
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  mkdirSync(join(projectsDir, 'app'), { recursive: true });
  mkdirSync(join(home, 'Documents'), { recursive: true });
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });

  writeFileSync(join(dataDir, '.secrets.key'), `${FAKE_HEX}\n`);
  writeFileSync(join(dataDir, '.secrets.enc'), 'ciphertext');
  writeFileSync(join(dataDir, 'workflow-encryption.key'), `${FAKE_HEX}\n`);
  writeFileSync(join(dataDir, 'cache', 'workflow-encryption.key'), `${FAKE_HEX}\n`);
  writeFileSync(join(dataDir, 'google-tokens.json'), '{"refresh_token":"placeholder"}');
  writeFileSync(join(dataDir, 'jarvis.db'), 'SQLite format 3');
  writeFileSync(join(dataDir, 'config.yaml'), 'channels:\n  telegram:\n    bot_token: placeholder\n');
  writeFileSync(join(dataDir, 'sidecar-keys', 'private.pem'), '-----BEGIN PRIVATE KEY-----');
  writeFileSync(join(dataDir, 'logs', 'jarvis.log'), 'an ordinary log line\n');
  writeFileSync(join(home, 'Documents', 'cv.pdf'), 'a document');
  writeFileSync(join(projectsDir, 'app', 'index.html'), '<h1>hi</h1>');

  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  setPolicyHome(home);
  setSiteProjectsDir(projectsDir);
  setDaemonDataRoots({ dataDirs: [dataDir], secretsDirs: [dataDir] });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  setPolicyHome(null);
  setSiteProjectsDir(null);
  setDaemonDataRoots({});
  rmSync(root, { recursive: true, force: true });
});

const refused = (path: string) => secretReadRefusal(path) !== null;
const kind = (path: string) => secretRead(path)?.kind ?? null;

describe('process memory and descriptors (#528)', () => {
  const pid = process.pid;
  // Every spelling that reaches this process's own environment. The resolver
  // canonicalises most of them to /proc/<pid>/environ; the textual rule catches
  // the rest, including a spelling the resolver could not resolve.
  const ENVIRON_SPELLINGS = [
    '/proc/self/environ',
    '/proc/self/../self/environ',
    '/proc/net/../self/environ',
    '/proc/thread-self/environ',
    '/proc/self/root/proc/self/environ',
    '/proc/./self/environ',
    '//proc//self//environ',
    '/proc/self/environ/.',
  ];
  test.skipIf(process.platform !== 'linux')('every /proc environ spelling is refused', () => {
    for (const spelling of [...ENVIRON_SPELLINGS, `/proc/${pid}/environ`, `/proc/self/task/${pid}/environ`]) {
      expect(refused(spelling), spelling).toBe(true);
      expect(kind(spelling), spelling).toBe('process-memory');
    }
  });

  test('the /proc rules are textual, so they hold where /proc does not exist', () => {
    // The same assertions with no filesystem behind them: this is what macOS
    // and Windows get, and it must not throw or silently no-op.
    for (const spelling of ENVIRON_SPELLINGS) {
      expect(refused(spelling), spelling).toBe(true);
    }
    expect(kind('/proc/1/cmdline')).toBe('process-memory');
    expect(kind('/proc/self/maps')).toBe('process-memory');
    expect(kind('/proc/self/mem')).toBe('process-memory');
    expect(kind('/proc/kcore')).toBe('process-memory');
  });

  test('a descriptor named as a path is refused on every platform', () => {
    // On Linux these are magic links and would resolve to the real file; on
    // macOS /dev/fd is fdesc and realpath leaves it alone, so the only defence
    // is refusing the spelling.
    for (const spelling of ['/dev/fd/7', '/dev/stdin', '/proc/self/fd/7', `/proc/${pid}/fd/3`, '/proc/self/fd']) {
      expect(refused(spelling), spelling).toBe(true);
      expect(kind(spelling), spelling).toBe('process-relative');
    }
  });

  test('ordinary /proc entries and /dev files stay readable', () => {
    for (const ok of ['/proc/cpuinfo', '/proc/meminfo', '/proc/version', '/proc/self/status', '/dev/null']) {
      expect(refused(ok), ok).toBe(false);
    }
  });
});

describe('Jarvis key material (#528)', () => {
  test('the keychain, the workflow key, the vault and the token file are refused', () => {
    for (const name of ['.secrets.key', '.secrets.enc', 'workflow-encryption.key', 'google-tokens.json', 'jarvis.db']) {
      expect(refused(join(dataDir, name)), name).toBe(true);
    }
    expect(kind(join(dataDir, '.secrets.key'))).toBe('jarvis-key');
    expect(kind(join(dataDir, 'sidecar-keys', 'private.pem'))).toBe('jarvis-key');
    expect(kind(join(dataDir, 'config.yaml'))).toBe('jarvis-config');
  });

  test('the legacy cache/workflow-encryption.key is refused, though `cache` itself is allowed', () => {
    // The trap: the write side's isSensitiveDataEntry tests the FIRST component,
    // and this read-side set deliberately drops `cache`. The suffix test has to
    // run on the basename of the whole relative entry.
    expect(refused(join(dataDir, 'cache', 'workflow-encryption.key'))).toBe(true);
    writeFileSync(join(dataDir, 'cache', 'engine.js'), 'console.log(1)');
    expect(refused(join(dataDir, 'cache', 'engine.js'))).toBe(false);
  });

  test("the daemon's own leftover <key>.<pid>.<hex>.tmp hard link is refused", () => {
    // persistKeyFile hard-links the key into place through such a temp and only
    // unlinks it best-effort; removeStaleKeyTemps skips a LIVE pid's temp, so the
    // running daemon's own can persist. The name ends `.tmp`, and it IS the key.
    const temp = join(dataDir, `workflow-encryption.key.${process.pid}.9f3ac1b7e02d.tmp`);
    linkSync(join(dataDir, 'workflow-encryption.key'), temp);
    expect(refused(temp)).toBe(true);
    expect(refused(join(dataDir, 'workflow-encryption.key.tmp'))).toBe(true); // the pre-#514 fixed name
  });

  test('a hard link to a key from an ordinary directory is refused by inode', () => {
    // No resolver can see through a hard link: it IS the file under another
    // name. Only identity catches this.
    const alias = join(home, 'Documents', 'notes.txt');
    linkSync(join(dataDir, '.secrets.key'), alias);
    expect(refused(alias)).toBe(true);
    expect(kind(alias)).toBe('jarvis-key');
  });

  test('a symlink from an ordinary directory to a key is refused', () => {
    const link = join(home, 'Documents', 'innocent.txt');
    symlinkSync(join(dataDir, '.secrets.key'), link);
    expect(refused(link)).toBe(true);
  });

  test('a relocated JARVIS_SECRETS_DIR is covered without being registered', () => {
    const secrets = join(root, 'elsewhere');
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, '.secrets.key'), `${FAKE_HEX}\n`);
    process.env.JARVIS_SECRETS_DIR = secrets;
    setDaemonDataRoots({ dataDirs: [dataDir] }); // deliberately NOT registering it
    expect(refused(join(secrets, '.secrets.key'))).toBe(true);
  });

  test('an explicit JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE is refused wherever it points', () => {
    const odd = join(root, 'etc-jarvis', 'wf.pem');
    mkdirSync(join(root, 'etc-jarvis'), { recursive: true });
    writeFileSync(odd, `${FAKE_HEX}\n`);
    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE = odd;
    setDaemonDataRoots({ dataDirs: [dataDir], secretsDirs: [dataDir] });
    expect(refused(odd)).toBe(true);
  });

  test('the staged GitHub PAT directory is refused', () => {
    const staged = join(root, 'run', 'jarvis-gh-cred-ab12cd', 'token');
    mkdirSync(join(root, 'run', 'jarvis-gh-cred-ab12cd'), { recursive: true });
    writeFileSync(staged, 'placeholder');
    expect(refused(staged)).toBe(true);
  });

  test('a routed read is judged by name, so a sidecar cannot fetch the brain layout', () => {
    // The brain cannot stat the sidecar's disk, so only the name-based tier
    // runs. The default ~/.jarvis layout is the one spelling it can judge.
    expect(refused('/home/someone/.jarvis/.secrets.key')).toBe(true);
    expect(refused('/opt/whatever/.jarvis/workflow-encryption.key')).toBe(true);
    expect(refused('/home/someone/.jarvis/config.yaml')).toBe(true);
  });

  test("the user's own files, logs and site projects still read fine", () => {
    for (const ok of [
      join(home, 'Documents', 'cv.pdf'),
      join(dataDir, 'logs', 'jarvis.log'),
      join(projectsDir, 'app', 'index.html'),
    ]) {
      expect(refused(ok), ok).toBe(false);
    }
  });

  test('a site project keeps its own key-shaped files readable', () => {
    // The projects carve-out: a web project's own dev certificate is the user's
    // file, not Jarvis's key material.
    const cert = join(projectsDir, 'app', 'localhost.pem');
    writeFileSync(cert, 'a self-signed dev cert');
    expect(refused(cert)).toBe(false);
  });
});

describe("the environment's source files (#528)", () => {
  test("Jarvis's own systemd unit and drop-ins are refused", () => {
    const unit = join(home, '.config', 'systemd', 'user', 'jarvis.service');
    writeFileSync(unit, '[Service]\nEnvironment=JARVIS_WORKFLOW_ENCRYPTION_KEY=placeholder\n');
    expect(refused(unit)).toBe(true);
    expect(kind(unit)).toBe('daemon-env-source');
    expect(refused(join(home, '.config', 'systemd', 'user', 'jarvis.service.d', 'override.conf'))).toBe(true);
    expect(refused('/etc/systemd/system/jarvis.service')).toBe(true);
  });

  test("Jarvis's launchd plist is refused", () => {
    expect(refused(join(home, 'Library', 'LaunchAgents', 'com.jarvis.daemon.plist'))).toBe(true);
  });

  test('another application\'s unit is not refused', () => {
    expect(refused(join(home, '.config', 'systemd', 'user', 'syncthing.service'))).toBe(false);
  });

  test('an env file in the data dir is refused', () => {
    writeFileSync(join(dataDir, 'env'), 'ANTHROPIC_API_KEY=placeholder\n');
    expect(refused(join(dataDir, 'env'))).toBe(true);
  });

  test('/etc/environment and environment.d are refused', () => {
    expect(refused('/etc/environment')).toBe(true);
    expect(refused(join(home, '.config', 'environment.d', '50-keys.conf'))).toBe(true);
  });

  test('a shell rc is returned unless it actually assigns a daemon secret', () => {
    // Reading ~/.bashrc is ordinary use and must keep working; reading the one
    // that exports the provider key must not. The classifier asks for a scan
    // rather than refusing outright.
    const rc = join(home, '.bashrc');
    writeFileSync(rc, 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -l"\n');
    const hit = secretRead(rc);
    expect(hit?.kind).toBe('daemon-env-source');
    expect(hit?.scanOnly).toBe(true);
    // scanOnly alone is not a refusal: the caller decides from the bytes.
    expect(secretReadRefusal(rc)).toBeNull();
  });

  test('scanForDaemonSecrets finds an assignment in every shape that matters', () => {
    expect(scanForDaemonSecrets('export ANTHROPIC_API_KEY=sk-placeholder')).toBe('ANTHROPIC_API_KEY');
    expect(scanForDaemonSecrets('JARVIS_WORKFLOW_ENCRYPTION_KEY=abc')).toBe('JARVIS_WORKFLOW_ENCRYPTION_KEY');
    expect(scanForDaemonSecrets('Environment="OPENAI_API_KEY=sk-x"')).toBe('OPENAI_API_KEY');
    expect(scanForDaemonSecrets('  setenv JARVIS_GITHUB_TOKEN: ghp_x')).toBe('JARVIS_GITHUB_TOKEN');
    expect(scanForDaemonSecrets('<key>ANTHROPIC_API_KEY</key><string>sk-x</string>')).toBe('ANTHROPIC_API_KEY');
  });

  test('scanForDaemonSecrets does not fire on a location or a mention', () => {
    // A path to a key is not a key, and prose is not an assignment.
    expect(scanForDaemonSecrets('JARVIS_API_KEY_FILE=/etc/jarvis/key')).toBeNull();
    expect(scanForDaemonSecrets('# remember to set ANTHROPIC_API_KEY somewhere')).toBeNull();
    expect(scanForDaemonSecrets('export MY_ANTHROPIC_API_KEY=x')).toBeNull();
    expect(scanForDaemonSecrets('alias ll="ls -l"')).toBeNull();
  });

  test('the scanned name list agrees with the spawn scrubber it mirrors', () => {
    // #536 strips exactly these from model-driven spawns. If that list grows,
    // this one must too, or a new secret becomes readable from a shell rc.
    expect([...SECRET_ENV_NAMES].sort()).toEqual([...DAEMON_SECRET_ENV_NAMES].sort());
  });
});

describe('list_directory (#528)', () => {
  test('a key-material directory and a descriptor directory are refused', () => {
    expect(secretListRefusal(join(dataDir, 'sidecar-keys'))).not.toBeNull();
    expect(secretListRefusal(join(dataDir, 'browser'))).not.toBeNull();
    expect(secretListRefusal('/proc/self/fd')).not.toBeNull();
  });

  test('a dedicated secrets dir is refused', () => {
    const secrets = join(root, 'only-secrets');
    mkdirSync(secrets, { recursive: true });
    process.env.JARVIS_SECRETS_DIR = secrets;
    setDaemonDataRoots({ dataDirs: [dataDir], secretsDirs: [secrets] });
    expect(secretListRefusal(secrets)).not.toBeNull();
    expect(secretListRefusal(join(secrets, 'sub'))).not.toBeNull();
  });

  test('the shared data dir, its logs and /proc/<pid> stay listable', () => {
    // Names and sizes, not bytes; every secret byte inside is refused on read,
    // and refusing this would break "what is in my Jarvis folder".
    expect(secretListRefusal(dataDir)).toBeNull();
    expect(secretListRefusal(join(dataDir, 'logs'))).toBeNull();
    expect(secretListRefusal(join(home, 'Documents'))).toBeNull();
    expect(secretListRefusal('/proc/self')).toBeNull();
  });
});

describe('the refusal sentence', () => {
  test('it is the same for every class, so it is not an enumeration oracle', () => {
    const a = secretReadRefusal('/proc/self/environ')!;
    const b = secretReadRefusal(join(dataDir, '.secrets.key'))!;
    const c = secretReadRefusal(join(home, '.config', 'systemd', 'user', 'jarvis.service'))!;
    const strip = (s: string) => s.replace(/"[^"]*"/, '"<path>"');
    expect(strip(a)).toBe(strip(b));
    expect(strip(b)).toBe(strip(c));
  });

  test('it does not tell the model to ask the user to read the file out', () => {
    const msg = secretReadRefusal(join(dataDir, '.secrets.key'))!;
    expect(msg).toContain('Access denied');
    expect(msg.toLowerCase()).not.toMatch(/ask the user to (?:paste|read it out for)/);
  });

  test('a null, empty or non-string path is not a crash and not a hit', () => {
    expect(secretRead(null)).toBeNull();
    expect(secretRead(undefined)).toBeNull();
    expect(secretRead('')).toBeNull();
    expect(secretRead(42)).toBeNull();
    expect(secretListRefusal(null)).toBeNull();
  });
});
