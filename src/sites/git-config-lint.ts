/**
 * Site Builder — git config lint (#523)
 *
 * Before the daemon runs git in a site project, read the project's own git
 * config and refuse to run at all if it holds a key outside a short
 * allowlist.
 *
 * Why a lint and not more pins: PROJECT_GIT_PINS (git-pins.ts) can only
 * override keys whose NAMES are known. The dangerous ones below are named by
 * whoever writes the config -- `filter.<x>.clean`, `diff.<x>.textconv`,
 * `merge.<x>.driver`, `include.path` / `includeIf.<cond>.path`,
 * `http.<url>.proxy`, `url.<base>.insteadOf` -- so there is no `-c` that turns
 * them off, and they run on add, commit, checkout, merge and fetch. #516 stops
 * the site file tools from writing `.git/`; this covers a config planted
 * before that, or through a route that is still open (#522), or by
 * site_run_command.
 *
 * WHAT IS CHECKED, on every daemon git call in a project:
 *   - that `<project>/.git` is a repository git itself would use, and that it
 *     and its common dir are inside the project (resolveRepo). Otherwise git
 *     would walk up to a repository above the project, or the daemon would
 *     commit and push someone else's repository;
 *   - that the repository has no legacy `remotes/` or `branches/` files (they
 *     define a remote with no config key at all) and no object alternates;
 *   - the repository config git reads -- `<commondir>/config` and
 *     `<gitdir>/config.worktree` -- against the allowlist. Includes are never
 *     followed: `include*` is refused.
 *
 * WHAT IS NOT: the system and global configs (`/etc/gitconfig`,
 * `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`), which the sanitized env
 * still lets git read; see the GIT_CONFIG_GLOBAL note in the #523 PR. A
 * driver defined THERE is still activated by a project `.gitattributes`.
 * Attributes need no lint of their own: an attribute only names a driver,
 * and the program comes from config.
 *
 * It is a check before the command, so a config rewritten between the check
 * and the command gets through once -- the same race as the per-name hook
 * lookup (git-pins.ts), open only to something that can already write the
 * file.
 */

import { createHash } from 'node:crypto';
import {
  accessSync, closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { sanitizedEnv } from '../util/subprocess-env.ts';
import { isWithin } from '../util/path.ts';
import { PROJECT_GIT_PINS } from './git-pins.ts';

/** A value check for one allowed key; `null` is a valueless key. */
type ValueCheck = (value: string | null, subsection: string | null) => boolean;
/** An allowed variable: `true` for any value, or a check on it. */
type Allowed = Readonly<Record<string, true | ValueCheck>>;

/**
 * git's boolean spellings (valueless is true), plus the non-boolean modes
 * GitHubManager.planIntegration handles itself. Not `interactive`/`i`, which
 * would start an editor, or `preserve`, which git 2.34+ rejects anyway.
 */
const REBASE_MODE: ValueCheck = value => value === null
  || /^(?:true|false|yes|no|on|off|1|0|merges|m)$/i.test(value);

/**
 * A fetch refspec that can only write remote-tracking refs of its own remote
 * (or a negative refspec). `+refs/heads/*:refs/heads/*` would let
 * getRemoteStatus's fetch overwrite local branches.
 */
const TRACKING_REFSPEC: ValueCheck = (value, remote) => {
  if (value === null || remote === null) return false;
  if (value.startsWith('^')) return !value.includes(':');
  const colon = value.indexOf(':');
  if (colon < 0 || value.indexOf(':', colon + 1) >= 0) return false;
  return value.slice(colon + 1).startsWith(`refs/remotes/${remote}/`);
};

/**
 * Keys allowed in a project's git config, by section, then variable (both
 * lowercase, as `git config --list` prints them). Everything not listed is
 * refused. Each entry is written by `git init`, by the site builder's own
 * flow, or by a common tool on a normal project, and none can name a program,
 * a path, a host or another config file -- except where it is overridden on
 * every daemon git call by PROJECT_GIT_PINS, which is said per entry.
 */
const ALLOWED: Readonly<Record<string, Allowed>> = {
  core: {
    // Written by `git init`: the first four everywhere, the next three on
    // macOS and Windows.
    repositoryformatversion: true, filemode: true, bare: true, logallrefupdates: true,
    ignorecase: true, precomposeunicode: true, symlinks: true,
    // git's built-in line-ending conversion, and a status speed-up.
    autocrlf: true, eol: true, safecrlf: true, untrackedcache: true,
    // Programs, but pinned off on every daemon git call (PROJECT_GIT_PINS),
    // which the command line always wins. Allowed because they are common in
    // real projects: husky sets `core.hooksPath=.husky/_` on `bun install`.
    hookspath: true, fsmonitor: true,
    // Not core.worktree (moves the work tree out of the project), nor
    // attributesFile/excludesFile/sshCommand/editor/pager/askPass/gitProxy/
    // alternateRefsCommand (paths and programs no pin covers).
  },
  // GitManager.init writes name and email; the rest is identity only.
  user: { name: true, email: true, useconfigonly: true, signingkey: true },
  init: { defaultbranch: true },
  // Written by `git init` with a global init.defaultObjectFormat /
  // init.defaultRefFormat; worktreeConfig enables config.worktree, which is
  // linted too. Not partialClone (lazy fetches) or any other extension.
  extensions: { objectformat: true, refstorage: true, worktreeconfig: true },
  // Read by GitHubManager.pull. Not twohead/octopus (merge strategy names).
  pull: { rebase: REBASE_MODE, ff: true },
  // Only matter for a push without a refspec; the daemon always names one.
  push: { default: true, autosetupremote: true, gpgsign: true /* pinned false */ },
  fetch: { prune: true },
  // Signing switches, all pinned false by PROJECT_GIT_PINS; the programs they
  // would start (gpg.*) are refused.
  commit: { gpgsign: true },
  log: { showsignature: true },
  merge: { verifysignatures: true },
  // Numbers and a schedule name (`git maintenance start` writes the last
  // two). Not the rest of gc.*: gc.recentObjectsHook runs a program.
  gc: { auto: true },
  maintenance: { auto: true, strategy: true },
  // git-lfs writes this into any repository it touches. Not the rest of
  // lfs.*: lfs.customtransfer.<name>.path runs a program, lfs.url redirects.
  lfs: { repositoryformatversion: true },
};

/** Sections whose every variable is allowed: display only. */
const ALLOWED_ANY_VARIABLE = new Set(['advice', 'color']);

/**
 * Keys with a subsection (`section.<sub>.variable`), by section:
 *   - remote.<name>: `git remote add` writes url and fetch; pushurl is
 *     allowed for the same reason url is. url/pushurl must be a network URL
 *     (isNetworkRemoteUrl), fetch a refspec into refs/remotes/<name>/. Not
 *     proxy, uploadpack, receivepack, vcs, push, mirror or anything else.
 *   - branch.<name>: `push -u` writes remote and merge; rebase is read by
 *     pull; description is text; VS Code writes vscode-merge-base. A
 *     branch.<b>.remote holding a URL -- the pre-#511 token URL, which
 *     GitHubManager scrubs -- is only used by an argument-less
 *     fetch/pull/push, which the daemon never runs. Not pushRemote or
 *     mergeOptions (a merge strategy is a program name).
 *   - lfs.<url>.access: git-lfs records the auth scheme a server wanted, one
 *     word (`basic`), after a push or fetch.
 *   - color.<slot>: display only.
 */
const ONE_WORD: ValueCheck = value => value !== null && /^[A-Za-z]{1,32}$/.test(value);
const ALLOWED_WITH_SUBSECTION: Readonly<Record<string, Allowed | '*'>> = {
  remote: {
    url: value => isNetworkRemoteUrl(value),
    pushurl: value => isNetworkRemoteUrl(value),
    fetch: TRACKING_REFSPEC,
    tagopt: true,
    prune: true,
    // The gh CLI writes `base` here; a word, not a remote or a URL.
    'gh-resolved': ONE_WORD,
  },
  branch: { remote: true, merge: true, rebase: REBASE_MODE, description: true, 'vscode-merge-base': true },
  lfs: { access: ONE_WORD },
  color: '*',
};

/**
 * A remote URL that selects git's own network transport. Refused: a local
 * path or `file://` (git then runs upload-pack/receive-pack on another
 * repository on this machine, without the daemon's pins and under that
 * repository's config and hooks), and the `<transport>::<address>` form, or
 * any other scheme, which runs `git-remote-<transport>` from PATH (`ext::`
 * runs its address as a command where protocol.ext.allow lets it). The
 * scheme compare is case-sensitive, as git's is: `HTTPS://` would look for
 * `git-remote-HTTPS`. The site builder only ever sets GitHub's https clone
 * URL; ssh stays allowed because GitHubManager deliberately supports an ssh
 * origin, and http because a self-hosted remote may use it.
 */
export function isNetworkRemoteUrl(value: string | null): boolean {
  if (value === null || /[\0-\x1f\x7f]/.test(value)) return false;
  const scheme = /^(?:https?|ssh|git):\/\//.exec(value);
  if (scheme) {
    // The host is what follows the last `@` of the authority. One starting
    // with `-` would be an ssh option (git refuses it too).
    const authority = value.slice(scheme[0].length).split('/', 1)[0]!;
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    return host !== '' && !host.startsWith('-');
  }
  // scp-like `[user@]host:path`: git reads it that way only when no `/`
  // comes before the first `:`, and the `:` does not start `//` (a URL of
  // some other scheme) or `:` (the transport-helper form). A host starting
  // with `-` would be an ssh option.
  return /^(?:[^@/:]+@)?(?:\[[^\]/]+\]|[^/:[\]]+):(?!:|\/\/)/.test(value) && !/^(?:[^@/:]+@)?-/.test(value);
}

/** A key as git prints it, split: section and variable lowercased. */
function splitKey(key: string): { section: string; subsection: string | null; variable: string } | null {
  const firstDot = key.indexOf('.');
  const lastDot = key.lastIndexOf('.');
  if (firstDot <= 0 || lastDot === key.length - 1) return null;
  return {
    section: key.slice(0, firstDot).toLowerCase(),
    subsection: firstDot === lastDot ? null : key.slice(firstDot + 1, lastDot),
    variable: key.slice(lastDot + 1).toLowerCase(),
  };
}

/** Whether one `git config --list` entry is allowed. `key` as git prints it. */
export function isAllowedConfigEntry(key: string, value: string | null): boolean {
  const parts = splitKey(key);
  if (parts === null) return false;
  const { section, subsection, variable } = parts;
  // hasOwn, not a plain lookup: `constructor` or `__proto__` would find
  // Object.prototype's.
  let rule: true | ValueCheck | undefined;
  if (subsection === null) {
    if (ALLOWED_ANY_VARIABLE.has(section)) return true;
    if (!Object.hasOwn(ALLOWED, section)) return false;
    const vars = ALLOWED[section]!;
    rule = Object.hasOwn(vars, variable) ? vars[variable] : undefined;
  } else {
    if (!Object.hasOwn(ALLOWED_WITH_SUBSECTION, section)) return false;
    const vars = ALLOWED_WITH_SUBSECTION[section]!;
    if (vars === '*') return true;
    rule = Object.hasOwn(vars, variable) ? vars[variable] : undefined;
  }
  if (rule === undefined) return false;
  return rule === true || rule(value, subsection);
}

/**
 * The refused keys in `git config --list -z` output, in file order. Entries
 * are NUL-terminated `key\nvalue`, or just `key` for a valueless one.
 */
export function refusedConfigKeys(listing: string): string[] {
  const refused: string[] = [];
  for (const entry of listing.split('\0')) {
    if (entry === '') continue;
    const nl = entry.indexOf('\n');
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const value = nl < 0 ? null : entry.slice(nl + 1);
    if (!isAllowedConfigEntry(key, value)) refused.push(key);
  }
  return refused;
}

/**
 * A key for a message. Subsections are the writer's free text, and these
 * messages reach the model: one that is not a plain name or URL is described
 * by its length instead of quoted. No `@`: a URL with userinfo
 * (`url.https://user:<token>@host/.insteadOf`) would carry a credential into
 * the message and the log.
 */
export function displayConfigKey(key: string): string {
  const parts = splitKey(key);
  if (parts === null) return /^[A-Za-z0-9.-]{1,64}$/.test(key) ? key : `<a ${key.length}-character key>`;
  const { section, subsection, variable } = parts;
  if (subsection === null) return `${section}.${variable}`;
  const shown = /^[A-Za-z0-9._/:+~-]{1,80}$/.test(subsection)
    ? subsection
    : `<${subsection.length}-character name>`;
  return `${section}.${shown}.${variable}`;
}

export type GitConfigVerdict =
  | { ok: true }
  | {
    ok: false;
    /**
     * 'refused-key': a key outside the allowlist. 'refused-repo': the
     * repository is outside the project, or carries files that act like
     * config (legacy remotes, alternates). 'unreadable': the config is not a
     * regular file, is too large, or git could not parse it in time.
     * 'no-repo': there is no `.git` git would use, so git would go looking in
     * the directories above the project.
     */
    reason: 'refused-key' | 'refused-repo' | 'unreadable' | 'no-repo';
    /** The first refused key, raw, for 'refused-key'. */
    key?: string;
    /**
     * For 'refused-key': the command that removes the key, for the user in
     * the dashboard. Kept out of `message`, which also reaches the model.
     */
    remedy?: string;
    /** One line for logs: which file, which key. No host paths. */
    summary: string;
    /** The full error: what happened, and what the user can do about it. */
    message: string;
  };

type Refusal = Extract<GitConfigVerdict, { ok: false }>;

/** Thrown by GitConfigLint.check; `.verdict` says why. */
export class GitConfigRefusedError extends Error {
  constructor(readonly verdict: Refusal) {
    super(verdict.message);
    this.name = 'GitConfigRefusedError';
  }
}

/** Where git would read this project's repository config. */
type RepoFiles = {
  /** The project's real path; the two below are real paths inside it. */
  root: string;
  /** `<commondir>/config`. */
  config: string;
  /** `<gitdir>/config.worktree`, read by git when extensions.worktreeConfig is on. */
  worktreeConfig: string;
};

/** Upper bound on a config file. Real ones are well under a few KB. */
const MAX_CONFIG_BYTES = 64 * 1024;
/** Upper bound on HEAD, a gitfile and commondir. git caps a gitfile at 1 MiB. */
const MAX_SMALL_FILE_BYTES = 64 * 1024;
/** Upper bound on one `git config --list`. */
const DEFAULT_LIST_TIMEOUT_MS = 10_000;
/** Bound on the cached verdicts and on the per-project last verdicts. */
const DEFAULT_MAX_ENTRIES = 1_000;

/**
 * Open `path` for reading without blocking and without following a symlink
 * in its last component (`nofollow`), and return its bytes if it is a regular
 * file of at most `max` bytes, else null. The type is checked on the open
 * descriptor, so a FIFO put where git expects a file cannot hang the daemon,
 * and what is returned is exactly what was checked. Throws what open throws
 * (ENOENT; ELOOP for a symlink under `nofollow`).
 */
function readSmallRegularFile(path: string, max: number, nofollow = false): Buffer | null {
  const flags = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (nofollow ? fsConstants.O_NOFOLLOW : 0);
  const fd = openSync(path, flags);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buffer = Buffer.alloc(st.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, null);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * A path read out of a gitfile or commondir, or null when it cannot be one
 * this lint follows faithfully: git uses the raw bytes, Node encodes a path
 * string as UTF-8, so anything outside printable ASCII is refused rather than
 * resolved to a different place than git's.
 */
function pathFromFile(bytes: Buffer): string | null {
  const text = bytes.toString('latin1').replace(/[\r\n]+$/, '');
  return text !== '' && /^[\x20-\x7e]+$/.test(text) ? text : null;
}

/**
 * git's validate_headref: HEAD is a symlink whose target starts `refs/`
 * (any other symlink is rejected outright), or a file holding `ref: refs/...`
 * or an object id (either hash). A HEAD git rejects makes it skip the whole
 * `.git` and keep walking up.
 */
function isValidHead(path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) return readlinkSync(path).startsWith('refs/');
    const bytes = readSmallRegularFile(path, 255);
    if (bytes === null) return false;
    const text = bytes.toString('latin1');
    return /^ref:[ \t\n\r]*refs\//.test(text) || /^[0-9a-f]{40}/i.test(text);
  } catch {
    return false;
  }
}

/** The kernel's symlink-hop limit (ELOOP). */
const MAX_LINK_HOPS = 40;

/**
 * The real path of `path` the way the kernel resolves it, or null when it
 * leads nowhere: one component at a time, a symlink replaced by its target
 * BEFORE any `..` after it is applied. path.resolve/join collapse `link/..`
 * to `.` first, and so does Bun's realpathSync (it normalizes its argument;
 * measured), while git hands the string to the kernel: `commondir` = `x/..`
 * with `x -> ../evil/deep` is `evil` to git (reproduced in review).
 */
function kernelRealpath(path: string): string | null {
  const pending = path.split('/').filter(part => part !== '');
  let current = '/';
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === '.') continue;
    // `current` holds no symlink and no `..`, so its parent is lexical.
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = current === '/' ? `/${part}` : `${current}/${part}`;
    let st;
    try {
      st = lstatSync(next);
    } catch {
      return null;
    }
    if (!st.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return null;
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      return null;
    }
    if (target.startsWith('/')) current = '/';
    pending.unshift(...target.split('/').filter(part => part !== ''));
  }
  return current;
}

/**
 * Where a path read from a gitfile or commondir leads from `base` (a real
 * path), resolved as git's kernel call resolves it; null when nowhere.
 */
function realFrom(base: string, raw: string): string | null {
  return kernelRealpath(raw.startsWith('/') ? raw : `${base}/${raw}`);
}

/**
 * git's get_common_dir: `<gitdir>/commondir` when present, relative to the
 * gitdir; else the gitdir itself. `gitDir` is a real path, and so is the
 * result. Null when the file is there but is not something this lint can
 * follow (see pathFromFile), not a regular file, or names nothing (git dies
 * on that).
 */
function commonDirOf(gitDir: string): string | null {
  let bytes: Buffer | null;
  try {
    bytes = readSmallRegularFile(`${gitDir}/commondir`, MAX_SMALL_FILE_BYTES);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? gitDir : null;
  }
  const path = bytes === null ? null : pathFromFile(bytes);
  return path === null ? null : realFrom(gitDir, path);
}

/** git's own test for `objects/` and `refs/`: searchable, i.e. access(X_OK). */
function isSearchable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether `path` exists at all (a dangling symlink counts). */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether `path` is a directory with anything in it (or not readable as one). */
function hasEntries(path: string): boolean {
  if (!exists(path)) return false;
  try {
    return readdirSync(path).length > 0;
  } catch {
    return true;
  }
}

type Resolution = { ok: true; files: RepoFiles } | { ok: false; verdict: Refusal };

function repoRefusal(summary: string, what: string): Resolution {
  return {
    ok: false,
    verdict: {
      ok: false,
      reason: 'refused-repo',
      summary,
      message: `Git is turned off for this project: ${summary}. ${what} This cannot be changed from a site chat: the `
        + 'user needs to look at the project\'s .git in a terminal.',
    },
  };
}

const NO_REPO: Resolution = {
  ok: false,
  verdict: {
    ok: false,
    reason: 'no-repo',
    summary: 'no usable .git',
    message: 'Not a git repository: the project has no usable .git, and the site builder does not let git look for '
      + 'one in the directories above it.',
  },
};

/**
 * The repository git uses for a command run in `project`, found the way
 * setup_git_directory finds it (with no GIT_DIR, which sanitizedEnv strips),
 * or why the daemon must not run git there:
 *   - `.git` a regular file (or a link to one): a gitfile, read as
 *     read_gitfile_gently reads it (`gitdir: ` then a path, trailing CR/LF
 *     dropped, relative to the project).
 *   - `.git` a directory (or a link to one).
 *   - either way, the git dir must pass is_git_directory. Otherwise git skips
 *     a directory `.git` and walks UP the tree (checked on 2.55: an empty
 *     `.git/`, a garbage HEAD) to a config nobody linted, and dies on a
 *     gitfile -- so both are refused.
 *   - anything else, or nothing: the same walk up, refused.
 * The git dir and the common dir must both be inside the project, and the
 * common dir must hold no legacy remote files and no alternates.
 */
function resolveRepo(project: string): Resolution {
  // Every path from here on is a real path, and every check and read uses it:
  // what was checked is what is read.
  const root = kernelRealpath(project);
  if (root === null) return NO_REPO;
  const dotGit = `${root}/.git`;
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return NO_REPO;
  }
  let gitDir: string | null;
  if (st.isFile()) {
    let bytes: Buffer | null;
    try {
      bytes = readSmallRegularFile(dotGit, MAX_SMALL_FILE_BYTES);
    } catch {
      return NO_REPO;
    }
    if (bytes === null || !bytes.subarray(0, 8).equals(Buffer.from('gitdir: '))) return NO_REPO;
    const path = pathFromFile(bytes.subarray(8));
    // Relative to the directory holding the gitfile, as git reads it.
    gitDir = path === null ? null : realFrom(root, path);
  } else if (st.isDirectory()) {
    gitDir = kernelRealpath(dotGit);
  } else {
    return NO_REPO;
  }
  if (gitDir === null || !isValidHead(`${gitDir}/HEAD`)) return NO_REPO;
  const common = commonDirOf(gitDir);
  if (common === null || !isSearchable(`${common}/objects`) || !isSearchable(`${common}/refs`)) return NO_REPO;

  // Inside the project: a gitfile or a `.git` symlink can name any
  // repository on disk, whose config may well pass, and the daemon would
  // then commit to it and push it. Linked worktrees of another checkout are
  // refused with it; the site builder never makes one.
  if (!isWithin(gitDir, root) || !isWithin(common, root)) {
    return repoRefusal('its .git points to a repository outside the project',
      'The site builder only runs git on a repository inside the project directory.');
  }

  // `remotes/<name>` and `branches/<name>` define a remote with no config
  // key at all (git 2.55 still reads them), which is how an origin pointing
  // at a local repository -- whose hooks run without the daemon's pins --
  // would get past the URL check. An empty `branches/` is what older
  // `git init` templates leave. Alternates make git read objects from any
  // path on disk.
  const legacy = ['remotes', 'branches'].find(dir => hasEntries(`${common}/${dir}`));
  if (legacy !== undefined) {
    return repoRefusal(`its .git/${legacy} directory defines a remote outside the git config`,
      'The site builder only uses remotes defined in the git config.');
  }
  const alternates = ['alternates', 'http-alternates'].find(f => exists(`${common}/objects/info/${f}`));
  if (alternates !== undefined) {
    return repoRefusal(`its .git/objects/info/${alternates} points git at objects outside the project`,
      'The site builder only runs git on a self-contained repository.');
  }
  return { ok: true, files: { root, config: `${common}/config`, worktreeConfig: `${gitDir}/config.worktree` } };
}

/** Single-quote for POSIX sh. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** How to name a config file in a message: its path inside the project. */
function describeFile(project: string, file: string): string {
  // resolveRepo keeps the repository inside the project, so this is always
  // relative; the fallback only guards against a host path in a message.
  return isWithin(file, project) ? relative(project, file) : 'the git config';
}

function refusedKeyVerdict(where: string, keys: string[]): Refusal {
  const key = keys[0]!;
  const shown = displayConfigKey(key);
  const more = keys.length > 1 ? ` (and ${keys.length - 1} other key${keys.length > 2 ? 's' : ''})` : '';
  const worktree = where.endsWith('config.worktree') ? ' --worktree' : '';
  const summary = `${where} sets "${shown}"${more}, which the site builder does not allow`;
  return {
    ok: false,
    reason: 'refused-key',
    key,
    summary,
    // No command in here: this text reaches the model, which would offer to
    // run it through site_run_command. The command is in `remedy`, for the
    // dashboard.
    message: `Git is turned off for this project: ${summary}. Keys outside the site builder's short list of safe `
      + 'git settings can make git run a program or connect somewhere else, so the site builder will not run '
      + 'git here while one is set. This cannot be changed from a site chat: the user needs to check the '
      + 'project\'s git config in a terminal, and remove the key if it is not theirs.',
    remedy: shown === key
      ? `To remove it, run \`git config${worktree} --unset-all ${shellQuote(key)}\` in the project directory.`
      : `To remove it, edit ${where} by hand.`,
  };
}

function unreadableVerdict(where: string, why: string): Refusal {
  const summary = `${where} ${why}`;
  return {
    ok: false,
    reason: 'unreadable',
    summary,
    message: `Git is turned off for this project: ${summary}, so the site builder cannot check it for unsafe `
      + 'settings. The user needs to look at the project\'s git config in a terminal.',
  };
}

/** What a `git config --list` run reports. */
export type ConfigListing = { exitCode: number; stdout: string; timedOut: boolean };

/**
 * `git config --file - --no-includes --list -z` on `content`, run from `/` so
 * there is no repository to discover and no index to read, with the same pins
 * and sanitized env as every daemon git call, and killed at the timeout. git
 * parses the bytes the lint read and hashed, not whatever the path holds by
 * the time git would open it.
 */
async function listConfigWithGit(content: Uint8Array, timeoutMs: number): Promise<ConfigListing> {
  const proc = Bun.spawn(['git', ...PROJECT_GIT_PINS, 'config', '--file', '-', '--no-includes', '--list', '-z'], {
    cwd: '/',
    stdin: content,
    stdout: 'pipe',
    stderr: 'pipe',
    env: sanitizedEnv({ GIT_TERMINAL_PROMPT: '0' }),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, timeoutMs);
  try {
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export type GitConfigLintOptions = {
  /** Test seam: replaces the `git config --list` spawn. */
  listConfig?: (content: Uint8Array, timeoutMs: number) => Promise<ConfigListing>;
  timeoutMs?: number;
  maxEntries?: number;
};

/** One config file as read: absent, refused before git sees it, or its bytes. */
type ReadConfig =
  | { kind: 'absent' }
  | { kind: 'refused'; why: string }
  | { kind: 'bytes'; bytes: Buffer; hash: string };

function readConfig(path: string): ReadConfig {
  let bytes: Buffer | null;
  try {
    // No symlink: git init never makes the config one, and following it here
    // would lint a file git may reach differently.
    bytes = readSmallRegularFile(path, MAX_CONFIG_BYTES, true);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    if (code === 'ELOOP') return { kind: 'refused', why: 'is a symlink' };
    return { kind: 'refused', why: `could not be read (${code ?? 'error'})` };
  }
  if (bytes === null) return { kind: 'refused', why: 'is not a regular file of at most 64 KiB' };
  return { kind: 'bytes', bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * The lint, with its cache. One instance per SiteBuilderService, shared by
 * its GitManager and GitHubManager; managers built without one share
 * `defaultGitConfigLint`.
 *
 * The cache is keyed on the CONTENT: each check reads both files (a few
 * hundred bytes; no spawn) and hashes them, and a verdict is reused only for
 * the same bytes. So no rewrite can keep a stale verdict -- not a same-size
 * one within one timestamp tick, not one with its mtime put back, not a file
 * renamed over the path -- and there is nothing to age out. Refusals are
 * cached like passes; a timed-out listing is not cached.
 */
export class GitConfigLint {
  /** Counters for tests and the cost measurement. */
  readonly stats = { listings: 0, hits: 0 };

  private readonly listConfig: (content: Uint8Array, timeoutMs: number) => Promise<ConfigListing>;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, Refusal | { ok: true }>();
  private readonly inflight = new Map<string, Promise<GitConfigVerdict>>();
  private readonly lastByProject = new Map<string, GitConfigVerdict>();

  constructor(options: GitConfigLintOptions = {}) {
    this.listConfig = options.listConfig ?? listConfigWithGit;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Throws GitConfigRefusedError unless the project passes. */
  async check(projectPath: string): Promise<void> {
    const verdict = await this.inspect(projectPath);
    if (!verdict.ok) throw new GitConfigRefusedError(verdict);
  }

  /** The verdict for a project, from the cache when its config is unchanged. */
  async inspect(projectPath: string): Promise<GitConfigVerdict> {
    const project = resolve(projectPath);
    const repo = resolveRepo(project);
    const verdict = repo.ok ? await this.lintFiles(project, repo.files) : repo.verdict;
    this.remember(this.lastByProject, project, verdict);
    return verdict;
  }

  /**
   * The last verdict seen for a project by any check, without checking
   * again; undefined when it was never checked. For the project listing.
   */
  lastVerdict(projectPath: string): GitConfigVerdict | undefined {
    return this.lastByProject.get(resolve(projectPath));
  }

  private async lintFiles(project: string, files: RepoFiles): Promise<GitConfigVerdict> {
    // config first: a refusal names the file git reads first.
    const read = [
      { where: describeFile(files.root, files.config), file: readConfig(files.config) },
      { where: describeFile(files.root, files.worktreeConfig), file: readConfig(files.worktreeConfig) },
    ];
    for (const { where, file } of read) {
      if (file.kind === 'refused') return unreadableVerdict(where, file.why);
    }
    const key = read.map(({ where, file }) => `${where}\0${file.kind === 'bytes' ? file.hash : 'absent'}`).join('\0');
    const hit = this.cache.get(key);
    if (hit) {
      this.stats.hits++;
      return hit;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const run = (async () => {
      const { verdict, cacheable } = await this.lintNow(read);
      if (cacheable) this.remember(this.cache, key, verdict);
      return verdict;
    })();
    this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async lintNow(
    read: Array<{ where: string; file: ReadConfig }>,
  ): Promise<{ verdict: Refusal | { ok: true }; cacheable: boolean }> {
    for (const { where, file } of read) {
      // A repository with no config file at all is valid (format 0); git
      // treats it as empty, and so does the lint.
      if (file.kind !== 'bytes') continue;
      this.stats.listings++;
      let listing: ConfigListing;
      try {
        listing = await this.listConfig(file.bytes, this.timeoutMs);
      } catch {
        return { verdict: unreadableVerdict(where, 'could not be read'), cacheable: false };
      }
      if (listing.timedOut) return { verdict: unreadableVerdict(where, 'took too long to read'), cacheable: false };
      if (listing.exitCode !== 0) return { verdict: unreadableVerdict(where, 'could not be parsed by git'), cacheable: true };
      const refused = refusedConfigKeys(listing.stdout);
      if (refused.length > 0) return { verdict: refusedKeyVerdict(where, refused), cacheable: true };
    }
    return { verdict: { ok: true }, cacheable: true };
  }

  /** Insert as the newest entry, dropping the oldest past maxEntries. */
  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > this.maxEntries) map.delete(map.keys().next().value!);
  }
}

/** The lint used by managers constructed without one. */
export const defaultGitConfigLint = new GitConfigLint();

export type ProjectScanResult = { id: string; verdict: Refusal };

/**
 * Lint every project in `projectsDir` once, one at a time, and return the
 * ones that fail other than by having no repository at all (a project
 * without `.git` is shown as having no branch already). Bounded: at most
 * `maxProjects`, and none started after `budgetMs`. Discovery matches
 * ProjectManager.listProjects: a directory, not hidden, with a Makefile.
 */
export async function scanProjectGitConfigs(
  projectsDir: string,
  lint: GitConfigLint,
  options: { maxProjects?: number; budgetMs?: number } = {},
): Promise<ProjectScanResult[]> {
  const maxProjects = options.maxProjects ?? 200;
  const deadline = Date.now() + (options.budgetMs ?? 30_000);
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const failing: ProjectScanResult[] = [];
  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= maxProjects || Date.now() > deadline) break;
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const projectPath = join(projectsDir, entry.name);
    try {
      if (!statSync(join(projectPath, 'Makefile')).isFile()) continue;
    } catch {
      continue;
    }
    scanned++;
    const verdict = await lint.inspect(projectPath);
    if (!verdict.ok && verdict.reason !== 'no-repo') failing.push({ id: entry.name, verdict });
  }
  return failing;
}
