/**
 * `browser_upload_file`'s allowed roots (#527), and the floor that stays
 * underneath them.
 *
 * #521 refused uploads from a denylist of sensitive locations. The review of it
 * showed why that struggles: a denylist has to predict every credential
 * location, and its first version missed macOS firmlinks, credential dirs moved
 * by environment variables, and the Windows profile as seen from WSL. So the rule
 * is now "only from these folders", with the denylist kept as a hard floor.
 *
 * The order under test is the one that matters: floor, resolve, floor again,
 * then roots on the RESOLVED path. A root must never be able to re-expose
 * something the floor denies, and that is what most of these tests check.
 *
 * Nothing uses the real home: every context is built by hand.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkUploadPath, defaultUploadRoots, outsideUploadRoots, pageOrigin, registerUploadRoots,
  uploadTargetRefusal, type UploadPolicyContext,
} from './upload-policy.ts';

let root: string;
let home: string;
let dataDir: string;
let projectsDir: string;
let staging: string;

function ctx(over: Partial<UploadPolicyContext> = {}): UploadPolicyContext {
  const roots = [join(home, 'Documents'), join(home, 'Downloads'), join(home, 'Desktop'),
    join(home, 'Pictures'), projectsDir, staging];
  return {
    home,
    platform: 'linux',
    jarvisDirs: [dataDir],
    projectsDir,
    stagingDirs: [staging],
    uploadRoots: roots,
    appDataDirs: [],
    credentialPaths: [],
    hostnames: ['testhost'],
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'upload-roots-'));
  home = join(root, 'home');
  dataDir = join(home, '.jarvis');
  projectsDir = join(dataDir, 'projects');
  staging = join(dataDir, 'uploads');
  for (const d of [join(home, 'Documents'), join(home, 'Downloads'), join(home, 'Pictures'),
    join(home, 'Desktop'), join(projectsDir, 'app'), staging, join(home, '.ssh'),
    join(home, 'notes'), join(dataDir, 'logs')]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(home, 'Documents', 'cv.pdf'), 'my cv');
  writeFileSync(join(home, 'Downloads', 'photo.jpg'), 'jpeg bytes');
  writeFileSync(join(home, 'notes', 'todo.md'), 'notes outside every root');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE-KEY-MUST-NOT-UPLOAD');
  writeFileSync(join(projectsDir, 'app', 'logo.png'), 'png bytes');
  writeFileSync(join(staging, 'ready.csv'), 'a,b,c');
  writeFileSync(join(dataDir, '.secrets.key'), 'KEY-MUST-NOT-UPLOAD');
  writeFileSync(join(dataDir, 'logs', 'jarvis.log'), 'a log line');
});

afterEach(() => {
  registerUploadRoots([]);
  rmSync(root, { recursive: true, force: true });
});

const upload = (path: string, over: Partial<UploadPolicyContext> = {}) => checkUploadPath(path, ctx(over));
const refusal = (path: string, over: Partial<UploadPolicyContext> = {}): string => {
  try {
    upload(path, over);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};

describe('the allowed roots', () => {
  test('the user document folders, site projects and the staging folder all work', () => {
    // The ordinary requests #527 must not break.
    expect(upload(join(home, 'Documents', 'cv.pdf'))).toBe(join(home, 'Documents', 'cv.pdf'));
    expect(upload(join(home, 'Downloads', 'photo.jpg'))).toBe(join(home, 'Downloads', 'photo.jpg'));
    expect(upload(join(projectsDir, 'app', 'logo.png'))).toBe(join(projectsDir, 'app', 'logo.png'));
    expect(upload(join(staging, 'ready.csv'))).toBe(join(staging, 'ready.csv'));
  });

  test('a file outside every root is refused, and the message says where to put it', () => {
    const msg = refusal(join(home, 'notes', 'todo.md'));
    expect(msg).toContain('outside the folders Jarvis may upload from');
    expect(msg).toContain('~/Documents');
    expect(msg).toContain('~/Downloads');
    // It must not offer to move the file itself: doing that for the model is how
    // a denied path becomes an allowed one.
    expect(msg).toContain('do not move or copy it for them');
  });

  test('a log inside the data dir is refused although it is not a secret', () => {
    // The data dir is denied wholesale by the floor; only the carve-outs escape.
    expect(refusal(join(dataDir, 'logs', 'jarvis.log'))).toContain('Refusing to upload');
  });

  test('with no roots configured the rule is off and only the floor applies', () => {
    // Keeps every existing caller and the #521 tests meaningful.
    expect(upload(join(home, 'notes', 'todo.md'), { uploadRoots: [] }))
      .toBe(join(home, 'notes', 'todo.md'));
    expect(refusal(join(home, '.ssh', 'id_ed25519'), { uploadRoots: [] })).toContain('hidden file or folder');
  });
});

describe('the floor stays underneath the roots', () => {
  test('a symlink from an allowed root into a denied location is refused', () => {
    // Roots are judged on the RESOLVED path, so the link cannot launder ~/.ssh.
    const link = join(home, 'Documents', 'innocent.txt');
    symlinkSync(join(home, '.ssh', 'id_ed25519'), link);
    const msg = refusal(link);
    expect(msg).toContain('Refusing to upload');
    expect(msg).not.toContain('PRIVATE-KEY');
  });

  test('a symlink from an allowed root to the keychain is refused', () => {
    const link = join(home, 'Downloads', 'notes.txt');
    symlinkSync(join(dataDir, '.secrets.key'), link);
    expect(refusal(link)).toContain('Refusing to upload');
  });

  test('a root set to the whole home directory is dropped, not honoured', () => {
    // Such a root would turn the allowed-roots rule back into the denylist it
    // replaces, so it is dropped -- and the floor refuses the credential anyway.
    const roots = defaultUploadRoots(home, projectsDir, [staging], { HOME: home });
    expect(roots).not.toContain(home);
    expect(roots.some(r => r === '/' || r === home)).toBe(false);
  });

  test('a root that is an ancestor of home, or the filesystem root, is dropped', () => {
    registerUploadRoots(['/', root, home]);
    const roots = defaultUploadRoots(home, projectsDir, [staging], {});
    for (const bad of ['/', root, home]) expect(roots).not.toContain(bad);
  });

  test('a hidden file inside an allowed root is still refused', () => {
    writeFileSync(join(home, 'Documents', '.env'), 'SECRET=1');
    expect(refusal(join(home, 'Documents', '.env'))).toContain('hidden file or folder');
  });

  test('a hidden file inside the staging folder is still refused', () => {
    writeFileSync(join(staging, '.env'), 'SECRET=1');
    expect(refusal(join(staging, '.env'))).toContain('hidden file or folder');
  });

  test('the staging carve-out cannot swallow the data dir it sits in', () => {
    // A staging dir misconfigured to the data dir (or home) would un-refuse all
    // of it; the carve-out is ignored instead.
    expect(refusal(join(dataDir, '.secrets.key'), { stagingDirs: [dataDir], uploadRoots: [dataDir] }))
      .toContain('Refusing to upload');
    expect(refusal(join(home, '.ssh', 'id_ed25519'), { stagingDirs: [home], uploadRoots: [home] }))
      .toContain('Refusing to upload');
  });

  test('/proc and /etc stay refused whatever the roots say', () => {
    for (const path of ['/proc/self/environ', '/etc/shadow']) {
      expect(refusal(path, { uploadRoots: ['/'] }), path).toContain('Refusing to upload');
    }
  });
});

describe('the XDG user directories', () => {
  test('an exported XDG variable moves the root', () => {
    const custom = join(root, 'Nextcloud', 'Docs');
    mkdirSync(custom, { recursive: true });
    const roots = defaultUploadRoots(home, projectsDir, [staging], { XDG_DOCUMENTS_DIR: custom });
    expect(roots).toContain(custom);
  });

  test('a localized folder from user-dirs.dirs is honoured', () => {
    // The variables are usually NOT exported; the file is where the value lives,
    // so without reading it every localized desktop breaks on day one.
    mkdirSync(join(home, '.config'), { recursive: true });
    mkdirSync(join(home, 'Dokumente'), { recursive: true });
    writeFileSync(join(home, '.config', 'user-dirs.dirs'),
      'XDG_DOCUMENTS_DIR="$HOME/Dokumente"\nXDG_DOWNLOAD_DIR="$HOME/Downloads"\n');
    const roots = defaultUploadRoots(home, projectsDir, [staging], {});
    expect(roots).toContain(join(home, 'Dokumente'));
  });

  test('user-dirs.dirs cannot widen a root beyond the home directory', () => {
    // That file is writable at plain write_data, so it is untrusted input: a
    // value is taken only if it lands strictly inside home.
    mkdirSync(join(home, '.config'), { recursive: true });
    writeFileSync(join(home, '.config', 'user-dirs.dirs'),
      `XDG_DOCUMENTS_DIR="$HOME"\nXDG_DOWNLOAD_DIR="/"\nXDG_DESKTOP_DIR="${root}"\n`);
    const roots = defaultUploadRoots(home, projectsDir, [staging], {});
    expect(roots).not.toContain(home);
    expect(roots).not.toContain('/');
    expect(roots).not.toContain(root);
    // It falls back to the default names instead.
    expect(roots).toContain(join(home, 'Documents'));
  });

  test('browser.upload_roots adds a folder', () => {
    const extra = join(root, 'shared');
    mkdirSync(extra, { recursive: true });
    registerUploadRoots([extra]);
    expect(defaultUploadRoots(home, projectsDir, [staging], {})).toContain(extra);
  });
});

describe('the receiving page', () => {
  test('only http and https may receive a file', () => {
    expect(uploadTargetRefusal('https://example.com/upload')).toBeNull();
    expect(uploadTargetRefusal('http://example.com/upload')).toBeNull();
  });

  test('an opaque origin is refused, and the message says read_file exists', () => {
    // An upload into a page the model wrote is a file read wearing an upload's
    // clothes: the page's script reads the File back and browser_evaluate hands
    // it over.
    for (const url of ['data:text/html,<input type=file>', 'about:blank', 'about:srcdoc',
      'blob:https://example.com/x', 'file:///etc/passwd', 'view-source:https://x.test',
      'chrome://settings', 'chrome-extension://abc/x.html', 'devtools://devtools/x',
      'filesystem:https://x.test/temporary/f', 'javascript:0', 'about:newtab', 'ftp://x.test/f']) {
      const why = uploadTargetRefusal(url);
      expect(why, url).not.toBeNull();
    }
    expect(uploadTargetRefusal('data:text/html,x')).toContain('read_file');
  });

  test('a frame with no committed document is refused, not treated as allowed', () => {
    // An allowlist is the point: a denylist would pass the empty string.
    expect(uploadTargetRefusal('')).toContain('not finished loading');
    expect(uploadTargetRefusal('   ')).toContain('not finished loading');
    expect(uploadTargetRefusal('not a url')).not.toBeNull();
  });

  test('pageOrigin compares the origin, not the path', () => {
    // SPAs rewrite the path constantly with history.pushState; refusing on that
    // would refuse every real upload to Gmail or Drive.
    expect(pageOrigin('https://mail.example.com/a/b?c=1#d')).toBe('https://mail.example.com');
    expect(pageOrigin('https://mail.example.com/x/y')).toBe(pageOrigin('https://mail.example.com/z'));
    expect(pageOrigin('https://evil.test/')).not.toBe(pageOrigin('https://mail.example.com/'));
    expect(pageOrigin('not a url')).toBeNull();
  });
});

describe('outsideUploadRoots directly', () => {
  test('it matches a root itself and anything below it', () => {
    expect(outsideUploadRoots(join(home, 'Documents', 'a', 'b.txt'), ctx())).toBeNull();
    expect(outsideUploadRoots(join(home, 'Documents'), ctx())).toBeNull();
  });

  test('a sibling with a shared prefix is not inside a root', () => {
    // `~/Documents2` must not pass because `~/Documents` is a root.
    mkdirSync(join(home, 'Documents2'), { recursive: true });
    expect(outsideUploadRoots(join(home, 'Documents2', 'x.txt'), ctx())).not.toBeNull();
  });
});
