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
 * code is execute_command, through the agent gate (resolveToolGate), the
 * workflow effect boundary and the deferred executor alike, and an ordinary
 * path stays write_data.
 *
 * Nothing here touches the real home: the policy's home is a temp dir
 * (setPolicyHome; Bun's homedir() ignores a HOME changed at runtime), and the
 * tools resolve a relative path against it when no site chat is active.
 *
 * Git dirs are laid out by hand (HEAD, objects/, refs/, config) -- the shape
 * git itself recognises -- so no git subprocess runs here except the one test
 * that checks a real `git init`, which gets a sanitised env so a pre-commit
 * hook's GIT_DIR cannot leak into it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listDirectoryTool, readFileTool, setDefaultCwd, writeFileTool } from './builtin.ts';
import {
  execOnWrite, execOnWriteClass, relativeBases, resolveReal, routedGitRefusal, setDaemonDataRoots, setPolicyHome, setSiteProjectsDir,
  siteGitRefusal,
} from './file-path-policy.ts';
import { ToolRegistry } from './registry.ts';
import { freezeToolArguments, gateContext, resolveToolGate } from '../../authority/tool-action-map.ts';
import { ApprovalManager, approvalIntentFromContext } from '../../authority/approval.ts';
import { AgentOrchestrator } from '../../agents/orchestrator.ts';
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
const JARVIS = "Jarvis's own code, configuration or keys";

let root: string;
let home: string;
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

const read = async (path: string, extra: Record<string, unknown> = {}) => String(await readFileTool.execute({ path, ...extra }));
const write = async (path: string, content = 'PWNED', extra: Record<string, unknown> = {}) =>
  String(await writeFileTool.execute({ path, content, ...extra }));
const list = async (path: string, extra: Record<string, unknown> = {}) => String(await listDirectoryTool.execute({ path, ...extra }));
const gateFor = (path: string) => resolveToolGate(writeFileTool, 'write_file', { path, content: 'x' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-522-'));
  home = join(root, 'home');
  projectsDir = join(root, 'projects');
  project = join(projectsDir, 'app');
  outside = join(root, 'outside');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  makeGitDir(join(project, DOT_GIT));
  writeFileSync(join(project, 'src', 'App.tsx'), 'export default 1;\n');
  writeFileSync(join(project, '.gitignore'), 'node_modules\n');
  setPolicyHome(home);
  setSiteProjectsDir(projectsDir);
  setDefaultCwd(project);
});

afterEach(() => {
  setDefaultCwd(null);
  setSiteProjectsDir(null);
  setDaemonDataRoots({});
  setPolicyHome(null);
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
    expect(await read('.git/logs/HEAD')).not.toContain('ghp_REFLOGSECRET');
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

  test('`..` after a symlink is resolved as the kernel resolves it, not lexically', async () => {
    // h -> .git/hooks, so h/../config opens .git/config; path.resolve would say <project>/config.
    symlinkSync(join(DOT_GIT, 'hooks'), join(project, 'h'));
    expect(resolveReal('h/../config', project)).toBe(join(realProject(), DOT_GIT, 'config'));
    expect(siteGitRefusal('h/../config', relativeBases())).toContain(REFUSED);
    expect(siteGitRefusal(`${project}/h/../config`, relativeBases())).toContain(REFUSED);
    // The spelling a sidecar would be handed as-is.
    for (const tool of [read, list]) expect(await tool('h/../config', { target: 'same-machine' })).toContain(REFUSED);
    expect(await write('h/../config', 'x', { target: 'same-machine' })).toContain(REFUSED);
    expect(readFileSync(configPath(), 'utf-8')).toBe(GIT_CONFIG);
  });

  test('a relative path is also judged against `/`, a launchd sidecar\'s cwd', async () => {
    setDefaultCwd(null);
    const fromRoot = join(project, DOT_GIT, 'logs', 'HEAD').slice(1); // e.g. tmp/jarvis-522-x/projects/app/.git/logs/HEAD
    expect(await read(fromRoot, { target: 'same-machine' })).toContain(REFUSED);
    expect(await write(fromRoot, 'x', { target: 'same-machine' })).toContain(REFUSED);
    expect(await read(fromRoot)).toContain(REFUSED);
    expect(readFileSync(join(project, DOT_GIT, 'logs', 'HEAD'), 'utf-8')).toBe(REFLOG);
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
    setSiteProjectsDir(projectsDir); // drop the cached scan: .git changed in place
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

  test('a project that is a symlink into the projects dir is protected too', async () => {
    setDefaultCwd(null);
    const real = join(outside, 'realproj');
    mkdirSync(real);
    makeGitDir(join(outside, 'store'));
    writeFileSync(join(real, DOT_GIT), `gitdir: ${join(outside, 'store')}\n`);
    symlinkSync(real, join(projectsDir, 'linked'));
    expect(await read(join(outside, 'store', 'config'))).toContain(REFUSED);
    expect(await write(join(outside, 'store', 'hooks', 'pre-commit'), '#!/bin/sh\nid\n')).toContain(REFUSED);
    expect(existsSync(join(outside, 'store', 'hooks', 'pre-commit'))).toBe(false);
  });

  test('a symlinked project with a real .git directory is protected at its real path too', async () => {
    setDefaultCwd(null);
    const real = join(outside, 'realproj2');
    makeGitDir(join(real, DOT_GIT));
    symlinkSync(real, join(projectsDir, 'linked2'));
    expect(await read(join(real, DOT_GIT, 'config'))).toContain(REFUSED);
    expect(await read(join(real, DOT_GIT, 'logs', 'HEAD'))).toContain(REFUSED);
    expect(await write(join(real, DOT_GIT, 'hooks', 'pre-commit'), '#!/bin/sh\nid\n')).toContain(REFUSED);
    expect(existsSync(join(real, DOT_GIT, 'hooks', 'pre-commit'))).toBe(false);
  });

  test('a symlinked project\'s relative gitfile resolves from the link\'s target, as git resolves it', async () => {
    // What `git worktree add --relative-paths` writes: the main repo's
    // worktree dir, relative to where the worktree really is.
    setDefaultCwd(null);
    const main = join(outside, 'a', 'main');
    makeGitDir(join(main, DOT_GIT));
    makeGitDir(join(main, DOT_GIT, 'worktrees', 'site'));
    writeFileSync(join(main, DOT_GIT, 'worktrees', 'site', 'commondir'), '../..\n');
    const site = join(outside, 'a', 'site');
    mkdirSync(site);
    writeFileSync(join(site, DOT_GIT), 'gitdir: ../main/.git/worktrees/site\n');
    symlinkSync(site, join(projectsDir, 'site'));
    expect(await read(join(main, DOT_GIT, 'logs', 'HEAD'))).toContain(REFUSED);
    expect(await read(join(main, DOT_GIT, 'worktrees', 'site', 'HEAD'))).toContain(REFUSED);
  });

  test('a symlinked project\'s .git -> ../store.git that does not exist yet is protected where it will be', async () => {
    setDefaultCwd(null);
    const site = join(outside, 'b', 'site');
    mkdirSync(site, { recursive: true });
    symlinkSync('../store.git', join(site, DOT_GIT));
    symlinkSync(site, join(projectsDir, 'site2'));
    expect(await write(join(outside, 'b', 'store.git', 'config'))).toContain(REFUSED);
    expect(existsSync(join(outside, 'b', 'store.git'))).toBe(false);
  });

  test('a gitfile target with `..` after a symlink lands where the kernel puts it', async () => {
    setDefaultCwd(null);
    rmSync(join(project, DOT_GIT), { recursive: true });
    mkdirSync(join(outside, 'c', 'deep'), { recursive: true });
    makeGitDir(join(outside, 'c', 'gd'));
    symlinkSync(join(outside, 'c', 'deep'), join(project, 'l'));
    writeFileSync(join(project, DOT_GIT), 'gitdir: l/../gd\n');
    expect(await read(join(outside, 'c', 'gd', 'config'))).toContain(REFUSED);
  });

  test('a gitfile padded past 64 KiB is still read, as git reads one up to 1 MiB', async () => {
    rmSync(join(project, DOT_GIT), { recursive: true });
    writeFileSync(join(project, DOT_GIT), `gitdir: ${join(outside, 'padded')}\n${'\n'.repeat(70 * 1024)}`);
    setDefaultCwd(null);
    expect(await write(join(outside, 'padded', 'config'))).toContain(REFUSED);
  });

  test('a relative git path routed to a sidecar is refused: its cwd is unknown here', async () => {
    setDefaultCwd(null);
    for (const path of ['app/.git/config', 'x/.GIT/hooks/pre-commit']) {
      expect(await read(path, { target: 'hand-started' })).toContain('relative, drive-letter or network path into a git directory');
      expect(await write(path, 'x', { target: 'hand-started' })).toContain('relative, drive-letter or network path into a git directory');
    }
    // Not routed: judged where it resolves (home), which is no site project.
    expect(await read('some/.git/config')).toContain('File not found');
  });

  test('a process-relative path routed to a sidecar is refused: it names the sidecar\'s cwd, not the brain\'s', async () => {
    // An XDG-autostarted sidecar has cwd = home, so this is the brain's
    // project reflog if the sidecar runs here; judged here, /proc/self is the brain.
    const viaCwd = '/proc/self/cwd/.jarvis/projects/app/.git/logs/HEAD';
    for (const path of [viaCwd, '/proc/thread-self/cwd/x/.git/config', '/proc/4242/root/etc/passwd', '/dev/fd/3',
      '//proc//self/cwd/notes.txt', '\\proc\\self\\cwd\\x', '/./proc/self/cwd/x', '/tmp/../proc/self/root',
      '/proc/net/../cwd/.jarvis/projects/app/.git/logs/HEAD', '/proc/sys/../self/cwd/x']) {
      expect(await read(path, { target: 'autostarted' })).toContain('process-relative path');
      expect(await write(path, 'x', { target: 'autostarted' })).toContain('process-relative path');
      expect(await list(path, { target: 'autostarted' })).toContain('process-relative path');
    }
    // Not process-relative: judged as usual.
    expect(routedGitRefusal('/proc/cpuinfo')).toBeNull();
    expect(routedGitRefusal('/procedures/self/x')).toBeNull();
  });

  test('a drive-letter or network git path routed to a sidecar cannot be placed, so it is refused', async () => {
    setDefaultCwd(null);
    for (const path of ['C:/work/app/.git/config', 'C:\\work\\app\\.git\\hooks\\pre-commit', 'd:/x/.GIT/config',
      '\\\\wsl.localhost\\U\\x\\.git\\config', '//wsl$/U/x/.git/config', '\\\\?\\C:\\x\\.git\\config']) {
      expect(await read(path, { target: 'linux-box' })).toContain('drive-letter or network path into a git directory');
      expect(await write(path, 'x', { target: 'linux-box' })).toContain('drive-letter or network path into a git directory');
    }
    expect(routedGitRefusal('//wsl$/U/x/notes.txt')).toBeNull();
    expect(routedGitRefusal('C:/work/app/notes.txt')).toBeNull();
    expect(routedGitRefusal(join(project, DOT_GIT, 'config'))).toBeNull(); // absolute POSIX: siteGitRefusal's job
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

  test('a `.git` that points at / or home does not make every path a git dir', () => {
    rmSync(join(project, DOT_GIT), { recursive: true });
    symlinkSync('/', join(project, DOT_GIT));
    setDefaultCwd(null);
    expect(siteGitRefusal(join(outside, 'notes.txt'), relativeBases())).toBeNull();
    rmSync(join(project, DOT_GIT));
    writeFileSync(join(project, DOT_GIT), `gitdir: ${home}\n`);
    setSiteProjectsDir(projectsDir);
    expect(siteGitRefusal(join(outside, 'notes.txt'), relativeBases())).toBeNull();
    writeFileSync(join(project, DOT_GIT), `gitdir: ${root}\n`);
    setSiteProjectsDir(projectsDir);
    expect(siteGitRefusal(join(outside, 'notes.txt'), relativeBases())).toBeNull();
  });

  test('with no site builder registered, only the default cwd is protected', () => {
    setSiteProjectsDir(null);
    setDefaultCwd(null);
    expect(siteGitRefusal(join(project, DOT_GIT, 'config'), relativeBases())).toBeNull();
    setDefaultCwd(project);
    expect(siteGitRefusal('.git/config', relativeBases())).toContain(REFUSED);
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

  test('with no site chat, a relative path goes to the (test) home, never anywhere else', async () => {
    setDefaultCwd(null);
    expect(await write('notes.txt', 'hi')).toContain(join(home, 'notes.txt'));
    expect(readFileSync(join(home, 'notes.txt'), 'utf-8')).toBe('hi');
  });

  // ── non-regular files ──

  test('read_file refuses a FIFO instead of blocking the daemon', async () => {
    const fifo = join(project, 'pipe');
    if (Bun.spawnSync(['mkfifo', fifo]).exitCode !== 0 || !Bun.which('timeout')) return; // no mkfifo or timeout here
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

  test('write_file refuses a FIFO instead of blocking in open()', async () => {
    const fifo = join(project, 'wpipe');
    if (Bun.spawnSync(['mkfifo', fifo]).exitCode !== 0 || !Bun.which('timeout')) return;
    const reader = Bun.spawn(['timeout', '3', 'sh', '-c', 'sleep 1; cat "$1" > /dev/null', 'sh', fifo], { stdout: 'ignore', stderr: 'ignore' });
    try {
      expect(await write('wpipe')).toContain('Not a regular file');
    } finally {
      reader.kill();
      await reader.exited;
    }
  });

  test('through a symlink to a hard-linked file, the file the link names is replaced and the link survives', async () => {
    const cache = join(outside, 'cache.js');
    writeFileSync(cache, 'orig\n');
    const target = join(outside, 'target.js');
    linkSync(cache, target);
    symlinkSync(target, join(project, 'alias.js'));
    expect(await write('alias.js', 'new\n')).toContain('File written successfully');
    expect(readFileSync(join(project, 'alias.js'), 'utf-8')).toBe('new\n');
    expect(readFileSync(target, 'utf-8')).toBe('new\n');
    expect(readFileSync(cache, 'utf-8')).toBe('orig\n');
    expect(lstatSync(join(project, 'alias.js')).isSymbolicLink()).toBe(true);
  });

  test('a file with other hard links is replaced, not written through: the other name keeps its content and mode', async () => {
    const cache = join(outside, 'cache-copy.js');
    writeFileSync(cache, 'module.exports = 1;\n');
    chmodSync(cache, 0o640);
    mkdirSync(join(project, 'node_modules'));
    const linked = join(project, 'node_modules', 'dep.js');
    linkSync(cache, linked);
    expect(gateFor(linked).actionCategory).toBe('write_data');
    expect(await write('node_modules/dep.js', 'module.exports = 2;\n')).toContain('File written successfully');
    expect(readFileSync(linked, 'utf-8')).toBe('module.exports = 2;\n');
    expect(readFileSync(cache, 'utf-8')).toBe('module.exports = 1;\n');
    expect(statSync(linked).mode & 0o777).toBe(0o640);
    expect(statSync(linked).nlink).toBe(1);
  });
});

function realProject(): string {
  return resolveReal(project);
}

// ── (b) exec-on-write paths are rated execute_command ────────────────────────

describe('write_file is rated execute_command for paths that run as code', () => {
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
    '/home/u/site/bunfig.toml', '/home/u/site/.vscode/tasks.json',
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
    for (const path of ['.bashrc', '../../.bashrc', '.git/config', 'sub/.git/hooks/pre-commit', '.npmrc', '.ssh/config']) {
      expect(gateFor(path).actionCategory).toBe('execute_command');
    }
  });

  test('`..` after a symlink is judged where the kernel lands it', () => {
    makeGitDir(join(outside, 'repo', DOT_GIT));
    symlinkSync(join(outside, 'repo', DOT_GIT, 'hooks'), join(outside, 'h'));
    // Lexically <outside>/config; really <outside>/repo/.git/config.
    expect(gateFor(`${outside}/h/../config`).actionCategory).toBe('execute_command');
  });

  test('a symlink to an exec file is judged by its target, and the card says where it lands', () => {
    writeFileSync(join(home, '.zshrc'), '# rc\n');
    symlinkSync(join(home, '.zshrc'), join(outside, 'notes.txt'));
    const gate = gateFor(join(outside, 'notes.txt'));
    expect(gate.actionCategory).toBe('execute_command');
    expect(gate.intent).toContain(`(lands on ${resolveReal(join(home, '.zshrc'))})`);
    // Dangling: the write would create ~/.config/autostart/x.desktop.
    symlinkSync(join(home, '.config', 'autostart', 'x.desktop'), join(outside, 'later.txt'));
    expect(gateFor(join(outside, 'later.txt')).actionCategory).toBe('execute_command');
    expect(resolveReal(join(outside, 'later.txt'))).toBe(join(resolveReal(home), '.config', 'autostart', 'x.desktop'));
  });

  test('a dotfile manager\'s real file is recognised through the home symlink', () => {
    mkdirSync(join(home, 'dotfiles', 'ssh'), { recursive: true });
    writeFileSync(join(home, 'dotfiles', 'bashrc'), '# rc\n');
    symlinkSync(join(home, 'dotfiles', 'bashrc'), join(home, '.bashrc'));
    symlinkSync(join(home, 'dotfiles', 'ssh'), join(home, '.ssh'));
    expect(execOnWriteClass(join(home, 'dotfiles', 'bashrc'))).toBe('a shell startup file');
    expect(execOnWriteClass(join(home, 'dotfiles', 'ssh', 'authorized_keys'))).toBe('SSH configuration or keys');
    expect(execOnWriteClass(join(home, 'dotfiles', 'vimrc-notes.md'))).toBeNull();
  });

  test('a git dir by content -- bare repo, gitfile target -- is git, whatever its name', () => {
    makeGitDir(join(outside, 'mirror.git'));
    expect(gateFor(join(outside, 'mirror.git', 'config')).actionCategory).toBe('execute_command');
    expect(gateFor(join(outside, 'mirror.git', 'hooks', 'post-receive')).actionCategory).toBe('execute_command');
  });

  test('a file put straight into a dir with objects/ and refs/ can complete a git dir', () => {
    const half = join(outside, 'half');
    mkdirSync(join(half, 'objects'), { recursive: true });
    mkdirSync(join(half, 'refs'), { recursive: true });
    expect(gateFor(join(half, 'HEAD')).actionCategory).toBe('execute_command');
    expect(gateFor(join(half, 'config')).actionCategory).toBe('execute_command');
  });

  test('overwriting a program in a bin dir is execute_command; an executable bit elsewhere is not', () => {
    const bins = [join(home, '.local', 'bin'), join(home, 'bin'), join(outside, 'node_modules', '.bin')];
    for (const dir of bins) mkdirSync(dir, { recursive: true });
    for (const dir of bins) {
      const program = join(dir, 'tool');
      writeFileSync(program, '#!/bin/sh\n');
      chmodSync(program, 0o755);
      expect(gateFor(program).actionCategory).toBe('execute_command');
      // A new file in a bin dir is created without an exec bit: nothing runs it.
      expect(gateFor(join(dir, 'new-tool')).actionCategory).toBe('write_data');
    }
    // The usual layout: the bin entry is a symlink to a script elsewhere
    // (npm/bun .bin, Homebrew, pipx, `npm link`).
    const pkg = join(outside, 'node_modules', 'pkg', 'bin');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'cli.js'), '#!/usr/bin/env node\n');
    chmodSync(join(pkg, 'cli.js'), 0o755);
    symlinkSync('../pkg/bin/cli.js', join(outside, 'node_modules', '.bin', 'pkgcli'));
    expect(gateFor(join(outside, 'node_modules', '.bin', 'pkgcli')).actionCategory).toBe('execute_command');
    mkdirSync(join(outside, 'src', 'tool'), { recursive: true });
    writeFileSync(join(outside, 'src', 'tool', 'cli.js'), '#!/usr/bin/env node\n');
    chmodSync(join(outside, 'src', 'tool', 'cli.js'), 0o755);
    symlinkSync(join(outside, 'src', 'tool', 'cli.js'), join(home, '.local', 'bin', 'linked-tool'));
    expect(gateFor(join(home, '.local', 'bin', 'linked-tool')).actionCategory).toBe('execute_command');
    // The target, written by its own name outside any bin dir, is the same file.
    // A vendored source with 0755, a CIFS or exFAT mount that reports 0755 for everything.
    const vendored = join(outside, 'lib', 'x.ts');
    mkdirSync(join(outside, 'lib'));
    writeFileSync(vendored, 'export {};\n');
    chmodSync(vendored, 0o755);
    expect(gateFor(vendored).actionCategory).toBe('write_data');
  });

  test('the card names the path that triggered, resolved -- here home, not the site cwd', () => {
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'tool'), '#!/bin/sh\n');
    chmodSync(join(home, 'bin', 'tool'), 0o755);
    // Under the project cwd, bin/tool does not exist; under home it is a program.
    expect(execOnWrite('bin/tool')).toEqual({ kind: 'a program something runs by name', path: join(home, 'bin', 'tool') });
    expect(execOnWrite('bin/other')).toBeNull();
    expect(gateFor('bin/tool').intent!.endsWith(join(home, 'bin', 'tool'))).toBe(true);
  });

  test('Jarvis\'s data dir: code, config and keys are execute_command; notes and logs are not', () => {
    const data = join(root, 'data');
    mkdirSync(join(data, 'cache', 'engine', 'abc'), { recursive: true });
    mkdirSync(join(data, 'logs'), { recursive: true });
    mkdirSync(join(data, 'projects', 'app', 'src'), { recursive: true });
    const engine = join(root, 'engine-bundles');
    mkdirSync(engine);
    setDaemonDataRoots({ dataDirs: [data], codeRoots: [engine] });
    setSiteProjectsDir(join(data, 'projects'));
    for (const p of ['cache/engine/abc/main.js', 'config.yaml', 'sidecar.yaml', '.secrets.key', '.secrets.enc', 'jarvis.db',
      'jarvis.db-wal', 'google-tokens.json', 'sidecar-keys/k', 'workflow-codes/v/s/index.js', 'webapp-templates/x.js',
      'browser/Default/Preferences', 'pieces/x/index.js', 'sidecar/desktop-bridge.exe', 'daemon/src/index.ts', 'jarvis.pid']) {
      expect(gateFor(join(data, p)).actionCategory).toBe('execute_command');
    }
    for (const p of ['notes.md', 'logs/jarvis.log', 'content/x.md', 'workflow-files/f/s/out.csv', 'projects/app/src/App.tsx']) {
      expect(gateFor(join(data, p)).actionCategory).toBe('write_data');
    }
    expect(gateFor(join(engine, 'main.js')).actionCategory).toBe('execute_command');
    // By name too, for a sidecar's own ~/.jarvis.
    expect(gateFor('/home/u/.jarvis/cache/engine/abc/main.js').actionCategory).toBe('execute_command');
    expect(gateFor('/home/u/.jarvis/notes.md').actionCategory).toBe('write_data');
    expect(gateFor('/home/u/.jarvis/pieces/x/index.js').actionCategory).toBe('execute_command');
    expect(gateFor('/mnt/c/Users/u/.jarvis/sidecar/desktop-bridge.exe').actionCategory).toBe('execute_command');
    expect(gateFor('C:\\Users\\u\\.jarvis\\sidecar\\desktop-bridge.exe').actionCategory).toBe('execute_command');
    expect(gateFor('/home/u/.jarvis/projects/app/src/App.tsx').actionCategory).toBe('write_data');
    expect(gateFor('/home/u/.jarvis/projects/../config.yaml').actionCategory).toBe('execute_command');
  });

  test('a site projects dir configured inside ~/.jarvis is not Jarvis\'s own data', () => {
    setSiteProjectsDir('/home/u/.jarvis/cache/sites');
    expect(execOnWriteClass('/home/u/.jarvis/cache/sites/app/src/App.tsx')).toBeNull();
    expect(execOnWriteClass('/home/u/.jarvis/config.yaml')).toBe(JARVIS);
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

  test('8.3 short names count only in a Windows path', () => {
    expect(execOnWriteClass('C:\\Users\\u\\STARTU~1\\a.bat')).toBe('a Windows 8.3 short name, which may hide where it lands');
    expect(execOnWriteClass(join(outside, 'backup~1'))).toBeNull();
    expect(execOnWriteClass(join(outside, 'v1~2.txt'))).toBeNull();
  });

  test('more places that run what is written there', () => {
    for (const path of [
      '/home/u/.bash_aliases', '/home/u/.bashrc.d/10-x.sh', '/home/u/.gitconfig.local', '/home/u/repo/.husky/pre-commit',
      '/home/u/repo/.pre-commit-config.yaml', '/home/u/repo/lefthook.yml', '/home/u/.gnupg/gpg-agent.conf', '/home/u/.aws/config',
      '/home/u/.kube/config', '/home/u/.cargo/config.toml', '/home/u/.gradle/init.d/x.gradle', '/home/u/.ipython/profile_default/startup/x.py',
      '/home/u/.gdbinit', '/home/u/.psqlrc', '/home/u/.config/hypr/hyprland.conf', '/home/u/.config/i3/config',
      '/home/u/.config/plasma-workspace/env/x.sh', '/home/u/.local/share/applications/firefox.desktop',
      '/home/u/.local/share/dbus-1/services/x.service', '/home/u/.config/direnv/direnvrc',
      '/home/u/.local/lib/python3.12/site-packages/requests/__init__.py', '/usr/lib/python3/dist-packages/x.py',
      '/home/u/.nvm/versions/node/v20/lib/node_modules/npm/lib/cli.js', '/home/u/.bun/install/global/node_modules/x/index.js',
      '/home/u/.config/Code/User/settings.json', '/home/u/.vscode/extensions/x/extension.js', '/home/u/.config/kitty/kitty.conf',
      '/home/u/.config/alacritty/alacritty.toml', '/home/u/.wezterm.lua', '/home/u/.config/awesome/rc.lua',
      '/home/u/.config/sxhkd/sxhkdrc', '/home/u/.local/share/kio/servicemenus/x.desktop', '/home/u/.mailcap',
      '/home/u/.config/mise/config.toml',
    ]) {
      expect(gateFor(path).actionCategory).toBe('execute_command');
    }
  });

  test('a non-string path is judged as the string it will be written as', () => {
    expect(execOnWriteClass(['/home/u/.bashrc'])).toBe('a shell startup file');
    expect(gateFor(['/home/u/.bashrc'] as unknown as string).actionCategory).toBe('execute_command');
    expect(toolEffectCapability(writeFileTool, { path: ['/home/u/.bashrc'], content: 'x' }).category).toBe('execute_command');
  });

  test('Jarvis\'s own code is execute_command', () => {
    expect(gateFor(join(import.meta.dir, 'builtin.ts')).actionCategory).toBe('execute_command');
  });

  // ── positive controls ──

  test('ordinary paths stay write_data with no gate', () => {
    writeFileSync(join(outside, 'report.md'), '# r\n');
    for (const path of [
      join(outside, 'notes.txt'), join(outside, 'report.md'), 'notes.txt', 'src/App.tsx', join(home, 'Documents', 'report.md'),
      '/home/u/project/.gitignore', '/home/u/project/.github/workflows/ci.yml', '/home/u/bashrc.md', '/home/u/profile.txt',
      '/home/u/my.ssh.txt', '/home/u/.config/app/settings.json', '/home/u/repo.git.txt', '/home/u/.gitattributes-notes',
      '/home/u/site/.vscode/settings.json', '/home/u/site/Makefile.md',
    ]) {
      expect(writeFileTool.authorityGate?.({ path, content: 'x' }) ?? null).toBeNull();
      expect(gateFor(path).actionCategory).toBe('write_data');
    }
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

// ── Arguments are pinned before they are judged ──────────────────────────────

describe('a relative path is frozen to what it means now', () => {
  test('the file tools pin a relative path against the site cwd, and leave absolute and sidecar paths alone', () => {
    for (const tool of [readFileTool, writeFileTool, listDirectoryTool]) {
      expect(freezeToolArguments(tool, { path: 'src/App.tsx' }).path).toBe(join(project, 'src', 'App.tsx'));
      expect(freezeToolArguments(tool, { path: '/abs/x' }).path).toBe('/abs/x');
      expect(freezeToolArguments(tool, { path: 'src/App.tsx', target: 'laptop' }).path).toBe('src/App.tsx');
    }
    setDefaultCwd(null);
    expect(freezeToolArguments(writeFileTool, { path: 'notes.txt' }).path).toBe(join(home, 'notes.txt'));
  });
});

describe('the chat gate pins the path before it asks', () => {
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());

  function chat(level: number, governed: string[]) {
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const approvals = new ApprovalManager();
    const orch = new AgentOrchestrator();
    orch.setToolRegistry(registry);
    orch.setAuthorityEngine(new AuthorityEngine({ default_level: level, governed_categories: governed as never, overrides: [],
      context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
    orch.setApprovalManager(approvals);
    orch.setAuditTrail(new AuditTrail());
    orch.createPrimary({ id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: ['file-ops'],
      authority_level: level } as never);
    const call = (args: Record<string, unknown>) =>
      (orch as unknown as { executeTool: (tc: unknown) => Promise<unknown> }).executeTool({ id: 'c', name: 'write_file', arguments: args });
    return { approvals, registry, call };
  }

  test('a relative path on a site-chat card is stored absolute, and runs there after the turn', async () => {
    const f = chat(10, ['write_data']);
    expect(String(await f.call({ path: 'src/App.tsx', content: 'export default 4;\n' }))).toContain('[AWAITING_APPROVAL]');
    const card = f.approvals.getPending().find((p) => p.tool_name === 'write_file')!;
    expect(JSON.parse(card.tool_arguments).path).toBe(join(project, 'src', 'App.tsx'));
    f.approvals.approve(card.id, 'dashboard');
    setDefaultCwd(null);
    const ex = new DeferredExecutor(f.approvals, new AuditTrail());
    ex.setToolRegistry(f.registry);
    expect(await ex.executeApproved(card.id)).toContain('File written successfully');
    expect(readFileSync(join(project, 'src', 'App.tsx'), 'utf-8')).toBe('export default 4;\n');
    expect(existsSync(join(home, 'src', 'App.tsx'))).toBe(false);
  });

  test('the realtime (voice) path freezes arguments before it gates and runs them', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();
    registry.register({ name: 'write_file', description: 'probe', category: 'file-ops',
      parameters: { path: { type: 'string', description: 'p', required: true }, frozen: { type: 'boolean', description: 'f', required: false } },
      freezeArguments: (p) => ({ ...p, frozen: true }),
      authorityGate: (p) => { seen.push({ gated: p.frozen === true }); return null; },
      execute: async (p) => { seen.push({ ran: p.frozen === true }); return 'ok'; } });
    const orch = new AgentOrchestrator();
    orch.setToolRegistry(registry);
    orch.setAuthorityEngine(new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
    orch.setAuditTrail(new AuditTrail());
    orch.createPrimary({ id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: ['file-ops'],
      authority_level: 10 } as never);
    await orch.executeRealtimeToolCall('write_file', { path: 'x' }, {});
    expect(seen).toEqual([{ gated: true }, { ran: true }]);
  });

  test('at level 3 an exec-on-write asks on a card that names the resolved file', async () => {
    const f = chat(3, []);
    expect(String(await f.call({ path: '.bashrc', content: 'echo hi\n' }))).toContain('[AWAITING_APPROVAL]');
    const card = f.approvals.getPending().find((p) => p.tool_name === 'write_file')!;
    expect(card.action_category).toBe('execute_command');
    expect(approvalIntentFromContext(card)).toContain(join(project, '.bashrc'));
    expect(existsSync(join(project, '.bashrc'))).toBe(false);
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

  /** An approval created the way the orchestrator creates one: arguments frozen, then gated. */
  function approvedWrite(mgr: ApprovalManager, path: string, content = 'echo pwned\n', freeze = true) {
    const args = freeze ? freezeToolArguments(writeFileTool, { path, content }) : { path, content };
    const gate = resolveToolGate(writeFileTool, 'write_file', args);
    const req = mgr.createRequest({ agentId: 'a1', agentName: 'PA', toolName: 'write_file', toolArguments: args,
      actionCategory: gate.actionCategory, urgency: 'normal', reason: 'test', context: gateContext(gate, 'write_file', args) });
    mgr.approve(req.id, 'dashboard');
    return req;
  }

  test('a plain write that has become exec-on-write is blocked, and the file is untouched', async () => {
    const mgr = new ApprovalManager();
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    const script = join(bin, 'job');
    writeFileSync(script, 'echo hi\n');
    chmodSync(script, 0o644);
    const req = approvedWrite(mgr, script);
    expect(mgr.getRequest(req.id)!.action_category).toBe('write_data');
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
    const req = approvedWrite(mgr, rc);
    expect(await executorWith(mgr).executeApproved(req.id)).toContain('File written successfully');
    expect(readFileSync(rc, 'utf-8')).toBe('echo pwned\n');
  });

  test('a relative path approved in a site chat writes the project file after the turn ends', async () => {
    const mgr = new ApprovalManager();
    const req = approvedWrite(mgr, 'src/App.tsx', 'export default 3;\n');
    // The turn ends and another begins elsewhere; the click arrives now.
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(join(elsewhere, 'src'), { recursive: true });
    setDefaultCwd(elsewhere);
    expect(await executorWith(mgr).executeApproved(req.id)).toContain('File written successfully');
    expect(readFileSync(join(project, 'src', 'App.tsx'), 'utf-8')).toBe('export default 3;\n');
    expect(existsSync(join(elsewhere, 'src', 'App.tsx'))).toBe(false);
  });

  test('an unfrozen relative exec-on-write approval does not run against another dir', async () => {
    // What a request stored before arguments were frozen looks like: the card
    // named <project>/.bashrc. Run from another cwd, it would be another file.
    const mgr = new ApprovalManager();
    const req = approvedWrite(mgr, '.bashrc', 'echo pwned\n', false);
    expect(JSON.parse(mgr.getRequest(req.id)!.context!).intent).toContain(join(project, '.bashrc'));
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    setDefaultCwd(elsewhere);
    const result = await executorWith(mgr).executeApproved(req.id);
    expect(result).toContain('changed after approval');
    expect(mgr.getRequest(req.id)).toMatchObject({ execution_outcome: 'blocked' });
    expect(existsSync(join(project, '.bashrc'))).toBe(false);
    expect(existsSync(join(elsewhere, '.bashrc'))).toBe(false);
  });

  test('a plain write that is still plain runs', async () => {
    const mgr = new ApprovalManager();
    const note = join(outside, 'note.txt');
    const req = approvedWrite(mgr, note);
    expect(await executorWith(mgr).executeApproved(req.id)).toContain('File written successfully');
    expect(readFileSync(note, 'utf-8')).toBe('echo pwned\n');
  });
});

// ── Workflows ────────────────────────────────────────────────────────────────

describe('the workflow effect boundary rates write_file the same way', () => {
  beforeEach(() => initWorkflowDb(':memory:'));
  afterEach(() => closeWorkflowDb());

  /** A real flow step through the real boundary; `level` and `governed` as an install configures them. */
  function flowStep(level: number, governed: string[], overrides: unknown[] = []) {
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
      authorityEngine: new AuthorityEngine({ default_level: level, governed_categories: governed as never, overrides: overrides as never,
        context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
      emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), approvalManager: approvals,
      onWorkflowApproval: () => {}, channelService: {},
    } as unknown as BuildServiceBackendsOptions);
    const context = { runId: run.id, projectId: run.projectId, stepName: 'action', executionPath: [] };
    return { approvals, invoke: (params: Record<string, unknown>) => backends.toolsInvoke!({ toolName: 'write_file', params }, context) };
  }

  test('the category a flow step is judged at', () => {
    expect(toolEffectCapability(writeFileTool, { path: '/home/u/.bashrc', content: 'x' }).categories)
      .toEqual(['execute_command', 'write_data']);
    expect(toolEffectCapability(writeFileTool, { path: '/home/u/code/r/.git/hooks/pre-push', content: 'x' }).category)
      .toBe('execute_command');
    expect(toolEffectCapability(writeFileTool, { path: join(outside, 'notes.txt'), content: 'x' }).category).toBe('write_data');
    expect(toolEffectCapability(readFileTool, { path: '/home/u/.bashrc' }).category).toBe('read_data');
  });

  test('at the shipped default level (3), an exec-on-write step asks for approval instead of failing', async () => {
    setDefaultCwd(null);
    const shipped = ['send_email', 'send_message', 'make_payment'];
    const plain = join(outside, 'report.md');
    const done = await flowStep(3, shipped).invoke({ path: plain, content: 'hi' });
    expect(String(done.result)).toContain('File written successfully');
    // One effect per step: a second write is a second run.
    const f = flowStep(3, shipped);
    const rc = join(outside, '.bashrc');
    const parked = await f.invoke({ path: rc, content: 'echo hi\n' });
    expect(parked.approval).toBeDefined();
    expect(existsSync(rc)).toBe(false);
    f.approvals.approve(parked.approval!.approvalId, 'test');
    expect(String((await f.invoke({ path: rc, content: 'echo hi\n' })).result)).toContain('File written successfully');
    expect(readFileSync(rc, 'utf-8')).toBe('echo hi\n');
  });

  test('the substitution is only for a gated shortfall above a floor the workflow clears', async () => {
    setDefaultCwd(null);
    const shipped = ['send_email', 'send_message', 'make_payment'];
    // Level 2 does not clear write_data: a plain write and an rc write both fail, nothing parks.
    await expect(flowStep(2, shipped).invoke({ path: join(outside, 'report.md'), content: 'x' })).rejects.toThrow(/Authority denied/);
    await expect(flowStep(2, shipped).invoke({ path: join(outside, '.bashrc'), content: 'x' })).rejects.toThrow(/Authority denied/);
    // An override that denies execute_command is a denial, not a shortfall.
    await expect(flowStep(3, shipped, [{ action: 'execute_command', allowed: false }])
      .invoke({ path: join(outside, '.bashrc'), content: 'x' })).rejects.toThrow(/Authority denied/);
    expect(existsSync(join(outside, 'report.md'))).toBe(false);
    expect(existsSync(join(outside, '.bashrc'))).toBe(false);
  });

  test('a relative rc write at level 3 parks, and once approved lands in the home it was resolved against', async () => {
    setDefaultCwd(null);
    const f = flowStep(3, ['send_email', 'send_message', 'make_payment']);
    const params = { path: '.bashrc', content: 'echo hi\n' };
    const parked = await f.invoke(params);
    expect(parked.approval).toBeDefined();
    expect(existsSync(join(home, '.bashrc'))).toBe(false);
    // Where the approved write will land, checked BEFORE approving: if the
    // path resolved against the real home, the approval must never run.
    expect(JSON.parse(f.approvals.getRequest(parked.approval!.approvalId)!.tool_arguments).path).toBe(join(home, '.bashrc'));
    f.approvals.approve(parked.approval!.approvalId, 'test');
    expect(String((await f.invoke(params)).result)).toContain(join(home, '.bashrc'));
    expect(readFileSync(join(home, '.bashrc'), 'utf-8')).toBe('echo hi\n');
  });

  test('a plain write reviewed as write_data is not dispatched once the file is a program', async () => {
    setDefaultCwd(null);
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    const script = join(bin, 'job');
    writeFileSync(script, 'echo hi\n');
    chmodSync(script, 0o644);
    const f = flowStep(10, ['write_data', 'execute_command']);
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
    const f = flowStep(10, ['write_data', 'execute_command']);
    const params = { path: note, content: 'hello\n' };
    const parked = await f.invoke(params);
    f.approvals.approve(parked.approval!.approvalId, 'test');
    const done = await f.invoke(params);
    expect(String(done.result)).toContain('File written successfully');
    expect(readFileSync(note, 'utf-8')).toBe('hello\n');
  });
});

afterAll(() => {
  setDefaultCwd(null);
  setSiteProjectsDir(null);
  setPolicyHome(null);
});
