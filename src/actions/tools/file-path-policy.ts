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

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isGitDirName, isWithin, isWithinCI, stripHfsIgnorable } from '../../util/path.ts';
import { exists, isDir, isGitDirectory, landingPath, linkedGitDirs } from '../../sites/git-dir.ts';
import { getDefaultCwd, isNoLocalTools } from './local-tools-guard.ts';

// ── Daemon-registered roots ──────────────────────────────────────────────────

let _siteProjectsDir: string | null = null;
let _dataDirs: string[] = [];
let _codeRoots: string[] = [];
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
export function setDaemonDataRoots(roots: { dataDirs?: Array<string | null | undefined>; codeRoots?: Array<string | null | undefined> }): void {
  const clean = (list: Array<string | null | undefined> = []) => [...new Set(list.filter((r): r is string => !!r).map((r) => resolve(r)))];
  _dataDirs = clean(roots.dataDirs);
  _codeRoots = clean(roots.codeRoots);
}

/**
 * The home dir the policy judges against. A seam for tests only: Bun's
 * homedir() ignores a HOME changed at runtime, and a test must never classify
 * (or write) against the developer's real home.
 */
export function setPolicyHome(dir: string | null): void {
  _home = dir ? resolve(dir) : null;
  homeTargetsCache = null;
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
 * The refusal for a call routed to a sidecar with a RELATIVE path that names
 * a git dir, while site projects exist on this host: the sidecar resolves it
 * against its own cwd, which the brain cannot know, so where it lands cannot
 * be judged. An absolute path, which siteGitRefusal can judge, still works.
 */
export function routedGitRefusal(requested: string): string | null {
  if (!_siteProjectsDir || isAbsolute(requested) || /^[a-z]:[\\/]/i.test(requested)) return null;
  if (!hasGitComponent(stripHfsIgnorable(requested))) return null;
  return `Error: Access denied: "${requested}" is a relative path into a git directory, routed to a sidecar whose working `
    + 'directory the brain cannot see. Use an absolute path.';
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
    '.xinitrc', '.xsession', '.xsessionrc', '.pam_environment'].map((n) => [n, SHELL] as const),
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
  return s;
}

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
