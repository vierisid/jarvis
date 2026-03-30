/**
 * Site Builder Service — Orchestrator
 *
 * Manages the lifecycle of the site builder feature.
 * Implements the Service interface for daemon integration.
 */

import type { Service, ServiceStatus } from '../daemon/services.ts';
import type { SiteBuilderConfig, Project } from './types.ts';
import { ProjectManager } from './project-manager.ts';
import { GitManager } from './git-manager.ts';
import { DevServerManager } from './dev-server-manager.ts';
import { SiteProxy } from './proxy.ts';
import { GitHubManager } from './github-manager.ts';

export class SiteBuilderService implements Service {
  name = 'site-builder';
  private _status: ServiceStatus = 'stopped';

  readonly projectManager: ProjectManager;
  readonly gitManager: GitManager;
  readonly githubManager: GitHubManager;
  readonly devServerManager: DevServerManager;
  readonly proxy: SiteProxy;

  constructor(private config: SiteBuilderConfig) {
    this.gitManager = new GitManager();
    this.githubManager = new GitHubManager();
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
    }
  }

  async stop(): Promise<void> {
    this._status = 'stopping';

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
      };
    });
  }
}
