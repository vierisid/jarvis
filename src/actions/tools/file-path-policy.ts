/**
 * File Path Policy -- what the generic file tools may touch, and at what
 * Authority action (#522).
 *
 * `read_file`, `write_file` and `list_directory` resolve a model-chosen path
 * against the site-chat default cwd or the home dir, with no containment.
 * Two consequences follow, and this module answers both.
 *
 * 1. Site projects' git internals are refused outright, exactly as the site
 *    file tools refuse them (#516, #517): the daemon runs git in those repos
 *    unattended, so their config is code it will run and a transport it will
 *    push the GitHub PAT through, and the reflogs of projects pulled before
 *    #511 still hold that PAT. See siteGitRefusal.
 *
 * 2. Everywhere else a write is a write, EXCEPT to a path that something runs
 *    as code without being asked: a shell startup file, git config or hooks,
 *    an autostart entry, a systemd or launchd unit, a crontab, SSH config, an
 *    editor config, a program on the PATH, Jarvis's own code and keys.
 *    Writing one of those is running a command later, so write_file's
 *    authorityGate rates it `execute_command` instead of `write_data`. It is
 *    not refused: a person can still approve an edit to their own .bashrc,
 *    but it is gated as what it is. See execOnWrite.
 *
 * What this does NOT close: the site builder turns project writes into
 * execution by design (`make dev` runs the project's Makefile, vite reloads
 * its config), so a write_data edit of a site project's build files is still
 * code the daemon runs. That is the site builder's contract, not this one's.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isGitDirName, isWithin, isWithinCI, stripHfsIgnorable } from '../../util/path.ts';
import { exists, isDir, isGitDirectory, landingPath, linkedGitDirs } from '../../sites/git-dir.ts';
import { getDefaultCwd, isNoLocalTools } from './local-tools-guard.ts';

// ── Daemon-registered roots ──────────────────────────────────────────────────

let _siteProjectsDir: string | null = null;
let _dataDirs: string[] = [];
let _codeRoots: string[] = [];
let _secretsDirs: string[] = [];
let _home: string | null = null;

/**
 * Where site projects live. Registered at daemon boot from the config,
 * whether or not the site builder is enabled or starts: projects created
 * while it was on keep their `.git`, and their pre-#511 reflogs, after it is
 * turned off.
 */
export function setSiteProjectsDir(dir: string | null): void {
  _siteProjectsDir = dir ? resolve(dir) : null;
  linkedCache = null;
}

export function getSiteProjectsDir(): string | null {
  return _siteProjectsDir;
}

/**
 * What the daemon loads from disk. `dataDirs` are its data dirs, where only
 * the code, config and key entries count (DATA_DIR_SENSITIVE); a note or a log
 * there is an ordinary file. `codeRoots` are configured engine, pieces and
 * metadata locations, where everything is code the daemon runs. The site
 * projects dir is carved out of both.
 */
export function setDaemonDataRoots(roots: {
  dataDirs?: Array<string | null | undefined>;
  codeRoots?: Array<string | null | undefined>;
  /**
   * Where the keychain and the workflow key really live: `JARVIS_SECRETS_DIR`
   * or `JARVIS_HOME` can put them outside every data dir, and until #528
   * nothing here knew that. Registered rather than resolved on demand because
   * the canonical resolver (vault/keychain.ts's keychainDir) deliberately
   * THROWS under NODE_ENV=test with neither variable set, and a classifier
   * must never throw because a test forgot an environment variable.
   */
  secretsDirs?: Array<string | null | undefined>;
}): void {
  const clean = (list: Array<string | null | undefined> = []) => [...new Set(list.filter((r): r is string => !!r).map((r) => resolve(r)))];
  _dataDirs = clean(roots.dataDirs);
  _codeRoots = clean(roots.codeRoots);
  _secretsDirs = clean(roots.secretsDirs);
  secretInodeCache = null;
}

/**
 * The home dir the policy judges against. A seam for tests only: Bun's
 * homedir() ignores a HOME changed at runtime, and a test must never classify
 * (or write) against the developer's real home.
 */
export function setPolicyHome(dir: string | null): void {
  _home = dir ? resolve(dir) : null;
  homeTargetsCache = null;
  secretInodeCache = null;
}

export function policyHome(): string {
  return _home ?? homedir();
}

/** Every base a relative path can be resolved against by whoever serves it: the site cwd, home, and `/` (a sidecar's cwd under launchd). */
export function relativeBases(): string[] {
  const home = policyHome();
  return [...new Set([getDefaultCwd() || home, home, '/'])];
}

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Where `path` (relative to `base`) lands when opened: the kernel's order,
 * dangling links followed. See landingPath's `follow` mode in
 * sites/git-dir.ts, shared with the site file tools.
 */
export function resolveReal(path: string, base = '/'): string {
  return landingPath(path, { dangling: 'follow', base });
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether `real` is, or is inside, a git directory, looking no higher than `stopAt` (exclusive). */
function insideGitDirectory(real: string, stopAt?: string): boolean {
  for (let dir = real; ; dir = dirname(dir)) {
    if (stopAt !== undefined && (!isWithinCI(dir, stopAt) || sameCI(dir, stopAt))) return false;
    if (isGitDirectory(dir)) return true;
    if (dirname(dir) === dir) return false;
  }
}

function sameCI(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function hasGitComponent(rel: string): boolean {
  return rel.split(/[\\/]/).some(isGitDirName);
}

// ── (1) Site project git internals: refused ──────────────────────────────────

/** Roots under which the daemon runs git on its own: the projects dir and the current site chat's project. */
function siteRoots(): string[] {
  const roots = [_siteProjectsDir, getDefaultCwd()].filter((r): r is string => !!r).map((r) => resolve(r));
  return [...new Set(roots)];
}

/**
 * The git dirs a project's root `.git` names -- sites/git-dir.ts's
 * linkedGitDirs, shared with the site file tools -- with the options these
 * tools need, since they have no containment of their own:
 * - targets OUTSIDE the project are kept, except one containing the project
 *   or the home dir (a `.git` pointing at `/` would make every path a git
 *   path);
 * - a real `.git` directory is included by its real path, for a project that
 *   is itself a symlink into the projects dir;
 * - targets resolve as git resolves them, from where the `.git` really is:
 *   `projectRoot` here is the path as listed, which for a symlinked project
 *   goes through the link;
 * - a gitfile is read as far as git reads one (1 MiB).
 */
function linkedGitDirsOf(projectRoot: string): string[] {
  return linkedGitDirs(projectRoot, {
    keepOutside: true, includeDotGitDir: true, kernelOrder: true, maxRead: 1024 * 1024, home: policyHome(),
  });
}

/** How long a scan of the projects' linked git dirs is trusted. */
const LINKED_TTL_MS = 2_000;
let linkedCache: { key: string; at: number; dirs: string[] } | null = null;

/**
 * The linked git dirs of every site project: the site chat's, and each
 * directory in the projects dir, symlinked project dirs included (a project
 * reached through a link has the same `.git`). All of them, not just the one
 * a path is under, because a linked git dir can be anywhere.
 *
 * Cached on the projects dir's mtime and the cwd, for LINKED_TTL_MS: a new or
 * removed project changes the mtime at once. A `.git` rewritten in place into
 * a gitfile does not, which is the staleness the TTL bounds; rewriting it
 * takes git or a shell in the project, which is already execution.
 */
function allLinkedGitDirs(): string[] {
  const cwd = getDefaultCwd();
  let mtime = 0;
  if (_siteProjectsDir) {
    try { mtime = statSync(_siteProjectsDir).mtimeMs; } catch { /* no projects dir yet */ }
  }
  const key = `${_siteProjectsDir}\0${mtime}\0${cwd}\0${_home}`;
  const now = Date.now();
  if (linkedCache && linkedCache.key === key && now - linkedCache.at < LINKED_TTL_MS) return linkedCache.dirs;
  const projects = new Set<string>();
  if (cwd) projects.add(resolve(cwd));
  if (_siteProjectsDir) {
    try {
      for (const entry of readdirSync(_siteProjectsDir, { withFileTypes: true })) {
        const path = join(_siteProjectsDir, entry.name);
        if (entry.isDirectory() || (entry.isSymbolicLink() && isDir(path))) projects.add(path);
      }
    } catch { /* no projects dir yet */ }
  }
  const dirs = [...projects].flatMap(linkedGitDirsOf);
  linkedCache = { key, at: now, dirs };
  return dirs;
}

/**
 * The refusal message when `requested` -- as spelled, or where it really
 * lands -- is inside a git directory of a site project, else null.
 *
 * A relative path is judged against every base in `bases`; an absolute one
 * once. For each, three paths: the lexical one (what this machine's tools
 * open, after path.resolve normalizes `..`), the kernel-resolved raw spelling
 * (what a sidecar handed the raw string opens: symlinks before `..`), and the
 * real path of the lexical one. Any of them refuses when, relative to a site
 * root, a component is a git dir name in any form isGitDirName knows, or it
 * is inside a directory git would treat as a git dir; or when it is inside a
 * git dir a project's `.git` points at.
 *
 * Callers run this BEFORE routing a call to a sidecar, with `/`, home and the
 * cwd as bases: a sidecar on the brain's own machine opens the brain's files,
 * nothing on its side knows about site projects, and under launchd its cwd is
 * `/`. A sidecar started by hand from some other dir resolves a relative path
 * against a cwd the brain does not know, so the tools also refuse a routed
 * relative path with a git dir component outright (routedGitRefusal). For a
 * genuinely remote sidecar the cost is refusing a path that happens to match
 * a project's git dir spelling there.
 */
export function siteGitRefusal(requested: string, bases: string[]): string | null {
  const roots = siteRoots();
  if (roots.length === 0) return null;
  const candidates = new Set<string>();
  for (const base of isAbsolute(requested) ? ['/'] : bases) {
    const lexical = resolve(base, requested);
    candidates.add(lexical);
    candidates.add(resolveReal(requested, base));
    candidates.add(resolveReal(lexical));
  }
  const refusal = `Error: Access denied: "${requested}" is inside a site project's git directory. The file tools cannot `
    + 'read, write or list git internals there; use site_git_commit and site_github_push for version control.';
  const realRoots = roots.map((root) => [root, realOrSelf(root)] as const);
  for (const path of candidates) {
    for (const [root, realRoot] of realRoots) {
      for (const r of new Set([root, realRoot])) {
        if (!isWithinCI(path, r)) continue;
        if (hasGitComponent(relative(r.toLowerCase(), path.toLowerCase())) || insideGitDirectory(path, r)) return refusal;
      }
    }
  }
  // A git dir a project's `.git` points at: maybe not created yet, maybe
  // outside the projects dir, and named nothing like `.git`.
  const linked = allLinkedGitDirs();
  for (const path of candidates) if (linked.some((dir) => isWithinCI(path, dir))) return refusal;
  return null;
}

/**
 * Whether a spelled absolute path means something only relative to the
 * process that opens it: `/proc/self/cwd/...` is the sidecar's cwd,
 * `/proc/self/root` its root, `/dev/fd/N` its descriptors. Judged here they
 * would mean the BRAIN's. Any `/proc/...` with a `..` in it counts too: the
 * kernel ships symlinks into `self` (`/proc/net -> self/net`), so
 * `/proc/net/../cwd` is the caller's cwd, and a lexical normalize would call
 * it `/proc/cwd`. A symlink PLANTED elsewhere to point at /proc/self is not
 * caught -- resolving it here gives the brain's own cwd -- but planting one
 * already takes a shell.
 */
function isProcessRelative(spelled: string): boolean {
  const parts = spelled.toLowerCase().split('/').filter((c) => c !== '' && c !== '.');
  if (parts[0] === 'dev' && parts[1] === 'fd') return true;
  if (parts[0] !== 'proc') return false;
  return /^(?:self|thread-self|net|\d+)$/.test(parts[1] ?? '') || parts.includes('..');
}

/**
 * The refusal for a call routed to a sidecar with a path the brain cannot
 * judge, else null:
 *
 * - a process-relative path (see isProcessRelative), always, whether or not
 *   it names a git dir: `/proc/self/cwd/.jarvis/projects/app/.git` sent to a
 *   sidecar whose cwd is home is a site project's git dir that
 *   siteGitRefusal, resolving `/proc/self` here, would judge as the brain's;
 * - while site projects exist on this host, a path that names a git dir and
 *   that the brain cannot place: a RELATIVE one (the sidecar resolves it
 *   against a cwd the brain does not know), a drive-letter one (`C:/...`,
 *   which a POSIX sidecar opens under its cwd), and a UNC or device one
 *   (`\\wsl$\...`, `\\?\C:\...`, `//host/...`), which on a Windows sidecar
 *   can name this host's files by another route.
 *
 * An ordinary absolute POSIX path, which siteGitRefusal can judge, still works.
 */
export function routedGitRefusal(requested: string): string | null {
  const spelled = stripHfsIgnorable(requested).replace(/\\/g, '/');
  // As spelled and normalized (`/./proc/self`, `/x/../proc/self`).
  if (isAbsolute(spelled) && [spelled, posix.normalize(spelled)].some(isProcessRelative)) {
    return `Error: Access denied: "${requested}" is a process-relative path; on a sidecar it names that process's own `
      + 'files, which the brain cannot judge. Use a plain absolute path.';
  }
  const judgeable = isAbsolute(spelled) && !/^[a-z]:\//i.test(spelled) && !/^\/\/[^/]/.test(spelled);
  if (!_siteProjectsDir || judgeable) return null;
  if (!hasGitComponent(spelled)) return null;
  return `Error: Access denied: "${requested}" is a relative, drive-letter or network path into a git directory, routed to `
    + 'a sidecar: the brain cannot tell where it lands. Use a plain absolute path.';
}

// ── (2) Exec-on-write paths: rated execute_command ───────────────────────────

// Each label completes "Write a file that can run as code (...)" on a card.
const SHELL = 'a shell startup file';
const GIT = 'git configuration, hooks or a git directory';
const AUTOSTART = 'an autostart, session or launcher entry';
const SYSTEMD = 'a systemd unit or config';
const LAUNCHD = 'a launchd job';
const CRON = 'a cron table';
const SSH = 'SSH configuration or keys';
const TOOL = 'a config, plugin or module a tool or editor runs';
const EXECUTABLE = 'a program something runs by name';
const JARVIS = "Jarvis's own code, configuration or keys";
const SHORT_NAME = 'a Windows 8.3 short name, which may hide where it lands';

/**
 * Files that run as code by NAME, wherever they sit. Matched on the basename,
 * lower-cased, so they also match on a sidecar whose home dir the brain does
 * not know, and on a case-insensitive filesystem. A false positive costs an
 * approval card for writing a file called `.bashrc` somewhere odd.
 */
const EXEC_FILE_NAMES: ReadonlyMap<string, string> = new Map([
  ...['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.bash_aliases', '.profile', '.zshrc', '.zshenv',
    '.zprofile', '.zlogin', '.zlogout', '.kshrc', '.mkshrc', '.cshrc', '.tcshrc', '.login', '.logout', '.xprofile',
    '.xinitrc', '.xsession', '.xsessionrc', '.pam_environment',
    // direnv runs `.envrc` on every cd into the directory, and a daemon started
    // from such a shell inherits what it exported; the `.local` files are what
    // prezto, grml and most dotfile managers source from the main rc.
    '.envrc', '.zshrc.local', '.bashrc.local', '.profile.local', '.zshenv.local',
  ].map((n) => [n, SHELL] as const),
  // Hook managers read these to decide what runs on commit.
  ...['.gitconfig', '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml'].map((n) => [n, GIT] as const),
  // Each of these can name a command the tool runs on its own: vim/emacs
  // configs are programs; tmux run-shell, screen exec, hg hooks; npm
  // script-shell / node-options; yarnPath; bun preload (global or a
  // project's bunfig.toml, which every `bun run` there loads); debugger and
  // REPL init files; Python's site-customisation hooks run on every start.
  ...['.vimrc', '.gvimrc', '.exrc', '.nvimrc', '.emacs', '.emacs.el', '.tmux.conf', '.screenrc', '.hgrc', '.npmrc',
    '.yarnrc', '.yarnrc.yml', '.bunfig.toml', 'bunfig.toml', '.gdbinit', '.lldbinit', '.psqlrc', '.irbrc', '.pryrc',
    '.rprofile', '.sqliterc', '.mavenrc', 'init.gradle', 'direnvrc', 'sitecustomize.py', 'usercustomize.py',
    '.wezterm.lua', '.mailcap', '.xbindkeysrc'].map((n) => [n, TOOL] as const),
]);

/**
 * Directories whose contents run as code, as `/segment/` substrings of a
 * normalized path. `anywhere` ones are home-relative, so they match under any
 * home (and on a sidecar); the rest are system paths matched from the root.
 */
const EXEC_DIRS: ReadonlyArray<{ seg: string; label: string; anywhere: boolean }> = [
  ...['/.config/fish/', '/.config/environment.d/', '/.bashrc.d/', '/.oh-my-zsh/custom/']
    .map((seg) => ({ seg, label: SHELL, anywhere: true })),
  ...['/etc/profile.d/', '/etc/zsh/'].map((seg) => ({ seg, label: SHELL, anywhere: false })),
  ...['/.config/git/', '/.husky/'].map((seg) => ({ seg, label: GIT, anywhere: true })),
  // Session and window-manager configs run their exec lines at login (Hyprland
  // on every save), and a .desktop or D-Bus service file shadows what a
  // launcher or a bus activation starts.
  ...['/.config/autostart/', '/.config/autostart-scripts/', '/start menu/programs/startup/', '/.config/i3/', '/.i3/',
    '/.config/sway/', '/.config/hypr/', '/.config/plasma-workspace/', '/.config/openbox/', '/.config/lxsession/',
    '/.local/share/applications/', '/.local/share/dbus-1/', '/.config/awesome/', '/.config/sxhkd/', '/.config/bspwm/',
    '/.config/qtile/', '/.local/share/kio/', '/.local/share/konsole/'].map((seg) => ({ seg, label: AUTOSTART, anywhere: true })),
  { seg: '/etc/xdg/autostart/', label: AUTOSTART, anywhere: false },
  ...['/.config/systemd/', '/.local/share/systemd/'].map((seg) => ({ seg, label: SYSTEMD, anywhere: true })),
  ...['/etc/systemd/', '/lib/systemd/', '/usr/lib/systemd/'].map((seg) => ({ seg, label: SYSTEMD, anywhere: false })),
  ...['/library/launchagents/', '/library/launchdaemons/'].map((seg) => ({ seg, label: LAUNCHD, anywhere: true })),
  ...['/var/spool/cron/', '/var/spool/at/', '/etc/cron.d/', '/etc/cron.hourly/', '/etc/cron.daily/',
    '/etc/cron.weekly/', '/etc/cron.monthly/'].map((seg) => ({ seg, label: CRON, anywhere: false })),
  { seg: '/.ssh/', label: SSH, anywhere: true },
  // Editors' plugin trees; credential and exec helpers every CLI call may
  // run (gpg pinentry-program, aws credential_process, kubectl exec auth,
  // cargo rustc-wrapper, gradle init scripts); IPython/Jupyter startup code.
  ...['/.vim/', '/.config/nvim/', '/.local/share/nvim/', '/.emacs.d/', '/.config/emacs/', '/.config/direnv/',
    '/.gnupg/', '/.aws/', '/.kube/', '/.cargo/', '/.gradle/init.d/', '/.ipython/', '/.jupyter/', '/.config/mise/']
    .map((seg) => ({ seg, label: TOOL, anywhere: true })),
  // Installed code every import or CLI call loads: Python packages, global
  // node and bun installs, editor extensions and the settings that pick the
  // shell and interpreters; terminal configs that name the shell to start.
  ...['/site-packages/', '/dist-packages/', '/.nvm/', '/.bun/install/global/', '/.npm-global/', '/.vscode/extensions/',
    '/.vscode-server/', '/.cursor/', '/.config/code/user/', '/.config/kitty/', '/.config/alacritty/', '/.config/wezterm/']
    .map((seg) => ({ seg, label: TOOL, anywhere: true })),
];

/** Single system files, matched as whole paths from the root. */
const EXEC_SYSTEM_FILES: ReadonlyMap<string, string> = new Map([
  ['/etc/profile', SHELL], ['/etc/bash.bashrc', SHELL], ['/etc/environment', SHELL], ['/etc/zshenv', SHELL],
  ['/etc/zshrc', SHELL], ['/etc/gitconfig', GIT], ['/etc/crontab', CRON], ['/etc/anacrontab', CRON],
]);

/**
 * What in a Jarvis data dir is code, config or keys: the config files (the
 * system config names engine and pieces dirs), the engine cache and installed
 * pieces, workflow code steps, the web-app templates injected into pages, the
 * local Chrome profile (extensions), the desktop bridge, an install.sh
 * checkout of the daemon, the vault DB and the key files. Everything else
 * there -- logs, content, workflow files, a note -- is ordinary data.
 */
const DATA_DIR_SENSITIVE_ENTRIES = new Set([
  'config.yaml', 'sidecar.yaml', 'cache', 'workflow-codes', 'webapp-templates', 'browser', 'sidecar-keys',
  'google-tokens.json',
  // Installed workflow pieces, which shadow the shared copy; the desktop
  // bridge the daemon launches; install.sh's daemon checkout; the PID
  // `jarvis stop` signals.
  'pieces', 'sidecar', 'daemon', 'jarvis.pid',
]);

function isSensitiveDataEntry(relInDataDir: string): boolean {
  const first = relInDataDir.split(/[\\/]/)[0]!.toLowerCase();
  return DATA_DIR_SENSITIVE_ENTRIES.has(first)
    || /^(?:\.secrets\.|jarvis\.db)/.test(first)
    || /\.(?:key|pem|enc)$/.test(first);
}

/**
 * The daemon's own package root: everything under it is code the daemon runs
 * on its next start. `src/actions/tools` is three levels down; a root without
 * a package.json is not trusted to be one (a bundled build would put
 * import.meta.dir somewhere that resolves to `/`, and every path is under `/`).
 */
const DAEMON_ROOT: string | null = (() => {
  const root = realOrSelf(resolve(import.meta.dir, '..', '..', '..'));
  return exists(join(root, 'package.json')) ? root : null;
})();

/**
 * One spelling per file, for matching: '/'-separated and rooted, lower-cased,
 * HFS-ignorable code points dropped, and each component stripped of what
 * Windows ignores -- an NTFS stream suffix (`.gitconfig::$DATA` writes the
 * file itself) and trailing dots and spaces (`Startup.\x.bat`). `.` and `..`
 * are then collapsed, so `Startup\x\..\a.bat` is `Startup/a.bat`: a posix
 * resolve would not collapse across backslashes, and a sidecar's path is
 * never resolved on the brain.
 */
function normalize(path: string): string {
  const parts = stripHfsIgnorable(path).replace(/\\/g, '/').toLowerCase().split('/')
    .map((c) => (c === '.' || c === '..' ? c : c.replace(/:.*$/, '').replace(/[. ]+$/, '')));
  let s = posix.normalize(`/${parts.join('/')}`);
  // macOS: /etc and /var are /private/etc and /private/var.
  if (s.startsWith('/private/etc/') || s.startsWith('/private/var/')) s = s.slice('/private'.length);
  // macOS: the data volume's firmlinked view of /Users, /private and friends.
  // A firmlink is NOT a symlink, so realpath does not canonicalise it away and
  // /System/Volumes/Data/Users/me/.jarvis/.secrets.key would otherwise miss
  // every data-dir and `/.jarvis/` test. upload-policy.ts already strips this
  // (DARWIN_DATA_VOLUME); doing it here too keeps the two policies agreeing.
  if (s === DARWIN_DATA_VOLUME || s.startsWith(`${DARWIN_DATA_VOLUME}/`)) {
    s = s.slice(DARWIN_DATA_VOLUME.length) || '/';
  }
  return s;
}

/** macOS: the data volume's firmlinked view of the root filesystem, lower-cased for normalize(). */
const DARWIN_DATA_VOLUME = '/system/volumes/data';

/** Name- and place-based classes: they need no filesystem, so they apply to a sidecar's paths as well. */
function classifyByName(path: string): string | null {
  const s = normalize(path);
  const components = s.split('/');
  const base = components[components.length - 1] ?? '';
  if (components.some(isGitDirName)) return GIT;
  // `PROGRA~1`, `STARTU~1`: the brain cannot expand an 8.3 name, so it
  // cannot say what it names. (`git~1` is caught above as `.git`.) Only in a
  // Windows-looking path: `backup~1` is an ordinary name elsewhere.
  if (/^[a-z]:|\\/i.test(path) && components.some((c) => /^[^.~]{1,6}~\d+(?:\.[^.]{0,3})?$/.test(c))) return SHORT_NAME;
  const byName = EXEC_FILE_NAMES.get(base);
  if (byName) return byName;
  // .gitconfig.local and other include files.
  if (base.startsWith('.gitconfig')) return GIT;
  // Microsoft.PowerShell_profile.ps1, profile.ps1, Microsoft.VSCode_profile.ps1.
  if (/(?:^|_)profile\.ps1$/.test(base)) return SHELL;
  // VS Code offers to run a folder's tasks, some on folder open.
  if (s.endsWith('/.vscode/tasks.json')) return TOOL;
  if (/\/\.cargo\/config(?:\.toml)?$/.test(s)) return TOOL;
  // Jarvis's data dir at its default place, the only place a sidecar's path
  // can be judged against.
  const inJarvis = /\/\.jarvis\/(.+)$/.exec(s);
  if (inJarvis && isSensitiveDataEntry(inJarvis[1]!)
    && !(_siteProjectsDir && isWithin(s, normalize(_siteProjectsDir)))) return JARVIS;
  const bySystemFile = EXEC_SYSTEM_FILES.get(s);
  if (bySystemFile) return bySystemFile;
  for (const { seg, label, anywhere } of EXEC_DIRS) {
    if (anywhere ? s.includes(seg) : s.startsWith(seg)) return label;
  }
  return null;
}

/** How long the home and PATH scans are trusted. */
const HOME_TTL_MS = 5_000;
let homeTargetsCache: { key: string; at: number; targets: Array<{ real: string; label: string; dir: boolean }>; binDirs: string[] } | null = null;

/**
 * The real path of each home-relative exec location that exists, so a file
 * reached some other way is still recognised -- dotfile managers make
 * `~/.bashrc` a symlink to `~/dotfiles/bashrc`, and a write to the latter is
 * a write to the former -- plus the real bin dirs. One realpath each, cached
 * for HOME_TTL_MS: about a hundred calls once, not per write.
 */
function homeScan(home: string): { targets: Array<{ real: string; label: string; dir: boolean }>; binDirs: string[] } {
  const key = `${home}\0${process.env.PATH ?? ''}`;
  const now = Date.now();
  if (homeTargetsCache && homeTargetsCache.key === key && now - homeTargetsCache.at < HOME_TTL_MS) return homeTargetsCache;
  const targets: Array<{ real: string; label: string; dir: boolean }> = [];
  const add = (rel: string, label: string, dir: boolean) => {
    try {
      targets.push({ real: realpathSync(join(home, rel)), label, dir });
    } catch { /* not there */ }
  };
  for (const [name, label] of EXEC_FILE_NAMES) add(name, label, false);
  for (const { seg, label, anywhere } of EXEC_DIRS) if (anywhere) add(seg.slice(1, -1), label, true);
  const binDirs = [...new Set([
    ...(process.env.PATH ?? '').split(delimiter).filter((d) => isAbsolute(d)),
    join(home, 'bin'), join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), join(home, 'go', 'bin'),
    '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/usr/sbin', '/bin', '/sbin', '/opt/homebrew/bin',
  ].map(realOrSelf))];
  homeTargetsCache = { key, at: now, targets, binDirs };
  return homeTargetsCache;
}

/**
 * Filesystem-based classes, for a path on this machine. `real` is where the
 * write lands; `named` is the name something would run it by, with only the
 * final component left unresolved (a bin dir entry is usually a symlink).
 */
function classifyOnDisk(real: string, named: string, home: string): string | null {
  const byName = classifyByName(real);
  if (byName) return byName;

  // $XDG_CONFIG_HOME away from ~/.config holds the same files.
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) {
    const realXdg = realOrSelf(xdg);
    if (isWithinCI(real, realXdg)) {
      const asConfig = classifyByName(join(home, '.config', relative(realXdg, real)));
      if (asConfig) return asConfig;
    }
  }

  if (insideGitDirectory(real)) return GIT;
  // A file put straight into a dir with objects/ and refs/ can complete a git
  // dir (HEAD or config last), which the test above only sees afterwards.
  if (isDir(join(dirname(real), 'objects')) && isDir(join(dirname(real), 'refs'))) return GIT;

  const projects = _siteProjectsDir ? realOrSelf(_siteProjectsDir) : null;
  if (projects === null || !isWithinCI(real, projects)) {
    for (const root of _codeRoots) if (isWithinCI(real, realOrSelf(root))) return JARVIS;
    for (const dir of _dataDirs) {
      const realDir = realOrSelf(dir);
      if (isWithinCI(real, realDir) && !sameCI(real, realDir) && isSensitiveDataEntry(relative(realDir, real))) return JARVIS;
    }
  }
  if (DAEMON_ROOT && isWithinCI(real, DAEMON_ROOT)) return JARVIS;

  const scan = homeScan(home);
  for (const target of scan.targets) {
    if (target.dir ? isWithinCI(real, target.real) : sameCI(real, target.real)) return target.label;
  }

  // Overwriting a program keeps its mode (writeFileSync truncates in place),
  // so it installs new code under a name something will run. Only where
  // things are run BY NAME: a bin dir or node_modules/.bin. An executable
  // bit elsewhere means little (vendored sources, CIFS and exFAT mounts
  // report 0755 for everything), and a new file in a bin dir is created
  // without one. The bin dir is the one holding the NAME, not the target:
  // npm and bun make every node_modules/.bin entry a symlink, Homebrew's
  // bin points into the Cellar, pipx and `npm link` shims do the same, and
  // write_file follows the link to rewrite the target in place.
  const inBinDir = [dirname(named), dirname(real)].some((dir) =>
    scan.binDirs.some((b) => sameCI(dir, b)) || /\/node_modules\/\.bin$/i.test(dir));
  if (inBinDir) {
    try {
      const st = statSync(real);
      if (st.isFile() && (st.mode & 0o111) !== 0) return EXECUTABLE;
    } catch { /* new file */ }
  }
  return null;
}

/** `path` is the resolved file that triggered; `lands` is where a write really goes when that differs. */
export type ExecOnWrite = { kind: string; path: string; lands?: string };

/**
 * What kind of exec-on-write location a write to `requested` reaches, and the
 * path that made it one, or null for an ordinary file.
 *
 * Deliberately over-inclusive about WHERE the write lands, because the answer
 * gates a call that may be served by a sidecar or run later than it is judged:
 *
 * - the spelled path is judged by name, so a sidecar-routed write (whose
 *   files the brain cannot stat) is still classified;
 * - a relative path is resolved against the default cwd, home and `/`
 *   (relativeBases): an approval clicked after a site turn resolves against
 *   home, and a sidecar under launchd has `/` as its cwd;
 * - each resolution is judged again where the kernel would land it, on this
 *   machine even when a sidecar is connected, since which machine serves the
 *   call is decided at execute time. Under --no-local-tools no call is served
 *   here, so the disk is not consulted.
 *
 * `requested` is coerced the way the workflow boundary coerces it before
 * dispatch (`String(path)`), so a non-string path is judged as the string it
 * will be written as, not waved through as nothing.
 */
export function execOnWrite(requested: unknown, opts: { bases?: string[]; home?: string } = {}): ExecOnWrite | null {
  if (requested === null || requested === undefined) return null;
  const path = String(requested);
  if (!path) return null;
  const home = opts.home ?? policyHome();
  const bases = isAbsolute(path) ? ['/'] : (opts.bases ?? relativeBases());
  const onDisk = !isNoLocalTools();
  const byName = classifyByName(path);
  if (byName) return { kind: byName, path: resolve(bases[0]!, path) };
  for (const base of bases) {
    const abs = resolve(base, path);
    let kind = classifyByName(abs);
    let lands: string | undefined;
    if (!kind && onDisk) {
      // Where the raw spelling lands (symlinks before `..`, as a sidecar
      // handed the string would open it) and where the normalized one does
      // (what this machine's tools open); usually the same path.
      const named = join(resolveReal(dirname(abs)), basename(abs));
      for (const real of new Set([resolveReal(path, base), resolveReal(abs)])) {
        kind = classifyOnDisk(real, named, home);
        if (kind) {
          if (real !== named && real !== abs) lands = real;
          break;
        }
      }
    }
    if (kind) return { kind, path: abs, ...(lands ? { lands } : {}) };
  }
  return null;
}

/** execOnWrite's kind alone. */
export function execOnWriteClass(requested: unknown, opts: { bases?: string[]; home?: string } = {}): string | null {
  return execOnWrite(requested, opts)?.kind ?? null;
}

// ── (3) The daemon's own secrets: refused on read (#528) ─────────────────────

/**
 * `read_file` is rated `read_data`, the lowest-friction authority there is,
 * and had no containment: a prompt-injected turn that may read files could
 * read the daemon's own credentials. This section refuses that, and only that.
 *
 * Five classes, all judged on RESOLVED paths (see readCandidates) so a
 * symlink, a `/proc/self/root/...` spelling and a relative path all land on
 * the real file:
 *
 * 1. `process-memory` -- a process's environment or memory. `/proc/<pid>/environ`
 *    holds ANTHROPIC_API_KEY, JARVIS_WORKFLOW_ENCRYPTION_KEY and
 *    JARVIS_GITHUB_TOKEN; `cmdline` holds argv. Refused for EVERY pid, not just
 *    the daemon's family: a family test needs the live parent/child set, which
 *    is racy (pids are reused, children re-parented) and per-platform, while
 *    process inspection is `run_command`'s job and `run_command` is already
 *    `execute_command`. The recon files (`maps`, `smaps`, `mountinfo`) go with
 *    them: they are how a reader finds a relocated data dir, and nothing a user
 *    wants from `read_file` needs them.
 * 2. `process-relative` -- `/dev/fd/N`, `/proc/<pid>/fd/N`, `/dev/stdin`. On
 *    Linux these are magic links and resolve to the real file, so they would be
 *    judged as that file; on macOS `/dev/fd` is fdesc, there is no readlink, and
 *    `realpath('/dev/fd/7')` is `/dev/fd/7` -- an unremarkable path that would
 *    be opened, dup'ing whatever the daemon holds open (the vault DB, the
 *    keychain, the key file). A path-based classifier cannot judge these on any
 *    platform, so they are refused on the spelling everywhere.
 *    `isProcessRelative` already refuses them for a call ROUTED to a sidecar
 *    (routedGitRefusal, #522); this closes the local side.
 * 3. `jarvis-key` -- key material in a data or secrets dir, by path AND by
 *    inode (see secretInodes: a hard link IS the file under another name, and no
 *    resolver can see through one -- the daemon itself makes such a link,
 *    `<key>.<pid>.<hex>.tmp`, and leaves it when an unlink fails).
 * 4. `jarvis-config` -- `config.yaml` / `sidecar.yaml`, which hold
 *    `channels.*.bot_token`, `llm.*.api_key`, `client_secret`, `notify_secret`,
 *    `refresh_secret` and `usage_secret` (config/types.ts).
 * 5. `daemon-env-source` -- where the daemon's environment COMES FROM. Closing
 *    `/proc/<pid>/environ` while leaving `~/.config/systemd/user/jarvis.service`
 *    readable would be cosmetic: the unit carries `Environment=` and
 *    `EnvironmentFile=` lines, "the workflow key among them"
 *    (cli/systemd-unit.ts:475), and SELF_HOSTING.md tells people to put them
 *    there. Jarvis's own service definitions are refused outright. A login shell
 *    rc is NOT refused outright -- reading `~/.bashrc` is ordinary use -- it is
 *    returned unless it actually assigns one of the daemon's secret names
 *    (`scanOnly`, resolved by the caller with scanForDaemonSecrets).
 *
 * What this does NOT close, stated so it is not mistaken for closed:
 * `run_command` and workflow code steps still read `/proc/$PPID/environ`, which
 * is the documented way round #536's env scrub, and a core dump still holds the
 * whole environment. Only `prctl(PR_SET_DUMPABLE, 0)` in the daemon closes
 * those, for every caller present and future; it is filed separately.
 */

export type SecretReadKind =
  | 'process-memory' | 'process-relative' | 'jarvis-key' | 'jarvis-config' | 'daemon-env-source';

/** `path` is the candidate that matched. `scanOnly`: refuse only if the bytes assign a daemon secret. */
export type SecretReadHit = { kind: SecretReadKind; path: string; scanOnly?: boolean };

/**
 * Files under `/proc/<pid>/` (or `/proc/<pid>/task/<tid>/`) that are refused.
 * `environ` and `cmdline` are the live leaks; `mem` and `pagemap` are the
 * address space (inert through `read_file` today, which has no offset
 * parameter, but not through a sidecar or a future ranged read); the rest are
 * recon that maps out every relocation this classifier relies on names for.
 */
const PROC_REFUSED_LEAVES = [
  'environ', 'mem', 'cmdline', 'auxv', 'syscall', 'stack', 'pagemap',
  'maps', 'smaps', 'smaps_rollup', 'numa_maps', 'mountinfo', 'mounts', 'mountstats',
] as const;

/**
 * `/proc/<pid|self|thread-self>[/task/<tid>]/<leaf>`, on a normalized path.
 *
 * The unresolved spellings (`self`, `thread-self`) are matched as well as the
 * numeric one, because followPath returns a path AS SPELLED once a component
 * cannot be lstat'ed -- under `hidepid=2`, `subset=pid`, an LSM denial or a
 * container, `resolveReal('/proc/self/environ')` can come back unchanged.
 *
 * Deliberately NOT anchored at the filesystem root: a procfs is routinely
 * visible somewhere else. `/run/host/proc/self/environ` is the flatpak, toolbx
 * and distrobox spelling; a Windows sidecar reaches this host's as
 * `\\wsl$\Ubuntu\proc\self\environ`, which normalizes to
 * `/wsl$/ubuntu/proc/self/environ`; and `C:\proc\...` normalizes to
 * `/c/proc/...`. The cost of matching the tail anywhere is refusing a directory
 * a user named `proc/self/environ`, which nobody has.
 */
const PROC_LEAF_RE = new RegExp(
  `(?:^|/)proc/(?:self|thread-self|\\d+)/(?:task/(?:thread-self|\\d+)/)?(?:${PROC_REFUSED_LEAVES.join('|')})$`,
);

/**
 * Whole-system memory. `/proc/kcore` stats as a REGULAR file of 140 TB, so a
 * read returns its first 100 KB; `vmcore` is the crash image on a kdump kernel.
 */
const WHOLE_MEMORY_RE = /(?:^|\/)(?:proc\/(?:kcore|vmcore)|dev\/(?:mem|kmem|port))$/;

/**
 * A descriptor named as a path: it means whatever the holding process has open,
 * which this classifier cannot know. Matched on the spelling, every platform.
 */
const FD_PATH_RE =
  /(?:^|\/)(?:dev\/fd(?:\/.*)?|dev\/std(?:in|out|err)|proc\/(?:self|thread-self|\d+)\/(?:task\/(?:thread-self|\d+)\/)?(?:fd|fdinfo|map_files)(?:\/.*)?)$/;

/**
 * Key material in a Jarvis data or secrets dir, as a relative entry.
 *
 * Deliberately NARROWER than the write side's DATA_DIR_SENSITIVE_ENTRIES --
 * reading the engine cache or an installed piece is not a credential leak,
 * reading the key is -- and deliberately tolerant of trailing junk, because the
 * daemon's own `persistKeyFile` leaves `workflow-encryption.key.<pid>.<hex>.tmp`
 * as a SECOND HARD LINK to the live key (workflows/db/encryption.ts:355-381),
 * and `removeStaleKeyTemps` skips temps whose pid is still alive -- i.e. the
 * running daemon's own.
 *
 * Matched on the BASENAME of the whole relative entry, not on its first
 * component the way the write side's isSensitiveDataEntry does: the legacy
 * workflow key lives at `cache/workflow-encryption.key`, whose first component
 * is the deliberately-allowed `cache`.
 */
function isSecretReadEntry(relInDir: string): boolean {
  const parts = relInDir.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return false;
  // A whole tree of key material, or the local Chrome profile: the user's
  // cookie jar and `Login Data`. Both sit at the data dir's ROOT
  // (sidecar/enrollment.ts's sidecarKeyPaths, the Chrome profile dir), so they
  // are matched as the first component only: a site project or a log directory
  // with a `browser` folder in it is not key material.
  const first = parts[0]!.toLowerCase();
  if (first === 'sidecar-keys' || first === 'browser') return true;
  const base = parts[parts.length - 1]!.toLowerCase();
  if (/^\.secrets\./.test(base)) return true;
  if (/^jarvis\.db/.test(base)) return true;
  if (base === 'google-tokens.json') return true;
  // `.key`, `.pem`, `.enc`, `.p12`, `.pfx`, each possibly with trailing junk
  // (`.tmp`, `.new`, `.bak`, `.<pid>.<hex>.tmp`).
  return /\.(?:key|pem|enc|p12|pfx)(?:\.[^/\\]*)?$/.test(base);
}

/** Token-bearing Jarvis config, as a relative entry in a data dir. */
function isSecretConfigEntry(relInDir: string): boolean {
  const parts = relInDir.split(/[\\/]/).filter(Boolean);
  if (parts.length !== 1) return false;
  const base = parts[0]!.toLowerCase();
  return base === 'config.yaml' || base === 'sidecar.yaml';
}

/** A file whose only job is to hold the daemon's environment, inside a data dir. */
function isDataDirEnvEntry(relInDir: string): boolean {
  const base = relInDir.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? '';
  return base === 'env' || base === '.env';
}

/**
 * Data and secrets dirs to judge a read against: the registered ones, plus a
 * pure environment fallback for the window before the daemon registers them
 * (and for tests). Never calls vault/keychain.ts's keychainDir, which throws
 * under NODE_ENV=test with neither variable set; the resolution rule is copied,
 * the throw is not.
 */
function secretHoldingDirs(): string[] {
  const env = process.env;
  const fromEnv = [env.JARVIS_SECRETS_DIR, env.JARVIS_HOME]
    .filter((d): d is string => !!d && isAbsolute(d)).map((d) => resolve(d));
  return [...new Set([..._dataDirs, ..._secretsDirs, ...fromEnv, join(policyHome(), '.jarvis')])];
}

/**
 * The site projects dir, but only when carving it out cannot swallow what it is
 * carved out of. A `sites.projects_dir` pointed at the data dir, the secrets dir
 * or the home dir would otherwise un-refuse every key under it -- the same trap
 * upload-policy.ts guards against for its own projects carve-out
 * ("unless it would swallow what it is carved out of"). A misconfigured
 * projects dir then costs a refused project file, not an exposed key.
 */
const CARVE_TTL_MS = 5_000;
let carveCache: { key: string; at: number; dir: string | null } | null = null;

function carveOutProjectsDir(): string | null {
  const env = process.env;
  const key = [_siteProjectsDir, _home, _dataDirs.join(','), _secretsDirs.join(','),
    env.JARVIS_SECRETS_DIR, env.JARVIS_HOME, env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE].join('\0');
  const now = Date.now();
  if (carveCache && carveCache.key === key && now - carveCache.at < CARVE_TTL_MS) return carveCache.dir;
  const dir = computeCarveOutProjectsDir();
  carveCache = { key, at: now, dir };
  return dir;
}

function computeCarveOutProjectsDir(): string | null {
  if (!_siteProjectsDir) return null;
  const projects = realOrSelf(_siteProjectsDir);
  for (const dir of [...secretHoldingDirs(), policyHome()]) {
    for (const form of new Set([resolve(dir), realOrSelf(dir)])) {
      if (isWithinCI(form, projects)) return null;
    }
  }
  return projects;
}

/**
 * An explicit `JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE`, which may point anywhere at
 * all. Resolved rather than required to be absolute, because
 * `resolveKeyFile` (workflows/db/encryption.ts:262) takes the value verbatim
 * with no absoluteness check -- a relative value there is resolved against the
 * daemon's cwd and used as the key, so dropping it here would leave that file
 * unclassified.
 */
function explicitKeyFiles(): string[] {
  const v = process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE;
  return v ? [resolve(v)] : [];
}

/**
 * Every secret-bearing file a data or secrets dir can hold, relative to it.
 *
 * This is the inventory `jarvis export --full` already keeps (cli/backup.ts's
 * SECRET_ENTRIES), plus the vault DB and its sidecar files, the legacy workflow
 * key location, and the token-bearing config -- a test asserts the backup list is
 * a subset, so the two cannot drift. Names only: identity is what is compared.
 */
export const SECRET_INODE_NAMES: readonly string[] = Object.freeze([
  '.secrets.key', '.secrets.enc',
  'workflow-encryption.key', join('cache', 'workflow-encryption.key'),
  'google-tokens.json',
  'jarvis.db', 'jarvis.db-wal', 'jarvis.db-shm', 'jarvis.db-journal',
  join('sidecar-keys', 'private.pem'), join('sidecar-keys', 'public.pem'),
  // Not key files, but they carry tokens, and a hard link to one is as good as
  // a copy: `config.yaml` holds bot_token / api_key / client_secret, and `env`
  // is an EnvironmentFile inside the data dir.
  'config.yaml', 'sidecar.yaml', 'env', '.env',
]);

/** How long the secret-inode scan is trusted, as a backstop to invalidateSecretInodes. */
const SECRET_INODE_TTL_MS = 5_000;
let secretInodeCache: { key: string; at: number; inodes: Set<string> } | null = null;

/**
 * Drop the inode cache. Called when a key is created or replaced at runtime
 * (first-boot generation, `rotate-encryption-key`): until the cache catches up, a
 * hard link to a brand-new key would be judged by name alone, and a link under
 * an unrelated name would not be judged at all.
 */
export function invalidateSecretInodes(): void {
  secretInodeCache = null;
}

/**
 * `dev:ino` of every secret file that exists, so a read is judged by WHICH FILE
 * it reaches rather than by what it is called.
 *
 * This is the only thing that closes a hard link, and a hard link is the one
 * alias no resolver can see through: after `ln ~/.jarvis/.secrets.key
 * ~/Downloads/notes.txt`, resolveReal reports an ordinary
 * `~/Downloads/notes.txt`. The upload policy answers this by refusing
 * `nlink > 1`, which cannot be reused for reads: bun's hardlink install backend
 * gives half of `node_modules` an `nlink > 1`. Comparing identity costs about
 * thirty stats, cached, and refuses nothing that is not actually the key.
 *
 * It also covers, for free: the daemon's own `<key>.<pid>.<hex>.tmp` link, a
 * single-file bind mount of a key (same inode), and -- once read_file fstats
 * the descriptor it opened -- the read TOCTOU.
 */
function secretInodes(): Set<string> {
  const dirs = secretHoldingDirs();
  const explicit = explicitKeyFiles();
  const key = `${dirs.join('\0')}\0${explicit.join('\0')}`;
  const now = Date.now();
  if (secretInodeCache && secretInodeCache.key === key && now - secretInodeCache.at < SECRET_INODE_TTL_MS) {
    return secretInodeCache.inodes;
  }
  const inodes = new Set<string>();
  const add = (path: string) => {
    try {
      const st = statSync(path);
      if (st.isFile()) inodes.add(`${st.dev}:${st.ino}`);
    } catch { /* not there */ }
  };
  for (const dir of dirs) for (const name of SECRET_INODE_NAMES) add(join(dir, name));
  for (const file of explicit) add(file);
  secretInodeCache = { key, at: now, inodes };
  return inodes;
}

/** Whether a file the daemon has already opened is one of its own secrets. Hard-link proof. */
export function isSecretInode(dev: number | bigint, ino: number | bigint): boolean {
  return secretInodes().has(`${dev}:${ino}`);
}

/**
 * Jarvis's own service definitions, which carry `Environment=` /
 * `EnvironmentFile=` / launchd `EnvironmentVariables` -- the same bytes as
 * `/proc/self/environ`, in a file. Matched on a normalized path, so a sidecar's
 * path and a case-insensitive filesystem are covered too.
 */
function isDaemonServiceFile(s: string): boolean {
  // A unit name, by pattern. The default install writes `jarvis.service`
  // (cli/autostart.ts), but a unit may be called anything, so the name the
  // daemon is ACTUALLY running under is detected separately -- see
  // ownUnitNames. `<target>.wants/` is matched too: on this machine those
  // entries are symlinks and resolution lands on the real unit, but a routed
  // path is judged by spelling alone.
  const names = ['jarvis[^/]*', ...ownUnitNames()].join('|');
  const dirs = String.raw`(?:etc|usr\/lib|lib|run)\/systemd\/(?:system|user)`;
  const wants = String.raw`(?:[^/]+\.(?:target|service)\.wants\/)?`;
  if (new RegExp(`^/${dirs}/${wants}(?:${names})\\.service(?:\\.d/.*)?$`).test(s)) return true;
  if (new RegExp(`^/run/systemd/(?:transient|system\\.control|user\\.control)/(?:${names})\\.service(?:\\.d/.*)?$`).test(s)) return true;
  if (new RegExp(`/\\.(?:config|local/share)/systemd/user(?:\\.control)?/${wants}(?:${names})\\.service(?:\\.d/.*)?$`).test(s)) return true;
  // launchd: ~/Library/LaunchAgents/<label>.plist and the system locations.
  return /\/library\/(?:launchagents|launchdaemons)\/[^/]*jarvis[^/]*\.plist$/.test(s);
}

/**
 * The unit name this daemon is running under, from its own cgroup, lower-cased
 * and regex-escaped. An operator may call the unit anything
 * (`cli/systemd-unit.ts`'s UNIT_NAME allows it, and detectSystemdUnit reads it
 * out of the cgroup), and that unit is where `Environment=` lines live -- so a
 * rule that only knew `jarvis*.service` would leave a renamed install's
 * credentials readable. Read once, cached for the process: a daemon does not
 * change unit while running.
 */
let ownUnitCache: string[] | null = null;
function ownUnitNames(): string[] {
  if (ownUnitCache) return ownUnitCache;
  const names = new Set<string>();
  try {
    const cgroup = readFileSync('/proc/self/cgroup', 'utf-8');
    for (const m of cgroup.matchAll(/([A-Za-z0-9_:.@\\-]+)\.service/g)) {
      const name = m[1]!.toLowerCase();
      // `\x2d` is systemd's escaping for `-` in a cgroup path.
      names.add(name.replace(/\\x2d/g, '-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  } catch { /* not Linux, or no cgroup: the pattern half still applies */ }
  ownUnitCache = [...names];
  return ownUnitCache;
}

/**
 * Files whose whole job is to set environment variables. Refused outright:
 * unlike a shell rc, nobody reads these casually.
 *
 * `/etc/default/<name>` and `/etc/sysconfig/<name>` are the two conventional
 * `EnvironmentFile=` targets on Debian- and RHEH-family systems. An
 * `EnvironmentFile=` pointed anywhere else is covered by parsing it out of the
 * unit (envFilesFromUnits), which is the only way to know an arbitrary path.
 */
function isEnvDefinitionFile(s: string): boolean {
  if (s === '/etc/environment') return true;
  if (/^\/etc\/(?:default|sysconfig)\/[^/]+$/.test(s)) return true;
  // DefaultEnvironment= sets variables for every unit, the daemon's included.
  if (/^\/(?:etc|usr\/lib|run)\/systemd\/(?:system|user)\.conf(?:\.d\/[^/]+)?$/.test(s)) return true;
  if (/\/\.config\/systemd\/user\.conf(?:\.d\/[^/]+)?$/.test(s)) return true;
  if (/\/\.config\/environment\.d\/[^/]+$/.test(s) || /^\/(?:etc|usr\/lib|run)\/environment\.d\/[^/]+$/.test(s)) return true;
  // A `jarvis export` archive holds .secrets.key, the workflow key, the
  // sidecar keypair and google-tokens.json verbatim (cli/backup.ts:112), and
  // they are ASCII, so a plain text read of the tar prints them.
  return /(?:^|\/)jarvis-(?:export|backup)-[^/]*\.(?:tar|tgz|zip)(?:\.[a-z0-9]+)?$/.test(s);
}

/** How long the parsed `EnvironmentFile=` set is trusted. */
const ENV_FILES_TTL_MS = 30_000;
let envFilesCache: { at: number; files: string[] } | null = null;

/**
 * Absolute paths named by `EnvironmentFile=` in a unit that is the daemon's
 * own, and by launchd's `EnvironmentVariables`. An `EnvironmentFile=` may point
 * at any path at all, so no pattern can cover it: the unit has to be read. Only
 * units this classifier already refuses are parsed, so this cannot be pointed at
 * an arbitrary file by anything the model controls.
 */
function envFilesFromUnits(): string[] {
  const now = Date.now();
  if (envFilesCache && now - envFilesCache.at < ENV_FILES_TTL_MS) return envFilesCache.files;
  const files = new Set<string>();
  const home = policyHome();
  const names = ['jarvis', ...ownUnitNames().map((n) => n.replace(/\\(.)/g, '$1'))];
  const dirs = [
    join(home, '.config', 'systemd', 'user'), '/etc/systemd/system', '/etc/systemd/user',
    '/usr/lib/systemd/system', '/run/systemd/transient',
  ];
  for (const dir of dirs) {
    for (const name of names) {
      for (const unit of [join(dir, `${name}.service`)]) {
        let text: string;
        try { text = readFileSync(unit, 'utf-8'); } catch { continue; }
        if (text.length > 256 * 1024) continue;
        for (const m of text.matchAll(/^\s*EnvironmentFile\s*=\s*-?\s*(\S+)\s*$/gm)) {
          const p = m[1]!.replace(/^["']|["']$/g, '');
          if (isAbsolute(p)) files.add(resolve(p));
        }
      }
    }
  }
  envFilesCache = { at: now, files: [...files] };
  return envFilesCache.files;
}

/**
 * A login shell startup file: readable, but not if it assigns one of the
 * daemon's own secrets. EXEC_FILE_NAMES, EXEC_SYSTEM_FILES and EXEC_DIRS
 * already know these -- the write side gates writing them as
 * `execute_command` -- so the read side reuses those tables rather than keeping
 * a second list that could drift from them. The directory half matters: fish's
 * `~/.config/fish/config.fish`, `/etc/profile.d/*.sh` and `~/.bashrc.d/*` are
 * known by their DIRECTORY, not by a file name, and each can export a key.
 */
function isShellStartupFile(s: string): boolean {
  const base = s.split('/').pop() ?? '';
  if (EXEC_FILE_NAMES.get(base) === SHELL || EXEC_SYSTEM_FILES.get(s) === SHELL) return true;
  // A PowerShell profile: classifyByName already rates WRITING one as SHELL by
  // this same rule, so the read side must know it too or a Windows sidecar
  // returns `$env:ANTHROPIC_API_KEY = "..."` unscanned.
  if (/(?:^|_)profile\.ps1$/.test(base)) return true;
  return EXEC_DIRS.some(({ seg, label, anywhere }) => label === SHELL && (anywhere ? s.includes(seg) : s.startsWith(seg)));
}

/**
 * Environment-variable names whose VALUE is one of the daemon's own secrets.
 * The same list as model-exec-env.ts's DAEMON_SECRET_ENV_NAMES, which strips
 * them from model-driven spawns (#536); importing it here would pull the spawn
 * machinery into a module the file tools load on every call, so it is duplicated
 * and a test asserts the two agree.
 */
export const SECRET_ENV_NAMES: readonly string[] = Object.freeze([
  // Exactly model-exec-env.ts's DAEMON_SECRET_ENV_NAMES (#536).
  'JARVIS_WORKFLOW_ENCRYPTION_KEY', 'JARVIS_GITHUB_TOKEN', 'JARVIS_DEBUG_RPC', 'JARVIS_API_KEY',
  'JARVIS_OPENAI_KEY', 'JARVIS_GROQ_KEY', 'JARVIS_OPENROUTER_KEY', 'JARVIS_LITELLM_KEY',
  'NVIDIA_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  // Plus names the scrub list does not need but the scan does. The two failure
  // modes are asymmetric: a scrub false positive breaks a child process, a scan
  // false negative hands over a key. So this list is a strict SUPERSET, and the
  // test asserts that relation rather than equality.
  'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'AZURE_OPENAI_API_KEY', 'XAI_API_KEY',
  'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN',
]);

const NAME_ALT = SECRET_ENV_NAMES.join('|');
/** The name, optionally quoted, not a prefix of a longer name (JARVIS_API_KEY_FILE is a location). */
const NAME_RE = `["']?(?:${NAME_ALT})["']?(?![A-Za-z0-9_])`;

/**
 * Every shape that gives one of those names a value, one per line.
 *
 * Anchored at the start of a statement -- line start, or after `;`, `&&`, `||`,
 * `(`, or a keyword that introduces an assignment -- so prose and tests do not
 * match: `# see ANTHROPIC_API_KEY: docs` and
 * `[ -n "$ANTHROPIC_API_KEY" ] && echo "ANTHROPIC_API_KEY: set"` are not
 * assignments, and an earlier version of this rule refused the whole file for
 * them.
 */
const ASSIGN_PATTERNS: readonly string[] = Object.freeze([
  // sh/bash/zsh: NAME=value, export NAME=value, declare -x NAME=value, env NAME=value.
  String.raw`(?:^|[;&|(]\s*)(?:export\s+|declare\s+-\w+\s+|typeset\s+-\w+\s+|local\s+|readonly\s+|env\s+)?` + NAME_RE + String.raw`\s*=(?!=)`,
  // fish: set -gx NAME value. No `=` at all, which is the whole point.
  String.raw`(?:^|[;&|(]\s*)set\s+(?:-\w+\s+)*` + NAME_RE + String.raw`\s+\S`,
  // csh/tcsh: setenv NAME value. Also no `=`.
  String.raw`(?:^|[;&|(]\s*)setenv\s+` + NAME_RE + String.raw`\s+\S`,
  // macOS: launchctl setenv NAME value, from a login script.
  String.raw`launchctl\s+setenv\s+` + NAME_RE + String.raw`\s+\S`,
  // Windows: setx NAME value, and PowerShell's $env:NAME = value.
  String.raw`setx\s+` + NAME_RE + String.raw`\s+\S`,
  String.raw`\$env:` + NAME_RE + String.raw`\s*=`,
  // A value read into the name from somewhere else still puts it in the file's
  // reach, so treat it as an assignment.
  String.raw`(?:^|[;&|(]\s*)read\s+(?:-\w+\s+)*` + NAME_RE,
  // systemd: Environment=NAME=value / Environment="NAME=value".
  String.raw`Environment\s*=\s*["']?` + NAME_RE + String.raw`\s*=`,
  // ~/.pam_environment: NAME DEFAULT=value / NAME OVERRIDE=value.
  NAME_RE + String.raw`\s+(?:DEFAULT|OVERRIDE)\s*=`,
  // launchd plist: <key>NAME</key>.
  String.raw`<key>\s*(?:` + NAME_ALT + String.raw`)\s*</key>`,
  // YAML / dotenv-style `NAME: value`, at the start of a line only.
  String.raw`^\s*` + NAME_RE + String.raw`\s*:\s*\S`,
]);

const SECRET_ENV_ASSIGN_RE = new RegExp(ASSIGN_PATTERNS.join('|'));

/**
 * The name of a daemon secret this text assigns, or null.
 *
 * Used for files that legitimately hold environment settings: they are returned
 * to the model unless they actually carry one of the daemon's credentials, so
 * reading `~/.bashrc` keeps working and reading the one that exports the API key
 * does not.
 *
 * Scanned line by line, after joining shell line-continuations, so a match has a
 * line to point at. Two limits, recorded rather than papered over with redaction
 * (which would imply a guarantee it cannot give): an indirection
 * (`A=secret; export ANTHROPIC_API_KEY=$A`) puts the value on a line this does
 * not match, and a name this list does not know is not scanned for at all.
 */
export function scanForDaemonSecrets(text: string): string | null {
  if (text.length > 4 * 1024 * 1024) return null;
  for (const line of text.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)) {
    if (line.length > 8 * 1024) continue;
    const m = SECRET_ENV_ASSIGN_RE.exec(line);
    if (m) return SECRET_ENV_NAMES.find((n) => m[0]!.includes(n)) ?? 'a Jarvis credential';
  }
  return null;
}

/**
 * Every spelling of `requested` this machine might open, the way execOnWrite
 * builds them: as spelled (so a sidecar's path is judged by name), lexically
 * resolved against each base, and resolved on disk from both the raw spelling
 * and the lexical form.
 *
 * Both resolutions matter and neither is redundant. Bun's `realpathSync.native`
 * normalizes `..` LEXICALLY, so resolveReal is kernel-order only for a path
 * whose lexical form does not exist -- measured on Bun 1.3.8, not assumed. Bun's
 * own openSync/readFileSync normalize the same way, so for a read served HERE
 * the lexical resolution is what gets opened, while a sidecar handed the raw
 * string opens the kernel-order one. Judging both means that whichever process
 * serves the call, the file it reaches was judged.
 */
function readCandidates(path: string, bases: string[], onDisk: boolean): string[] {
  const out = new Set<string>([path]);
  for (const base of isAbsolute(path) ? ['/'] : bases) {
    const abs = resolve(base, path);
    out.add(abs);
    if (onDisk) {
      out.add(resolveReal(path, base));
      out.add(resolveReal(abs));
    }
  }
  return [...out];
}

/** The class of `candidate`, judged without touching the disk. */
function classifySecretByName(candidate: string): SecretReadHit | null {
  const s = normalize(candidate);
  if (FD_PATH_RE.test(s)) return { kind: 'process-relative', path: candidate };
  if (PROC_LEAF_RE.test(s) || WHOLE_MEMORY_RE.test(s)) return { kind: 'process-memory', path: candidate };
  if (isDaemonServiceFile(s) || isEnvDefinitionFile(s)) return { kind: 'daemon-env-source', path: candidate };

  // Jarvis's data dir at its default place -- the only spelling judgeable for a
  // path whose filesystem the brain cannot see (a sidecar's), and the reason a
  // routed read of `~/.jarvis/.secrets.key` is refused too.
  const carveOut = carveOutProjectsDir();
  const inJarvis = /\/\.jarvis\/(.+)$/.exec(s);
  if (inJarvis && !(carveOut && isWithin(s, normalize(carveOut)))) {
    const rel = inJarvis[1]!;
    if (isSecretReadEntry(rel)) return { kind: 'jarvis-key', path: candidate };
    if (isSecretConfigEntry(rel)) return { kind: 'jarvis-config', path: candidate };
    if (isDataDirEnvEntry(rel)) return { kind: 'daemon-env-source', path: candidate };
  }

  // A shell startup file is allowed unless its bytes assign a daemon secret.
  if (isShellStartupFile(s)) return { kind: 'daemon-env-source', path: candidate, scanOnly: true };
  return null;
}

/**
 * The class of `candidate` against the REGISTERED dirs -- the data dir, the
 * secrets dir, an explicit key file -- by string containment only.
 *
 * Kept separate from, and run unconditionally with, the on-disk pass below.
 * These are pure string tests, and putting them behind `--no-local-tools`
 * switched off the whole point of registering a relocated data dir in exactly
 * the mode where the brain is hosted and the user's machine is a sidecar: a
 * `JARVIS_HOME=/srv/jarvis` install would have had `/srv/jarvis/.secrets.key`
 * readable through a routed `read_file`, because the name tier only knows the
 * literal `/.jarvis/` spelling.
 *
 * `carve` is the projects carve-out, passed in so it is computed once per call
 * rather than once per candidate.
 */
function classifySecretByRegisteredDirs(candidate: string, carve: string | null): SecretReadHit | null {
  const abs = resolve(candidate);
  if (carve !== null && isWithinCI(abs, carve)) return null;
  for (const file of explicitKeyFiles()) {
    if (sameCI(abs, file)) return { kind: 'jarvis-key', path: candidate };
  }
  for (const file of envFilesFromUnits()) {
    if (sameCI(abs, file)) return { kind: 'daemon-env-source', path: candidate };
  }
  // The PAT the site builder stages for a git push: 0600 under XDG_RUNTIME_DIR
  // or the temp dir, for the life of one push (sites/github-manager.ts:326-338).
  // A pure spelling rule, so it must not sit behind --no-local-tools.
  if (/(?:^|\/)jarvis-gh-cred-[^/]*(?:\/|$)/.test(normalize(candidate))) {
    return { kind: 'jarvis-key', path: candidate };
  }
  for (const dir of secretHoldingDirs()) {
    if (!isWithinCI(abs, dir) || sameCI(abs, dir)) continue;
    const rel = relative(dir, abs);
    if (isSecretReadEntry(rel)) return { kind: 'jarvis-key', path: candidate };
    if (isSecretConfigEntry(rel)) return { kind: 'jarvis-config', path: candidate };
    if (isDataDirEnvEntry(rel)) return { kind: 'daemon-env-source', path: candidate };
  }
  return null;
}

/**
 * The class of `real` (a resolved path on THIS machine) against the alternate,
 * symlink-resolved forms of the registered dirs -- a `~/.jarvis` that is a link
 * to `/data/jarvis` must still cover `/data/jarvis/.secrets.key`. Only the
 * `realOrSelf` calls need the disk, so only they live here.
 */
function classifySecretOnDisk(real: string, carve: string | null): SecretReadHit | null {
  if (carve !== null && isWithinCI(real, carve)) return null;
  // A dotfile manager makes `~/.bashrc` a symlink to `~/dotfiles/bashrc`, and
  // reading the latter is reading the former. homeScan already has the real path
  // of every home-relative exec location -- the write side uses it for exactly
  // this -- so the read side reuses it instead of judging names only.
  for (const target of homeScan(policyHome()).targets) {
    if (target.label !== SHELL) continue;
    if (target.dir ? isWithinCI(real, target.real) : sameCI(real, target.real)) {
      return { kind: 'daemon-env-source', path: real, scanOnly: true };
    }
  }
  for (const file of explicitKeyFiles()) {
    if (sameCI(real, realOrSelf(file))) return { kind: 'jarvis-key', path: real };
  }
  for (const dir of secretHoldingDirs()) {
    const form = realOrSelf(dir);
    if (!isWithinCI(real, form) || sameCI(real, form)) continue;
    const rel = relative(form, real);
    if (isSecretReadEntry(rel)) return { kind: 'jarvis-key', path: real };
    if (isSecretConfigEntry(rel)) return { kind: 'jarvis-config', path: real };
    if (isDataDirEnvEntry(rel)) return { kind: 'daemon-env-source', path: real };
  }
  return null;
}

/**
 * What secret of the daemon's own a read of `requested` would reach, or null.
 *
 * `requested` is coerced the way the workflow boundary coerces it before
 * dispatch, so a non-string path is judged as the string it will be read as.
 */
export function secretRead(requested: unknown, opts: { bases?: string[] } = {}): SecretReadHit | null {
  if (requested === null || requested === undefined) return null;
  const path = String(requested);
  if (!path) return null;
  const onDisk = !isNoLocalTools();
  const candidates = readCandidates(path, opts.bases ?? relativeBases(), onDisk);
  const carve = carveOutProjectsDir();

  // Spelling first, for every candidate: it needs no filesystem, so it judges a
  // sidecar's path and a file that is not there yet alike. A scan-only hit is
  // held back, so a definite hit from another candidate still wins.
  let scanHit: SecretReadHit | null = null;
  for (const candidate of candidates) {
    const hit = classifySecretByName(candidate) ?? classifySecretByRegisteredDirs(candidate, carve);
    if (!hit) continue;
    if (hit.scanOnly) scanHit ??= hit;
    else return hit;
  }
  if (onDisk) {
    for (const candidate of candidates) {
      const hit = classifySecretOnDisk(candidate, carve);
      if (!hit) continue;
      if (hit.scanOnly) scanHit ??= hit;
      else return hit;
    }
    // Identity, last: the only test that sees through a hard link.
    for (const candidate of candidates) {
      try {
        const st = statSync(candidate);
        if (st.isFile() && isSecretInode(st.dev, st.ino)) return { kind: 'jarvis-key', path: candidate };
      } catch { /* not there */ }
    }
  }
  return scanHit;
}

/**
 * One sentence for every class. Deliberately uniform: naming which rule matched
 * would let a caller enumerate the classifier by probing, and the distinction is
 * of no use to a legitimate caller. It does not suggest asking the user to paste
 * the file -- a prompt-injected turn would do exactly that, and a trusting user
 * would comply.
 */
function secretRefusalText(requested: string, what: string): string {
  return `Error: Access denied: ${what} "${requested}" holds Jarvis's own credentials (keys, tokens, or the `
    + 'environment they are set in), which are never returned to the model. The refusal has been logged. Do not '
    + 'retry this path, do not look for the same data by another route, and do not ask the user to read it out.';
}

/** The refusal for a `read_file`, or null. A `scanOnly` hit is resolved by the caller, not here. */
export function secretReadRefusal(requested: unknown, opts: { bases?: string[] } = {}): string | null {
  const hit = secretRead(requested, opts);
  if (!hit || hit.scanOnly) return null;
  logSecretRefusal('read_file', hit);
  return secretRefusalText(String(requested), 'the file');
}

/** The refusal for a file whose bytes turned out to assign a daemon secret. */
export function secretScanRefusal(requested: unknown, envName: string): string {
  logSecretRefusal('read_file', { kind: 'daemon-env-source', path: String(requested) }, envName);
  return secretRefusalText(String(requested), 'the file');
}

/**
 * The refusal for a descriptor that turned out to BE one of the daemon's
 * secrets, whatever the path said. This is the verdict that cannot be raced or
 * aliased: the caller has the file open, and identity does not depend on any
 * spelling.
 */
export function secretInodeRefusal(requested: unknown): string {
  logSecretRefusal('read_file', { kind: 'jarvis-key', path: `${String(requested)} (by inode)` });
  return secretRefusalText(String(requested), 'the file');
}

/**
 * Secrets dirs that exist only to hold secrets: what `JARVIS_SECRETS_DIR` or an
 * explicit key file points at, when that is not also a data dir (where ordinary
 * things -- logs, notes, content -- live beside the keys).
 */
function dedicatedSecretsDirs(): string[] {
  const dataDirs = [..._dataDirs, join(policyHome(), '.jarvis')].map((d) => resolve(d));
  const env = process.env.JARVIS_SECRETS_DIR;
  // Deliberately NOT the directory holding an explicit key file: an ordinary
  // directory does not become a secrets dir because a key happens to sit in it,
  // and taking its dirname made `list_directory ~/Documents` a refusal whenever
  // JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE pointed there. The FILE is still refused
  // on read, by exact match and by inode.
  const candidates = [...(env && isAbsolute(env) ? [resolve(env)] : []), ..._secretsDirs];
  const home = resolve(policyHome());
  return [...new Set(candidates.filter((d) =>
    // Not a data dir: those hold logs, notes and content beside the keys, and
    // listing them is ordinary use.
    !dataDirs.some((dd) => sameCI(dd, d))
    // And not a directory that CONTAINS the home dir or a data dir. A secrets
    // dir misconfigured to `~` or `/` would otherwise make `list_directory ~`
    // a refusal, which is a worse bug than the recon it would prevent.
    && !isWithinCI(home, d) && !dataDirs.some((dd) => isWithinCI(dd, d))))];
}

/**
 * The refusal for a `list_directory`, or null.
 *
 * A listing discloses entry names and sizes, not bytes, so this is narrower than
 * the read rule. Refused: a descriptor directory (`/proc/<pid>/fd`, whose
 * entries name every file the daemon has open), a directory whose whole contents
 * are key material (`sidecar-keys`, the local Chrome profile), and a DEDICATED
 * secrets dir -- one a `JARVIS_SECRETS_DIR` or an explicit
 * `JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE` points at, which is not also a data dir.
 *
 * Deliberately NOT refused: listing the shared `~/.jarvis`, which is also the
 * default keychain dir. Refusing it would break "what is in my Jarvis folder"
 * for a names-and-sizes disclosure, and every secret byte in it is refused on
 * read. `/proc/<pid>` stays listable for the same reason. The one thing such a
 * listing does leak is a name that is itself the capability -- the daemon's
 * leftover `workflow-encryption.key.<pid>.<hex>.tmp` hard link -- and that is
 * covered because both its name (isSecretReadEntry) and its inode
 * (secretInodes) refuse the read however it is spelled.
 */
export function secretListRefusal(requested: unknown, opts: { bases?: string[] } = {}): string | null {
  if (requested === null || requested === undefined) return null;
  const path = String(requested);
  if (!path) return null;
  const onDisk = !isNoLocalTools();
  const dedicated = dedicatedSecretsDirs();
  const refuse = (hit: SecretReadHit): string => {
    logSecretRefusal('list_directory', hit);
    return secretRefusalText(path, 'the directory');
  };
  const carve = carveOutProjectsDir();
  for (const candidate of readCandidates(path, opts.bases ?? relativeBases(), onDisk)) {
    const s = normalize(candidate);
    if (FD_PATH_RE.test(s)) return refuse({ kind: 'process-relative', path: candidate });
    if (carve !== null && isWithinCI(resolve(candidate), carve)) continue;
    // A key-material tree at the default data-dir location. The FIRST component
    // under the data dir, matching the read side's isSecretReadEntry: a site
    // project or a notes folder with a `browser` directory in it is the user's.
    if (/\/\.jarvis\/(?:sidecar-keys|browser)(?:\/|$)/.test(s)) {
      return refuse({ kind: 'jarvis-key', path: candidate });
    }
    for (const dir of dedicated) {
      for (const form of new Set([dir, ...(onDisk ? [realOrSelf(dir)] : [])])) {
        if (isWithinCI(resolve(candidate), form)) return refuse({ kind: 'jarvis-key', path: candidate });
      }
    }
    for (const dir of secretHoldingDirs()) {
      for (const form of new Set([resolve(dir), ...(onDisk ? [realOrSelf(dir)] : [])])) {
        const abs = resolve(candidate);
        if (!isWithinCI(abs, form) || sameCI(abs, form)) continue;
        if (/^(?:sidecar-keys|browser)(?:[\\/]|$)/i.test(relative(form, abs))) {
          return refuse({ kind: 'jarvis-key', path: candidate });
        }
      }
    }
  }
  return null;
}

/**
 * The daemon's log is where the user finds out. A refusal here is the loudest
 * prompt-injection signal the system produces, and returning it only to the
 * model would throw that away. The class and the path are logged; no bytes and
 * no values ever are.
 */
function logSecretRefusal(tool: string, hit: SecretReadHit, envName?: string): void {
  console.warn(`[FilePolicy] ${tool} refused: ${hit.kind}${envName ? ` (assigns ${envName})` : ''} at ${hit.path}`);
}
