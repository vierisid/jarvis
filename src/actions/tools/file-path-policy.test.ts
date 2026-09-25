/**
 * The generic file tools and git internals / exec-on-write paths (#522).
 *
 * Two halves. The first drives the real read_file / write_file /
 * list_directory against a temp site projects dir, with the default cwd set
 * the way ws-service sets it during a site chat, and checks that a project's
 * git internals are refused however they are spelled or reached. Every
 * refused write also checks the disk, so a test cannot pass on an error
 * string while the write went through.
 *
 * The second checks the Authority rating of write_file: a path that runs as
 * code is execute_command, through the agent gate (resolveToolGate) and the
 * workflow effect boundary (toolEffectCapability) alike, and an ordinary path
 * stays write_data.
 *
 * Git dirs are laid out by hand (HEAD, objects/, refs/, config) -- the shape
 * git itself recognises -- so no git subprocess runs here except the one test
 * that checks a real `git init`, which gets a sanitised env so a pre-commit
 * hook's GIT_DIR cannot leak into it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listDirectoryTool, readFileTool, setDefaultCwd, writeFileTool } from './builtin.ts';
import { execOnWriteClass, resolveReal, setDaemonDataRoots, setSiteProjectsDir, siteGitRefusal } from './file-path-policy.ts';
import { ToolRegistry } from './registry.ts';
import { gateContext, resolveToolGate } from '../../authority/tool-action-map.ts';
import { ApprovalManager } from '../../authority/approval.ts';
import { AuditTrail } from '../../authority/audit.ts';
import { DeferredExecutor } from '../../authority/deferred-executor.ts';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import { toolEffectCapability } from '../../workflows/runtime/effect-capabilities.ts';
import { buildSandboxServiceBackends, type BuildServiceBackendsOptions } from '../../workflows/runtime/service-backends.ts';
import { WorkflowEventBuffer } from '../../workflows/runtime/event-buffer.ts';
import { CredentialResolver } from '../../workflows/credentials/adapter.ts';
import { closeWorkflowDb, initWorkflowDb } from '../../workflows/db/index.ts';
import { createFlow } from '../../workflows/db/repos/flow.ts';
import { createDraftVersion } from '../../workflows/db/repos/flow-version.ts';
import { createFlowRun } from '../../workflows/db/repos/flow-run.ts';
import { AuthorityEngine } from '../../authority/engine.ts';
import { EmergencyController } from '../../authority/emergency.ts';
import { sanitizedEnv } from '../../util/subprocess-env.ts';

const DOT_GIT = '.git';
const GIT_CONFIG = '[core]\n\trepositoryformatversion = 0\n';
const REFLOG = '0000 1111 Jarvis <j@x> 1 +0000\tpull https://ghp_REFLOGSECRET@github.com/o/r.git\n';
const REFUSED = "inside a site project's git directory";

let root: string;
let projectsDir: string;
let project: string;
let outside: string;

/** A directory git would accept as a git dir: HEAD, objects/, refs/, plus config and a reflog. */
function makeGitDir(dir: string): void {
  mkdirSync(join(dir, 'objects'), { recursive: true });
  mkdirSync(join(dir, 'refs', 'heads'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, 'config'), GIT_CONFIG);
  writeFileSync(join(dir, 'logs', 'HEAD'), REFLOG);
}

const read = async (path: string) => String(await readFileTool.execute({ path }));
const write = async (path: string, content = 'PWNED') => String(await writeFileTool.execute({ path, content }));
const list = async (path: string) => String(await listDirectoryTool.execute({ path }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-522-'));
  projectsDir = join(root, 'projects');
  project = join(projectsDir, 'app');
  outside = join(root, 'outside');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  makeGitDir(join(project, DOT_GIT));
  writeFileSync(join(project, 'src', 'App.tsx'), 'export default 1;\n');
  writeFileSync(join(project, '.gitignore'), 'node_modules\n');
  setSiteProjectsDir(projectsDir);
  setDefaultCwd(project);
});

afterEach(() => {
  setDefaultCwd(null);
  setSiteProjectsDir(null);
  rmSync(root, { recursive: true, force: true });
});

// ── (a) site project git internals, through the real tools ──────────────────

describe('generic file tools refuse a site project\'s git internals', () => {
  const configPath = () => join(project, DOT_GIT, 'config');

  test('relative .git paths under the site cwd: read, write and list are all refused', async () => {
    expect(await read('.git/logs/HEAD')).toContain(REFUSED);
    expect(await read('.git/config')).toContain(REFUSED);
    expect(await list('.git')).toContain(REFUSED);
    expect(await list('.git/hooks')).toContain(REFUSED);
    expect(await write('.git/config')).toContain(REFUSED);
    expect(await write('.git/hooks/pre-commit', '#!/bin/sh\nid\n')).toContain(REFUSED);
    expect(readFileSync(configPath(), 'utf-8')).toBe(GIT_CONFIG);
    expect(existsSync(join(project, DOT_GIT, 'hooks', 'pre-commit'))).toBe(false);
  });

  test('the refusal never echoes the reflog, so the PAT stays put', async () => {
    const out = await read('.git/logs/HEAD');
    expect(out).not.toContain('ghp_REFLOGSECRET');
  });

  test('case, NTFS and HFS spellings of .git are refused before the disk is touched', async () => {
    for (const spelled of ['.GIT/config', '.Git/config', '.git./config', '.git /config', 'GIT~1/config', '.g\u200cit/config',
      '.git::$INDEX_ALLOCATION/config', 'src\\..\\.git\\config']) {
      expect(await read(spelled)).toContain(REFUSED);
      expect(await write(spelled)).toContain(REFUSED);
    }
    expect(readFileSync(configPath(), 'utf-8')).toBe(GIT_CONFIG);
  });

  test('dot-dot spellings that land in .git are refused', async () => {
    expect(await read('src/../.git/config')).toContain(REFUSED);
    expect(await write('./src/../.git/config')).toContain(REFUSED);
    // Another project's .git, reached from this project's cwd.
    makeGitDir(join(projectsDir, 'other', DOT_GIT));
    expect(await read('../other/.git/config')).toContain(REFUSED);
    expect(await write('../other/.git/config')).toContain(REFUSED);
    expect(readFileSync(join(projectsDir, 'other', DOT_GIT, 'config'), 'utf-8')).toBe(GIT_CONFIG);
  });

  test('an absolute path into a project\'s .git is refused outside a site chat too', async () => {
    setDefaultCwd(null);
    expect(await read(configPath())).toContain(REFUSED);
    expect(await write(configPath())).toContain(REFUSED);
    expect(await list(join(project, DOT_GIT))).toContain(REFUSED);
    expect(readFileSync(configPath(), 'utf-8')).toBe(GIT_CONFIG);
  });

  test('a symlink inside the project into .git is judged by where it lands', async () => {
    symlinkSync(DOT_GIT, join(project, 'gitlink'));
    symlinkSync(join(DOT_GIT, 'config'), join(project, 'cfg'));
    expect(await read('gitlink/config')).toContain(REFUSED);
    expect(await list('gitlink')).toContain(REFUSED);
    expect(await read('cfg')).toContain(REFUSED);
    expect(await write('cfg')).toContain(REFUSED);
    expect(await write('gitlink/hooks/post-checkout', '#!/bin/sh\nid\n')).toContain(REFUSED);
    expect(readFileSync(configPath(), 'utf-8')).toBe(GIT_CONFIG);
    expect(existsSync(join(project, DOT_GIT, 'hooks', 'post-checkout'))).toBe(false);
  });

  test('a symlink OUTSIDE the projects dir pointing into a project\'s .git is refused', async () => {
    setDefaultCwd(null);
    symlinkSync(join(project, DOT_GIT), join(outside, 'sneaky'));
    expect(await read(join(outside, 'sneaky', 'logs', 'HEAD'))).toContain(REFUSED);
    expect(await write(join(outside, 'sneaky', 'config'))).toContain(REFUSED);
    expect(await list(join(outside, 'sneaky'))).toContain(REFUSED);
    expect(readFileSync(configPath(), 'utf-8')).toBe(GIT_CONFIG);
  });

  test('a dangling symlink whose target would be created inside .git is refused', async () => {
    symlinkSync(join(DOT_GIT, 'hooks', 'pre-push'), join(project, 'innocent.txt'));
    expect(await write('innocent.txt', '#!/bin/sh\nid\n')).toContain(REFUSED);
    expect(existsSync(join(project, DOT_GIT, 'hooks', 'pre-push'))).toBe(false);
  });

  test('a git dir no .git name points at directly (gitfile) is still refused', async () => {
    rmSync(join(project, DOT_GIT), { recursive: true });
    makeGitDir(join(project, 'gitdata'));
    writeFileSync(join(project, DOT_GIT), 'gitdir: gitdata\n');
    expect(await read('gitdata/config')).toContain(REFUSED);
    expect(await read('gitdata/logs/HEAD')).toContain(REFUSED);
    expect(await list('gitdata')).toContain(REFUSED);
    expect(await write('gitdata/config')).toContain(REFUSED);
    expect(await write('gitdata/hooks/pre-commit', '#!/bin/sh\nid\n')).toContain(REFUSED);
    expect(readFileSync(join(project, 'gitdata', 'config'), 'utf-8')).toBe(GIT_CONFIG);
  });

  test('a gitdir the project\'s .git names but that does not exist yet is still refused', async () => {
    rmSync(join(project, DOT_GIT), { recursive: true });
    writeFileSync(join(project, DOT_GIT), 'gitdir: gitdata\n');
    mkdirSync(join(project, 'gitdata')); // empty: no HEAD, git would not call it a repo yet
    expect(await write('gitdata/config')).toContain(REFUSED);
    expect(await write('gitdata/HEAD', 'ref: refs/heads/main\n')).toContain(REFUSED);
    expect(existsSync(join(project, 'gitdata', 'config'))).toBe(false);
    // Through a dangling chain: .git -> a -> b, b missing.
    rmSync(join(project, DOT_GIT));
    symlinkSync('a', join(project, DOT_GIT));
    symlinkSync('b', join(project, 'a'));
    expect(await write('b')).toContain(REFUSED);
    expect(existsSync(join(project, 'b'))).toBe(false);
  });

  test('a gitdir a project\'s .git names OUTSIDE the projects dir is refused, from any chat', async () => {
    rmSync(join(project, DOT_GIT), { recursive: true });
    makeGitDir(join(outside, 'external-git'));
    writeFileSync(join(project, DOT_GIT), `gitdir: ${join(outside, 'external-git')}\n`);
    expect(await read(join(outside, 'external-git', 'logs', 'HEAD'))).toContain(REFUSED);
    setDefaultCwd(null);
    expect(await read(join(outside, 'external-git', 'logs', 'HEAD'))).toContain(REFUSED);
    expect(await write(join(outside, 'external-git', 'config'))).toContain(REFUSED);
    expect(readFileSync(join(outside, 'external-git', 'config'), 'utf-8')).toBe(GIT_CONFIG);
  });

  test('a git dir nothing points at -- a bare repo in the tree -- is recognised by its content', async () => {
    makeGitDir(join(project, 'vendor', 'mirror'));
    expect(await read('vendor/mirror/config')).toContain(REFUSED);
    expect(await list('vendor/mirror/refs')).toContain(REFUSED);
    expect(await write('vendor/mirror/hooks/post-update', '#!/bin/sh\nid\n')).toContain(REFUSED);
    expect(existsSync(join(project, 'vendor', 'mirror', 'hooks', 'post-update'))).toBe(false);
  });

  test('a nested repo\'s .git inside the project is refused', async () => {
    makeGitDir(join(project, 'vendor', 'lib', DOT_GIT));
    expect(await read('vendor/lib/.git/config')).toContain(REFUSED);
    expect(await write('vendor/lib/.git/config')).toContain(REFUSED);
  });

  test('a real `git init` repo is recognised', async () => {
    rmSync(join(project, DOT_GIT), { recursive: true });
    const init = Bun.spawnSync(['git', 'init', '-q', '--separate-git-dir', join(project, 'store'), project], {
      env: sanitizedEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(init.exitCode).toBe(0);
    expect(await read('store/config')).toContain(REFUSED);
    expect(await read('store/HEAD')).toContain(REFUSED);
    expect(await write('store/config')).toContain(REFUSED);
  });

  // ── positive controls ──

  test('ordinary project files still read, write and list', async () => {
    expect(await read('src/App.tsx')).toBe('export default 1;\n');
    expect(await write('src/App.tsx', 'export default 2;\n')).toContain('File written successfully');
    expect(readFileSync(join(project, 'src', 'App.tsx'), 'utf-8')).toBe('export default 2;\n');
    expect(await write('index.html', '<p>hi</p>')).toContain('File written successfully');
    expect(await read('.gitignore')).toBe('node_modules\n');
    expect(await write('.gitignore', 'dist\n')).toContain('File written successfully');
    mkdirSync(join(project, '.github', 'workflows'), { recursive: true });
    expect(await write('.github/workflows/ci.yml', 'on: push\n')).toContain('File written successfully');
    mkdirSync(join(project, 'repo.git'));
    expect(await write('repo.git/readme.txt', 'x')).toContain('File written successfully');
    const listing = await list('.');
    expect(listing).toContain('src');
    expect(listing).toContain('index.html');
  });

  test('a git dir outside the site projects can still be read and listed (writes are re-rated, not refused)', async () => {
    setDefaultCwd(null);
    makeGitDir(join(outside, 'myrepo', DOT_GIT));
    const cfg = join(outside, 'myrepo', DOT_GIT, 'config');
    expect(await read(cfg)).toBe(GIT_CONFIG);
    expect(await list(join(outside, 'myrepo', DOT_GIT))).toContain('HEAD');
    expect(await write(cfg, GIT_CONFIG + '[user]\n\tname = me\n')).toContain('File written successfully');
  });

  test('with no site builder registered, only the default cwd is protected', async () => {
    setSiteProjectsDir(null);
    setDefaultCwd(null);
    expect(siteGitRefusal('x', join(project, DOT_GIT, 'config'))).toBeNull();
    setDefaultCwd(project);
    expect(siteGitRefusal('.git/config', join(project, DOT_GIT, 'config'))).toContain(REFUSED);
  });

  test('read_file refuses a FIFO instead of blocking the daemon', async () => {
    const fifo = join(project, 'pipe');
    const made = Bun.spawnSync(['mkfifo', fifo]);
    if (made.exitCode !== 0 || !Bun.which('timeout')) return; // no mkfifo or timeout on this platform
    // A writer that unblocks a reader after a second, so a regression FAILS
    // (the read returns "x") instead of hanging the run. `timeout` bounds it
    // on its own if nothing ever opens the read end, which is the passing case.
    const writer = Bun.spawn(['timeout', '3', 'sh', '-c', 'sleep 1; printf x > "$1"', 'sh', fifo], { stdout: 'ignore', stderr: 'ignore' });
    try {
      expect(await read('pipe')).toContain('Not a regular file');
    } finally {
      writer.kill();
      await writer.exited;
    }
  });
});

// ── (b) exec-on-write paths are rated execute_command ────────────────────────

describe('write_file is rated execute_command for paths that run as code', () => {
  const gateFor = (path: string) => resolveToolGate(writeFileTool, 'write_file', { path, content: 'x' });

  const EXEC_PATHS = [
    '~/.bashrc', '/home/u/.bash_profile', '/home/u/.profile', '/home/u/.zshrc', '/home/u/.zshenv', '/root/.bashrc',
    '/home/u/.config/fish/config.fish', '/home/u/.pam_environment', '/home/u/.config/environment.d/10-x.conf',
    'C:\\Users\\u\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
    '/home/u/.gitconfig', '/home/u/.config/git/config', '/etc/gitconfig',
    '/home/u/code/repo/.git/config', '/home/u/code/repo/.git/hooks/pre-commit', 'repo/.git/hooks/post-checkout',
    '/home/u/.config/autostart/x.desktop', '/etc/xdg/autostart/x.desktop',
    'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat',
    '/home/u/.config/systemd/user/x.service', '/home/u/.local/share/systemd/user/x.timer', '/etc/systemd/system/x.service',
    '/Users/u/Library/LaunchAgents/com.x.plist', '/Library/LaunchDaemons/com.x.plist',
    '/var/spool/cron/crontabs/u', '/var/spool/cron/u', '/etc/crontab', '/etc/cron.d/x',
    '/home/u/.ssh/authorized_keys', '/home/u/.ssh/config', '/home/u/.ssh/rc',
    '/home/u/.vimrc', '/home/u/.vim/plugin/x.vim', '/home/u/.config/nvim/init.lua', '/home/u/.emacs.d/init.el',
    '/home/u/.tmux.conf', '/home/u/.npmrc', '/home/u/.yarnrc.yml', '/home/u/.bunfig.toml',
    '/home/u/.local/lib/python3.12/site-packages/evil.pth', '/home/u/.jarvis/config.yaml',
  ];

  test.each(EXEC_PATHS)('%s', (path) => {
    const gate = gateFor(path);
    expect(gate.actionCategory).toBe('execute_command');
    expect(gate.floorCategory).toBe('write_data');
    expect(gate.categories).toEqual(['execute_command', 'write_data']);
    expect(gate.confirm).toBe('above_level');
    expect(gate.intent).toContain('can run as code');
    expect(gate.intent!.endsWith(resolve(project, path))).toBe(true);
  });

  test('case, separator and trailing-dot spellings are the same file', () => {
    for (const path of ['/home/u/.BASHRC', '/home/u/.SSH/Authorized_Keys', '/home/u/.Git/config', 'C:\\Users\\u\\.gitconfig',
      '/home/u/.bashrc.', '/home/u/.Config/Autostart/x.desktop', '/home/u/.git./config']) {
      expect(gateFor(path).actionCategory).toBe('execute_command');
    }
  });

  test('relative paths under a site cwd are judged by name, whatever they resolve to', () => {
    setDefaultCwd(project);
    for (const path of ['.bashrc', '../../.bashrc', '.git/config', 'sub/.git/hooks/pre-commit', '.npmrc', '.ssh/config']) {
      expect(gateFor(path).actionCategory).toBe('execute_command');
    }
  });

  test('a symlink to an exec file is judged by its target', () => {
    const home = join(root, 'home');
    mkdirSync(join(home, 'dotfiles'), { recursive: true });
    writeFileSync(join(home, '.zshrc'), '# rc\n');
    symlinkSync(join(home, '.zshrc'), join(outside, 'notes.txt'));
    expect(gateFor(join(outside, 'notes.txt')).actionCategory).toBe('execute_command');
    // Dangling: the write would create ~/.config/autostart/x.desktop.
    symlinkSync(join(home, '.config', 'autostart', 'x.desktop'), join(outside, 'later.txt'));
    expect(gateFor(join(outside, 'later.txt')).actionCategory).toBe('execute_command');
    expect(resolveReal(join(outside, 'later.txt'))).toBe(join(home, '.config', 'autostart', 'x.desktop'));
  });

  test('a dotfile manager\'s real file is recognised through the home symlink', () => {
    const home = join(root, 'home');
    mkdirSync(join(home, 'dotfiles', 'ssh'), { recursive: true });
    writeFileSync(join(home, 'dotfiles', 'bashrc'), '# rc\n');
    symlinkSync(join(home, 'dotfiles', 'bashrc'), join(home, '.bashrc'));
    symlinkSync(join(home, 'dotfiles', 'ssh'), join(home, '.ssh'));
    expect(execOnWriteClass(join(home, 'dotfiles', 'bashrc'), { home, cwd: null })).toBe('a shell startup file');
    expect(execOnWriteClass(join(home, 'dotfiles', 'ssh', 'authorized_keys'), { home, cwd: null })).toBe('SSH configuration or keys');
    expect(execOnWriteClass(join(home, 'dotfiles', 'vimrc-notes.md'), { home, cwd: null })).toBeNull();
  });

  test('a git dir by content -- bare repo, gitfile target -- is git, whatever its name', () => {
    makeGitDir(join(outside, 'mirror.git'));
    expect(gateFor(join(outside, 'mirror.git', 'config')).actionCategory).toBe('execute_command');
    expect(gateFor(join(outside, 'mirror.git', 'hooks', 'post-receive')).actionCategory).toBe('execute_command');
  });

  test('overwriting an existing executable is execute_command; a plain file is not', () => {
    const script = join(outside, 'deploy.sh');
    writeFileSync(script, 'echo deploy\n');
    chmodSync(script, 0o755);
    expect(gateFor(script).actionCategory).toBe('execute_command');
    chmodSync(script, 0o700);
    expect(gateFor(script).actionCategory).toBe('execute_command');
    chmodSync(script, 0o644);
    expect(gateFor(script).actionCategory).toBe('write_data');
  });

  test('on a 0777-everything mount (WSL /mnt/c) the content decides', () => {
    const doc = join(outside, 'notes.txt');
    writeFileSync(doc, 'just words\n');
    chmodSync(doc, 0o777);
    expect(gateFor(doc).actionCategory).toBe('write_data');
    for (const [name, head] of [['run.sh', '#!/bin/sh\n'], ['tool', '\x7fELF'], ['setup.exe', 'MZ\x90\x00']] as const) {
      const file = join(outside, name);
      writeFileSync(file, head, 'latin1');
      chmodSync(file, 0o777);
      expect(gateFor(file).actionCategory).toBe('execute_command');
    }
  });

  test('Jarvis\'s data dir is execute_command, except the site projects inside it', () => {
    const data = join(root, 'data');
    mkdirSync(join(data, 'cache', 'engine', 'abc'), { recursive: true });
    writeFileSync(join(data, 'cache', 'engine', 'abc', 'main.js'), 'module.exports = 1;\n');
    setDaemonDataRoots([data]);
    setSiteProjectsDir(join(data, 'projects'));
    mkdirSync(join(data, 'projects', 'app', 'src'), { recursive: true });
    try {
      expect(gateFor(join(data, 'cache', 'engine', 'abc', 'main.js')).actionCategory).toBe('execute_command');
      expect(gateFor(join(data, 'config.yaml')).actionCategory).toBe('execute_command');
      expect(gateFor(join(data, 'projects', 'app', 'src', 'App.tsx')).actionCategory).toBe('write_data');
    } finally {
      setDaemonDataRoots([]);
    }
    // By name too, for a sidecar's own ~/.jarvis.
    expect(gateFor('/home/u/.jarvis/cache/engine/abc/main.js').actionCategory).toBe('execute_command');
    expect(gateFor('/home/u/.jarvis/projects/app/src/App.tsx').actionCategory).toBe('write_data');
    expect(gateFor('/home/u/.jarvis/projects/../config.yaml').actionCategory).toBe('execute_command');
  });

  test('spellings Windows and HFS+ read differently are judged as the file they open', () => {
    for (const path of [
      'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\x\\..\\Startup\\a.bat',
      'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup.\\a.bat',
      'C:\\Users\\u\\.gitconfig::$DATA', 'C:\\Users\\u\\.ssh.\\authorized_keys',
      'C:\\Users\\u\\AppData\\Roaming\\MICROS~1\\Windows\\STARTU~1\\a.bat',
      '/Users/u/.zsh\u200crc', '/private/etc/crontab', '/home/u/./.config/../.config/systemd/user/x.service',
    ]) {
      expect(gateFor(path).actionCategory).toBe('execute_command');
    }
  });

  test('more places that run what is written there', () => {
    for (const path of [
      '/home/u/.bash_aliases', '/home/u/.bashrc.d/10-x.sh', '/home/u/.gitconfig.local', '/home/u/repo/.husky/pre-commit',
      '/home/u/repo/.pre-commit-config.yaml', '/home/u/repo/lefthook.yml', '/home/u/.gnupg/gpg-agent.conf', '/home/u/.aws/config',
      '/home/u/.kube/config', '/home/u/.cargo/config.toml', '/home/u/.gradle/init.d/x.gradle', '/home/u/.ipython/profile_default/startup/x.py',
      '/home/u/.gdbinit', '/home/u/.psqlrc', '/home/u/.config/hypr/hyprland.conf', '/home/u/.config/i3/config',
      '/home/u/.config/plasma-workspace/env/x.sh', '/home/u/.local/share/applications/firefox.desktop',
      '/home/u/.local/share/dbus-1/services/x.service', '/home/u/.config/direnv/direnvrc',
    ]) {
      expect(gateFor(path).actionCategory).toBe('execute_command');
    }
  });

  test('a file put straight into a dir with objects/ and refs/ can complete a git dir', () => {
    const half = join(outside, 'half');
    mkdirSync(join(half, 'objects'), { recursive: true });
    mkdirSync(join(half, 'refs'), { recursive: true });
    expect(gateFor(join(half, 'HEAD')).actionCategory).toBe('execute_command');
    expect(gateFor(join(half, 'config')).actionCategory).toBe('execute_command');
  });

  test('a non-string path is judged as the string it will be written as', () => {
    expect(execOnWriteClass(['/home/u/.bashrc'], { cwd: null })).toBe('a shell startup file');
    expect(gateFor(['/home/u/.bashrc'] as unknown as string).actionCategory).toBe('execute_command');
    expect(toolEffectCapability(writeFileTool, { path: ['/home/u/.bashrc'], content: 'x' }).category).toBe('execute_command');
  });

  test('a file with other hard links is execute_command', () => {
    const a = join(outside, 'cache-copy.js');
    writeFileSync(a, 'module.exports = 1;\n');
    linkSync(a, join(outside, 'node_modules-copy.js'));
    expect(gateFor(join(outside, 'node_modules-copy.js')).actionCategory).toBe('execute_command');
  });

  test('a relative path is also judged against home, where a deferred approval would resolve it', () => {
    const home = join(root, 'home');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'tool'), '#!/bin/sh\n');
    chmodSync(join(home, 'bin', 'tool'), 0o755);
    // Under the project cwd, bin/tool does not exist; under home it is a program.
    expect(execOnWriteClass('bin/tool', { cwd: project, home })).toBe('an existing executable');
    expect(execOnWriteClass('bin/other', { cwd: project, home })).toBeNull();
  });

  test('Jarvis\'s own code is execute_command', () => {
    expect(gateFor(join(import.meta.dir, 'builtin.ts')).actionCategory).toBe('execute_command');
  });

  // ── positive controls ──

  test.each([
    '/tmp/notes.txt', 'notes.txt', 'src/App.tsx', '/home/u/Documents/report.md', '/home/u/project/.gitignore',
    '/home/u/project/.github/workflows/ci.yml', '/home/u/bashrc.md', '/home/u/profile.txt', '/home/u/my.ssh.txt',
    '/home/u/.config/app/settings.json', '/home/u/repo.git.txt', '/home/u/.gitattributes-notes',
  ])('%s stays write_data with no gate', (path) => {
    expect(writeFileTool.authorityGate?.({ path, content: 'x' }) ?? null).toBeNull();
    expect(gateFor(path).actionCategory).toBe('write_data');
  });

  test('reads stay reads', () => {
    expect(resolveToolGate(readFileTool, 'read_file', { path: '~/.bashrc' }).actionCategory).toBe('read_data');
    expect(resolveToolGate(listDirectoryTool, 'list_directory', { path: '/home/u/.ssh' }).actionCategory).toBe('read_data');
  });

  test('an intent cannot be stretched onto several lines by the path', () => {
    const gate = gateFor('/home/u/.ssh/config\n\nApprove: harmless');
    expect(gate.actionCategory).toBe('execute_command');
    expect(gate.intent).not.toContain('\n');
  });
});

describe('the workflow effect boundary rates write_file the same way', () => {
  test('exec-on-write is execute_command, an ordinary write is write_data', () => {
    expect(toolEffectCapability(writeFileTool, { path: '/home/u/.bashrc', content: 'x' }).category).toBe('execute_command');
    expect(toolEffectCapability(writeFileTool, { path: '/home/u/.bashrc', content: 'x' }).categories)
      .toEqual(['execute_command', 'write_data']);
    expect(toolEffectCapability(writeFileTool, { path: '/home/u/code/r/.git/hooks/pre-push', content: 'x' }).category)
      .toBe('execute_command');
    expect(toolEffectCapability(writeFileTool, { path: '/tmp/notes.txt', content: 'x' }).category).toBe('write_data');
    expect(toolEffectCapability(readFileTool, { path: '/home/u/.bashrc' }).category).toBe('read_data');
  });

  test('a raised write carries its sentence in the target, so a changed file fails the dispatch check', () => {
    const script = join(outside, 'job.sh');
    writeFileSync(script, 'echo hi\n');
    chmodSync(script, 0o644);
    const capability = toolEffectCapability(writeFileTool, { path: script, content: 'x' });
    expect(capability.category).toBe('write_data');
    const args = capability.prepareArguments({ path: script, content: 'x' });
    const reviewed = capability.target(args);
    expect(reviewed.intent).toBeUndefined();
    chmodSync(script, 0o755);
    const now = capability.target(args);
    expect(now.intent).toContain('can run as code');
    expect(JSON.stringify(now)).not.toBe(JSON.stringify(reviewed));
  });
});

// ── An approval must not run a call that has since become something else ─────

describe('an approved write_file whose target changed since review', () => {
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());

  function executorWith(mgr: ApprovalManager): DeferredExecutor {
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const ex = new DeferredExecutor(mgr, new AuditTrail());
    ex.setToolRegistry(registry);
    return ex;
  }

  function approvedWrite(mgr: ApprovalManager, path: string, category: 'write_data' | 'execute_command') {
    const args = { path, content: 'echo pwned\n' };
    const gate = resolveToolGate(writeFileTool, 'write_file', args);
    const req = mgr.createRequest({ agentId: 'a1', agentName: 'PA', toolName: 'write_file', toolArguments: args,
      actionCategory: category, urgency: 'normal', reason: 'test', context: gateContext(gate, 'write_file', args) });
    mgr.approve(req.id, 'dashboard');
    return req;
  }

  test('a plain write that has become exec-on-write is blocked, and the file is untouched', async () => {
    const mgr = new ApprovalManager();
    const script = join(outside, 'job.sh');
    writeFileSync(script, 'echo hi\n');
    chmodSync(script, 0o644);
    const req = approvedWrite(mgr, script, 'write_data');
    chmodSync(script, 0o755); // between the click and the run
    const result = await executorWith(mgr).executeApproved(req.id);
    expect(result).toContain('was NOT executed');
    expect(result).toContain('execute_command');
    expect(readFileSync(script, 'utf-8')).toBe('echo hi\n');
    expect(mgr.getRequest(req.id)).toMatchObject({ status: 'executed', execution_outcome: 'blocked' });
  });

  test('an approval of the exec-on-write write itself runs', async () => {
    const mgr = new ApprovalManager();
    const rc = join(outside, '.bashrc');
    writeFileSync(rc, '# rc\n');
    const req = approvedWrite(mgr, rc, 'execute_command');
    expect(await executorWith(mgr).executeApproved(req.id)).toContain('File written successfully');
    expect(readFileSync(rc, 'utf-8')).toBe('echo pwned\n');
  });

  test('a plain write that is still plain runs', async () => {
    const mgr = new ApprovalManager();
    const note = join(outside, 'note.txt');
    const req = approvedWrite(mgr, note, 'write_data');
    expect(await executorWith(mgr).executeApproved(req.id)).toContain('File written successfully');
    expect(readFileSync(note, 'utf-8')).toBe('echo pwned\n');
  });
});

// ── Refusal before sidecar routing ───────────────────────────────────────────

describe('an approval clicked after the site turn ended', () => {
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());

  test('a relative exec-on-write path approved in a site chat does not run against another dir', async () => {
    // Approved while the cwd is the project: the card names <project>/.bashrc.
    const mgr = new ApprovalManager();
    const args = { path: '.bashrc', content: 'echo pwned\n' };
    const gate = resolveToolGate(writeFileTool, 'write_file', args);
    expect(gate.intent).toContain(join(project, '.bashrc'));
    const req = mgr.createRequest({ agentId: 'a1', agentName: 'PA', toolName: 'write_file', toolArguments: args,
      actionCategory: gate.actionCategory, urgency: 'normal', reason: 'test', context: gateContext(gate, 'write_file', args) });
    mgr.approve(req.id, 'dashboard');
    // The turn ends; ws-service clears the cwd; the click arrives.
    setDefaultCwd(null);
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const ex = new DeferredExecutor(mgr, new AuditTrail());
    ex.setToolRegistry(registry);
    const result = await ex.executeApproved(req.id);
    expect(result).toContain('changed after approval');
    expect(mgr.getRequest(req.id)).toMatchObject({ execution_outcome: 'blocked' });
    expect(existsSync(join(project, '.bashrc'))).toBe(false);
  });

  test('the same approval run while the cwd is unchanged writes the file it named', async () => {
    const mgr = new ApprovalManager();
    const args = { path: '.bashrc', content: 'echo ok\n' };
    const gate = resolveToolGate(writeFileTool, 'write_file', args);
    const req = mgr.createRequest({ agentId: 'a1', agentName: 'PA', toolName: 'write_file', toolArguments: args,
      actionCategory: gate.actionCategory, urgency: 'normal', reason: 'test', context: gateContext(gate, 'write_file', args) });
    mgr.approve(req.id, 'dashboard');
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const ex = new DeferredExecutor(mgr, new AuditTrail());
    ex.setToolRegistry(registry);
    expect(await ex.executeApproved(req.id)).toContain('File written successfully');
    expect(readFileSync(join(project, '.bashrc'), 'utf-8')).toBe('echo ok\n');
  });
});

describe('a workflow flow step whose file changed kind after review', () => {
  beforeEach(() => initWorkflowDb(':memory:'));
  afterEach(() => closeWorkflowDb());

  function flowStep() {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: 'write step', trigger: {
      name: 'trigger', type: 'EMPTY', nextAction: { name: 'action', type: 'PIECE', settings: {
        pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1', actionName: 'invoke', input: {} } },
    } });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const approvals = new ApprovalManager();
    const backends = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(),
      llmManager: {}, wsService: {}, eventBuffer: new WorkflowEventBuffer(), toolRegistry: registry,
      authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: ['write_data', 'execute_command'], overrides: [],
        context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
      emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), approvalManager: approvals,
      onWorkflowApproval: () => {}, channelService: {},
    } as unknown as BuildServiceBackendsOptions);
    const context = { runId: run.id, projectId: run.projectId, stepName: 'action', executionPath: [] };
    return { approvals, invoke: (params: Record<string, unknown>) => backends.toolsInvoke!({ toolName: 'write_file', params }, context) };
  }

  test('a plain write reviewed as write_data is not dispatched once the file is executable', async () => {
    setDefaultCwd(null);
    const script = join(outside, 'job.sh');
    writeFileSync(script, 'echo hi\n');
    chmodSync(script, 0o644);
    const f = flowStep();
    const params = { path: script, content: 'echo pwned\n' };
    const parked = await f.invoke(params);
    expect(parked.approval).toBeDefined();
    chmodSync(script, 0o755);
    f.approvals.approve(parked.approval!.approvalId, 'test');
    await expect(f.invoke(params)).rejects.toThrow(/changed/);
    expect(readFileSync(script, 'utf-8')).toBe('echo hi\n');
  });

  test('the same step with the file unchanged is dispatched under its approval', async () => {
    setDefaultCwd(null);
    const note = join(outside, 'note.txt');
    const f = flowStep();
    const params = { path: note, content: 'hello\n' };
    const parked = await f.invoke(params);
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.invoke(params);
    expect(String(done.result)).toContain('File written successfully');
    expect(readFileSync(note, 'utf-8')).toBe('hello\n');
  });
});

describe('review follow-ups', () => {
  test('write_file refuses a FIFO instead of blocking in open()', async () => {
    const fifo = join(project, 'wpipe');
    if (Bun.spawnSync(['mkfifo', fifo]).exitCode !== 0 || !Bun.which('timeout')) return;
    // A reader that unblocks a regressed writer after a second, so a
    // regression fails instead of hanging; bounded on its own by `timeout`.
    const reader = Bun.spawn(['timeout', '3', 'sh', '-c', 'sleep 1; cat "$1" > /dev/null', 'sh', fifo], { stdout: 'ignore', stderr: 'ignore' });
    try {
      expect(await write('wpipe')).toContain('Not a regular file');
    } finally {
      reader.kill();
      await reader.exited;
    }
  });

  test('a `.git` that points at / or home does not make every path a git dir', async () => {
    rmSync(join(project, DOT_GIT), { recursive: true });
    symlinkSync('/', join(project, DOT_GIT));
    setDefaultCwd(null);
    expect(siteGitRefusal('x', join(outside, 'notes.txt'))).toBeNull();
    rmSync(join(project, DOT_GIT));
    writeFileSync(join(project, DOT_GIT), `gitdir: ${homedir()}\n`);
    expect(siteGitRefusal('x', join(outside, 'notes.txt'))).toBeNull();
    writeFileSync(join(project, DOT_GIT), `gitdir: ${root}\n`);
    expect(siteGitRefusal('x', join(outside, 'notes.txt'))).toBeNull();
  });

  test('8.3 short names count only in a Windows path', () => {
    expect(execOnWriteClass('C:\\Users\\u\\STARTU~1\\a.bat', { cwd: null })).toBe('a Windows 8.3 short name, which may hide where it lands');
    expect(execOnWriteClass('/tmp/notes/backup~1', { cwd: null })).toBeNull();
    expect(execOnWriteClass('/tmp/v1~2.txt', { cwd: null })).toBeNull();
  });

  test('a site projects dir configured inside ~/.jarvis is not Jarvis\'s own data', () => {
    setSiteProjectsDir('/home/u/.jarvis/sites');
    expect(execOnWriteClass('/home/u/.jarvis/sites/app/src/App.tsx', { cwd: null })).toBeNull();
    expect(execOnWriteClass('/home/u/.jarvis/config.yaml', { cwd: null })).toBe("Jarvis's own data, configuration or code");
  });

  test('installed code and the configs that pick a shell or interpreter', () => {
    for (const path of [
      '/home/u/.local/lib/python3.12/site-packages/requests/__init__.py', '/usr/lib/python3/dist-packages/x.py',
      '/home/u/.nvm/versions/node/v20/lib/node_modules/npm/lib/cli.js', '/home/u/.bun/install/global/node_modules/x/index.js',
      '/home/u/.config/Code/User/settings.json', '/home/u/.vscode/extensions/x/extension.js', '/home/u/.config/kitty/kitty.conf',
      '/home/u/.config/alacritty/alacritty.toml', '/home/u/.wezterm.lua', '/home/u/.config/awesome/rc.lua',
      '/home/u/.config/sxhkd/sxhkdrc', '/home/u/.local/share/kio/servicemenus/x.desktop', '/home/u/.mailcap',
      '/home/u/.config/mise/config.toml',
    ]) {
      expect(execOnWriteClass(path, { cwd: null })).not.toBeNull();
    }
  });
});

describe('the site git refusal runs before a call is routed to a sidecar', () => {
  test('an explicit target does not carry a site .git path past the refusal', async () => {
    for (const tool of [readFileTool, writeFileTool, listDirectoryTool]) {
      const out = String(await tool.execute({ path: '.git/config', content: 'x', target: 'my-laptop' }));
      expect(out).toContain(REFUSED);
    }
  });
});

afterAll(() => {
  setDefaultCwd(null);
  setSiteProjectsDir(null);
});
