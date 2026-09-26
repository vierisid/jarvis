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

/**
 * What is wrong with an allowed key's value, and how the user puts it right:
 * `fix` is the git command, given the `git config` file option for the file
 * the key is in (see fileOption), or null when there is none to suggest.
 */
type ValueProblem = { why: string; fix: ((fileOption: string) => string) | null };
/** A value check for one allowed key: null when the value is fine. */
type ValueCheck = (value: string | null, subsection: string | null) => ValueProblem | null;
/** An allowed variable: `true` for any value, or a check on its value. */
type Rule = true | ValueCheck;
type Rules = Readonly<Record<string, Rule>>;

/** A value check from a predicate. */
function valueCheck(
  ok: (value: string | null, subsection: string | null) => boolean,
  why: string,
  fix: ValueProblem['fix'],
): ValueCheck {
  return (value, subsection) => (ok(value, subsection) ? null : { why, fix });
}

/**
 * git's boolean spellings (valueless is true), plus the non-boolean modes
 * GitHubManager.planIntegration handles itself. Not `interactive`/`i` or
 * `preserve`.
 */
function isRebaseMode(value: string | null): boolean {
  return value === null || /^(?:true|false|yes|no|on|off|1|0|merges|m)$/i.test(value);
}

/**
 * A fetch refspec that can only write remote-tracking refs of its own remote
 * (or a negative refspec). `+refs/heads/*:refs/heads/*` would let
 * getRemoteStatus's fetch overwrite local branches.
 */
function isTrackingRefspec(value: string | null, remote: string): boolean {
  if (value === null) return false;
  if (value.startsWith('^')) return !value.includes(':');
  const colon = value.indexOf(':');
  if (colon < 0 || value.indexOf(':', colon + 1) >= 0) return false;
  return value.slice(colon + 1).startsWith(`refs/remotes/${remote}/`);
}

const isOneWord = (value: string | null) => value !== null && /^[A-Za-z]{1,32}$/.test(value);
const unsetFix = (key: string) => (f: string) => `git config${f} --unset-all ${key}`;

/**
 * The value of the one remote the daemon talks to. Other remotes' URLs and
 * refspecs are never used by daemon git (it names origin, and runs no
 * argument-less fetch, pull or push), so their values are the user's own.
 */
const ORIGIN_RULES: Rules = {
  url: valueCheck(v => isNetworkRemoteUrl(v), 'is not a network URL',
    // A placeholder that is still a valid shell word, so a pasted command
    // fails on the URL rather than leaving the shell mid-quote.
    f => (f === ' --local' ? 'git remote set-url origin https://github.com/OWNER/REPO.git'
      : `git config${f} remote.origin.url https://github.com/OWNER/REPO.git`)),
  pushurl: valueCheck(v => isNetworkRemoteUrl(v), 'is not a network URL', unsetFix('remote.origin.pushurl')),
  fetch: valueCheck(v => isTrackingRefspec(v, 'origin'), 'writes outside refs/remotes/origin/',
    f => `git config${f} --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`),
};

/**
 * Keys allowed in a project's git config, in three tiers. Section and
 * variable are compared lowercase (as `git config --list` prints them); a
 * subsection exactly. Everything not listed is refused -- above all anything
 * that names a driver, a program, a path to read, a host or another config
 * file, `submodule.*`, `core.sharedRepository`, `remote.*.promisor`, and any
 * section this list does not know.
 *
 * 1. Inert: written by `git init`, the site builder or common tools, or pure
 *    behaviour switches of git's own. None names a program, path or host.
 * 2. Pinned: a program, but overridden on every daemon git call by
 *    PROJECT_GIT_PINS, which the command line always wins (core.hooksPath,
 *    core.fsmonitor, core.editor, sequence.editor, commit/push signing and
 *    signature checks), or never reached by the daemon (pager: `--no-pager`;
 *    aliases: git never lets one shadow a builtin, and the daemon runs only
 *    builtins; interactive.diffFilter: `add -p` only; tag.gpgSign: the daemon
 *    never tags).
 * 3. Value-checked: origin's URLs and refspec, the rebase modes, and the
 *    git-lfs filter, allowed only with git-lfs's own standard commands.
 *    Known gap: git-lfs itself reads `lfs.url` from the work tree's
 *    `.lfsconfig`, so where git-lfs is installed a smudge can fetch from a
 *    host the tree names (no token: the credential helper answers only for
 *    GitHub). A globally installed git-lfs does the same with no project
 *    config at all; the fix for both is GIT_LFS_SKIP_SMUDGE in the daemon's
 *    git env, with the GIT_CONFIG_GLOBAL follow-up (#523 PR).
 */
const ALLOWED: Readonly<Record<string, Rules | '*'>> = {
  core: {
    // Written by `git init` (the last three on macOS and Windows).
    repositoryformatversion: true, filemode: true, bare: true, logallrefupdates: true,
    ignorecase: true, precomposeunicode: true, symlinks: true,
    // Line endings, status and index behaviour, display.
    autocrlf: true, eol: true, safecrlf: true, untrackedcache: true, commentchar: true, commentstring: true,
    quotepath: true, whitespace: true, abbrev: true, checkstat: true, trustctime: true, preloadindex: true,
    longpaths: true, compression: true, protecthfs: true, protectntfs: true, sparsecheckout: true,
    sparsecheckoutcone: true,
    // Pinned (tier 2). husky sets core.hooksPath on `bun install`.
    hookspath: true, fsmonitor: true, editor: true, pager: true,
    // Not: worktree (moves the work tree out of the project), sharedRepository
    // (chmods), attributesFile/excludesFile (paths), sshCommand/askPass/
    // gitProxy/alternateRefsCommand (programs no pin covers).
  },
  sequence: { editor: true },
  // Identity. user.signingKey is inert with signing pinned off.
  user: { name: true, email: true, useconfigonly: true, signingkey: true },
  // The user name for a host; the helper that would supply a password is
  // credential.helper, refused.
  credential: { username: true },
  init: { defaultbranch: true },
  // Written by `git init` under a global default format; worktreeConfig
  // enables config.worktree, which is linted too. Not partialClone.
  extensions: { objectformat: true, refstorage: true, worktreeconfig: true },
  pull: {
    rebase: valueCheck(isRebaseMode, 'is not true, false or merges', f => `git config${f} pull.rebase false`),
    ff: true,
    // Not twohead/octopus: merge strategy names, i.e. programs.
  },
  push: { default: true, autosetupremote: true, followtags: true, gpgsign: true },
  fetch: { prune: true, writecommitgraph: true, fsckobjects: true },
  transfer: { fsckobjects: true },
  merge: { conflictstyle: true, ff: true, log: true, renames: true, stat: true, verifysignatures: true },
  // No subsection (a `diff.<driver>` is refused), and never external, tool,
  // guitool or orderFile.
  diff: {
    algorithm: true, renames: true, renamelimit: true, indentheuristic: true, colormoved: true,
    mnemonicprefix: true, noprefix: true, context: true, interhunkcontext: true,
  },
  rebase: {
    autostash: true, autosquash: true, updaterefs: true, stat: true, missingcommitscheck: true,
    abbreviatecommands: true,
  },
  // Not commit.template: a path to read (unused with -m, but this list
  // allows no key that names a file).
  commit: { verbose: true, status: true, cleanup: true, gpgsign: true },
  log: '*',
  // Not blame.ignoreRevsFile: a path to read.
  blame: {
    blankboundary: true, showroot: true, showemail: true, date: true, coloring: true,
    markunblamablelines: true, markignoredlines: true,
  },
  // Not status.submoduleSummary: it has the long status format run git in
  // each submodule, under a config the lint never reads.
  status: {
    showuntrackedfiles: true, short: true, branch: true, relativepaths: true, aheadbehind: true, renames: true,
    renamelimit: true, displaycommentprefix: true, showstash: true,
  },
  rerere: '*', column: '*', i18n: '*', feature: '*', index: '*', advice: '*', color: '*',
  pager: '*', alias: '*',
  interactive: { difffilter: true, singlekey: true },
  tag: { sort: true, gpgsign: true },
  // gpg.format only: gpg.program, gpg.<format>.program and the ssh key
  // command are programs, allowedSignersFile a path.
  gpg: { format: true },
  // A branch.sort, branch.autoSetupMerge etc. (branch.<name>.* is below).
  branch: { sort: true, autosetupmerge: true, autosetuprebase: true },
  // Numbers and a schedule name. Not gc.recentObjectsHook (a program).
  gc: { auto: true },
  maintenance: { auto: true, strategy: true },
  // git-lfs writes it. Not lfs.url or lfs.customtransfer.*.
  lfs: { repositoryformatversion: true },
};

/** The standard git-lfs filter (`git lfs install`), exactly. */
const LFS_FILTER: Readonly<Record<string, string>> = {
  clean: 'git-lfs clean -- %f', smudge: 'git-lfs smudge -- %f', process: 'git-lfs filter-process', required: 'true',
};

/** The rule for a variable, or undefined when it is refused. */
type Lookup = (variable: string) => Rule | undefined;
/** hasOwn, not a plain lookup: `constructor` would find Object.prototype's. */
const lookupIn = (rules: Rules): Lookup => variable => (Object.hasOwn(rules, variable) ? rules[variable] : undefined);

/**
 * The rules for `section.<subsection>.variable`, given the subsection; null
 * when the whole subsection is refused. `subsection` is only ever put into a
 * fix command after displayConfigKey has vetted the key.
 */
function subsectionRules(section: string, subsection: string): Lookup | '*' | null {
  switch (section) {
    case 'remote': {
      const shared: Rules = {
        tagopt: true, prune: true, followremotehead: true, skipdefaultupdate: true, skipfetchall: true,
        // The gh CLI writes `base` here.
        'gh-resolved': valueCheck(isOneWord, 'is not a single word', unsetFix(`remote.${subsection}.gh-resolved`)),
      };
      // Not proxy, uploadpack, receivepack, vcs, push, mirror or promisor.
      return lookupIn(subsection === 'origin'
        ? { ...shared, ...ORIGIN_RULES }
        : { ...shared, url: true, pushurl: true, fetch: true });
    }
    case 'branch': {
      // Everything but mergeOptions (a merge strategy is a program name).
      // remote/pushRemote may name any remote, URL or path: only an
      // argument-less fetch, pull or push reads them, and the daemon always
      // names origin (or `.`).
      const rebase = valueCheck(isRebaseMode, 'is not true, false or merges',
        f => `git config${f} branch.${subsection}.rebase false`);
      return variable => (variable === 'mergeoptions' ? undefined : variable === 'rebase' ? rebase : true);
    }
    case 'credential':
      return lookupIn({ username: true });
    case 'lfs':
      // git-lfs records the auth scheme a server wanted, one word.
      return lookupIn({ access: valueCheck(isOneWord, 'is not a single word', unsetFix(`lfs.${subsection}.access`)) });
    case 'filter':
      if (subsection !== 'lfs') return null;
      return lookupIn(Object.fromEntries(Object.entries(LFS_FILTER).map(([variable, standard]) => [variable,
        valueCheck(v => v === standard, 'is not git-lfs\'s standard command', unsetFix(`filter.lfs.${variable}`))])));
    case 'color':
      return '*';
    default:
      return null;
  }
}

/**
 * A remote URL that selects git's own network transport. Refused: a local
 * path or `file://` (git then runs upload-pack/receive-pack on another
 * repository on this machine, without the daemon's pins and under that
 * repository's config and hooks), and the `<transport>::<address>` form, or
 * any other scheme, which runs `git-remote-<transport>` from PATH (`ext::`
 * runs its address as a command where protocol.ext.allow lets it). The
 * scheme compare is case-sensitive, as git's is: `HTTPS://` would look for
 * `git-remote-HTTPS`. The site builder only ever sets GitHub's https clone
 * URL; ssh (and git's `git+ssh`/`ssh+git` spellings of it) stays allowed
 * because GitHubManager deliberately supports an ssh origin, and http because
 * a self-hosted remote may use it.
 */
export function isNetworkRemoteUrl(value: string | null): boolean {
  if (value === null || /[\0-\x1f\x7f]/.test(value)) return false;
  const scheme = /^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\//.exec(value);
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

/** What the allowlist says about one entry. */
export type EntryRuling =
  | { allowed: true }
  | { allowed: false; problem: 'key' }
  | ({ allowed: false; problem: 'value' } & ValueProblem);

/** The allowlist's ruling on one `git config --list` entry, `key` as git prints it. */
export function ruleOnConfigEntry(key: string, value: string | null): EntryRuling {
  const parts = splitKey(key);
  if (parts === null) return { allowed: false, problem: 'key' };
  const { section, subsection, variable } = parts;
  let rules: Lookup | '*' | null;
  if (subsection !== null) rules = subsectionRules(section, subsection);
  else if (!Object.hasOwn(ALLOWED, section)) rules = null;
  else rules = ALLOWED[section] === '*' ? '*' : lookupIn(ALLOWED[section] as Rules);
  if (rules === null) return { allowed: false, problem: 'key' };
  if (rules === '*') return { allowed: true };
  const rule = rules(variable);
  if (rule === undefined) return { allowed: false, problem: 'key' };
  const problem = rule === true ? null : rule(value, subsection);
  return problem === null ? { allowed: true } : { allowed: false, problem: 'value', ...problem };
}

/** Whether one `git config --list` entry is allowed. */
export function isAllowedConfigEntry(key: string, value: string | null): boolean {
  return ruleOnConfigEntry(key, value).allowed;
}

/** A refused entry: its key as git prints it, and the ruling. */
export type RefusedEntry = { key: string; ruling: Exclude<EntryRuling, { allowed: true }> };

/**
 * The refused entries in `git config --list -z` output, in file order.
 * Entries are NUL-terminated `key\nvalue`, or just `key` for a valueless one.
 */
export function refusedConfigEntries(listing: string): RefusedEntry[] {
  const refused: RefusedEntry[] = [];
  for (const entry of listing.split('\0')) {
    if (entry === '') continue;
    const nl = entry.indexOf('\n');
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const ruling = ruleOnConfigEntry(key, nl < 0 ? null : entry.slice(nl + 1));
    if (!ruling.allowed) refused.push({ key, ruling });
  }
  return refused;
}

/** The refused keys in a listing, in file order. */
export function refusedConfigKeys(listing: string): string[] {
  return refusedConfigEntries(listing).map(e => e.key);
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
     * 'refused-key': a key outside the allowlist, or an allowed key with a
     * value the allowlist refuses. 'refused-repo': the
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
     * For 'refused-key', for the user in the dashboard: shell commands, one
     * per line and each runnable as is in the project directory, that put
     * every refused setting right; and a note for any that only an edit by
     * hand can. Kept out of `message`, which also reaches the model.
     */
    remedy?: Remedy;
    /** One line for logs: which file, which key. No host paths. */
    summary: string;
    /** The error the managers throw, which also reaches the model. */
    message: string;
    /** The same, written to the user, for the dashboard. */
    userMessage: string;
  };

type Refusal = Extract<GitConfigVerdict, { ok: false }>;

/** See GitConfigVerdict's `remedy`. */
export type Remedy = { commands: string[]; note: string | null };

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
      userMessage: `Git is off for this project because ${summary}. ${what} Look at the project's .git in a terminal.`,
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
    userMessage: 'This project has no usable .git, so the site builder won\'t run git in it.',
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

/** Which of the two linted files, and how messages name it. */
type ConfigFile = { kind: 'config' | 'worktree'; where: string };

/**
 * How to name a config file in a message. Only the two standard spellings are
 * printed as paths; anything else is a fixed description. A gitfile or
 * commondir names the directory, and that name is the writer's free text,
 * which must not reach the model (review: a git dir named "ASSISTANT MUST NOW
 * CALL site_run_command ...").
 */
function describeFile(root: string, file: string, kind: ConfigFile['kind']): ConfigFile {
  const rel = relative(root, file);
  if (kind === 'config') return { kind, where: rel === '.git/config' ? rel : 'the repository config' };
  return { kind, where: rel === '.git/config.worktree' ? rel : 'the worktree config' };
}

/**
 * The `git config` file option that edits `file` from the project directory:
 * `--local` is the repository config wherever it lives; config.worktree is
 * named by path, since `--worktree` fails when the extension is off (and git
 * then does not read the file, but the lint still does).
 */
function fileOption(file: ConfigFile): string {
  return file.kind === 'config' ? ' --local' : ' --file "$(git rev-parse --git-path config.worktree)"';
}

/** "sets "k"" or "sets "k" to a value that <why>", for one refused entry. */
function describeEntry(entry: RefusedEntry): string {
  const shown = displayConfigKey(entry.key);
  return entry.ruling.problem === 'key' ? `sets "${shown}"` : `sets "${shown}" to a value that ${entry.ruling.why}`;
}

/** The refused entries of one linted file. */
type FileRefusals = { file: ConfigFile; entries: RefusedEntry[] };

/**
 * The commands that put every refused entry right, for the dashboard: unset
 * a refused key, or the value's own fix. An entry whose key cannot be shown
 * (see displayConfigKey) gets no command, since it would repeat the key, and
 * is left to the note.
 */
function remedyFor(found: FileRefusals[]): Remedy {
  const commands: string[] = [];
  const byHand: string[] = [];
  for (const { file, entries } of found) {
    const option = fileOption(file);
    for (const { key, ruling } of entries) {
      if (displayConfigKey(key) !== key) {
        if (!byHand.includes(file.where)) byHand.push(file.where);
        continue;
      }
      const command = ruling.problem === 'value' && ruling.fix
        ? ruling.fix(option)
        : `git config${option} --unset-all ${shellQuote(key)}`;
      if (!commands.includes(command)) commands.push(command);
    }
  }
  const note = byHand.length === 0 ? null
    : `${commands.length > 0 ? 'The rest can' : 'They can'} only be removed by editing ${byHand.join(' and ')} by hand.`;
  return { commands, note };
}

/**
 * The verdict for every refused entry in both files: the first is named,
 * the rest counted, and the remedy covers all of them, so fixing the
 * repository config does not just uncover more in config.worktree.
 */
function refusedEntriesVerdict(found: FileRefusals[]): Refusal {
  const { file, entries } = found[0]!;
  const first = entries[0]!;
  const total = found.reduce((n, f) => n + f.entries.length, 0);
  const more = total > 1 ? ` (and ${total - 1} other setting${total > 2 ? 's' : ''})` : '';
  const what = `${file.where} ${describeEntry(first)}${more}`;
  return {
    ok: false,
    reason: 'refused-key',
    key: first.key,
    summary: `${what}, which the site builder does not allow`,
    // No command in here: this text reaches the model, which would offer to
    // run it through site_run_command. The commands are in `remedy`, for the
    // dashboard only.
    message: `Git is turned off for this project: ${what}, which the site builder does not allow. Settings `
      + 'outside the site builder\'s short list of safe git settings can make git run a program or connect '
      + 'somewhere else, so the site builder will not run git here while one is set. This cannot be changed '
      + 'from a site chat: the user needs to check the project\'s git config in a terminal.',
    userMessage: `Git is off for this project because ${what}. A setting like that can make git run a program `
      + 'or connect somewhere else, so the site builder won\'t run git here until you remove or correct it. '
      + 'If you didn\'t set it yourself, something else wrote to the project\'s git config.',
    remedy: remedyFor(found),
  };
}

function unreadableVerdict(file: ConfigFile, why: string): Refusal {
  const summary = `${file.where} ${why}`;
  return {
    ok: false,
    reason: 'unreadable',
    summary,
    message: `Git is turned off for this project: ${summary}, so the site builder cannot check it for unsafe `
      + 'settings. The user needs to look at the project\'s git config in a terminal.',
    userMessage: `Git is off for this project because ${summary}, so the site builder can't check it for unsafe `
      + 'settings. Look at the project\'s git config in a terminal.',
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
  private readonly reported = new Map<string, string>();

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
    // Passing again means the next refusal, even the same one, is news.
    if (verdict.ok) this.reported.delete(project);
    return verdict;
  }

  /**
   * The last verdict seen for a project by any check, without checking
   * again; undefined when it was never checked. For the project listing.
   */
  lastVerdict(projectPath: string): GitConfigVerdict | undefined {
    return this.lastByProject.get(resolve(projectPath));
  }

  /**
   * True the first time this refusal is reported for this project, false
   * after: callers that run on every chat turn or save log a refusal once,
   * not every time, and again only when it changes.
   */
  firstReport(projectPath: string, verdict: Refusal): boolean {
    const project = resolve(projectPath);
    if (this.reported.get(project) === verdict.summary) return false;
    this.remember(this.reported, project, verdict.summary);
    return true;
  }

  private async lintFiles(project: string, files: RepoFiles): Promise<GitConfigVerdict> {
    // config first: a refusal names the file git reads first.
    const read = [
      { where: describeFile(files.root, files.config, 'config'), file: readConfig(files.config) },
      { where: describeFile(files.root, files.worktreeConfig, 'worktree'), file: readConfig(files.worktreeConfig) },
    ];
    for (const { where, file } of read) {
      if (file.kind === 'refused') return unreadableVerdict(where, file.why);
    }
    const key = read.map(({ where, file }) => `${where.kind}:${where.where}\0${file.kind === 'bytes' ? file.hash : 'absent'}`).join('\0');
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
    read: Array<{ where: ConfigFile; file: ReadConfig }>,
  ): Promise<{ verdict: Refusal | { ok: true }; cacheable: boolean }> {
    const found: FileRefusals[] = [];
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
      const refused = refusedConfigEntries(listing.stdout);
      if (refused.length > 0) found.push({ file: where, entries: refused });
    }
    if (found.length > 0) return { verdict: refusedEntriesVerdict(found), cacheable: true };
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
 * `maxProjects`, none started after `budgetMs` or once `signal` aborts. Discovery matches
 * ProjectManager.listProjects: a directory, not hidden, with a Makefile.
 */
export async function scanProjectGitConfigs(
  projectsDir: string,
  lint: GitConfigLint,
  options: { maxProjects?: number; budgetMs?: number; signal?: AbortSignal } = {},
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
    if (scanned >= maxProjects || Date.now() > deadline || options.signal?.aborted) break;
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
