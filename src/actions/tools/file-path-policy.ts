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
 *    editor config, an existing executable, Jarvis's own data and code.
 *    Writing one of those is running a command later, so write_file's
 *    authorityGate rates it `execute_command` instead of `write_data`. It is
 *    not refused: a person can still approve an edit to their own .bashrc,
 *    but it is gated as what it is. See execOnWriteClass.
 *
 * What this does NOT close: the site builder turns project writes into
 * execution by design (`make dev` runs the project's Makefile, vite reloads
 * its config), so a write_data edit of a site project's build files is still
 * code the daemon runs. That is the site builder's contract, not this one's.
 */

import {
  closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { HFS_IGNORABLE, isGitDirName, isWithin } from '../../util/path.ts';
import { getDefaultCwd } from './local-tools-guard.ts';

// ── Daemon-registered roots ──────────────────────────────────────────────────

let _siteProjectsDir: string | null = null;
let _daemonRoots: string[] = [];

/**
 * Where site projects live. Registered at daemon boot from the config,
 * whether or not the site builder is enabled or starts: projects created
 * while it was on keep their `.git`, and their pre-#511 reflogs, after it is
 * turned off.
 */
export function setSiteProjectsDir(dir: string | null): void {
  _siteProjectsDir = dir ? resolve(dir) : null;
}

export function getSiteProjectsDir(): string | null {
  return _siteProjectsDir;
}

/**
 * Directories whose contents the daemon itself loads or runs: its data dir
 * (config.yaml names engine and pieces dirs; cache/engine holds bundles run
 * by hash with no content check) and any configured engine, pieces or
 * metadata location outside it. Registered at boot. The site projects dir is
 * carved out even when it sits inside one of these.
 */
export function setDaemonDataRoots(roots: Array<string | null | undefined>): void {
  _daemonRoots = [...new Set(roots.filter((r): r is string => !!r).map((r) => resolve(r)))];
}

// ── Path resolution ──────────────────────────────────────────────────────────

/** Symlink hops before giving up, the same bound Linux puts on open(). */
const MAX_LINK_HOPS = 40;

/**
 * Where `path` lands when opened for writing: the real path of its deepest
 * existing ancestor with the missing tail appended, following a DANGLING
 * symlink by reading it. A write through `x -> .git/new` creates `.git/new`,
 * so a link whose target is missing is judged by that target, not by its own
 * name. realpath alone cannot do that: it fails on the link, and walking up
 * past it would judge `x` as an ordinary new file.
 *
 * Never throws. An unreadable component ends the walk with the lexical path,
 * which the name-based checks still see.
 */
export function resolveReal(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (let hops = 0; ;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch { /* missing, dangling, or unreadable: look closer */ }
    let target: string | null = null;
    try {
      if (lstatSync(current).isSymbolicLink()) target = readlinkSync(current);
    } catch { /* not there at all */ }
    if (target !== null && ++hops <= MAX_LINK_HOPS) {
      current = resolve(dirname(current), target);
      continue;
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...tail);
    tail.unshift(basename(current));
    current = parent;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether `dir` is a git directory by git's own test (setup.c,
 * is_git_directory): a HEAD, plus objects/ and refs/ or a commondir file.
 * This is how a git dir is recognised whatever it is called -- the target of
 * a `.git` gitfile or symlink, a linked worktree's gitdir, a bare repo --
 * without following any pointer to it. It generalises #516's linkedGitDirs,
 * which finds only the ones the project root's `.git` points at.
 */
function isGitDirectory(dir: string): boolean {
  if (!exists(join(dir, 'HEAD'))) return false;
  return (isDir(join(dir, 'objects')) && isDir(join(dir, 'refs'))) || exists(join(dir, 'commondir'));
}

/** Whether `real` is, or is inside, a git directory, looking no higher than `stopAt` (exclusive). */
function insideGitDirectory(real: string, stopAt?: string): boolean {
  for (let dir = real; ; dir = dirname(dir)) {
    if (stopAt !== undefined && (!isWithinCI(dir, stopAt) || sameCI(dir, stopAt))) return false;
    if (isGitDirectory(dir)) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Containment that ignores case. On a case-insensitive filesystem
 * `~/.JARVIS/projects` opens `~/.jarvis/projects`, and realpath keeps the
 * spelling it was given, so a case-sensitive compare would let a respelled
 * path out of the check. On a case-sensitive one the only cost is treating a
 * same-name-different-case sibling as inside, which errs toward refusing.
 */
function isWithinCI(path: string, base: string): boolean {
  return isWithin(path.toLowerCase(), base.toLowerCase());
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
 * The git dirs a project's root `.git` names when it is a gitfile or a
 * symlink, plus a linked worktree's commondir: #516's linkedGitDirs, with two
 * differences. A target that does not exist yet is still returned (a write
 * that creates `gitdata/config` is the write that makes it a repository
 * config), resolved the way a write would land (resolveReal follows dangling
 * links). And targets OUTSIDE the project are kept: the site tools refuse
 * those by containment, but these tools have none.
 */
function linkedGitDirsOf(projectRoot: string): string[] {
  const dotGit = join(projectRoot, '.git');
  const found: string[] = [];
  try {
    const st = lstatSync(dotGit);
    if (st.isSymbolicLink()) {
      found.push(resolveReal(dotGit));
    } else if (st.isFile()) {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf-8'));
      if (match) found.push(resolveReal(resolve(projectRoot, match[1]!)));
    }
  } catch { /* no .git, or unreadable */ }
  for (const gitDir of [...found]) {
    const commondir = join(gitDir, 'commondir');
    // Only a regular file: a FIFO there would block every file-tool call.
    if (!isFile(commondir)) continue;
    try {
      found.push(resolveReal(resolve(gitDir, readFileSync(commondir, 'utf-8').trim())));
    } catch { /* unreadable */ }
  }
  // A `.git` pointing at `/`, the home dir or anything above the project
  // would put every path under a "git dir" and refuse them all. That takes a
  // shell to set up, so it is a nuisance rather than a bypass, but a git dir
  // that contains its own project is not one git would use either.
  const home = homedir();
  return found.filter((dir) => !isWithinCI(projectRoot, dir) && !isWithinCI(home, dir));
}

/**
 * The linked git dirs of every site project: the site chat's, and each
 * directory in the projects dir. All of them, not just the one a path is
 * under, because a linked git dir can be anywhere; there are tens of
 * projects, not thousands, and this is one lstat each.
 */
function allLinkedGitDirs(): string[] {
  const projects = new Set<string>();
  const cwd = getDefaultCwd();
  if (cwd) projects.add(resolve(cwd));
  if (_siteProjectsDir) {
    try {
      for (const entry of readdirSync(_siteProjectsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) projects.add(join(_siteProjectsDir, entry.name));
      }
    } catch { /* no projects dir yet */ }
  }
  return [...projects].flatMap(linkedGitDirsOf);
}

/**
 * The refusal message when `absPath` -- as spelled, or where it really lands
 * -- is inside a git directory of a site project, else null.
 *
 * Three tests, any one refuses, each relative to a site root: a component of
 * the spelled path is a git dir name in any form isGitDirName knows (`.git`,
 * `.GIT`, `.git.`, `git~1`, HFS-ignorable spellings); the same of the real
 * path, so a symlink into `.git` from anywhere, inside the project or not, is
 * caught; and the real path is inside a directory git would treat as a git
 * dir, whatever its name.
 *
 * Callers run this BEFORE routing a call to a sidecar. A sidecar on the
 * brain's own machine opens the brain's files, and nothing on that side knows
 * about site projects. For a genuinely remote sidecar the cost is refusing a
 * path that happens to match a project's `.git` spelling there.
 */
export function siteGitRefusal(requested: string, absPath: string): string | null {
  const roots = siteRoots();
  if (roots.length === 0) return null;
  const real = resolveReal(absPath);
  const refusal = `Error: Access denied: "${requested}" is inside a site project's git directory. The file tools cannot `
    + 'read, write or list git internals there; use site_git_commit and site_github_push for version control.';
  for (const root of roots) {
    const realRoot = realOrSelf(root);
    const spelled = isWithinCI(absPath, root) && hasGitComponent(relative(root.toLowerCase(), absPath.toLowerCase()));
    const landed = isWithinCI(real, realRoot)
      && (hasGitComponent(relative(realRoot.toLowerCase(), real.toLowerCase())) || insideGitDirectory(real, realRoot));
    if (spelled || landed) return refusal;
  }
  // A git dir a project's `.git` points at: maybe not created yet, maybe
  // outside the projects dir, and named nothing like `.git`.
  if (allLinkedGitDirs().some((dir) => isWithinCI(real, dir) || isWithinCI(absPath, dir))) return refusal;
  return null;
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
const EXECUTABLE = 'an existing executable';
const HARDLINK = 'a file with other hard links, which may be code another name runs';
const JARVIS = "Jarvis's own data, configuration or code";
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
  // script-shell / node-options; yarnPath; bun preload; debugger and REPL
  // init files; Python's site-customisation hooks run on every start.
  ...['.vimrc', '.gvimrc', '.exrc', '.nvimrc', '.emacs', '.emacs.el', '.tmux.conf', '.screenrc', '.hgrc', '.npmrc',
    '.yarnrc', '.yarnrc.yml', '.bunfig.toml', '.gdbinit', '.lldbinit', '.psqlrc', '.irbrc', '.pryrc', '.rprofile',
    '.sqliterc', '.mavenrc', 'init.gradle', 'direnvrc', 'sitecustomize.py', 'usercustomize.py', '.wezterm.lua',
    '.mailcap', '.xbindkeysrc'].map((n) => [n, TOOL] as const),
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
  const parts = path.replace(HFS_IGNORABLE, '').replace(/\\/g, '/').toLowerCase().split('/')
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
  if (/\/(?:site|dist)-packages\/[^/]+\.pth$/.test(s)) return TOOL;
  if (/\/\.cargo\/config(?:\.toml)?$/.test(s)) return TOOL;
  // Jarvis's data dir at its default place, the only place a sidecar's path
  // can be judged against; the projects inside it are site files, not
  // Jarvis's own.
  if (s.includes('/.jarvis/') && !s.includes('/.jarvis/projects/')
    && !(_siteProjectsDir && isWithin(s, normalize(_siteProjectsDir)))) return JARVIS;
  const bySystemFile = EXEC_SYSTEM_FILES.get(s);
  if (bySystemFile) return bySystemFile;
  for (const { seg, label, anywhere } of EXEC_DIRS) {
    if (anywhere ? s.includes(seg) : s.startsWith(seg)) return label;
  }
  return null;
}

/**
 * The real path of each home-relative exec location that exists, so a file
 * reached some other way is still recognised. Dotfile managers make
 * `~/.bashrc` a symlink to `~/dotfiles/bashrc`; a write to the latter is a
 * write to the former, and no name test sees it.
 */
function realHomeTargets(home: string): Array<{ real: string; label: string; dir: boolean }> {
  const found: Array<{ real: string; label: string; dir: boolean }> = [];
  const add = (rel: string, label: string, dir: boolean) => {
    try {
      found.push({ real: realpathSync(join(home, rel)), label, dir });
    } catch { /* not there */ }
  };
  for (const [name, label] of EXEC_FILE_NAMES) add(name, label, false);
  for (const { seg, label, anywhere } of EXEC_DIRS) if (anywhere) add(seg.slice(1, -1), label, true);
  return found;
}

/** The first bytes of a regular file, or '' when it cannot be read. */
function head(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('latin1');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Filesystem-based classes, for a path on this machine. `real` is where the write lands. */
function classifyOnDisk(real: string, home: string): string | null {
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
  const inProjects = projects !== null && isWithinCI(real, projects);
  if (!inProjects) {
    for (const root of _daemonRoots) if (isWithinCI(real, realOrSelf(root))) return JARVIS;
  }
  if (DAEMON_ROOT && isWithinCI(real, DAEMON_ROOT)) return JARVIS;

  for (const target of realHomeTargets(home)) {
    if (target.dir ? isWithinCI(real, target.real) : sameCI(real, target.real)) return target.label;
  }

  try {
    const st = statSync(real);
    if (st.isFile()) {
      // writeFileSync truncates in place and keeps the mode, so overwriting
      // an executable installs a new program under its name. All nine bits
      // set is what drvfs, vfat and NTFS mounts report for every file (WSL's
      // /mnt/c), so there it takes the content to say so: a shebang, an ELF
      // or a PE header.
      const perm = st.mode & 0o777;
      if ((perm & 0o111) !== 0 && (perm !== 0o777 || /^(?:#!|\x7fELF|MZ)/.test(head(real, 4)))) return EXECUTABLE;
      // An in-place write through one name rewrites every name: bun's
      // hardlink backend links node_modules to its global cache, which the
      // daemon's own dependencies share, and a hard link to ~/.bashrc has no
      // name any test above would recognise.
      if (st.nlink > 1) return HARDLINK;
    }
  } catch { /* new file */ }
  return null;
}

/**
 * What kind of exec-on-write location a write to `requested` reaches, or null
 * for an ordinary file.
 *
 * Deliberately over-inclusive about WHERE the write lands, because the answer
 * gates a call that may run later than it is judged:
 *
 * - the spelled path is judged by name, so a sidecar-routed write (whose
 *   files the brain cannot stat) is still classified;
 * - a relative path is resolved against the default cwd AND the home dir. An
 *   approval card raised during a site chat can be approved after the turn
 *   ends, when setDefaultCwd(null) has made the same relative path resolve
 *   against home instead;
 * - each resolution is judged again at its real path (symlinks followed,
 *   dangling ones by their target), on this machine even when a sidecar is
 *   connected: which machine serves the call is decided at execute time.
 *
 * `requested` is coerced the way the workflow boundary coerces it before
 * dispatch (`String(path)`), so a non-string path is judged as the string it
 * will be written as, not waved through as nothing.
 */
export function execOnWriteClass(requested: unknown, opts: { cwd?: string | null; home?: string } = {}): string | null {
  if (requested === null || requested === undefined) return null;
  const path = String(requested);
  if (!path) return null;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd === undefined ? getDefaultCwd() : opts.cwd;
  const byName = classifyByName(path);
  if (byName) return byName;
  const bases = isAbsolute(path) ? [''] : [...new Set([cwd || home, home])];
  for (const base of bases) {
    const abs = resolve(base, path);
    const label = classifyByName(abs) ?? classifyOnDisk(resolveReal(abs), home);
    if (label) return label;
  }
  return null;
}
