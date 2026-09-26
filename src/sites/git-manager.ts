/**
 * Site Builder — Git Manager
 *
 * Wraps git CLI commands via Bun.spawn for project version control.
 */

import type { GitCommit, GitBranch } from './types.ts';
import { sanitizedEnv } from '../util/subprocess-env.ts';
import {
  PROJECT_GIT_PINS, PROJECT_STATUS_ARGS, gitVersionReader, resolveHookPins, type GitVersion,
} from './git-pins.ts';
import { GitConfigRefusedError, defaultGitConfigLint, type GitConfigLint } from './git-config-lint.ts';

/** HEAD and the pseudo-refs git writes next to it. */
const PSEUDO_REFS = new Set([
  'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD',
  'BISECT_HEAD', 'AUTO_MERGE',
]);

export class GitManager {
  private readonly configLint: GitConfigLint;

  /**
   * `configLint` is the project config lint every call in a project runs
   * first (#523); SiteBuilderService passes the one it shares with its
   * GitHubManager.
   */
  constructor(options: { configLint?: GitConfigLint } = {}) {
    this.configLint = options.configLint ?? defaultGitConfigLint;
  }

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
    // Not linted: there is no repository yet. Every call after it is.
    await this.run(projectPath, ['init'], { lint: false });

    if (author) {
      const scope = author.global ? '--global' : '--local';
      await this.run(projectPath, ['config', scope, 'user.name', author.name]);
      await this.run(projectPath, ['config', scope, 'user.email', author.email]);
    }

    // Create initial commit
    await this.stageAll(projectPath);
    await this.run(projectPath, ['commit', '-m', 'Initial commit', '--allow-empty']);
  }

  /**
   * Stage all changes and commit with a descriptive message.
   * Returns null if there are no changes to commit.
   */
  async autoCommit(projectPath: string, message: string): Promise<GitCommit | null> {
    const dirty = await this.isDirty(projectPath);
    if (!dirty) return null;

    await this.stageAll(projectPath);
    await this.run(projectPath, ['commit', '-m', message]);

    const log = await this.getLog(projectPath, 1);
    return log[0] ?? null;
  }

  /**
   * `git add -A`, minus the gitlinks already in the index (#523). For each
   * one, add checks the nested repository's work tree by running git inside
   * it, under THAT repository's config, which the lint never reads -- its
   * filters ran (reproduced in review), and no config pin or
   * `diff.ignoreSubmodules` stops it. Excluded, git never enters them; a new
   * nested repository is still recorded as a gitlink, by reading its HEAD.
   * Site projects have no submodules, so nothing real is left unstaged.
   */
  private async stageAll(projectPath: string): Promise<void> {
    const gitlinks = (await this.run(projectPath, ['ls-files', '--stage', '-z']))
      .split('\0')
      .filter(entry => entry.startsWith('160000 '))
      .map(entry => entry.slice(entry.indexOf('\t') + 1));
    const exclude = gitlinks.map(path => `:(exclude,literal)${path}`);
    await this.run(projectPath, exclude.length > 0 ? ['add', '-A', '--', '.', ...exclude] : ['add', '-A']);
  }

  /**
   * List all local branches.
   */
  async getBranches(projectPath: string): Promise<GitBranch[]> {
    // --no-column: a project's column.ui=always would put names side by side.
    const output = await this.run(projectPath, ['branch', '--no-color', '--no-column']);
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
        // A project's i18n.logOutputEncoding would re-encode the output.
        '--encoding=UTF-8',
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
    const output = await this.run(projectPath, [...PROJECT_STATUS_ARGS]);
    return output.trim().length > 0;
  }

  /**
   * Get diff of uncommitted changes.
   */
  async getDiff(projectPath: string): Promise<string> {
    // --ignore-submodules=all for the reason on PROJECT_STATUS_ARGS.
    // --no-color: a project's color.diff=always would put escapes in it.
    const diff = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all'];
    const staged = await this.run(projectPath, [...diff, '--cached']);
    const unstaged = await this.run(projectPath, diff);
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
      const status = await this.run(projectPath, [...PROJECT_STATUS_ARGS]);
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
      const status = await this.run(projectPath, [...PROJECT_STATUS_ARGS]);
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
   * since check-ref-format would read the name as an option too. After it:
   * a short list of names that are valid refnames but not branches, then
   * check-ref-format, whose output must equal the input.
   */
  private async checkBranchName(projectPath: string, name: string): Promise<void> {
    const invalid = new Error(`Invalid branch name: "${String(name)}"`);
    if (typeof name !== 'string' || !name || name.startsWith('-')) throw invalid;
    // Names check-ref-format passes but that do not mean a branch here: `@`
    // is HEAD, HEAD and git's pseudo-refs name whatever git last left there
    // (compared case-insensitively, as a case-insensitive filesystem would
    // read them), and a full `refs/...` name is a ref path, not a branch.
    // A fixed list, not `*_HEAD`: `page_head` is an ordinary branch.
    if (name === '@' || PSEUDO_REFS.has(name.toUpperCase()) || name.startsWith('refs/')) throw invalid;
    let normalized: string;
    try {
      normalized = (await this.run(projectPath, ['check-ref-format', '--branch', name])).trim();
    } catch (err) {
      // The config lint's refusal is about the project, not the name.
      if (err instanceof GitConfigRefusedError) throw err;
      throw invalid;
    }
    // `--branch` also EXPANDS shorthands (`@{-1}` becomes the previous
    // branch), so a name it rewrites is not the name the caller sent.
    if (normalized !== name) throw invalid;
  }

  /**
   * gitVersionReader, run from `/`: the version describes the binary, and `/`
   * always exists, where a missing TMPDIR would fail every call on this path.
   */
  private readonly readGitVersion = gitVersionReader(args => this.run('/', args, { hookPins: [], lint: false }));

  /**
   * The git version, or null when it cannot be read this time (not cached;
   * the next call retries). Null means "do the hook lookup", so a failed read
   * keeps hooks pinned off and leaves the manager usable, rather than failing
   * every status and commit with an error that reads like git is missing.
   */
  private async gitVersion(): Promise<GitVersion> {
    try {
      return await this.readGitVersion();
    } catch {
      return null;
    }
  }

  /**
   * Run a git command in the project directory. `hookPins`, when given,
   * replaces the per-call resolveHookPins lookup; the lookups themselves pass
   * `[]`, since they cannot wait on their own result. Unlike GitHubManager
   * there is no secret here to keep the lookup away from, so every other call
   * resolves its own pins.
   *
   * Every call first lints the project's git config (GitConfigLint.check,
   * #523) and throws its refusal instead of running git. `lint: false` is
   * for the calls with no project repository to lint -- `git init` and the
   * version read from `/` -- and for the hook lookup, which runs straight
   * after its own call's lint.
   */
  private async run(
    cwd: string,
    args: string[],
    options: { hookPins?: readonly string[]; lint?: boolean } = {},
  ): Promise<string> {
    if (options.lint !== false) await this.configLint.check(cwd);
    // Sanitized, not inherited: git can still run commands the project names
    // (PROJECT_GIT_PINS covers the ones a pin can), and the project is written
    // by the model. Stripping the inherited GIT_* also stops a hook-invoked
    // daemon's GIT_DIR/GIT_INDEX_FILE from pointing these commands at the
    // wrong repository.
    //
    // On git 2.54 (or an unknown version), a config hook name that cannot be
    // pinned makes this throw for every call in that repo -- or in every
    // repo, if the name is in ~/.gitconfig. Fail closed; project listings
    // catch the error and show the project as having no branch.
    const hookPins = options.hookPins
      ?? await resolveHookPins(lookup => this.run(cwd, lookup, { hookPins: [], lint: false }), await this.gitVersion());
    const proc = Bun.spawn(['git', ...PROJECT_GIT_PINS, ...hookPins, ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: sanitizedEnv({ GIT_TERMINAL_PROMPT: '0' }),
    });

    // Both pipes at once: git blocks once a pipe nobody reads fills (~64 KiB),
    // and stderr is only read on failure otherwise.
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      // exitCode rides along so resolveHookPins can tell "no match" (1) apart.
      throw Object.assign(new Error(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}`), { exitCode });
    }

    return stdout;
  }
}
