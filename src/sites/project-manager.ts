/**
 * Site Builder — Project Manager
 *
 * CRUD operations for projects, file system access, project discovery.
 */

import type { Project, ProjectMeta, FileEntry, SiteBuilderConfig } from './types.ts';
import { GitManager } from './git-manager.ts';
import { TEMPLATES, generateMakefile, scaffoldBunReact } from './templates.ts';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  readdirSync, statSync, lstatSync, existsSync, mkdirSync, rmSync, readFileSync, realpathSync,
  writeFileSync, chmodSync, renameSync, type Stats,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isGitDirName, isWithin } from '../util/path.ts';
import { landingPath, linkedGitDirs } from './git-dir.ts';
import { sanitizedEnv } from '../util/subprocess-env.ts';

const META_FILE = '.jarvis-project.json';

// Directories to exclude from file tree
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', '.vite', 'dist', 'build',
  '.cache', '.turbo', '.output', '.nuxt', '.svelte-kit',
]);

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Why the site file tools stay out of git's own files (#516, #517).
 *
 * Writing git's config is running code: core.fsmonitor, core.hooksPath,
 * filter and diff drivers all name commands git starts during ordinary
 * operations, and the daemon runs git in the project after every site chat
 * turn, on every project listing, and on push and pull. So a `write_data`
 * call that could write `.git/config` would be `execute_command` without that
 * gate. The same file can also point the github.com transport at a proxy of
 * the writer's choosing, and the reflogs of projects pulled before #511 still
 * hold the PAT. Reading, listing and deleting are refused along with writing:
 * all four are the same path resolution, and a delete of `.git/index` or
 * `.git/HEAD` is its own damage.
 *
 * The rule is on the RESOLVED path, not the spelling: every component of the
 * requested path, and every component of its real path inside the project,
 * must not be a git dir name in any of the forms `isGitDirName` knows. That
 * covers `.git` anywhere in the tree (a nested repo's `.git` dir included;
 * absorbed submodules live under the root `.git/modules`), and a symlink into
 * one, whoever made it: the model through site_run_command, a scaffold, or a
 * pulled commit. Only the ROOT `.git` is followed when it is a gitfile or a
 * symlink (see linkedGitDirs in git-dir.ts): a nested gitfile pointing at
 * another in-tree dir is not, and the daemon never runs git there.
 */
function gitDirRefusal(requested: string): Error {
  return new Error(
    `Access denied: "${requested}" is inside a git directory. The site file tools cannot read, write, list or delete ` +
    'git internals; use site_git_commit and site_github_push for version control.',
  );
}

/**
 * Whether a real path inside the project is one of git's own files. The
 * linked-dir compare ignores case for the same reason isGitDirName does: on a
 * case-insensitive filesystem `GITDATA/config` opens `gitdata/config`, and
 * realpath keeps the spelling it was given.
 */
function isGitPath(realRoot: string, real: string, gitDirs: string[] = linkedGitDirs(realRoot)): boolean {
  return relative(realRoot, real).split(/[\\/]/).some(isGitDirName)
    || gitDirs.some((dir) => isWithin(real.toLowerCase(), dir.toLowerCase()));
}

type TreeGuard = { realRoot: string; gitDirs: string[] };

/**
 * Filesystem errors carry absolute host paths ("ELOOP: ..., realpath
 * '/home/<user>/.jarvis/sites/app/x'"), and these messages go back to the
 * model and the editor. Replace them with ones that name only the path the
 * caller asked for. Errors with no errno code are this module's own and
 * already say what they mean.
 */
const FS_ERROR_TEXT: Record<string, string> = {
  ENOENT: 'File not found',
  ENOTDIR: 'A parent of the path is not a directory',
  EEXIST: 'A parent of the path is not a directory',
  EISDIR: 'Path is a directory',
  ELOOP: 'Too many levels of symlinks',
  ENAMETOOLONG: 'Path is too long',
  EACCES: 'Permission denied',
  EPERM: 'Permission denied',
  ENOSPC: 'No space left on device',
};

async function withProjectErrors<T>(requested: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code !== 'string') throw err;
    // The original stays on `cause` for server-side diagnosis; callers show
    // only `.message`.
    throw new Error(`${FS_ERROR_TEXT[code] ?? `Filesystem error ${code}`}: ${requested}`, { cause: err });
  }
}

/**
 * Put `content` at `path` by writing a sibling and renaming it over. Only the
 * name is retargeted: whatever the name pointed at before -- another hard link
 * to the same inode, or a symlink's target -- is left as it was.
 */
function replaceFile(path: string, content: string, mode: number): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export class ProjectManager {
  private projectsDir: string;
  private gitManager: GitManager;

  constructor(config: SiteBuilderConfig, gitManager?: GitManager) {
    this.projectsDir = config.projects_dir.replace(/^~/, homedir());
    this.gitManager = gitManager ?? new GitManager();

    // Ensure projects directory exists
    mkdirSync(this.projectsDir, { recursive: true });
  }

  /**
   * Discover all projects by scanning the projects directory.
   */
  async listProjects(): Promise<Project[]> {
    if (!existsSync(this.projectsDir)) return [];

    const entries = readdirSync(this.projectsDir, { withFileTypes: true });
    const projects: Project[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      const projectPath = join(this.projectsDir, entry.name);

      // Must have a Makefile to be considered a project
      if (!existsSync(join(projectPath, 'Makefile'))) continue;

      const meta = this.readMeta(projectPath);
      let gitBranch: string | null = null;
      let gitDirty = false;

      try {
        gitBranch = await this.gitManager.getCurrentBranch(projectPath);
        gitDirty = await this.gitManager.isDirty(projectPath);
      } catch { /* not a git repo */ }

      projects.push({
        id: entry.name,
        name: meta?.name ?? entry.name,
        path: projectPath,
        framework: meta?.framework ?? 'custom',
        devPort: null,
        devServerPid: null,
        status: 'stopped',
        gitBranch,
        gitDirty,
        createdAt: meta?.createdAt ?? statSync(projectPath).birthtimeMs,
        lastOpenedAt: meta?.lastOpenedAt ?? Date.now(),
        githubUrl: meta?.github ? `https://github.com/${meta.github.owner}/${meta.github.repo}` : null,
      });
    }

    return projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  /**
   * Get a single project by ID.
   */
  async getProject(id: string): Promise<Project | null> {
    const projectPath = this.resolveProjectPath(id);
    if (!projectPath || !existsSync(join(projectPath, 'Makefile'))) return null;

    const meta = this.readMeta(projectPath);
    let gitBranch: string | null = null;
    let gitDirty = false;

    try {
      gitBranch = await this.gitManager.getCurrentBranch(projectPath);
      gitDirty = await this.gitManager.isDirty(projectPath);
    } catch { /* not a git repo */ }

    return {
      id,
      name: meta?.name ?? id,
      path: projectPath,
      framework: meta?.framework ?? 'custom',
      devPort: null,
      devServerPid: null,
      status: 'stopped',
      gitBranch,
      gitDirty,
      createdAt: meta?.createdAt ?? statSync(projectPath).birthtimeMs,
      lastOpenedAt: meta?.lastOpenedAt ?? Date.now(),
      githubUrl: meta?.github ? `https://github.com/${meta.github.owner}/${meta.github.repo}` : null,
    };
  }

  /**
   * Create a new project from a template.
   */
  async createProject(name: string, templateId: string, gitAuthor?: { name: string; email: string; global: boolean }): Promise<Project> {
    const id = this.sanitizeId(name);
    const projectPath = join(this.projectsDir, id);

    if (existsSync(projectPath)) {
      throw new Error(`Project "${id}" already exists`);
    }

    const template = TEMPLATES.find(t => t.id === templateId);
    if (!template) {
      throw new Error(`Unknown template: ${templateId}`);
    }

    mkdirSync(projectPath, { recursive: true });

    // Scaffold the project
    if (template.command === 'scaffold') {
      // Internal scaffolding
      if (template.framework === 'bun-react') {
        scaffoldBunReact(projectPath);
      }
    } else {
      // Use CLI tool (bunx create-vite, etc.)
      const args = [...template.args, id];
      const proc = Bun.spawn([template.command, ...args], {
        cwd: this.projectsDir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: sanitizedEnv(),
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        // Clean up failed scaffold
        rmSync(projectPath, { recursive: true, force: true });
        throw new Error(`Template scaffolding failed: ${stderr}`);
      }
    }

    // Generate Makefile
    const makefile = generateMakefile(template.framework);
    await Bun.write(join(projectPath, 'Makefile'), makefile);

    // Write project metadata
    const meta: ProjectMeta = {
      name,
      framework: template.framework,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    this.writeMeta(projectPath, meta);

    // Install dependencies
    const installProc = Bun.spawn(['make', 'install'], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: sanitizedEnv(),
    });
    await installProc.exited;

    // Initialize git
    await this.gitManager.init(projectPath, gitAuthor);

    console.log(`[SiteBuilder] Created project "${id}" with template "${templateId}"`);

    return {
      id,
      name,
      path: projectPath,
      framework: template.framework,
      devPort: null,
      devServerPid: null,
      status: 'stopped',
      gitBranch: 'main',
      gitDirty: false,
      createdAt: meta.createdAt,
      lastOpenedAt: meta.lastOpenedAt,
      githubUrl: null,
    };
  }

  /**
   * Delete a project and its directory.
   */
  async deleteProject(id: string): Promise<void> {
    const projectPath = this.resolveProjectPath(id);
    if (!projectPath) throw new Error(`Project "${id}" not found`);

    rmSync(projectPath, { recursive: true, force: true });
    console.log(`[SiteBuilder] Deleted project "${id}"`);
  }

  /**
   * Get the file tree for a project.
   */
  getFileTree(projectId: string, maxDepth: number = 5): FileEntry {
    const projectPath = this.resolveProjectPath(projectId);
    if (!projectPath) throw new Error(`Project "${projectId}" not found`);

    const realRoot = realpathSync(projectPath);
    const guard: TreeGuard = { realRoot, gitDirs: linkedGitDirs(realRoot) };
    return this.buildFileTree(projectPath, projectPath, realRoot, 0, maxDepth, guard);
  }

  /**
   * Read a file from a project.
   */
  async readFile(projectId: string, relativePath: string): Promise<string> {
    const projectPath = this.resolveProjectPath(projectId);
    if (!projectPath) throw new Error(`Project "${projectId}" not found`);

    return withProjectErrors(relativePath, async () => {
      const filePath = this.safeJoin(projectPath, relativePath, 'follow');
      // ENOENT maps to "File not found". A FIFO or device in the tree would
      // block the read forever.
      const st = statSync(filePath);
      if (st.isDirectory()) throw new Error(`Path is a directory: ${relativePath}`);
      if (!st.isFile()) throw new Error(`Not a regular file: ${relativePath}`);

      return Bun.file(filePath).text();
    });
  }

  /**
   * Write a file to a project.
   */
  async writeFile(projectId: string, relativePath: string, content: string): Promise<void> {
    const projectPath = this.resolveProjectPath(projectId);
    if (!projectPath) throw new Error(`Project "${projectId}" not found`);
    // The HTTP PUT body is unchecked JSON. Refused here, once, so both write
    // paths below agree rather than one coercing and the other throwing.
    if (typeof content !== 'string') throw new Error('File content must be a string');

    return withProjectErrors(relativePath, async () => {
      const filePath = this.safeJoin(projectPath, relativePath, 'follow');

      // Ensure parent directory exists
      mkdirSync(dirname(filePath), { recursive: true });

      // A file with other hard links is replaced, not written in place.
      // `bun install` hardlinks node_modules into its global cache, which
      // other projects and the daemon's own dependencies share, so an
      // in-place write under node_modules would rewrite code the daemon
      // loads. A hardlink shows up in no realpath, so safeJoin cannot see it.
      // Renaming a written sibling over it retargets this name only; the mode
      // is carried over so an edited script stays executable.
      let existing: Stats | undefined;
      try {
        existing = lstatSync(filePath);
      } catch { /* new file */ }
      if (existing?.isFile() && existing.nlink > 1) {
        replaceFile(filePath, content, existing.mode & 0o777);
        return;
      }

      await Bun.write(filePath, content);
    });
  }

  /**
   * Delete a file from a project.
   */
  async deleteFile(projectId: string, relativePath: string): Promise<void> {
    const projectPath = this.resolveProjectPath(projectId);
    if (!projectPath) throw new Error(`Project "${projectId}" not found`);

    // `rmSync` unlinks a symlink itself, never its target, so only the
    // parent has to be resolved: deleting a link that points into .git is
    // allowed and leaves .git alone.
    return withProjectErrors(relativePath, async () => {
      const filePath = this.safeJoin(projectPath, relativePath, 'nofollow');
      // Bun's rmSync reports a directory, or a path below a file, as EFAULT,
      // which says nothing; lstat reports them properly. lstat, not stat: a
      // symlink to a directory is a file here, and unlinking it is fine.
      let st: Stats | undefined;
      try {
        st = lstatSync(filePath);
      } catch (err) {
        // Already gone is fine: rm with force is a no-op then.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (st?.isDirectory()) throw new Error(`Path is a directory: ${relativePath}`);
      rmSync(filePath, { force: true });
    });
  }

  /**
   * Update last opened timestamp.
   */
  async touchProject(projectId: string): Promise<void> {
    const projectPath = this.resolveProjectPath(projectId);
    if (!projectPath) return;

    const meta = this.readMeta(projectPath) ?? {
      name: projectId,
      framework: 'custom',
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    meta.lastOpenedAt = Date.now();
    this.writeMeta(projectPath, meta);
  }

  /**
   * Record a successful push, for a project already connected to GitHub.
   * Goes through readMeta/writeMeta like every other metadata write, so a
   * planted `.jarvis-project.json` symlink is neither read nor written through.
   */
  markPushed(projectId: string): void {
    const projectPath = this.resolveProjectPath(projectId);
    if (!projectPath) return;
    const meta = this.readMeta(projectPath);
    if (!meta?.github) return;
    meta.github.lastPushedAt = Date.now();
    this.writeMeta(projectPath, meta);
  }

  /**
   * Update the GitHub metadata for a project (or clear it with null).
   */
  async updateGitHubMeta(projectId: string, github: ProjectMeta['github'] | null): Promise<void> {
    const projectPath = this.resolveProjectPath(projectId);
    if (!projectPath) throw new Error(`Project "${projectId}" not found`);

    const meta = this.readMeta(projectPath) ?? {
      name: projectId,
      framework: 'custom',
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    };

    if (github) {
      meta.github = github;
    } else {
      delete meta.github;
    }

    this.writeMeta(projectPath, meta);
  }

  /** The projects directory, `~` expanded. */
  getProjectsDir(): string {
    return this.projectsDir;
  }

  /**
   * Get the resolved absolute path for a project.
   */
  getProjectPath(projectId: string): string | null {
    return this.resolveProjectPath(projectId);
  }

  // ── Private Helpers ──

  private resolveProjectPath(id: string): string | null {
    // One plain directory name, the only kind listProjects discovers. The
    // tools take project_id straight from the model, and a multi-segment id
    // like "app/.git" would make a git dir the project root, while "" or "."
    // would make the projects dir one, with every project's .git below it.
    if (typeof id !== 'string' || !id || id.startsWith('.') || /[\\/]/.test(id) || isGitDirName(id)) return null;
    const projectPath = join(this.projectsDir, id);
    // Prevent path traversal
    const resolved = resolve(projectPath);
    if (!isWithin(resolved, resolve(this.projectsDir))) return null;
    // A real directory: a one-component id can still name a FILE in the
    // projects dir, such as the dev server's PID file, or a symlink to a git
    // dir, which safeJoin would then trust as the project root. listProjects
    // never shows either.
    try {
      if (!lstatSync(resolved).isDirectory()) return null;
    } catch {
      return null;
    }
    return resolved;
  }

  /**
   * Resolve a path the model or the editor asked for, for the one operation
   * about to use it. The single choke point for every file the site tools
   * touch; see gitDirRefusal for why git's files are off limits.
   *
   * Returns the REAL path, so the caller opens what was checked rather than
   * re-walking symlinks. `final` says whether the operation follows a symlink
   * in the last component: reads and writes do; a delete unlinks the link
   * itself, so only its parent is resolved.
   */
  private safeJoin(projectPath: string, relativePath: string, final: 'follow' | 'nofollow'): string {
    const requested = String(relativePath);
    if (requested.includes('\0')) throw new Error('Path contains a NUL byte');
    // The spelling check. The real-path check below catches all of these too
    // (a missing tail keeps its spelling), so this is belt and braces that
    // refuses before touching the filesystem at all.
    if (requested.split(/[\\/]/).some(isGitDirName)) throw gitDirRefusal(requested);

    const resolved = resolve(join(projectPath, requested));
    if (!isWithin(resolved, resolve(projectPath))) {
      throw new Error('Path traversal attempt blocked');
    }
    if (resolved === resolve(projectPath)) throw new Error('A file path inside the project is required');

    const realRoot = realpathSync(projectPath);
    const real = final === 'nofollow'
      ? join(landingPath(dirname(resolved), { dangling: 'refuse', requested }), basename(resolved))
      : landingPath(resolved, { dangling: 'refuse', requested });
    if (!isWithin(real, realRoot)) {
      throw new Error(`Access denied: "${requested}" resolves outside the project through a symlink`);
    }
    if (isGitPath(realRoot, real)) throw gitDirRefusal(requested);
    return real;
  }

  private sanitizeId(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'project';
  }

  /**
   * The metadata file is the daemon's, but it sits in the tree, and a pulled
   * commit can make it a symlink to `.git/HEAD` or `.git/config`. So it is
   * only ever read as a regular file, and written by replacing the name: a
   * rename over a symlink replaces the link and never touches its target.
   */
  private readMeta(projectPath: string): ProjectMeta | null {
    const metaPath = join(projectPath, META_FILE);
    try {
      if (!lstatSync(metaPath).isFile()) return null;
      return JSON.parse(readFileSync(metaPath, 'utf-8')) as ProjectMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(projectPath: string, meta: ProjectMeta): void {
    replaceFile(join(projectPath, META_FILE), JSON.stringify(meta, null, 2), 0o644);
  }

  /**
   * `realCurrent` is where `currentPath` really is, and `guard` what a real
   * path must stay clear of. A child is listed only if the file tools could
   * open it: a symlink that leaves the project or lands in a git dir is
   * skipped, as is one whose target is missing, so the tree can neither
   * describe git's files nor wander out of the project.
   */
  private buildFileTree(
    basePath: string,
    currentPath: string,
    realCurrent: string,
    depth: number,
    maxDepth: number,
    guard: TreeGuard,
  ): FileEntry {
    const name = currentPath === basePath ? '.' : currentPath.split('/').pop()!;
    const rel = relative(basePath, currentPath) || '.';

    const stat = statSync(currentPath);

    if (!stat.isDirectory()) {
      return {
        name,
        path: rel,
        type: 'file',
        size: stat.size,
        modified: stat.mtimeMs,
      };
    }

    const entry: FileEntry = {
      name,
      path: rel,
      type: 'directory',
      children: [],
    };

    if (depth >= maxDepth) return entry;

    try {
      const entries = readdirSync(currentPath, { withFileTypes: true });
      const sorted = entries
        .filter(e => !IGNORED_DIRS.has(e.name) && !IGNORED_FILES.has(e.name) && !e.name.startsWith('.') && !isGitDirName(e.name))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      for (const child of sorted) {
        const childPath = join(currentPath, child.name);
        try {
          let realChild = join(realCurrent, child.name);
          if (child.isSymbolicLink()) {
            realChild = realpathSync(childPath);
            if (!isWithin(realChild, guard.realRoot) || isGitPath(guard.realRoot, realChild, guard.gitDirs)) continue;
          } else if (guard.gitDirs.some((dir) => isWithin(realChild.toLowerCase(), dir.toLowerCase()))) {
            // A plain entry is inside its real parent and its name passed the
            // filter above; only a linked git dir can still claim it.
            continue;
          }
          entry.children!.push(
            this.buildFileTree(basePath, childPath, realChild, depth + 1, maxDepth, guard)
          );
        } catch { /* dangling symlink, or gone since readdir: skip it, keep its siblings */ }
      }
    } catch { /* permission error */ }

    return entry;
  }
}
