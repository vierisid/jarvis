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
 *   - Hidden entries under the home directory: any path component starting
 *     with "." below $HOME. That is ~/.ssh, ~/.gnupg, ~/.aws, ~/.config (gh
 *     and gcloud tokens, browser profiles), ~/.netrc, ~/.git-credentials,
 *     ~/.jarvis and the rest, without having to list them.
 *   - The per-user application-data trees that play the same role elsewhere:
 *     ~/Library on macOS (keychains, cookies), AppData on Windows.
 *   - The Jarvis data directory wherever it lives (JARVIS_HOME, --data-dir,
 *     daemon.data_dir) and JARVIS_SECRETS_DIR: config, databases, the
 *     encryption key, the browser profile with the user's cookies.
 *   - /proc, /sys, /dev, /run (and /var/run) and /etc: process environments
 *     (the daemon's /proc/<pid>/environ holds its API keys), devices,
 *     sockets, and system configuration.
 *
 * One carve-out: the site builder's projects directory, which defaults to
 * ~/.jarvis/projects. Files the user and the model built together live there,
 * and uploading one of them (a logo, an export) is ordinary. Hidden entries
 * INSIDE a project (.env, .git) are still refused.
 *
 * Also required: an absolute path to an existing regular file. Directories are
 * refused because Chrome accepts one for a directory-upload input, which would
 * send a whole tree. Symlinks are resolved first and the rule is applied to
 * the target, which is also what Chrome is given.
 *
 * What this deliberately does NOT do is restrict uploads to a staging folder.
 * "Upload my CV from ~/Documents" is a normal request; a staging-only rule
 * would break it, and whether to trade that away is a product decision, not a
 * bug fix. Everything outside the list above is left to the approval card.
 */

import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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

export type UploadPolicyContext = {
  home: string;
  platform: NodeJS.Platform;
  /** Jarvis data and secrets directories: refused, except projectsDir. */
  jarvisDirs: string[];
  /** The site projects directory; allowed even inside a Jarvis dir. */
  projectsDir: string | null;
  /** Windows %APPDATA% / %LOCALAPPDATA%, when set. */
  appDataDirs: string[];
};

export function defaultUploadPolicyContext(): UploadPolicyContext {
  const home = homedir();
  const env = process.env;
  const jarvisDirs = [
    join(home, '.jarvis'),
    ...(env.JARVIS_HOME ? [env.JARVIS_HOME] : []),
    ...(env.JARVIS_SECRETS_DIR ? [env.JARVIS_SECRETS_DIR] : []),
    ...registeredDataDirs,
  ];
  return {
    home,
    platform: process.platform,
    jarvisDirs,
    projectsDir: registeredProjectsDir ?? join(home, '.jarvis', 'projects'),
    appDataDirs: [env.APPDATA, env.LOCALAPPDATA].filter((d): d is string => !!d),
  };
}

// Both spellings of the linked ones: /var/run is /run on most Linux distros,
// and on macOS /etc and /var are links into /private. The rule runs on the
// path as written and as resolved, and a missing file only has the former.
const SYSTEM_DIRS = ['/proc', '/sys', '/dev', '/run', '/var/run', '/etc', '/private/etc', '/private/var/run'];

/**
 * Check a path the model wants to upload. Returns the resolved real path to
 * hand to Chrome, or throws an Error whose message is written for the model.
 */
export function checkUploadPath(raw: string, ctx: UploadPolicyContext = defaultUploadPolicyContext()): string {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input || !isAbsolute(input)) {
    throw new Error(`browser_upload_file needs an absolute path to a file, got "${input}".`);
  }

  // The lexical path first: a refused location stays refused even when the
  // file is missing, so the model learns the rule rather than "not found".
  refuseSensitive(resolve(input), input, ctx);

  let real: string;
  try {
    real = realpathSync.native(input);
  } catch {
    throw new Error(`Cannot upload ${input}: the file does not exist.`);
  }
  // Then the target: a link from an ordinary folder into ~/.ssh is ~/.ssh.
  refuseSensitive(real, input, ctx);

  let isFile = false;
  try {
    isFile = statSync(real).isFile();
  } catch { /* raced away: reported as not a file */ }
  if (!isFile) {
    throw new Error(`Cannot upload ${input}: it is not a regular file. Only single files can be uploaded, not folders or devices.`);
  }
  return real;
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
 * Why `path` (absolute, normalised) is a refused location, or null. Exported
 * for tests.
 *
 * Every configured directory is compared in both its written and its
 * symlink-resolved form, because the rule runs on both forms of the upload
 * path: a ~/.jarvis that is a link to /data/jarvis must still cover
 * /data/jarvis/config.yaml.
 */
export function sensitiveReason(path: string, ctx: UploadPolicyContext): string | null {
  const fold = ctx.platform === 'win32' || ctx.platform === 'darwin';
  const homes = forms(ctx.home);
  const jarvisDirs = ctx.jarvisDirs.flatMap(forms);

  if (ctx.platform !== 'win32') {
    for (const dir of SYSTEM_DIRS) {
      if (within(path, dir, fold)) return `it is under ${dir}, a system directory`;
    }
  }

  // The projects carve-out, unless it would swallow what it is carved out of:
  // a projects_dir set to the data directory or the home directory itself
  // would otherwise un-refuse all of it.
  for (const projects of ctx.projectsDir ? forms(ctx.projectsDir) : []) {
    if ([...homes, ...jarvisDirs].some(d => within(d, projects, fold))) continue;
    if (!within(path, projects, fold)) continue;
    // Allowed tree, but not its hidden entries (.env, .git, ...).
    if (hasHiddenComponent(relative(projects, path))) return 'it is a hidden file or folder inside a site project';
    return null;
  }

  for (const dir of jarvisDirs) {
    if (within(path, dir, fold)) return 'it is inside the Jarvis data directory';
  }

  for (const dir of ctx.appDataDirs.flatMap(forms)) {
    if (within(path, dir, fold)) return 'it is inside AppData, where applications keep their data';
  }

  for (const home of homes) {
    if (!within(path, home, fold)) continue;
    const rel = relative(home, path);
    if (hasHiddenComponent(rel)) return 'it is a hidden file or folder in the home directory (like ~/.ssh or ~/.config)';
    const first = (rel.split(/[\\/]/)[0] ?? '').toLowerCase();
    if (ctx.platform === 'darwin' && first === 'library') {
      return 'it is inside ~/Library, where applications keep their data';
    }
    if (ctx.platform === 'win32' && first === 'appdata') {
      return 'it is inside AppData, where applications keep their data';
    }
  }
  return null;
}

/** A directory as written (resolved) and, when it exists, symlink-resolved. */
function forms(dir: string): string[] {
  const written = resolve(dir);
  let real = written;
  try { real = realpathSync.native(written); } catch { /* does not exist: written form only */ }
  return real === written ? [written] : [written, real];
}

function hasHiddenComponent(rel: string): boolean {
  return rel.split(/[\\/]/).some(part => part.startsWith('.') && part !== '.' && part !== '..');
}

/** True when `path` is `dir` or below it. */
function within(path: string, dir: string, fold: boolean): boolean {
  const p = fold ? path.toLowerCase() : path;
  const d = fold ? dir.toLowerCase() : dir;
  if (p === d) return true;
  const withSep = d.endsWith(sep) ? d : d + sep;
  return p.startsWith(withSep);
}

function expandHome(dir: string): string {
  return resolve(dir.replace(/^~(?=$|[\\/])/, homedir()));
}
