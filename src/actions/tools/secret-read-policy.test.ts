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
  SECRET_ENV_NAMES, SECRET_INODE_NAMES, scanForDaemonSecrets, secretListRefusal, secretRead, secretReadRefusal,
  setDaemonDataRoots, setPolicyHome, setSiteProjectsDir,
} from './file-path-policy.ts';
import { setNoLocalTools } from './local-tools-guard.ts';
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

describe('carve-outs cannot swallow what they are carved out of', () => {
  test('a projects_dir pointed at the data dir does not un-refuse the keys', () => {
    // The trap upload-policy.ts guards against for its own carve-out: a
    // projects dir set to the data dir (or home, or /) would otherwise make
    // every key under it an ordinary project file.
    setSiteProjectsDir(dataDir);
    expect(refused(join(dataDir, '.secrets.key'))).toBe(true);
    expect(refused(join(dataDir, 'workflow-encryption.key'))).toBe(true);
    setSiteProjectsDir(home);
    expect(refused(join(dataDir, '.secrets.key'))).toBe(true);
    setSiteProjectsDir('/');
    expect(refused(join(dataDir, '.secrets.key'))).toBe(true);
  });

  test('a secrets dir misconfigured to home does not make listing home a refusal', () => {
    // Over-refusing `list_directory ~` would be a worse bug than the recon it
    // prevents.
    process.env.JARVIS_SECRETS_DIR = home;
    setDaemonDataRoots({ dataDirs: [dataDir], secretsDirs: [home] });
    expect(secretListRefusal(home)).toBeNull();
    expect(secretListRefusal(join(home, 'Documents'))).toBeNull();
    // The keys inside it are still refused on read.
    expect(refused(join(dataDir, '.secrets.key'))).toBe(true);
  });
});

describe('the data-dir component rules do not over-refuse', () => {
  test('`browser` and `sidecar-keys` only match at the data dir root', () => {
    // They are the Chrome profile and the sidecar keypair, both at the root. A
    // log or content folder that happens to contain a `browser` directory is
    // the user's data.
    mkdirSync(join(dataDir, 'content', 'browser'), { recursive: true });
    writeFileSync(join(dataDir, 'content', 'browser', 'notes.md'), 'notes');
    expect(refused(join(dataDir, 'content', 'browser', 'notes.md'))).toBe(false);
    expect(refused(join(dataDir, 'browser', 'Cookies'))).toBe(true);
    expect(refused(join(dataDir, 'sidecar-keys', 'private.pem'))).toBe(true);
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

  test('the system env files are scanned, not blanket-refused', () => {
    // These are shared with the rest of the OS: /etc/default holds grub, locale
    // and ufw, and /etc/systemd/system.conf is ordinary sysadmin reading.
    // Refusing them outright broke that for no gain, because the one that really
    // carries a key is caught by the scan -- and if the unit names it in
    // EnvironmentFile= it is refused outright whatever is in it.
    for (const path of ['/etc/environment', join(home, '.config', 'environment.d', '50-keys.conf'),
      '/etc/default/grub', '/etc/default/jarvis', '/etc/sysconfig/network',
      '/etc/systemd/system.conf', '/etc/systemd/system.conf.d/10-env.conf', '/etc/systemd/user.conf']) {
      expect(secretRead(path)?.scanOnly, path).toBe(true);
      expect(refused(path), path).toBe(false);
    }
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

  test('a shell startup file known by its DIRECTORY is scanned too', () => {
    // fish's config, /etc/profile.d and ~/.bashrc.d are known by directory, not
    // by file name, and each can export a provider key. Before the fix these
    // returned null from the classifier, i.e. readable with no scan at all.
    mkdirSync(join(home, '.config', 'fish'), { recursive: true });
    for (const path of [
      join(home, '.config', 'fish', 'config.fish'),
      join(home, '.bashrc.d', '10-keys.sh'),
      '/etc/profile.d/keys.sh',
    ]) {
      expect(secretRead(path)?.scanOnly, path).toBe(true);
    }
  });

  test('scanForDaemonSecrets finds an assignment in every shell syntax that matters', () => {
    // fish and csh have NO `=` and no `:` -- the whitespace-separated form is
    // the whole syntax -- and both their rc files reach the scanner, so a rule
    // built only around `=` would return the file with the key in it.
    const cases: Array<[string, string]> = [
      ['export ANTHROPIC_API_KEY=sk-placeholder', 'ANTHROPIC_API_KEY'],
      ['JARVIS_WORKFLOW_ENCRYPTION_KEY=abc', 'JARVIS_WORKFLOW_ENCRYPTION_KEY'],
      ['export "ANTHROPIC_API_KEY"=sk-x', 'ANTHROPIC_API_KEY'],
      ['declare -x OPENAI_API_KEY=sk-x', 'OPENAI_API_KEY'],
      ['set -gx ANTHROPIC_API_KEY sk-x', 'ANTHROPIC_API_KEY'],            // fish
      ['setenv ANTHROPIC_API_KEY sk-x', 'ANTHROPIC_API_KEY'],             // csh/tcsh
      ['launchctl setenv ANTHROPIC_API_KEY sk-x', 'ANTHROPIC_API_KEY'],   // macOS
      ['setx ANTHROPIC_API_KEY sk-x', 'ANTHROPIC_API_KEY'],               // Windows
      ['$env:ANTHROPIC_API_KEY = "sk-x"', 'ANTHROPIC_API_KEY'],           // PowerShell
      ['ANTHROPIC_API_KEY DEFAULT=sk-x', 'ANTHROPIC_API_KEY'],            // ~/.pam_environment
      ['read ANTHROPIC_API_KEY < /etc/k', 'ANTHROPIC_API_KEY'],
      ['Environment="OPENAI_API_KEY=sk-x"', 'OPENAI_API_KEY'],            // systemd
      ['<key>ANTHROPIC_API_KEY</key><string>sk-x</string>', 'ANTHROPIC_API_KEY'], // launchd
      ['TELEGRAM_BOT_TOKEN=123:abc', 'TELEGRAM_BOT_TOKEN'],
      ['export ANTHROPIC_API_KEY \\\n  = sk-x', 'ANTHROPIC_API_KEY'],     // line continuation
      ['true && export ANTHROPIC_API_KEY=sk-x', 'ANTHROPIC_API_KEY'],
    ];
    for (const [text, name] of cases) expect(scanForDaemonSecrets(text), text).toBe(name);
  });

  test('scanForDaemonSecrets does not fire on a location, a mention or a test', () => {
    // A path to a key is not a key, and prose is not an assignment. Firing on
    // these would refuse an innocent ~/.bashrc wholesale.
    for (const text of [
      'JARVIS_API_KEY_FILE=/etc/jarvis/key',
      '# remember to set ANTHROPIC_API_KEY somewhere',
      '# see ANTHROPIC_API_KEY: docs',
      'echo "ANTHROPIC_API_KEY: unset"',
      '[ -n "$ANTHROPIC_API_KEY" ] && echo "ANTHROPIC_API_KEY: set"',
      'if [ "$ANTHROPIC_API_KEY" == "x" ]; then true; fi',
      'export MY_ANTHROPIC_API_KEY=x',
      'alias ll="ls -l"',
      'unset ANTHROPIC_API_KEY',
    ]) {
      expect(scanForDaemonSecrets(text), text).toBeNull();
    }
  });

  test('the scanned name list is a superset of the spawn scrubber it mirrors', () => {
    // #536 strips exactly DAEMON_SECRET_ENV_NAMES from model-driven spawns, and
    // every one of those must be scanned for. The scan list is deliberately
    // wider: the failure modes are asymmetric -- a scrub false positive breaks a
    // child process, a scan false negative hands over a key.
    for (const name of DAEMON_SECRET_ENV_NAMES) expect(SECRET_ENV_NAMES).toContain(name);
    expect(SECRET_ENV_NAMES.length).toBeGreaterThan(DAEMON_SECRET_ENV_NAMES.length);
  });
});

describe('--no-local-tools: the hosted brain with the user as a sidecar', () => {
  // The mode where the containment rules matter MOST and were switched off: the
  // brain serves nothing locally, so every read is routed, and a relocated data
  // dir was then invisible because the registered-dir tests sat behind the
  // on-disk branch even though they are pure string work.
  const relocated = () => join(root, 'srv', 'jarvis');

  const withNoLocalTools = (fn: () => void) => {
    setNoLocalTools(true);
    try { fn(); } finally { setNoLocalTools(false); }
  };

  beforeEach(() => {
    mkdirSync(join(relocated(), 'sidecar-keys'), { recursive: true });
    writeFileSync(join(relocated(), '.secrets.key'), `${FAKE_HEX}\n`);
    writeFileSync(join(relocated(), 'workflow-encryption.key'), `${FAKE_HEX}\n`);
    writeFileSync(join(relocated(), 'config.yaml'), 'llm:\n  anthropic:\n    api_key: placeholder\n');
    writeFileSync(join(relocated(), 'sidecar-keys', 'private.pem'), '-----BEGIN PRIVATE KEY-----');
    setDaemonDataRoots({ dataDirs: [relocated()], secretsDirs: [relocated()] });
  });

  test('a relocated data dir is refused even with no local filesystem', () => {
    for (const name of ['.secrets.key', 'workflow-encryption.key', 'config.yaml', join('sidecar-keys', 'private.pem')]) {
      const path = join(relocated(), name);
      expect(refused(path), `local: ${name}`).toBe(true);
      withNoLocalTools(() => expect(refused(path), `routed: ${name}`).toBe(true));
    }
  });

  test('the staged GitHub PAT is refused with no local filesystem', () => {
    withNoLocalTools(() => {
      expect(refused('/tmp/jarvis-gh-cred-9f2a/token')).toBe(true);
    });
  });

  test('the default layout and /proc stay refused with no local filesystem', () => {
    withNoLocalTools(() => {
      expect(refused('/home/someone/.jarvis/.secrets.key')).toBe(true);
      expect(refused('/proc/self/environ')).toBe(true);
      expect(refused('/dev/fd/7')).toBe(true);
    });
  });

  test('an ordinary file is still not refused with no local filesystem', () => {
    withNoLocalTools(() => {
      expect(refused('/home/someone/Documents/cv.pdf')).toBe(false);
      expect(refused(join(relocated(), 'logs', 'jarvis.log'))).toBe(false);
    });
  });
});

describe('near-miss spellings found by review', () => {
  test('a procfs visible somewhere other than the root is refused', () => {
    // flatpak/toolbx/distrobox mount the host's procfs at /run/host/proc, and a
    // Windows sidecar reaches this host's as \\wsl$\<distro>\proc.
    for (const spelling of [
      '/run/host/proc/self/environ',
      '\\\\wsl$\\Ubuntu\\proc\\self\\environ',
      '\\\\wsl.localhost\\Ubuntu\\proc\\self\\environ',
      'C:/proc/self/environ',
      '/run/host/dev/fd/7',
    ]) {
      expect(refused(spelling), spelling).toBe(true);
    }
  });

  test('vmcore, fdinfo and map_files are refused', () => {
    for (const spelling of ['/proc/vmcore', '/proc/self/fdinfo/3', '/proc/self/map_files/400000-401000']) {
      expect(refused(spelling), spelling).toBe(true);
    }
  });

  test('a jarvis export archive is refused wherever it sits', () => {
    // --full puts .secrets.key, the workflow key and the sidecar keypair in it
    // verbatim, and they are ASCII, so a plain text read prints them.
    for (const name of ['jarvis-export-2026-01-01T00-00-00.tar', 'jarvis-backup-x.tar.zst']) {
      expect(refused(join(home, name)), name).toBe(true);
      expect(refused(join(home, 'Downloads', name)), name).toBe(true);
    }
    expect(refused(join(home, 'notes.tar'))).toBe(false);
  });

  test("Jarvis's own units are refused wherever systemd keeps them", () => {
    for (const path of [
      '/run/systemd/transient/jarvis.service',
      '/etc/systemd/system/multi-user.target.wants/jarvis.service',
      join(home, '.config', 'systemd', 'user.control', 'jarvis.service'),
    ]) {
      expect(refused(path), path).toBe(true);
    }
  });

  test('an EnvironmentFile the unit names is refused wherever it points', () => {
    // The only way to cover an arbitrary path is to read the pointer out of the
    // unit, which is why the unit is parsed rather than pattern-matched.
    const envFile = join(root, 'etc-jarvis', 'daemon.env');
    mkdirSync(join(root, 'etc-jarvis'), { recursive: true });
    writeFileSync(envFile, 'ANTHROPIC_API_KEY=placeholder\n');
    writeFileSync(join(home, '.config', 'systemd', 'user', 'jarvis.service'),
      `[Service]\nEnvironmentFile=${envFile}\nExecStart=/usr/bin/jarvis\n`);
    expect(refused(envFile)).toBe(true);
  });

  test('a hard link to any secret-bearing file in the data dir is refused', () => {
    // The inode set must cover the whole inventory, not just the key files: a
    // hard link to config.yaml is as good as a copy of the bot token.
    const names = ['.secrets.key', '.secrets.enc', 'workflow-encryption.key', 'google-tokens.json',
      'jarvis.db', 'config.yaml'];
    for (const [i, name] of names.entries()) {
      const alias = join(home, 'Documents', `alias-${i}.txt`);
      linkSync(join(dataDir, name), alias);
      expect(refused(alias), name).toBe(true);
    }
  });

  test('the inode list covers the export inventory, so the two cannot drift', () => {
    // cli/backup.ts's SECRET_ENTRIES is the project's canonical secret list.
    for (const entry of ['.secrets.key', '.secrets.enc', 'google-tokens.json', 'workflow-encryption.key']) {
      expect(SECRET_INODE_NAMES).toContain(entry);
    }
    expect(SECRET_INODE_NAMES.some((n) => n.includes('sidecar-keys'))).toBe(true);
  });

  test('a relative JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE is still refused', () => {
    // encryption.ts takes the value verbatim with no absoluteness check, so a
    // relative one is resolved against the daemon cwd and used as the key.
    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE = 'keys/wf';
    expect(refused(join(process.cwd(), 'keys', 'wf'))).toBe(true);
  });

  test('a PowerShell profile is scanned like any other shell startup file', () => {
    for (const path of [
      'C:\\Users\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
      'C:\\Users\\me\\Documents\\WindowsPowerShell\\profile.ps1',
      join(home, '.config', 'powershell', 'Microsoft.PowerShell_profile.ps1'),
    ]) {
      expect(secretRead(path)?.scanOnly, path).toBe(true);
    }
  });

  test('a fragment the rc SOURCES is scanned, not returned unread', () => {
    // The common dotfiles layout: the rc is boring and the exports live in a
    // fragment, which matches no name or directory rule. Before this it came
    // back with the key in it.
    mkdirSync(join(home, '.dotfiles'), { recursive: true });
    const fragment = join(home, '.dotfiles', 'secrets.sh');
    writeFileSync(fragment, 'export ANTHROPIC_API_KEY=placeholder\n');
    writeFileSync(join(home, '.bashrc'), `alias ll="ls -l"\nsource ${fragment}\n`);
    expect(secretRead(fragment)?.scanOnly).toBe(true);
  });

  test('a sourced fragment is followed through ~ and $HOME and one more level', () => {
    mkdirSync(join(home, '.zsh'), { recursive: true });
    const second = join(home, '.zsh', 'exports.zsh');
    const first = join(home, '.zsh', 'env.zsh');
    writeFileSync(second, 'export OPENAI_API_KEY=placeholder\n');
    writeFileSync(first, `. "$HOME/.zsh/exports.zsh"\n`);
    writeFileSync(join(home, '.zshrc'), 'source ~/.zsh/env.zsh\n');
    expect(secretRead(first)?.scanOnly, 'first level').toBe(true);
    expect(secretRead(second)?.scanOnly, 'second level').toBe(true);
  });

  test('an unrelated file is not made scannable by a sourced-fragment rule', () => {
    writeFileSync(join(home, '.bashrc'), 'source ~/.dotfiles/secrets.sh\n');
    expect(secretRead(join(home, 'Documents', 'cv.pdf'))).toBeNull();
    expect(secretRead(join(home, 'notes.md'))).toBeNull();
  });

  test("a dotfile manager's real file is scanned, not just the ~/.bashrc name", () => {
    // `~/.bashrc -> ~/dotfiles/bashrc`: reading the target is reading the rc.
    // The write side already resolves this through homeScan; the read side must.
    mkdirSync(join(home, 'dotfiles'), { recursive: true });
    const target = join(home, 'dotfiles', 'bashrc');
    writeFileSync(target, 'export PATH=$PATH\n');
    symlinkSync(target, join(home, '.bashrc'));
    expect(secretRead(target)?.scanOnly).toBe(true);
  });

  test('direnv and *.local rc files are scanned', () => {
    for (const path of [
      join(home, '.envrc'), join(home, '.zshrc.local'), join(home, '.bashrc.local'),
      join(home, '.config', 'fish', 'conf.d', 'keys.fish'),
      join(home, '.oh-my-zsh', 'custom', 'keys.zsh'),
    ]) {
      expect(secretRead(path)?.scanOnly, path).toBe(true);
    }
  });

  test('a long or NUL-bearing path is judged, not a crash', () => {
    // secretRead is called from a tool's execute AND from a sync authority gate,
    // so "never throws" is the invariant.
    expect(() => secretRead('/proc/self/environ\u0000')).not.toThrow();
    expect(() => secretRead(`/${'a'.repeat(5000)}`)).not.toThrow();
    expect(() => secretRead(`/${'a/'.repeat(3000)}b`)).not.toThrow();
    expect(() => secretRead('//')).not.toThrow();
    expect(() => secretRead('C:')).not.toThrow();
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
