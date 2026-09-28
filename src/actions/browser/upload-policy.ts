/**
 * Which local files browser_upload_file may hand to a web page (#521).
 *
 * An upload sends a file's bytes to whatever site the model is on, so it is
 * an exfiltration route by construction. It is already a reviewed action
 * (REVIEWED_UI_TOOLS forces an approval click on every call), but a card
 * reading "upload /home/me/.ssh/id_ed25519" is one careless click from
 * sending a private key, and a page the model is reading can ask for exactly
 * that. So some locations are refused outright, whatever the approval says:
 *
 *   - Hidden entries: any path component starting with ".", anywhere. Under
 *     the home directory that is ~/.ssh, ~/.gnupg, ~/.aws, ~/.config (gh and
 *     gcloud tokens, browser profiles), ~/.netrc, ~/.git-credentials,
 *     ~/.jarvis and the rest, without having to list them; elsewhere it is
 *     the same kind of thing kept somewhere unusual (/srv/app/.env).
 *   - The per-user application-data trees that play the same role elsewhere:
 *     ~/Library on macOS (keychains, cookies; its cloud-drive folders,
 *     CloudStorage and iCloud Drive, excepted), AppData on Windows -- also
 *     another profile's, and a Windows profile seen from WSL under
 *     /mnt/<drive>/Users/<name>.
 *   - Credential locations relocated by the environment: XDG_CONFIG_HOME,
 *     XDG_DATA_HOME, GNUPGHOME, AWS_SHARED_CREDENTIALS_FILE, AWS_CONFIG_FILE,
 *     GOOGLE_APPLICATION_CREDENTIALS, KUBECONFIG, DOCKER_CONFIG, CARGO_HOME,
 *     PASSWORD_STORE_DIR.
 *   - The Jarvis data directory wherever it lives (JARVIS_HOME, --data-dir,
 *     daemon.data_dir) and JARVIS_SECRETS_DIR: config, databases, the
 *     encryption key, the browser profile with the user's cookies.
 *   - /proc, /sys, /dev, /run (and /var/run) and /etc: process environments
 *     (the daemon's /proc/<pid>/environ holds its API keys), devices,
 *     sockets, and system configuration.
 *   - On Windows: device paths (\\.\PhysicalDrive0), loopback and WSL shares
 *     (\\localhost\..., \\wsl$\..., \\wsl.localhost\...) and administrative
 *     shares (\\host\C$\...), which reach the same files by another name.
 *
 * One carve-out: the site builder's projects directory, which defaults to
 * ~/.jarvis/projects. Files the user and the model built together live there,
 * and uploading one of them (a logo, an export) is ordinary. Hidden entries
 * INSIDE a project (.env, .git) are still refused.
 *
 * Also required: an absolute path to an existing regular file with a single
 * link. Directories are refused because Chrome accepts one for a
 * directory-upload input, which would send a whole tree. Symlinks are resolved
 * and the rule is applied to the target, which is also what Chrome is given.
 * A hard link cannot be resolved that way -- it IS the file, under another
 * name -- so a file with more than one link is refused instead.
 *
 * What this deliberately does NOT do is restrict uploads to a staging folder.
 * "Upload my CV from ~/Documents" is a normal request; a staging-only rule
 * would break it, and whether to trade that away is a product decision, not a
 * bug fix. Everything outside the list above is left to the approval card.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import nodePath from 'node:path';

type PlatformPath = typeof nodePath.posix;

/** Data directories registered at daemon start (see daemon/index.ts). */
const registeredDataDirs = new Set<string>();
/** The site builder's projects directory, if the site builder is running. */
let registeredProjectsDir: string | null = null;

export function registerJarvisDataDir(dir: string): void {
  registeredDataDirs.add(expandHome(dir));
}

export function registerSiteProjectsDir(dir: string | null): void {
  registeredProjectsDir = dir ? expandHome(dir) : null;
}

/** Extra roots from `browser.upload_roots` (SYSTEM-owned config, not model input). */
let registeredUploadRoots: string[] = [];

export function registerUploadRoots(roots: readonly string[] | undefined): void {
  registeredUploadRoots = (roots ?? []).filter(r => typeof r === 'string' && r.trim()).map(expandHome);
}

/** The staging folder inside a data dir, for files put there to be uploaded. */
export const UPLOAD_STAGING_DIR_NAME = 'uploads';

export type UploadPolicyContext = {
  home: string;
  platform: NodeJS.Platform;
  /** Jarvis data and secrets directories: refused, except projectsDir and stagingDirs. */
  jarvisDirs: string[];
  /** The site projects directory; allowed even inside a Jarvis dir. */
  projectsDir: string | null;
  /** `<dataDir>/uploads`: allowed even inside a Jarvis dir, like projectsDir. */
  stagingDirs?: string[];
  /** Roots an upload may come from. Empty means the allowed-roots rule is off. */
  uploadRoots?: string[];
  /** Windows %APPDATA% / %LOCALAPPDATA%, when set. */
  appDataDirs: string[];
  /** Credential files and directories named by the environment. */
  credentialPaths?: Array<{ path: string; source: string }>;
  /** This machine's names, for spotting a share of itself on Windows. */
  hostnames?: string[];
};

/** Variables that relocate a credential file or directory. */
const CREDENTIAL_ENV = [
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'GNUPGHOME', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS', 'KUBECONFIG', 'DOCKER_CONFIG', 'CARGO_HOME', 'PASSWORD_STORE_DIR',
] as const;

export function credentialPathsFromEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Array<{ path: string; source: string }> {
  const P = pathFor(platform);
  const out: Array<{ path: string; source: string }> = [];
  for (const name of CREDENTIAL_ENV) {
    const value = env[name];
    if (!value) continue;
    // KUBECONFIG is a list, like PATH.
    const parts = name === 'KUBECONFIG' ? value.split(P.delimiter) : [value];
    for (const part of parts) {
      if (part && P.isAbsolute(part)) out.push({ path: part, source: name });
    }
  }
  return out;
}

export function defaultUploadPolicyContext(): UploadPolicyContext {
  const home = homedir();
  const env = process.env;
  const dataDirs = [
    nodePath.join(home, '.jarvis'),
    ...(env.JARVIS_HOME ? [env.JARVIS_HOME] : []),
    ...registeredDataDirs,
  ];
  const jarvisDirs = [...dataDirs, ...(env.JARVIS_SECRETS_DIR ? [env.JARVIS_SECRETS_DIR] : [])];
  const projectsDir = registeredProjectsDir ?? nodePath.join(home, '.jarvis', 'projects');
  const stagingDirs = [...new Set(dataDirs.map(d => nodePath.join(expandHome(d), UPLOAD_STAGING_DIR_NAME)))];
  return {
    home,
    platform: process.platform,
    jarvisDirs,
    projectsDir,
    stagingDirs,
    uploadRoots: defaultUploadRoots(home, projectsDir, stagingDirs, env),
    appDataDirs: [env.APPDATA, env.LOCALAPPDATA].filter((d): d is string => !!d),
    credentialPaths: credentialPathsFromEnv(env),
    hostnames: [hostname()],
  };
}

/**
 * The XDG user directories an upload may come from, by variable and by default
 * name. The variables are the reason this is not a fixed list of English names:
 * a localized desktop has `~/Documentos` or `~/Dokumente`, and a relocated one
 * has `~/Nextcloud/Documents`.
 */
const XDG_UPLOAD_DIRS: ReadonlyArray<readonly [string, string]> = [
  ['XDG_DOCUMENTS_DIR', 'Documents'],
  ['XDG_DOWNLOAD_DIR', 'Downloads'],
  ['XDG_DESKTOP_DIR', 'Desktop'],
  ['XDG_PICTURES_DIR', 'Pictures'],
];

/**
 * Where an upload may come from: the user's own document folders, site
 * projects, the Jarvis staging folder, and whatever `browser.upload_roots`
 * adds.
 *
 * The XDG variables are usually NOT exported -- `xdg-user-dirs` keeps them in
 * `~/.config/user-dirs.dirs` and only a login-shell hook exports them -- so that
 * file is read as well, or every localized desktop would fall back to
 * `~/Documents` and #527 would refuse the user's real Documents folder on day
 * one. It is read as UNTRUSTED input: a value is taken only if it lands strictly
 * inside the home directory, so a `user-dirs.dirs` rewritten to
 * `XDG_DOCUMENTS_DIR="$HOME"` (which a plain `write_data` could do) cannot widen
 * the roots to the whole home directory. The denylist floor runs underneath in
 * any case, so no root -- configured, localized or forged -- can re-expose
 * `~/.ssh`, `/proc` or the Jarvis data dir.
 */
export function defaultUploadRoots(
  home: string,
  projectsDir: string | null,
  stagingDirs: string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  const fromFile = readUserDirsFile(home, env);
  const roots: string[] = [];
  for (const [variable, fallback] of XDG_UPLOAD_DIRS) {
    const candidate = env[variable] ?? fromFile[variable];
    // A variable may point anywhere the user likes; one read out of the
    // untrusted file may not escape home.
    if (candidate && nodePath.isAbsolute(candidate) && (env[variable] || under(candidate, home))) {
      roots.push(nodePath.resolve(candidate));
    } else {
      roots.push(nodePath.join(home, fallback));
    }
  }
  if (projectsDir) roots.push(nodePath.resolve(projectsDir));
  roots.push(...stagingDirs);
  roots.push(...registeredUploadRoots);
  // A root that IS the home dir, an ancestor of it, or the filesystem root
  // would turn the allowed-roots rule back into the denylist it replaces. The
  // floor still bounds the damage, but a rule that silently does nothing is
  // worse than one that drops a bad root.
  const homeReal = nodePath.resolve(home);
  return [...new Set(roots.map(r => nodePath.resolve(r)))].filter(r =>
    r !== nodePath.parse(r).root && r !== homeReal && !under(homeReal, r));
}

/** Whether `path` is strictly inside `dir` (not `dir` itself). */
function under(path: string, dir: string): boolean {
  const p = nodePath.resolve(path);
  const d = nodePath.resolve(dir);
  return p !== d && p.startsWith(d.endsWith(nodePath.sep) ? d : d + nodePath.sep);
}

/**
 * `XDG_*_DIR` values from `~/.config/user-dirs.dirs`, which is the only place
 * most desktops record them. Untrusted data: parsed, never executed, and the
 * caller decides what it may point at.
 */
function readUserDirsFile(home: string, env: Record<string, string | undefined>): Record<string, string> {
  const configHome = env.XDG_CONFIG_HOME && nodePath.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : nodePath.join(home, '.config');
  const out: Record<string, string> = {};
  let text: string;
  try {
    const stat = statSync(nodePath.join(configHome, 'user-dirs.dirs'));
    if (!stat.isFile() || stat.size > 64 * 1024) return out;
    text = readFileSync(nodePath.join(configHome, 'user-dirs.dirs'), 'utf-8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(XDG_[A-Z_]+_DIR)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (!m) continue;
    const value = m[2]!.replace(/^\$HOME/, home);
    if (value && nodePath.isAbsolute(value)) out[m[1]!] = nodePath.resolve(value);
  }
  return out;
}

// Both spellings of the linked ones: /var/run is /run on most Linux distros,
// and on macOS /etc and /var are links into /private. The rule runs on the
// path as written and as resolved, and a missing file only has the former.
const SYSTEM_DIRS = ['/proc', '/sys', '/dev', '/run', '/var/run', '/etc', '/private/etc', '/private/var/run'];

/** macOS: the data volume's firmlinked view of /Users, /private and friends. */
const DARWIN_DATA_VOLUME = '/System/Volumes/Data';

/** Another account's Library on macOS. */
const DARWIN_PROFILE_LIBRARY = /^\/users\/[^/]+\/(library(\/.*)?)$/i;
/**
 * A Windows profile's AppData, natively or from WSL's /mnt/<drive>. On Windows
 * anywhere in the path, not only after a drive letter: a share of the Users
 * folder (\\fileserver\Users\me\AppData) reaches the same tree.
 */
const WIN32_PROFILE_APPDATA = /(^|\\)users\\[^\\]+\\appdata(\\|$)/i;
const WSL_PROFILE_APPDATA = /^\/mnt\/[a-z]\/users\/[^/]+\/appdata(\/|$)/i;

/**
 * Check a path the model wants to upload. Returns the resolved real path to
 * hand to Chrome, or throws an Error whose message is written for the model.
 */
export function checkUploadPath(raw: string, ctx: UploadPolicyContext = defaultUploadPolicyContext()): string {
  const P = pathFor(ctx.platform);
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input || !P.isAbsolute(input)) {
    throw new Error(`browser_upload_file needs an absolute path to a file, got "${input}".`);
  }

  // The lexical path first: a refused location stays refused even when the
  // file is missing, so the model learns the rule rather than "not found".
  refuseSensitive(input, input, ctx);

  let real: string;
  try {
    real = realpathSync.native(input);
  } catch {
    throw new Error(`Cannot upload ${input}: the file does not exist.`);
  }
  // Then the target: a link from an ordinary folder into ~/.ssh is ~/.ssh.
  // Not redundant on Windows either: the canonical name is where spellings
  // the text rules cannot see through (8.3 short names like APPDAT~1, a
  // trailing dot or space, \??\ prefixes) come out as the real name.
  refuseSensitive(real, input, ctx);

  // Only now the allowed roots, and only on the RESOLVED path (#527). The order
  // is deliberate -- floor, resolve, floor again, roots -- so an allowed root
  // cannot re-expose a denied location: a symlink from ~/Documents into ~/.ssh
  // is refused by the floor above, and a root misconfigured to a wide directory
  // still cannot reach anything the floor denies. Roots only ever NARROW what
  // the floor already permitted.
  const outside = outsideUploadRoots(real, ctx);
  if (outside) throw new Error(`Refusing to upload ${input}: ${outside}`);

  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(real);
  } catch { /* raced away: reported as not a file */ }
  if (!stat?.isFile()) {
    throw new Error(`Cannot upload ${input}: it is not a regular file. Only single files can be uploaded, not folders or devices.`);
  }
  if (stat.nlink > 1) {
    throw new Error(
      `Refusing to upload ${input}: the file has ${stat.nlink} hard links, so it may be a protected file under ` +
      `another name. If the user really wants to share it, they must copy it to an ordinary folder themselves; ` +
      `do not copy or move it for them.`,
    );
  }
  return real;
}

/**
 * Why `real` is outside every folder an upload may come from, or null.
 *
 * The message names the folders, because the model cannot guess them and the
 * useful next step is for the USER to move the file. It must not offer to move
 * the file itself: doing that for the model is how a denied path becomes an
 * allowed one.
 */
export function outsideUploadRoots(real: string, ctx: UploadPolicyContext): string | null {
  const roots = ctx.uploadRoots ?? [];
  if (roots.length === 0) return null; // no roots configured: rule off, floor only
  const P = pathFor(ctx.platform);
  const fold = ctx.platform === 'win32' || ctx.platform === 'darwin';
  for (const root of roots.flatMap(r => forms(r, P))) {
    if (relUnder(real, root, fold, P) !== null) return null;
  }
  const shown = roots.map(r => displayRoot(r, ctx.home, P)).join(', ');
  return `it is outside the folders Jarvis may upload from (${shown}). Ask the user to move or copy the file `
    + 'into one of those folders themselves; do not move or copy it for them, and do not upload it from where it is.';
}

/** A root as a person would recognise it, with the home dir shortened to `~`. */
function displayRoot(root: string, home: string, P: PlatformPath): string {
  const rel = relUnder(root, home, false, P);
  return rel === null || rel === '' ? root : `~${P.sep}${rel}`;
}

function refuseSensitive(path: string, input: string, ctx: UploadPolicyContext): void {
  const why = sensitiveReason(path, ctx);
  if (why) {
    throw new Error(
      `Refusing to upload ${input}: ${why}. Files there can hold credentials, keys or Jarvis's own data, ` +
      `so they are never sent to a web page. If the user really wants to share this file, they must copy ` +
      `it to an ordinary folder themselves; do not copy or move it for them.`,
    );
  }
}

/**
 * Why `rawPath` (absolute) is a refused location, or null. Exported for tests.
 *
 * Every configured directory is compared in both its written and its
 * symlink-resolved form, because the rule runs on both forms of the upload
 * path: a ~/.jarvis that is a link to /data/jarvis must still cover
 * /data/jarvis/config.yaml. Comparison folds case on macOS and Windows, whose
 * default filesystems do.
 */
export function sensitiveReason(rawPath: string, ctx: UploadPolicyContext): string | null {
  const P = pathFor(ctx.platform);
  const fold = ctx.platform === 'win32' || ctx.platform === 'darwin';

  let path = rawPath;
  if (ctx.platform === 'win32') {
    const win = normalizeWin32(rawPath, ctx.hostnames);
    if (win.refuse) return win.refuse;
    path = win.path;
  }
  path = P.resolve(path);
  if (ctx.platform === 'darwin' && relUnder(path, DARWIN_DATA_VOLUME, fold, P) !== null) {
    // /System/Volumes/Data/Users/me/.ssh is /Users/me/.ssh.
    path = path.slice(DARWIN_DATA_VOLUME.length) || '/';
  }

  const homes = forms(ctx.home, P);
  const jarvisDirs = ctx.jarvisDirs.flatMap(d => forms(d, P));

  if (ctx.platform !== 'win32') {
    for (const dir of SYSTEM_DIRS) {
      if (relUnder(path, dir, fold, P) !== null) return `it is under ${dir}, a system directory`;
    }
  }

  // The carve-outs inside a Jarvis dir: site projects (files the user and the
  // model built together) and the upload staging folder (files put there to be
  // uploaded). Each applies unless it would swallow what it is carved out of --
  // a projects_dir or data dir set to the home directory itself would otherwise
  // un-refuse all of it.
  const carveOuts = [
    ...(ctx.projectsDir ? forms(ctx.projectsDir, P).map(d => [d, 'a site project'] as const) : []),
    ...(ctx.stagingDirs ?? []).flatMap(s => forms(s, P).map(d => [d, 'the upload folder'] as const)),
  ];
  for (const [carve, what] of carveOuts) {
    if ([...homes, ...jarvisDirs].some(d => relUnder(d, carve, fold, P) !== null)) continue;
    const rel = relUnder(path, carve, fold, P);
    if (rel === null) continue;
    // Allowed tree, but not its hidden entries (.env, .git, ...).
    if (hasHiddenComponent(rel)) return `it is a hidden file or folder inside ${what}`;
    return null;
  }

  for (const dir of jarvisDirs) {
    if (relUnder(path, dir, fold, P) !== null) return 'it is inside the Jarvis data directory';
  }

  for (const dir of ctx.appDataDirs.flatMap(d => forms(d, P))) {
    if (relUnder(path, dir, fold, P) !== null) return 'it is inside AppData, where applications keep their data';
  }

  for (const { path: cred, source } of ctx.credentialPaths ?? []) {
    for (const form of forms(cred, P)) {
      // A variable pointed at the home directory (or above it) would refuse
      // everything; that is a misconfiguration, not a credential location.
      if (homes.some(h => relUnder(h, form, fold, P) !== null)) continue;
      if (relUnder(path, form, fold, P) !== null) return `it is inside ${source}, a credentials location`;
    }
  }

  let underHome = false;
  for (const home of homes) {
    const rel = relUnder(path, home, fold, P);
    if (rel === null) continue;
    underHome = true;
    if (hasHiddenComponent(rel)) return 'it is a hidden file or folder in the home directory (like ~/.ssh or ~/.config)';
    const first = rel.split(/[\\/]/)[0] ?? '';
    if (ctx.platform === 'darwin' && first === 'library' && !isMacCloudDrive(rel)) {
      return 'it is inside ~/Library, where applications keep their data';
    }
    if (ctx.platform === 'win32' && first === 'appdata') {
      return 'it is inside AppData, where applications keep their data';
    }
  }

  // Outside home, a hidden component anywhere. (Under home only the part
  // below it counts, so a home that itself sits in a dot-directory works.)
  if (!underHome && hasHiddenComponent(path)) return 'it is a hidden file or folder';
  const macLibrary = ctx.platform === 'darwin' ? DARWIN_PROFILE_LIBRARY.exec(path) : null;
  if (macLibrary && !isMacCloudDrive(macLibrary[1]!.toLowerCase())) {
    return "it is inside a user's Library folder, where applications keep their data";
  }
  if (ctx.platform === 'win32' && WIN32_PROFILE_APPDATA.test(path)) {
    return "it is inside a user's AppData, where applications keep their data";
  }
  if (ctx.platform === 'linux' && WSL_PROFILE_APPDATA.test(path)) {
    return "it is inside a Windows user's AppData, where applications keep their data";
  }
  return null;
}

/**
 * Cloud-drive folders macOS keeps under ~/Library: CloudStorage (Dropbox,
 * OneDrive, Google Drive on macOS 12.3+) and iCloud Drive. They hold the
 * user's own documents, not application data. `rel` is below home, folded.
 */
function isMacCloudDrive(rel: string): boolean {
  return /^library\/(cloudstorage|mobile documents\/com~apple~clouddocs)(\/|$)/.test(rel);
}

/**
 * Strip Win32 device prefixes so the ordinary rules see an ordinary path, and
 * refuse the forms that reach local files under another name.
 */
function normalizeWin32(raw: string, selfNames: string[] = []): { path: string; refuse?: string } {
  let p = raw.replace(/\//g, '\\');
  if (!p.startsWith('\\\\')) return { path: p };

  // \\?\C:\x and \\.\C:\x are C:\x.
  const drive = /^\\\\[?.]\\([a-z]:(\\.*)?)$/i.exec(p);
  if (drive) return { path: drive[1]! };
  // \\?\UNC\host\share is \\host\share.
  const unc = /^\\\\[?.]\\unc\\(.*)$/i.exec(p);
  if (unc) p = `\\\\${unc[1]}`;
  else if (/^\\\\[?.]\\/.test(p)) return { path: p, refuse: 'it is a Windows device path' };

  const [host = '', share = ''] = p.slice(2).split('\\');
  const h = host.toLowerCase();
  if (h === 'wsl$' || h === 'wsl.localhost') return { path: p, refuse: 'it is inside a WSL distribution' };
  // IPv4 in any spelling the WHATWG parser accepts (0x7f000001, 127.1).
  let ip = h;
  try { ip = new URL(`http://${h}/`).hostname; } catch { /* not a host name */ }
  const self = selfNames.map(n => n.toLowerCase()).flatMap(n => [n, n.split('.')[0]!]);
  if (h === 'localhost' || h === '.' || h === '::1' || ip.startsWith('127.') || ip === '0.0.0.0' || self.includes(h)) {
    return { path: p, refuse: 'it is a network path back to this machine' };
  }
  if (share.endsWith('$')) return { path: p, refuse: 'it is on an administrative share' };
  return { path: p };
}

/**
 * The part of `path` below `dir`, in the folded case when `fold` ('' for the
 * directory itself), or null when `path` is not `dir` or below it. Both are
 * absolute and normalised.
 */
function relUnder(path: string, dir: string, fold: boolean, P: PlatformPath): string | null {
  const p = fold ? path.toLowerCase() : path;
  const d = fold ? dir.toLowerCase() : dir;
  if (p === d) return '';
  const withSep = d.endsWith(P.sep) ? d : d + P.sep;
  return p.startsWith(withSep) ? p.slice(withSep.length) : null;
}

/**
 * Why a page may not receive a file, or null. An ALLOWLIST: only `http:` and
 * `https:` may, and everything else -- `data:`, `about:blank`, `about:srcdoc`,
 * `blob:`, `javascript:`, `file:`, `view-source:`, `chrome:`,
 * `chrome-extension:`, `devtools:`, `filesystem:`, and the empty string a frame
 * reports before it has committed a document -- may not. A denylist here would
 * have to predict the next scheme Chrome adds, which is the mistake #527 exists
 * to stop repeating.
 *
 * Why refuse an opaque origin at all: an upload into a `data:` page the model
 * wrote is not an upload, it is a file read. The page's script can read the
 * attached File back and `browser_evaluate` hands it to the model, which is
 * exactly the containment `read_file` now has and this would route around.
 *
 * What this is NOT: an exfiltration control. A `data:` document runs script and
 * an ordinary `https:` page can `fetch()` the attached bytes anywhere (CORS
 * restricts reading responses, not sending bodies). The controls on exfiltration
 * are the allowed roots and the human click.
 */
export function uploadTargetRefusal(pageUrl: string): string | null {
  const url = (pageUrl ?? '').trim();
  if (!url) {
    return 'the page has not finished loading a document, so there is nothing to attach a file to. '
      + 'Take a browser_snapshot first.';
  }
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return `"${url.slice(0, 120)}" is not a page a file can be attached to.`;
  }
  if (scheme === 'http:' || scheme === 'https:') return null;
  return `the page is ${scheme} rather than a web page. A file is never attached to a ${scheme} document: `
    + 'such a page has an opaque origin and only reads the file back to the model, which is what read_file is for.';
}

/** The origin of a page URL, for comparing the reviewed page with the one being uploaded to. */
export function pageOrigin(pageUrl: string): string | null {
  try {
    return new URL(pageUrl).origin;
  } catch {
    return null;
  }
}

/** A directory as written (resolved) and, when it exists, symlink-resolved. */
function forms(dir: string, P: PlatformPath): string[] {
  const written = P.resolve(dir);
  let real = written;
  try { real = realpathSync.native(written); } catch { /* does not exist: written form only */ }
  return real === written ? [written] : [written, real];
}

function hasHiddenComponent(rel: string): boolean {
  return rel.split(/[\\/]/).some(part => part.startsWith('.') && part !== '.' && part !== '..');
}

function pathFor(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function expandHome(dir: string): string {
  return nodePath.resolve(dir.replace(/^~(?=$|[\\/])/, homedir()));
}
