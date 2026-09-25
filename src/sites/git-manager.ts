/**
 * Site Builder — Git Manager
 *
 * Wraps git CLI commands via Bun.spawn for project version control.
 */

import type { GitCommit, GitBranch } from './types.ts';
import { sanitizedEnv } from '../util/subprocess-env.ts';

/**
 * `-c` pins on every git call made here (#516). Command-line config beats
 * every config file for the same key, so these hold even against a
 * `.git/config` planted before the site file tools stopped writing it, or
 * through site_run_command. They are defense in depth: the site file tools
 * refusing `.git` is the fix.
 *
 * - `safe.bareRepository=explicit`: in a project with no .git, git would take
 *   the project ROOT for a bare repository if it holds HEAD, objects/ and
 *   refs/, and read its `config` -- ordinary files the site file tools may
 *   write, whose core.worktree + core.fsmonitor then run on the next
 *   `git status`. Nothing here ever uses a bare repository.
 * - `core.fsmonitor=false`: git runs the fsmonitor command whenever it reads
 *   the index, and status runs on every project listing.
 * - `core.hooksPath=/dev/null`: no hook runs for the daemon's own commits,
 *   checkouts, merges and rebases. A hooks dir in the worktree (husky's
 *   `.husky`, set by an npm install) is model-writable, and overwriting an
 *   existing executable hook keeps its mode. Costs a user's pre-commit lint on
 *   auto-commits; their own `git commit` still runs it.
 * - `log.showSignature=false`: getLog would otherwise start gpg.
 *
 * NOT pinnable this way, because the names are arbitrary: filter drivers
 * (`filter.<x>.clean`), merge drivers and textconv drivers, and config pulled
 * in through `include.path`. Those need a config file the site tools can
 * write, which is what they no longer can. getDiff passes --no-ext-diff and
 * --no-textconv for the diff side of it.
 */
const PROJECT_GIT_PINS = [
  '-c', 'safe.bareRepository=explicit',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'log.showSignature=false',
];

export class GitManager {
  /**
   * Check if git is installed on the system.
   */
  static async isInstalled(): Promise<boolean> {
    try {
      const proc = Bun.spawn(['git', '--version'], { stdout: 'pipe', stderr: 'pipe', env: sanitizedEnv() });
      const stdout = await new Response(proc.stdout).text();
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  }

  /**
   * Get the effective git author config (global/system level).
   */
  static async getGlobalAuthor(): Promise<{ name: string | null; email: string | null }> {
    let name: string | null = null;
    let email: string | null = null;
    try {
      const proc = Bun.spawn(['git', 'config', '--global', 'user.name'], { stdout: 'pipe', stderr: 'pipe', env: sanitizedEnv() });
      const out = await new Response(proc.stdout).text();
      if ((await proc.exited) === 0) name = out.trim() || null;
    } catch {}
    try {
      const proc = Bun.spawn(['git', 'config', '--global', 'user.email'], { stdout: 'pipe', stderr: 'pipe', env: sanitizedEnv() });
      const out = await new Response(proc.stdout).text();
      if ((await proc.exited) === 0) email = out.trim() || null;
    } catch {}
    return { name, email };
  }

  /**
   * Initialize a new git repo in the project directory.
   * If author config is provided, sets it before the initial commit.
   */
  async init(projectPath: string, author?: { name: string; email: string; global: boolean }): Promise<void> {
    await this.run(projectPath, ['init']);

    if (author) {
      const scope = author.global ? '--global' : '--local';
      await this.run(projectPath, ['config', scope, 'user.name', author.name]);
      await this.run(projectPath, ['config', scope, 'user.email', author.email]);
    }

    // Create initial commit
    await this.run(projectPath, ['add', '-A']);
    await this.run(projectPath, ['commit', '-m', 'Initial commit', '--allow-empty']);
  }

  /**
   * Stage all changes and commit with a descriptive message.
   * Returns null if there are no changes to commit.
   */
  async autoCommit(projectPath: string, message: string): Promise<GitCommit | null> {
    const dirty = await this.isDirty(projectPath);
    if (!dirty) return null;

    await this.run(projectPath, ['add', '-A']);
    await this.run(projectPath, ['commit', '-m', message]);

    const log = await this.getLog(projectPath, 1);
    return log[0] ?? null;
  }

  /**
   * List all local branches.
   */
  async getBranches(projectPath: string): Promise<GitBranch[]> {
    const output = await this.run(projectPath, ['branch', '--no-color']);
    if (!output.trim()) return [{ name: 'main', current: true }];

    return output
      .split('\n')
      .filter(line => line.trim())
      .map(line => ({
        name: line.replace(/^\*?\s+/, '').trim(),
        current: line.startsWith('*'),
      }));
  }

  /**
   * Get the current branch name.
   */
  async getCurrentBranch(projectPath: string): Promise<string> {
    const output = await this.run(projectPath, ['branch', '--show-current']);
    return output.trim() || 'main';
  }

  /**
   * Create a new branch.
   */
  async createBranch(projectPath: string, name: string): Promise<void> {
    await this.checkBranchName(projectPath, name);
    await this.run(projectPath, ['switch', '-c', name]);
  }

  /**
   * Switch to an existing branch.
   */
  async switchBranch(projectPath: string, name: string): Promise<void> {
    await this.checkBranchName(projectPath, name);
    // `switch`, not `checkout`: checkout takes a name that is also a path
    // ("src") as a pathspec and overwrites that path's uncommitted changes.
    await this.run(projectPath, ['switch', '--', name]);
  }

  /**
   * Get commit log.
   */
  async getLog(projectPath: string, limit: number = 50): Promise<GitCommit[]> {
    try {
      const output = await this.run(projectPath, [
        'log',
        `--max-count=${limit}`,
        '--format=%H|%h|%s|%an|%at',
      ]);

      if (!output.trim()) return [];

      return output
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [hash, shortHash, message, author, dateStr] = line.split('|');
          return {
            hash: hash!,
            shortHash: shortHash!,
            message: message!,
            author: author!,
            date: parseInt(dateStr!, 10) * 1000,
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Check if working tree has uncommitted changes.
   */
  async isDirty(projectPath: string): Promise<boolean> {
    const output = await this.run(projectPath, ['status', '--porcelain']);
    return output.trim().length > 0;
  }

  /**
   * Get diff of uncommitted changes.
   */
  async getDiff(projectPath: string): Promise<string> {
    const staged = await this.run(projectPath, ['diff', '--no-ext-diff', '--no-textconv', '--cached']);
    const unstaged = await this.run(projectPath, ['diff', '--no-ext-diff', '--no-textconv']);
    return (staged + '\n' + unstaged).trim();
  }

  /**
   * Merge a branch into the current branch.
   */
  async merge(projectPath: string, branch: string): Promise<{ success: boolean; conflicts?: string[] }> {
    await this.checkBranchName(projectPath, branch);
    try {
      await this.run(projectPath, ['merge', branch]);
      return { success: true };
    } catch (err) {
      // Check for merge conflicts
      const status = await this.run(projectPath, ['status', '--porcelain']);
      const conflicts = status
        .split('\n')
        .filter(line => line.startsWith('UU') || line.startsWith('AA'))
        .map(line => line.slice(3).trim());

      if (conflicts.length > 0) {
        return { success: false, conflicts };
      }

      // Abort the failed merge
      try { await this.run(projectPath, ['merge', '--abort']); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Rebase current branch onto another branch.
   */
  async rebase(projectPath: string, ontoBranch: string): Promise<{ success: boolean; conflicts?: string[] }> {
    // Outside the try, which turns every failure into `success: false`.
    await this.checkBranchName(projectPath, ontoBranch);
    try {
      await this.run(projectPath, ['rebase', ontoBranch]);
      return { success: true };
    } catch {
      const status = await this.run(projectPath, ['status', '--porcelain']);
      const conflicts = status
        .split('\n')
        .filter(line => line.startsWith('UU') || line.startsWith('AA'))
        .map(line => line.slice(3).trim());

      if (conflicts.length > 0) {
        return { success: false, conflicts };
      }

      try { await this.run(projectPath, ['rebase', '--abort']); } catch { /* ignore */ }
      return { success: false };
    }
  }

  /**
   * Delete a branch.
   */
  async deleteBranch(projectPath: string, name: string): Promise<void> {
    await this.checkBranchName(projectPath, name);
    await this.run(projectPath, ['branch', '-d', name]);
  }

  /**
   * Refuse a branch name before it reaches git's argv (#520). The names come
   * from the dashboard, and git reads one that starts with `-` as an option:
   * `--orphan=x` or `--detach` change what checkout does, and
   * `rebase --exec=<cmd>` runs a command. The dash check has to come first,
   * since check-ref-format would read the name as an option too; after it,
   * check-ref-format rejects everything else git would not take as a branch.
   */
  private async checkBranchName(projectPath: string, name: string): Promise<void> {
    const invalid = new Error(`Invalid branch name: "${String(name)}"`);
    if (typeof name !== 'string' || !name || name.startsWith('-')) throw invalid;
    try {
      await this.run(projectPath, ['check-ref-format', '--branch', name]);
    } catch {
      throw invalid;
    }
  }

  /**
   * Run a git command in the project directory.
   */
  private async run(cwd: string, args: string[]): Promise<string> {
    // Sanitized, not inherited: git can still run commands the project names
    // (PROJECT_GIT_PINS covers the ones a pin can), and the project is written
    // by the model. Stripping the inherited GIT_* also stops a hook-invoked
    // daemon's GIT_DIR/GIT_INDEX_FILE from pointing these commands at the
    // wrong repository.
    const proc = Bun.spawn(['git', ...PROJECT_GIT_PINS, ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: sanitizedEnv({ GIT_TERMINAL_PROMPT: '0' }),
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
    }

    return stdout;
  }
}
