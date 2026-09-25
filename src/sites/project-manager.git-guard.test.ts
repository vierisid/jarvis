/**
 * The site file tools must not reach git's own files (#516, #517).
 *
 * Driven through the real tools the model calls, against real temp dirs and
 * real symlinks. Every refusal also checks that nothing on disk changed, so a
 * test cannot pass on an error message while the write went through anyway.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '../actions/tools/registry.ts';
import { createSiteBuilderTools } from './builder-tools.ts';
import { GitManager } from './git-manager.ts';
import { ProjectManager } from './project-manager.ts';

const GIT_CONFIG = '[core]\n\trepositoryformatversion = 0\n';
const REFLOG = '0000 1111 Jarvis <j@x> 1 +0000\tpull https://ghp_REFLOGSECRET@github.com/o/r.git: Fast-forward\n';
const REFUSED = 'inside a git directory';

let root: string;
let projectsDir: string;
let project: string;
let outside: string;
let manager: ProjectManager;
let tools: Map<string, ToolDefinition>;

function makeManager(dir: string): ProjectManager {
  return new ProjectManager({
    enabled: true,
    projects_dir: dir,
    port_range_start: 3000,
    port_range_end: 3999,
    auto_commit: false,
    max_concurrent_servers: 1,
  });
}

async function call(name: string, params: Record<string, unknown>): Promise<string> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return String(await tool.execute(params));
}

const read = (path: string, projectId = 'app') => call('site_read_file', { project_id: projectId, path });
const write = (path: string, content = 'PWNED', projectId = 'app') =>
  call('site_write_file', { project_id: projectId, path, content });
const del = (path: string, projectId = 'app') => call('site_delete_file', { project_id: projectId, path });
const list = (projectId = 'app') => call('site_list_files', { project_id: projectId });

/** Every entry under `dir`, symlinks recorded as links and never followed. */
function snapshot(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) out.push(`${rel} -> link`);
    else if (entry.isDirectory()) out.push(`${rel}/`, ...snapshot(full, `${rel}/`));
    else out.push(`${rel} (${readFileSync(full, 'utf-8')})`);
  }
  return out.sort();
}

/** Assert the call was refused and left the whole temp root untouched. */
async function expectRefused(action: () => Promise<string>, message: string = REFUSED): Promise<void> {
  const before = snapshot(root);
  const result = await action();
  expect(result).toStartWith('Error:');
  expect(result).toContain(message);
  expect(result).not.toContain('ghp_REFLOGSECRET');
  expect(result).not.toContain('repositoryformatversion');
  expect(snapshot(root)).toEqual(before);
  expect(readFileSync(join(project, '.git', 'config'), 'utf-8')).toBe(GIT_CONFIG);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-git-guard-'));
  projectsDir = join(root, 'projects');
  project = join(projectsDir, 'app');
  outside = join(root, 'outside');

  mkdirSync(join(project, '.git', 'logs', 'refs', 'heads'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, '.git', 'config'), GIT_CONFIG);
  writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(project, '.git', 'logs', 'HEAD'), REFLOG);
  writeFileSync(join(project, '.git', 'logs', 'refs', 'heads', 'main'), REFLOG);
  writeFileSync(join(project, 'Makefile'), 'dev:\n');
  writeFileSync(join(project, 'src', 'App.tsx'), 'export default 1;\n');

  // A nested repo (a vendored clone, or a submodule's checkout).
  mkdirSync(join(project, 'vendor', 'lib', '.git'), { recursive: true });
  writeFileSync(join(project, 'vendor', 'lib', '.git', 'config'), GIT_CONFIG);

  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE SECRET');

  manager = makeManager(projectsDir);
  tools = new Map(createSiteBuilderTools(manager, new GitManager()).map((t) => [t.name, t]));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Spellings of `.git/config` (or of a file under another git dir). Each one
 * either IS the repo config on some filesystem or walks back into it.
 */
const SPELLINGS: Array<[string, string]> = [
  ['plain', '.git/config'],
  ['the reflog holding the pre-#511 PAT', '.git/logs/HEAD'],
  ['a branch reflog', '.git/logs/refs/heads/main'],
  ['upper case (case-insensitive filesystems)', '.GIT/config'],
  ['mixed case', '.Git/config'],
  ['dot prefix', './.git/config'],
  ['dot-dot walk back', 'src/../.git/config'],
  ['leading slash', '/.git/config'],
  ['trailing dot (Windows strips it)', '.git./config'],
  ['trailing space (Windows strips it)', '.git /config'],
  ['trailing dots and spaces', '.git. . /config'],
  ['NTFS alternate data stream', '.git::$INDEX_ALLOCATION/config'],
  ['NTFS 8.3 short name', 'git~1/config'],
  ['NTFS 8.3 short name, upper case', 'GIT~1/config'],
  ['HFS+ ignorable zero-width non-joiner', '.g‌it/config'],
  ['HFS+ ignorable byte order mark', '﻿.git/config'],
  ['backslash separators (Windows)', 'src\\..\\.git\\config'],
  ['a nested repo', 'vendor/lib/.git/config'],
  ['the git dir itself', '.git'],
];

describe('site file tools refuse every spelling of a git dir', () => {
  test.each(SPELLINGS)('site_read_file: %s', async (_label, path) => {
    await expectRefused(() => read(path));
  });

  test.each(SPELLINGS)('site_write_file: %s', async (_label, path) => {
    await expectRefused(() => write(path));
  });

  test.each(SPELLINGS)('site_delete_file: %s', async (_label, path) => {
    await expectRefused(() => del(path));
  });

  test('URL encoding is not decoded here, so %2Egit is a literal, harmless name', async () => {
    // The HTTP route decodes its query string once, before this layer sees
    // the path; a second decode here would turn a literal name into `.git`.
    expect(await write('%2Egit/config', 'literal')).toBe('File written: %2Egit/config');
    expect(readFileSync(join(project, '%2Egit', 'config'), 'utf-8')).toBe('literal');
    expect(readFileSync(join(project, '.git', 'config'), 'utf-8')).toBe(GIT_CONFIG);
  });
});

describe('site file tools refuse symlinks into a git dir', () => {
  const LINKS: Array<[string, () => void, string]> = [
    ['relative directory link', () => symlinkSync('.git', join(project, 'lg')), 'lg/config'],
    ['absolute directory link', () => symlinkSync(join(project, '.git'), join(project, 'abs')), 'abs/config'],
    ['link in a subdirectory', () => symlinkSync('../.git', join(project, 'src', 'up')), 'src/up/config'],
    ['chain of links', () => {
      symlinkSync('.git', join(project, 'chain2'));
      symlinkSync('chain2', join(project, 'chain1'));
    }, 'chain1/config'],
    ['upper-case link name to the real dir', () => symlinkSync('.git', join(project, 'G')), 'G/logs/HEAD'],
    ['link into a nested repo', () => symlinkSync('vendor/lib/.git', join(project, 'nested')), 'nested/config'],
  ];

  test.each(LINKS)('site_read_file through a %s', async (_label, setup, path) => {
    setup();
    await expectRefused(() => read(path));
  });

  test.each(LINKS)('site_write_file through a %s', async (_label, setup, path) => {
    setup();
    await expectRefused(() => write(path));
  });

  test.each(LINKS)('site_delete_file through a %s', async (_label, setup, path) => {
    setup();
    await expectRefused(() => del(path));
  });

  test('a file link to .git/config can be deleted as a link, but not read or written through', async () => {
    symlinkSync('.git/config', join(project, 'cfg'));
    await expectRefused(() => read('cfg'));
    await expectRefused(() => write('cfg'));

    // rm unlinks the link itself; the config it pointed at stays.
    expect(await del('cfg')).toBe('File deleted: cfg');
    expect(existsSync(join(project, 'cfg'))).toBe(false);
    expect(readFileSync(join(project, '.git', 'config'), 'utf-8')).toBe(GIT_CONFIG);
  });

  test('a dangling link is not followed: writing through it would create the file inside .git', async () => {
    symlinkSync('.git/hooks/pre-commit', join(project, 'hook'));
    await expectRefused(() => write('hook'), 'symlink whose target does not exist');
    await expectRefused(() => read('hook'), 'symlink whose target does not exist');
    expect(existsSync(join(project, '.git', 'hooks'))).toBe(false);
  });

  test('a dangling directory link is not followed either', async () => {
    symlinkSync('.git/newdir', join(project, 'nd'));
    await expectRefused(() => write('nd/x'), 'symlink whose target does not exist');
    expect(existsSync(join(project, '.git', 'newdir'))).toBe(false);
  });

  test('a link the model made with site_run_command is refused the same way', async () => {
    const made = await call('site_run_command', { project_id: 'app', command: 'ln -s .git shell-link' });
    expect(made).toBe('(no output)');
    expect(lstatSync(join(project, 'shell-link')).isSymbolicLink()).toBe(true);
    await expectRefused(() => write('shell-link/config'));
    await expectRefused(() => read('shell-link/logs/HEAD'));
  });

  test('a link out of the project is refused', async () => {
    symlinkSync(outside, join(project, 'out'));
    await expectRefused(() => read('out/secret.txt'), 'resolves outside the project');
    await expectRefused(() => write('out/new.txt'), 'resolves outside the project');
    await expectRefused(() => del('out/secret.txt'), 'resolves outside the project');
  });
});

describe('a git dir that is not named .git', () => {
  test('a gitfile pointing at a directory in the tree protects that directory', async () => {
    const wt = join(projectsDir, 'wt');
    mkdirSync(join(wt, 'gitdata', 'logs'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: gitdata\n');
    writeFileSync(join(wt, 'gitdata', 'config'), GIT_CONFIG);
    writeFileSync(join(wt, 'gitdata', 'logs', 'HEAD'), REFLOG);

    await expectRefused(() => read('gitdata/logs/HEAD', 'wt'));
    await expectRefused(() => write('gitdata/config', 'x', 'wt'));
    await expectRefused(() => del('gitdata/config', 'wt'));
    await expectRefused(() => read('.git', 'wt'));
    // What a case-insensitive filesystem would open as gitdata/config.
    await expectRefused(() => write('GITDATA/config', 'x', 'wt'));
    expect(await list('wt')).not.toContain('gitdata');
  });

  test("a linked worktree's commondir is protected too", async () => {
    const wt = join(projectsDir, 'wt');
    mkdirSync(join(wt, 'repo', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(wt, 'repo', 'config'), GIT_CONFIG);
    writeFileSync(join(wt, 'repo', 'worktrees', 'wt', 'commondir'), '../..\n');
    writeFileSync(join(wt, '.git'), 'gitdir: repo/worktrees/wt\n');

    await expectRefused(() => write('repo/config', 'x', 'wt'));
  });

  test('a .git symlink to a directory in the tree protects that directory', async () => {
    const linked = join(projectsDir, 'linked');
    mkdirSync(join(linked, 'store'), { recursive: true });
    writeFileSync(join(linked, 'store', 'config'), GIT_CONFIG);
    symlinkSync('store', join(linked, '.git'));

    await expectRefused(() => write('store/config', 'x', 'linked'));
    await expectRefused(() => read('store/config', 'linked'));
  });
});

describe('project_id cannot move the project root onto a git dir', () => {
  const IDS: Array<[string, string, string]> = [
    ['the git dir as the project', 'app/.git', 'config'],
    ['the git dir, backslash-separated', 'app\\.git', 'config'],
    ['the projects dir as the project (empty id)', '', 'app/.git/config'],
    ['the projects dir as the project (dot id)', '.', 'app/.git/config'],
    ['a parent of the projects dir', '..', 'projects/app/.git/config'],
    ['a dot-named sibling', '.hidden', 'x'],
  ];

  test.each(IDS)('%s', async (_label, projectId, path) => {
    await expectRefused(() => read(path, projectId), 'not found');
    await expectRefused(() => write(path, 'x', projectId), 'not found');
    await expectRefused(() => del(path, projectId), 'not found');
    expect(manager.getProjectPath(projectId)).toBe(null);
  });

  test('an id naming a file in the projects dir is not a project', async () => {
    writeFileSync(join(projectsDir, 'pids.json'), '{}');
    await expectRefused(() => write('.', 'x', 'pids.json'), 'not found');
    expect(readFileSync(join(projectsDir, 'pids.json'), 'utf-8')).toBe('{}');
  });

  test('the project root itself is not a file path', async () => {
    await expectRefused(() => write('.'), 'A file path inside the project is required');
    await expectRefused(() => del(''), 'A file path inside the project is required');
  });
});

describe('writes do not reach through hard links', () => {
  test('a file hardlinked to a shared cache is replaced, not rewritten in place', async () => {
    // What `bun install` does to every file under node_modules.
    const cached = join(outside, 'cache-index.js');
    writeFileSync(cached, 'module.exports = "clean";\n');
    chmodSync(cached, 0o755);
    mkdirSync(join(project, 'node_modules', 'pkg'), { recursive: true });
    linkSync(cached, join(project, 'node_modules', 'pkg', 'index.js'));

    expect(await write('node_modules/pkg/index.js', 'patched')).toBe('File written: node_modules/pkg/index.js');
    expect(readFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'utf-8')).toBe('patched');
    expect(readFileSync(cached, 'utf-8')).toBe('module.exports = "clean";\n');
    expect(lstatSync(cached).nlink).toBe(1);
    expect(lstatSync(join(project, 'node_modules', 'pkg', 'index.js')).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(project, 'node_modules', 'pkg'))).toEqual(['index.js']);
  });

  test('a hard link to .git/config in the tree is replaced, leaving the config alone', async () => {
    linkSync(join(project, '.git', 'config'), join(project, 'src', 'cfg'));
    expect(await write('src/cfg', 'PWNED')).toBe('File written: src/cfg');
    expect(readFileSync(join(project, '.git', 'config'), 'utf-8')).toBe(GIT_CONFIG);
  });
});

describe("the daemon's git does not take the project root for a bare repository", () => {
  test('HEAD, objects/, refs/ and config written at a .git-less root do not run core.fsmonitor', async () => {
    const bare = join(projectsDir, 'bare');
    mkdirSync(bare, { recursive: true });
    const marker = join(root, 'FSMONITOR_RAN');
    // Every one of these is an ordinary file the site tools may write.
    expect(await write('HEAD', 'ref: refs/heads/main\n', 'bare')).toStartWith('File written');
    expect(await write('objects/info/keep', '', 'bare')).toStartWith('File written');
    expect(await write('refs/heads/keep', '', 'bare')).toStartWith('File written');
    const config = `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = "touch ${marker}; false"\n`;
    expect(await write('config', config, 'bare')).toStartWith('File written');

    const git = new GitManager();
    // Upward discovery could still find an enclosing repo (a temp dir inside
    // one); what matters is that this root's config never ran.
    await git.isDirty(bare).catch(() => undefined);
    await git.getCurrentBranch(bare).catch(() => undefined);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('site_list_files never shows git internals', () => {
  test('hides .git, its aliases, nested repos and links into them; keeps real files and in-project links', async () => {
    mkdirSync(join(project, 'git~1'), { recursive: true });
    writeFileSync(join(project, 'git~1', 'short-name-secret'), 'x');
    symlinkSync('.git', join(project, 'lg'));
    symlinkSync('.git/config', join(project, 'cfg'));
    symlinkSync(outside, join(project, 'out'));
    symlinkSync('.git/missing', join(project, 'dangling'));
    symlinkSync('src', join(project, 'lsrc'));

    const text = await list();
    expect(text).not.toStartWith('Error:');
    for (const hidden of ['"lg"', '"cfg"', '"out"', '"dangling"', 'git~1', 'short-name-secret', 'secret.txt', '"logs"', '"HEAD"', '"config"']) {
      expect(text).not.toContain(hidden);
    }
    const tree = JSON.parse(text) as { children: Array<{ name: string; children?: Array<{ name: string }> }> };
    const names = tree.children.map((c) => c.name);
    expect(names).toContain('src');
    expect(names).toContain('Makefile');
    // A link to a real in-project directory is still listed and descended.
    const lsrc = tree.children.find((c) => c.name === 'lsrc');
    expect(lsrc?.children?.map((c) => c.name)).toEqual(['App.tsx']);
    // The nested repo's directory is listed, its .git is not.
    expect(text).toContain('"vendor"');
  });
});

describe('ordinary files, including git-adjacent names, still work', () => {
  const ALLOWED = [
    '.gitignore',
    '.gitkeep',
    'src/.gitkeep',
    '.gitattributes',
    '.gitmodules',
    '.github/workflows/x.yml',
    '.git-blame-ignore-revs',
    'repo.git/HEAD',
    'docs/git/notes.md',
    'src/components/Button.tsx',
  ];

  test.each(ALLOWED)('write, read and delete %s', async (path) => {
    expect(await write(path, `content of ${path}`)).toBe(`File written: ${path}`);
    expect(await read(path)).toBe(`content of ${path}`);
    expect(await del(path)).toBe(`File deleted: ${path}`);
    expect(existsSync(join(project, path))).toBe(false);
  });

  test('a link to an in-project directory can be read and written through', async () => {
    symlinkSync('src', join(project, 'lsrc'));
    expect(await read('lsrc/App.tsx')).toBe('export default 1;\n');
    expect(await write('lsrc/New.tsx', 'n')).toBe('File written: lsrc/New.tsx');
    expect(readFileSync(join(project, 'src', 'New.tsx'), 'utf-8')).toBe('n');
  });

  test('a dangling link can still be deleted', async () => {
    symlinkSync('nowhere', join(project, 'stale'));
    expect(await del('stale')).toBe('File deleted: stale');
    expect(existsSync(join(project, 'stale'))).toBe(false);
  });

  test('git itself keeps working in a project the tools have written to', async () => {
    const real = join(projectsDir, 'real');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'Makefile'), 'dev:\n');
    const git = new GitManager();
    await git.init(real, { name: 'Test', email: 'test@example.invalid', global: false });

    expect(await write('.gitignore', 'dist/\n', 'real')).toBe('File written: .gitignore');
    expect(await write('src/main.ts', 'export {};\n', 'real')).toBe('File written: src/main.ts');
    const commit = await git.autoCommit(real, 'add files');
    expect(commit?.message).toBe('add files');
    expect(await git.isDirty(real)).toBe(false);
    expect(await read('.git/HEAD', 'real')).toContain(REFUSED);
  });
});
