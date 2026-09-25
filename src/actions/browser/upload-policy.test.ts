import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkUploadPath, sensitiveReason, type UploadPolicyContext } from './upload-policy.ts';

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
});
