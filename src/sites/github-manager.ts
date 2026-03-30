/**
 * Site Builder — GitHub Manager
 *
 * Handles GitHub integration: token management (via encrypted keychain),
 * GitHub REST API calls (create/list repos, validate token), and git
 * remote operations (push, pull, fetch, ahead/behind status).
 */

import { getSecret, setSecret, deleteSecret, hasSecret } from '../vault/keychain.ts';
import type { GitRemoteStatus, GitHubRepoOptions } from './types.ts';

const TOKEN_KEY = 'github.personal_access_token';
const API_BASE = 'https://api.github.com';

export class GitHubManager {

  // ── Token Management ──

  getToken(): string | null {
    return process.env.JARVIS_GITHUB_TOKEN ?? getSecret(TOKEN_KEY);
  }

  setToken(token: string): void {
    setSecret(TOKEN_KEY, token);
  }

  deleteToken(): void {
    deleteSecret(TOKEN_KEY);
  }

  hasToken(): boolean {
    return !!process.env.JARVIS_GITHUB_TOKEN || hasSecret(TOKEN_KEY);
  }

  /**
   * Validate the stored token against GitHub API.
   * Returns the authenticated username and granted scopes.
   */
  async validateToken(): Promise<{ valid: boolean; username: string | null; scopes: string[] }> {
    try {
      const res = await this.githubFetch('GET', '/user');
      const data = await res.json() as { login: string };
      const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(',').map(s => s.trim()).filter(Boolean);
      return { valid: true, username: data.login, scopes };
    } catch {
      return { valid: false, username: null, scopes: [] };
    }
  }

  // ── Repository Operations ──

  /**
   * Create a new GitHub repository under the authenticated user.
   */
  async createRepo(options: GitHubRepoOptions): Promise<{
    owner: string;
    repo: string;
    cloneUrl: string;
    htmlUrl: string;
  }> {
    const res = await this.githubFetch('POST', '/user/repos', {
      name: options.name,
      description: options.description ?? '',
      private: options.private,
      auto_init: false,
    });
    const data = await res.json() as {
      owner: { login: string };
      name: string;
      clone_url: string;
      html_url: string;
    };
    return {
      owner: data.owner.login,
      repo: data.name,
      cloneUrl: data.clone_url,
      htmlUrl: data.html_url,
    };
  }

  /**
   * List the authenticated user's repositories (sorted by most recently updated).
   */
  async listUserRepos(page = 1, perPage = 30): Promise<Array<{
    owner: string;
    name: string;
    fullName: string;
    private: boolean;
    htmlUrl: string;
    cloneUrl: string;
  }>> {
    const res = await this.githubFetch('GET', `/user/repos?sort=updated&per_page=${perPage}&page=${page}`);
    const data = await res.json() as Array<{
      owner: { login: string };
      name: string;
      full_name: string;
      private: boolean;
      html_url: string;
      clone_url: string;
    }>;
    return data.map(r => ({
      owner: r.owner.login,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      htmlUrl: r.html_url,
      cloneUrl: r.clone_url,
    }));
  }

  /**
   * Get info about a specific repo (used when connecting to an existing repo).
   */
  async getRepo(owner: string, repo: string): Promise<{
    owner: string;
    repo: string;
    cloneUrl: string;
    htmlUrl: string;
  }> {
    const res = await this.githubFetch('GET', `/repos/${owner}/${repo}`);
    const data = await res.json() as {
      owner: { login: string };
      name: string;
      clone_url: string;
      html_url: string;
    };
    return {
      owner: data.owner.login,
      repo: data.name,
      cloneUrl: data.clone_url,
      htmlUrl: data.html_url,
    };
  }

  // ── Git Remote Operations ──

  /**
   * Add or update the 'origin' remote for a project.
   */
  async addRemote(projectPath: string, remoteUrl: string): Promise<void> {
    const existing = await this.getRemoteUrl(projectPath);
    if (existing) {
      await this.git(projectPath, ['remote', 'set-url', 'origin', remoteUrl]);
    } else {
      await this.git(projectPath, ['remote', 'add', 'origin', remoteUrl]);
    }
  }

  /**
   * Remove the 'origin' remote.
   */
  async removeRemote(projectPath: string): Promise<void> {
    try {
      await this.git(projectPath, ['remote', 'remove', 'origin']);
    } catch { /* already gone */ }
  }

  /**
   * Get the current origin remote URL, or null if not set.
   */
  async getRemoteUrl(projectPath: string): Promise<string | null> {
    try {
      const url = await this.git(projectPath, ['remote', 'get-url', 'origin']);
      return url.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Push to the origin remote. Injects token into URL for authentication.
   */
  async push(projectPath: string, branch?: string, force = false): Promise<{ success: boolean; error?: string }> {
    const token = this.getToken();
    if (!token) return { success: false, error: 'GitHub token not configured' };

    const remoteUrl = await this.getRemoteUrl(projectPath);
    if (!remoteUrl) return { success: false, error: 'No remote origin configured' };

    const authUrl = this.injectToken(remoteUrl, token);
    const targetBranch = branch ?? await this.getCurrentBranch(projectPath);

    const args = ['push', '-u', authUrl, targetBranch];
    if (force) args.splice(1, 0, '--force');

    try {
      await this.git(projectPath, args);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Pull from the origin remote.
   */
  async pull(projectPath: string, branch?: string): Promise<{ success: boolean; conflicts?: string[]; error?: string }> {
    const token = this.getToken();
    if (!token) return { success: false, error: 'GitHub token not configured' };

    const remoteUrl = await this.getRemoteUrl(projectPath);
    if (!remoteUrl) return { success: false, error: 'No remote origin configured' };

    const authUrl = this.injectToken(remoteUrl, token);
    const targetBranch = branch ?? await this.getCurrentBranch(projectPath);

    try {
      await this.git(projectPath, ['pull', authUrl, targetBranch]);
      return { success: true };
    } catch (err) {
      // Check for merge conflicts
      try {
        const status = await this.git(projectPath, ['status', '--porcelain']);
        const conflicts = status
          .split('\n')
          .filter(line => line.startsWith('UU') || line.startsWith('AA'))
          .map(line => line.slice(3).trim());

        if (conflicts.length > 0) {
          return { success: false, conflicts };
        }
      } catch { /* ignore */ }

      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Fetch from origin and compute ahead/behind status.
   */
  async getRemoteStatus(projectPath: string): Promise<GitRemoteStatus> {
    const remoteUrl = await this.getRemoteUrl(projectPath);
    if (!remoteUrl) {
      return { hasRemote: false, remoteUrl: null, owner: null, repo: null, ahead: 0, behind: 0, lastPushedAt: null };
    }

    const { owner, repo } = this.parseRemoteUrl(remoteUrl);
    const token = this.getToken();

    // Fetch latest refs from origin (requires auth)
    if (token) {
      const authUrl = this.injectToken(remoteUrl, token);
      try {
        await this.git(projectPath, ['fetch', authUrl, '--quiet']);
      } catch { /* network error, show stale data */ }
    }

    const currentBranch = await this.getCurrentBranch(projectPath);
    let ahead = 0;
    let behind = 0;

    try {
      const behindStr = await this.git(projectPath, ['rev-list', '--count', `HEAD..origin/${currentBranch}`]);
      behind = parseInt(behindStr.trim(), 10) || 0;
    } catch { /* no tracking branch yet */ }

    try {
      const aheadStr = await this.git(projectPath, ['rev-list', '--count', `origin/${currentBranch}..HEAD`]);
      ahead = parseInt(aheadStr.trim(), 10) || 0;
    } catch { /* no tracking branch yet — all local commits are "ahead" */
      try {
        const totalStr = await this.git(projectPath, ['rev-list', '--count', 'HEAD']);
        ahead = parseInt(totalStr.trim(), 10) || 0;
      } catch { /* empty repo */ }
    }

    return { hasRemote: true, remoteUrl, owner, repo, ahead, behind, lastPushedAt: null };
  }

  // ── Private Helpers ──

  /**
   * Inject a token into an HTTPS GitHub URL for non-interactive auth.
   * Converts https://github.com/owner/repo.git → https://<token>@github.com/owner/repo.git
   */
  private injectToken(remoteUrl: string, token: string): string {
    try {
      const url = new URL(remoteUrl);
      url.username = token;
      url.password = '';
      return url.toString();
    } catch {
      // Fallback for non-standard URLs
      return remoteUrl.replace('https://', `https://${token}@`);
    }
  }

  /**
   * Parse owner/repo from a GitHub remote URL.
   */
  private parseRemoteUrl(remoteUrl: string): { owner: string | null; repo: string | null } {
    // Handles both https://github.com/owner/repo.git and git@github.com:owner/repo.git
    const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) return { owner: null, repo: null };
    return { owner: match[1]!, repo: match[2]! };
  }

  private async getCurrentBranch(projectPath: string): Promise<string> {
    const output = await this.git(projectPath, ['branch', '--show-current']);
    return output.trim() || 'main';
  }

  /**
   * Run a git command via Bun.spawn.
   */
  private async git(cwd: string, args: string[]): Promise<string> {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
    }

    return stdout;
  }

  /**
   * Make an authenticated request to the GitHub REST API.
   */
  private async githubFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const token = this.getToken();
    if (!token) throw new Error('GitHub token not configured');

    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'JARVIS-SiteBuilder',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(`GitHub API error (${res.status}): ${err.message ?? res.statusText}`);
    }

    return res;
  }
}
