import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkUploadPath, credentialPathsFromEnv, sensitiveReason, type UploadPolicyContext } from './upload-policy.ts';

/**
 * The rule runs against a fake home under a temp dir, so nothing here reads
 * the real ~/.ssh or ~/.jarvis. POSIX paths only: the win32 branches are
 * string rules over the same helpers and are covered through sensitiveReason
 * with platform 'darwin' where the shape is the same.
 */
describe.skipIf(process.platform === 'win32')('browser_upload_file path rule (#521)', () => {
  let root: string;
  let home: string;
  let dataDir: string;
  let ctx: UploadPolicyContext;

  function file(path: string, body = 'x'): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
  }

  beforeAll(() => {
    // realpath: macOS tmpdir is behind a /var -> /private/var link.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-upload-policy-')));
    home = join(root, 'home');
    dataDir = join(root, 'srv', 'jarvis-data');
    mkdirSync(home, { recursive: true });
    ctx = {
      home,
      platform: 'linux',
      jarvisDirs: [join(home, '.jarvis'), dataDir],
      projectsDir: join(home, '.jarvis', 'projects'),
      appDataDirs: [],
    };
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('an ordinary file is allowed and comes back resolved', () => {
    const cv = file(join(home, 'Documents', 'cv.pdf'));
    expect(checkUploadPath(cv, ctx)).toBe(cv);
    const outside = file(join(root, 'elsewhere', 'photo.png'));
    expect(checkUploadPath(outside, ctx)).toBe(outside);
  });

  test('hidden files and folders in the home directory are refused', () => {
    for (const p of [
      file(join(home, '.ssh', 'id_ed25519')),
      file(join(home, '.aws', 'credentials')),
      file(join(home, '.config', 'gh', 'hosts.yml')),
      file(join(home, '.netrc')),
      file(join(home, 'Documents', '.secret', 'notes.txt')),
    ]) {
      expect(() => checkUploadPath(p, ctx)).toThrow(/Refusing to upload .*hidden file or folder in the home directory/);
    }
  });

  test('the Jarvis data directory is refused, wherever it lives', () => {
    expect(() => checkUploadPath(file(join(home, '.jarvis', 'config.yaml')), ctx)).toThrow(/Refusing to upload/);
    expect(() => checkUploadPath(file(join(dataDir, 'jarvis.db')), ctx)).toThrow(/inside the Jarvis data directory/);
  });

  test('site projects are uploadable, their hidden entries are not', () => {
    const logo = file(join(home, '.jarvis', 'projects', 'my-site', 'public', 'logo.png'));
    expect(checkUploadPath(logo, ctx)).toBe(logo);
    const env = file(join(home, '.jarvis', 'projects', 'my-site', '.env'));
    expect(() => checkUploadPath(env, ctx)).toThrow(/hidden file or folder inside a site project/);
    const git = file(join(home, '.jarvis', 'projects', 'my-site', '.git', 'config'));
    expect(() => checkUploadPath(git, ctx)).toThrow(/Refusing to upload/);
  });

  test('a projects directory that would swallow home or the data dir is ignored', () => {
    const cfg = file(join(home, '.jarvis', 'config.yaml'));
    expect(() => checkUploadPath(cfg, { ...ctx, projectsDir: join(home, '.jarvis') })).toThrow(/inside the Jarvis data directory/);
    const key = file(join(home, '.ssh', 'id_rsa'));
    expect(() => checkUploadPath(key, { ...ctx, projectsDir: home })).toThrow(/hidden file or folder in the home directory/);
    expect(() => checkUploadPath(key, { ...ctx, projectsDir: '/' })).toThrow(/Refusing to upload/);
  });

  test('a symlink is judged by its target, and Chrome gets the target', () => {
    const key = file(join(home, '.ssh', 'id_rsa'));
    const link = join(home, 'Documents', 'innocent.txt');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(key, link);
    expect(() => checkUploadPath(link, ctx)).toThrow(/Refusing to upload .*innocent\.txt/);

    const real = file(join(root, 'elsewhere', 'real.txt'));
    const okLink = join(home, 'Documents', 'shortcut.txt');
    symlinkSync(real, okLink);
    expect(checkUploadPath(okLink, ctx)).toBe(real);
  });

  test('a symlinked data directory still covers its real location', () => {
    const realData = join(root, 'mnt', 'jarvis-real');
    const secret = file(join(realData, 'secrets.key'));
    const linkedData = join(root, 'jarvis-link');
    symlinkSync(realData, linkedData);
    // The configured dir is the link; the upload names the real path.
    expect(() => checkUploadPath(secret, { ...ctx, jarvisDirs: [linkedData] })).toThrow(/inside the Jarvis data directory/);
  });

  test('system directories are refused', () => {
    expect(() => checkUploadPath('/proc/self/environ', ctx)).toThrow(/under \/proc, a system directory/);
    expect(() => checkUploadPath('/etc/hostname', ctx)).toThrow(/under \/etc/);
    expect(() => checkUploadPath('/dev/null', ctx)).toThrow(/under \/dev/);
    expect(() => checkUploadPath('/var/run/does-not-matter', ctx)).toThrow(/under \/var\/run/);
    // Resolved before judging: .. cannot climb out of the check.
    expect(() => checkUploadPath(`${home}/../../../../proc/self/environ`, ctx)).toThrow(/under \/proc/);
  });

  test('only absolute paths to existing regular files', () => {
    expect(() => checkUploadPath('Documents/cv.pdf', ctx)).toThrow(/needs an absolute path/);
    expect(() => checkUploadPath('', ctx)).toThrow(/needs an absolute path/);
    expect(() => checkUploadPath(join(home, 'nope.pdf'), ctx)).toThrow(/does not exist/);
    const dir = join(home, 'Pictures');
    mkdirSync(dir, { recursive: true });
    expect(() => checkUploadPath(dir, ctx)).toThrow(/not a regular file/);
  });

  test('the refusal tells the model not to copy the file out itself', () => {
    expect(() => checkUploadPath(file(join(home, '.ssh', 'k')), ctx)).toThrow(/do not copy or move it for them/);
  });

  test('macOS Library and case-insensitive matching', () => {
    const mac: UploadPolicyContext = { ...ctx, platform: 'darwin' };
    expect(sensitiveReason(join(home, 'Library', 'Keychains', 'login.keychain-db'), mac)).toMatch(/~\/Library/);
    expect(sensitiveReason(join(home, 'library', 'Cookies', 'Cookies.binarycookies'), mac)).toMatch(/~\/Library/);
    expect(sensitiveReason(join(home.toUpperCase(), '.SSH', 'id_rsa'), mac)).toMatch(/hidden/);
    expect(sensitiveReason(join(dataDir.toUpperCase(), 'x'), mac)).toMatch(/Jarvis data directory/);
    expect(sensitiveReason('/private/etc/master.passwd', mac)).toMatch(/system directory/);
    expect(sensitiveReason(join(home, 'Documents', 'cv.pdf'), mac)).toBeNull();
    // Linux is case-sensitive: ~/library is an ordinary folder there.
    expect(sensitiveReason(join(home, 'Library', 'book.pdf'), ctx)).toBeNull();
  });

  test('macOS: case folding applies to the part below home too', () => {
    // A lower-cased spelling of home must not dodge the ~/Library rule.
    const mac: UploadPolicyContext = { ...ctx, platform: 'darwin', home: '/Users/me', jarvisDirs: [], projectsDir: null };
    expect(sensitiveReason('/users/me/Library/Keychains/login.keychain-db', mac)).toMatch(/~\/Library/);
    expect(sensitiveReason('/USERS/ME/LIBRARY/Cookies/c', mac)).toMatch(/~\/Library/);
    expect(sensitiveReason('/users/me/.SSH/id_ed25519', mac)).toMatch(/hidden/);
    expect(sensitiveReason('/users/me/Documents/cv.pdf', mac)).toBeNull();
  });

  test("macOS: cloud-drive folders under ~/Library are the user's files", () => {
    const mac: UploadPolicyContext = { ...ctx, platform: 'darwin', home: '/Users/me', jarvisDirs: [], projectsDir: null };
    expect(sensitiveReason('/Users/me/Library/CloudStorage/Dropbox/cv.pdf', mac)).toBeNull();
    expect(sensitiveReason('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/cv.pdf', mac)).toBeNull();
    // Hidden entries inside them, and the rest of Library, stay refused.
    expect(sensitiveReason('/Users/me/Library/CloudStorage/Dropbox/.ssh/id', mac)).toMatch(/hidden/);
    expect(sensitiveReason('/Users/me/Library/Mobile Documents/iCloud~com~app/state.db', mac)).toMatch(/~\/Library/);
    expect(sensitiveReason('/Users/me/Library/CloudStorageX/x', mac)).toMatch(/~\/Library/);
  });

  test('macOS: the /System/Volumes/Data firmlink is the same place', () => {
    const mac: UploadPolicyContext = { ...ctx, platform: 'darwin', home: '/Users/me', jarvisDirs: ['/Users/me/.jarvis'], projectsDir: null };
    expect(sensitiveReason('/System/Volumes/Data/Users/me/.ssh/id_ed25519', mac)).toMatch(/hidden/);
    expect(sensitiveReason('/system/volumes/data/Users/me/Library/Keychains/k', mac)).toMatch(/Library/);
    expect(sensitiveReason('/System/Volumes/Data/private/etc/master.passwd', mac)).toMatch(/system directory/);
    expect(sensitiveReason('/System/Volumes/Data/Users/me/Documents/cv.pdf', mac)).toBeNull();
    // Another account's Library, by either spelling.
    expect(sensitiveReason('/Users/other/Library/Keychains/k', mac)).toMatch(/Library/);
    expect(sensitiveReason('/System/Volumes/Data/Users/other/Library/k', mac)).toMatch(/Library/);
  });

  test('hidden components are refused outside home too', () => {
    const env = file(join(root, 'srv', 'app', '.env'));
    expect(() => checkUploadPath(env, ctx)).toThrow(/it is a hidden file or folder\./);
    const inHidden = file(join(root, 'srv', '.secrets', 'token.txt'));
    expect(() => checkUploadPath(inHidden, ctx)).toThrow(/hidden file or folder/);
    // A home that itself sits in a dot-directory still has ordinary files.
    const oddHome = join(root, '.homes', 'me');
    const doc = file(join(oddHome, 'Documents', 'cv.pdf'));
    expect(checkUploadPath(doc, { ...ctx, home: oddHome })).toBe(doc);
  });

  test('credential locations moved by the environment are refused', () => {
    const creds = join(root, 'creds');
    const env = {
      XDG_CONFIG_HOME: join(creds, 'config'),
      XDG_DATA_HOME: join(creds, 'data'),
      GNUPGHOME: join(creds, 'gnupg'),
      AWS_SHARED_CREDENTIALS_FILE: join(creds, 'aws-credentials'),
      AWS_CONFIG_FILE: join(creds, 'aws-config'),
      GOOGLE_APPLICATION_CREDENTIALS: join(creds, 'gcp.json'),
      KUBECONFIG: `${join(creds, 'kube-a')}:${join(creds, 'kube-b')}`,
      DOCKER_CONFIG: join(creds, 'docker'),
      CARGO_HOME: join(creds, 'cargo'),
      PASSWORD_STORE_DIR: join(creds, 'pass'),
    };
    const c: UploadPolicyContext = { ...ctx, credentialPaths: credentialPathsFromEnv(env, 'linux') };
    const cases: Array<[string, string]> = [
      [join(creds, 'config', 'gh', 'hosts.yml'), 'XDG_CONFIG_HOME'],
      [join(creds, 'data', 'keyrings', 'login.keyring'), 'XDG_DATA_HOME'],
      [join(creds, 'gnupg', 'private-keys-v1.d', 'k.key'), 'GNUPGHOME'],
      [join(creds, 'aws-credentials'), 'AWS_SHARED_CREDENTIALS_FILE'],
      [join(creds, 'aws-config'), 'AWS_CONFIG_FILE'],
      [join(creds, 'gcp.json'), 'GOOGLE_APPLICATION_CREDENTIALS'],
      [join(creds, 'kube-a'), 'KUBECONFIG'],
      [join(creds, 'kube-b'), 'KUBECONFIG'],
      [join(creds, 'docker', 'config.json'), 'DOCKER_CONFIG'],
      [join(creds, 'cargo', 'credentials.toml'), 'CARGO_HOME'],
      [join(creds, 'pass', 'bank.gpg'), 'PASSWORD_STORE_DIR'],
    ];
    for (const [p, source] of cases) {
      expect(() => checkUploadPath(file(p), c)).toThrow(new RegExp(`inside ${source}, a credentials location`));
    }
    const notes = file(join(creds, 'notes.txt'));
    expect(checkUploadPath(notes, c)).toBe(notes);

    // Relative values are ignored, and a variable pointed at home (or above
    // it) is a misconfiguration that must not refuse everything.
    expect(credentialPathsFromEnv({ CARGO_HOME: 'relative/dir' }, 'linux')).toEqual([]);
    const pointedAtHome = { ...ctx, credentialPaths: credentialPathsFromEnv({ XDG_CONFIG_HOME: home, XDG_DATA_HOME: '/' }, 'linux') };
    const cv = file(join(home, 'Documents', 'cv2.pdf'));
    expect(checkUploadPath(cv, pointedAtHome)).toBe(cv);
  });

  test("WSL: a Windows profile's AppData and hidden folders under /mnt", () => {
    expect(sensitiveReason('/mnt/c/Users/me/AppData/Roaming/Code/secrets.json', ctx)).toMatch(/Windows user's AppData/);
    expect(sensitiveReason('/mnt/d/users/Other/appdata/Local/x', ctx)).toMatch(/AppData/);
    expect(sensitiveReason('/mnt/c/Users/me/.ssh/id_ed25519', ctx)).toMatch(/hidden file or folder/);
    expect(sensitiveReason('/mnt/c/Users/me/Documents/cv.pdf', ctx)).toBeNull();
  });

  test('Windows: device paths, loopback, WSL and administrative shares', () => {
    const win: UploadPolicyContext = {
      home: String.raw`C:\Users\me`, platform: 'win32', jarvisDirs: [String.raw`C:\Users\me\.jarvis`], projectsDir: null,
      appDataDirs: [String.raw`C:\Users\me\AppData\Roaming`],
    };
    for (const p of [
      String.raw`\\localhost\C$\Users\me\Documents\cv.pdf`,
      String.raw`\\127.0.0.1\Users\me\cv.pdf`,
      String.raw`\\?\UNC\localhost\C$\x.txt`,
      String.raw`\\.\UNC\fileserver\ADMIN$\x.txt`,
      String.raw`\\fileserver\D$\x.txt`,
      String.raw`\\wsl$\Ubuntu\home\me\notes.txt`,
      String.raw`\\wsl.localhost\Ubuntu\home\me\notes.txt`,
      '//localhost/C$/x.txt',
      String.raw`\\.\PhysicalDrive0`,
      String.raw`\\?\Volume{0000}\x.txt`,
    ]) {
      expect({ p, why: sensitiveReason(p, win) })
        .toEqual({ p, why: expect.stringMatching(/device path|back to this machine|WSL|administrative share/) });
    }
    // Device-prefixed drive paths get the ordinary rules, not a free pass.
    expect(sensitiveReason(String.raw`\\?\C:\Users\me\.ssh\id_rsa`, win)).toMatch(/hidden/);
    expect(sensitiveReason(String.raw`\\?\c:\users\ME\AppData\Roaming\x`, win)).toMatch(/AppData/);
    expect(sensitiveReason(String.raw`C:\Users\other\AppData\Local\x`, win)).toMatch(/AppData/);
    // A share of this machine by its own name or an odd IPv4 spelling, and
    // AppData reached through any share of the Users folder.
    const named: UploadPolicyContext = { ...win, hostnames: ['DESKTOP-1.corp.example'] };
    expect(sensitiveReason(String.raw`\\desktop-1\Users\me\Documents\cv.pdf`, named)).toMatch(/back to this machine/);
    expect(sensitiveReason(String.raw`\\DESKTOP-1.corp.example\share\x.txt`, named)).toMatch(/back to this machine/);
    expect(sensitiveReason(String.raw`\\0x7f000001\share\x.txt`, win)).toMatch(/back to this machine/);
    expect(sensitiveReason(String.raw`\\fileserver\Users\me\AppData\Local\x`, win)).toMatch(/AppData/);
    // An ordinary file, and an ordinary network share, are left to the card.
    expect(sensitiveReason(String.raw`C:\Users\me\Documents\cv.pdf`, win)).toBeNull();
    expect(sensitiveReason(String.raw`\\fileserver\team\report.pdf`, win)).toBeNull();
  });

  test('a file with more than one hard link is refused', () => {
    const key = file(join(home, '.ssh', 'hardlinked-key'));
    const alias = join(home, 'Documents', 'totally-a-photo.jpg');
    linkSync(key, alias);
    expect(() => checkUploadPath(alias, ctx)).toThrow(/has 2 hard links/);
  });
});
