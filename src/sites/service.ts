/**
 * Site Builder Service — Orchestrator
 *
 * Manages the lifecycle of the site builder feature.
 * Implements the Service interface for daemon integration.
 */

import { basename, join } from 'node:path';
import type { Service, ServiceStatus } from '../daemon/services.ts';
import type { SiteBuilderConfig, Project, GitCommit } from './types.ts';
import { ProjectManager } from './project-manager.ts';
import { GitManager } from './git-manager.ts';
import { DevServerManager } from './dev-server-manager.ts';
import { SiteProxy } from './proxy.ts';
import { GitHubManager } from './github-manager.ts';
import { GitConfigLint, GitConfigRefusedError, scanProjectGitConfigs, type GitConfigVerdict } from './git-config-lint.ts';

/**
 * What a listing shows for a verdict: the refusal written to the user, the
 * shell commands that fix it, and a note for what only a hand edit can; or
 * null. A project with no repository is not
 * flagged: it already shows no branch.
 */
function configIssue(verdict: GitConfigVerdict | undefined): Project['gitConfigIssue'] {
  if (!verdict || verdict.ok || verdict.reason === 'no-repo') return null;
  return { message: verdict.userMessage, commands: verdict.remedy?.commands ?? [], note: verdict.remedy?.note ?? null };
}

/** Upper bound on the random delay before the startup scan. */
const SCAN_JITTER_MS = 5_000;

export class SiteBuilderService implements Service {
  name = 'site-builder';
  private _status: ServiceStatus = 'stopped';

  readonly projectManager: ProjectManager;
  readonly gitManager: GitManager;
  readonly githubManager: GitHubManager;
  readonly devServerManager: DevServerManager;
  readonly proxy: SiteProxy;
  /** One lint, and so one cache, for both managers (#523). */
  readonly configLint: GitConfigLint;
  /** The pending or running startup scan, for stop() to cancel. */
  private scan: { timer: ReturnType<typeof setTimeout>; abort: AbortController } | null = null;

  constructor(private config: SiteBuilderConfig) {
    this.configLint = new GitConfigLint();
    this.gitManager = new GitManager({ configLint: this.configLint });
    this.githubManager = new GitHubManager({ configLint: this.configLint });
    this.devServerManager = new DevServerManager(config);
    this.projectManager = new ProjectManager(config, this.gitManager);
    this.proxy = new SiteProxy(this.devServerManager);
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[SiteBuilder] Disabled by config');
      this._status = 'stopped';
      return;
    }

    this._status = 'starting';

    try {
      // Clean up any orphaned dev server processes from a previous crash
      await this.devServerManager.cleanupOrphans();

      this._status = 'running';
      console.log('[SiteBuilder] Service started');
    } catch (err) {
      this._status = 'error';
      console.error('[SiteBuilder] Failed to start:', err instanceof Error ? err.message : err);
      return;
    }

    // Not awaited, and after a random delay: startup does not wait on a git
    // spawn per project, nor do several daemons on one host scan at once.
    this.cancelScan();
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void this.scanGitConfigs(abort.signal);
    }, Math.random() * SCAN_JITTER_MS);
    // A pending scan never keeps the process alive on its own.
    timer.unref?.();
    this.scan = { timer, abort };
  }

  /**
   * Lint every project's git config once (#523), so a project whose config
   * a model planted keys in is logged, and flagged in the listing
   * (gitConfigIssue), before anyone opens it. Sequential and bounded (see
   * scanProjectGitConfigs); its verdicts warm the cache the managers use.
   */
  async scanGitConfigs(signal?: AbortSignal): Promise<void> {
    try {
      const failing = await scanProjectGitConfigs(this.projectManager.getProjectsDir(), this.configLint, { signal });
      for (const { id, verdict } of failing) {
        if (!this.configLint.firstReport(join(this.projectManager.getProjectsDir(), id), verdict)) continue;
        console.warn(`[SiteBuilder] Git is turned off for project "${id}": ${verdict.summary}`);
      }
    } catch (err) {
      console.error('[SiteBuilder] Git config scan failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * The auto-commit after a dashboard save or a site chat turn. A project the
   * config lint refuses (#523) is not an error here: the file was written,
   * and git is simply off for the project, which its listing shows. That is
   * logged once per project and refusal, not on every save and turn; any
   * other failure is thrown as before.
   */
  async autoCommitIfAllowed(projectPath: string, message: string): Promise<GitCommit | null> {
    try {
      return await this.gitManager.autoCommit(projectPath, message);
    } catch (err) {
      if (!(err instanceof GitConfigRefusedError)) throw err;
      if (err.verdict.reason !== 'no-repo' && this.configLint.firstReport(projectPath, err.verdict)) {
        console.warn(`[SiteBuilder] Not auto-committing in ${basename(projectPath)}: ${err.verdict.summary}`);
      }
      return null;
    }
  }

  /** Stop a pending or running startup scan, if there is one. */
  private cancelScan(): void {
    if (!this.scan) return;
    clearTimeout(this.scan.timer);
    this.scan.abort.abort();
    this.scan = null;
  }

  async stop(): Promise<void> {
    this._status = 'stopping';
    this.cancelScan();

    // Kill all running dev servers
    await this.devServerManager.stopAll();

    this._status = 'stopped';
    console.log('[SiteBuilder] Service stopped');
  }

  status(): ServiceStatus {
    return this._status;
  }

  /**
   * Start a project's dev server and return enriched project info.
   */
  async startProject(projectId: string): Promise<Project> {
    const project = await this.projectManager.getProject(projectId);
    if (!project) throw new Error(`Project "${projectId}" not found`);

    if (this.devServerManager.isRunning(projectId)) {
      const port = this.devServerManager.getPort(projectId)!;
      return { ...project, devPort: port, status: 'running' };
    }

    const { port, pid } = await this.devServerManager.start(projectId, project.path);

    // Update last opened time
    await this.projectManager.touchProject(projectId);

    // Wait for server to be ready
    const ready = await this.devServerManager.waitForReady(port);

    return {
      ...project,
      devPort: port,
      devServerPid: pid,
      status: ready ? 'running' : 'starting',
    };
  }

  /**
   * Stop a project's dev server.
   */
  async stopProject(projectId: string): Promise<void> {
    await this.devServerManager.stop(projectId);
  }

  /**
   * Get project with live status info.
   */
  async getProjectWithStatus(projectId: string): Promise<Project | null> {
    const project = await this.projectManager.getProject(projectId);
    if (!project) return null;

    const running = this.devServerManager.isRunning(projectId);
    const port = this.devServerManager.getPort(projectId);

    return {
      ...project,
      devPort: port,
      status: running ? 'running' : 'stopped',
      // getProject just ran git in the project, so this verdict is current.
      gitConfigIssue: configIssue(this.configLint.lastVerdict(project.path)),
    };
  }

  /**
   * List all projects with live status.
   */
  async listProjectsWithStatus(): Promise<Project[]> {
    const projects = await this.projectManager.listProjects();
    return projects.map(p => {
      const running = this.devServerManager.isRunning(p.id);
      const port = this.devServerManager.getPort(p.id);
      return {
        ...p,
        devPort: port,
        status: running ? 'running' as const : 'stopped' as const,
        gitConfigIssue: configIssue(this.configLint.lastVerdict(p.path)),
      };
    });
  }
}
