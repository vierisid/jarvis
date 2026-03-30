/**
 * Site Builder — Project Manager
 *
 * CRUD operations for projects, file system access, project discovery.
 */

import type { Project, ProjectMeta, FileEntry, SiteBuilderConfig } from './types.ts';
import { GitManager } from './git-manager.ts';
import { TEMPLATES, generateMakefile, scaffoldBunReact } from './templates.ts';
import { join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const META_FILE = '.jarvis-project.json';

// Directories to exclude from file tree
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', '.vite', 'dist', 'build',
  '.cache', '.turbo', '.output', '.nuxt', '.svelte-kit',
]);

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

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
    await Bun.write(join(projectPath, META_FILE), JSON.stringify(meta, null, 2));

    // Install dependencies
    const installProc = Bun.spawn(['make', 'install'], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
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

    return this.buildFileTree(projectPath, projectPath, 0, maxDepth);
  }

  /**
   * Read a file from a project.
   */
  async readFile(projectId: string, relativePath: string): Promise<string> {
    const projectPath = this.resolveProjectPath(projectId);
    if (!projectPath) throw new Error(`Project "${projectId}" not found`);

    const filePath = this.safeJoin(projectPath, relativePath);
    const file = Bun.file(filePath);
    if (!await file.exists()) throw new Error(`File not found: ${relativePath}`);

    return file.text();
  }

  /**
   * Write a file to a project.
   */
  async writeFile(projectId: string, relativePath: string, content: string): Promise<void> {
    const projectPath = this.resolveProjectPath(projectId);
    if (!projectPath) throw new Error(`Project "${projectId}" not found`);

    const filePath = this.safeJoin(projectPath, relativePath);

    // Ensure parent directory exists
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });

    await Bun.write(filePath, content);
  }

  /**
   * Delete a file from a project.
   */
  async deleteFile(projectId: string, relativePath: string): Promise<void> {
    const projectPath = this.resolveProjectPath(projectId);
    if (!projectPath) throw new Error(`Project "${projectId}" not found`);

    const filePath = this.safeJoin(projectPath, relativePath);
    rmSync(filePath, { force: true });
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
    await Bun.write(join(projectPath, META_FILE), JSON.stringify(meta, null, 2));
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

    await Bun.write(join(projectPath, META_FILE), JSON.stringify(meta, null, 2));
  }

  /**
   * Get the resolved absolute path for a project.
   */
  getProjectPath(projectId: string): string | null {
    return this.resolveProjectPath(projectId);
  }

  // ── Private Helpers ──

  private resolveProjectPath(id: string): string | null {
    const projectPath = join(this.projectsDir, id);
    // Prevent path traversal
    const resolved = resolve(projectPath);
    if (!resolved.startsWith(resolve(this.projectsDir))) return null;
    if (!existsSync(resolved)) return null;
    return resolved;
  }

  private safeJoin(projectPath: string, relativePath: string): string {
    const resolved = resolve(join(projectPath, relativePath));
    if (!resolved.startsWith(resolve(projectPath))) {
      throw new Error('Path traversal attempt blocked');
    }
    return resolved;
  }

  private sanitizeId(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'project';
  }

  private readMeta(projectPath: string): ProjectMeta | null {
    const metaPath = join(projectPath, META_FILE);
    if (!existsSync(metaPath)) return null;
    try {
      const text = require('node:fs').readFileSync(metaPath, 'utf-8');
      return JSON.parse(text) as ProjectMeta;
    } catch {
      return null;
    }
  }

  private buildFileTree(basePath: string, currentPath: string, depth: number, maxDepth: number): FileEntry {
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
        .filter(e => !IGNORED_DIRS.has(e.name) && !IGNORED_FILES.has(e.name) && !e.name.startsWith('.'))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      for (const child of sorted) {
        entry.children!.push(
          this.buildFileTree(basePath, join(currentPath, child.name), depth + 1, maxDepth)
        );
      }
    } catch { /* permission error */ }

    return entry;
  }
}
