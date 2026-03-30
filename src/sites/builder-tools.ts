/**
 * Site Builder — LLM Tools
 *
 * Tools available to the LLM when working in the context of a site builder project.
 * These are scoped to the active project directory.
 */

import type { ToolDefinition } from '../actions/tools/registry.ts';
import type { ProjectManager } from './project-manager.ts';
import type { GitManager } from './git-manager.ts';
import type { GitHubManager } from './github-manager.ts';

/** Block patterns for long-running dev servers that conflict with the managed server */
const BLOCKED_SERVER_PATTERNS = /\b(make\s+dev|bun\s+--hot|vite\s*$|next\s+dev|npm\s+run\s+dev|yarn\s+dev)\b/i;

/** Env keys that must never leak to subprocesses */
const SECRET_ENV_PATTERNS = [
  /api[_-]?key/i, /secret/i, /token/i, /password/i, /credential/i,
  /^JARVIS_API_KEY$/, /^JARVIS_AUTH_TOKEN$/, /^JARVIS_OPENAI_KEY$/,
  /^JARVIS_OPENROUTER_KEY$/, /^ANTHROPIC_API_KEY$/, /^OPENAI_API_KEY$/,
];

/** Build a sanitized env with secrets stripped */
function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_ENV_PATTERNS.some(p => p.test(key))) continue;
    env[key] = value;
  }
  return env;
}

export function createSiteBuilderTools(
  projectManager: ProjectManager,
  gitManager: GitManager,
  githubManager?: GitHubManager,
): ToolDefinition[] {
  return [
    {
      name: 'site_read_file',
      description: 'Read a file from the current site builder project. Returns the file content as text.',
      category: 'site-builder',
      parameters: {
        project_id: { type: 'string', description: 'The project ID', required: true },
        path: { type: 'string', description: 'Relative path to the file (e.g., "src/App.tsx")', required: true },
      },
      execute: async (params) => {
        try {
          const content = await projectManager.readFile(params.project_id as string, params.path as string);
          return content;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'site_write_file',
      description: 'Write content to a file in the current site builder project. Creates parent directories if needed.',
      category: 'site-builder',
      parameters: {
        project_id: { type: 'string', description: 'The project ID', required: true },
        path: { type: 'string', description: 'Relative path to the file (e.g., "src/App.tsx")', required: true },
        content: { type: 'string', description: 'The full file content to write', required: true },
      },
      execute: async (params) => {
        try {
          await projectManager.writeFile(params.project_id as string, params.path as string, params.content as string);
          return `File written: ${params.path}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'site_delete_file',
      description: 'Delete a file from the current site builder project.',
      category: 'site-builder',
      parameters: {
        project_id: { type: 'string', description: 'The project ID', required: true },
        path: { type: 'string', description: 'Relative path to the file to delete', required: true },
      },
      execute: async (params) => {
        try {
          await projectManager.deleteFile(params.project_id as string, params.path as string);
          return `File deleted: ${params.path}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'site_list_files',
      description: 'List the file tree of the current site builder project. Returns the directory structure.',
      category: 'site-builder',
      parameters: {
        project_id: { type: 'string', description: 'The project ID', required: true },
      },
      execute: async (params) => {
        try {
          const tree = projectManager.getFileTree(params.project_id as string);
          return JSON.stringify(tree, null, 2);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'site_run_command',
      description: 'Run a shell command in the project directory. Use for installing packages, building, running one-off scripts, etc. Has a 30-second timeout. Do NOT use this to start dev servers — use the dashboard Start button or /api/sites/projects/:id/start instead.',
      category: 'site-builder',
      parameters: {
        project_id: { type: 'string', description: 'The project ID', required: true },
        command: { type: 'string', description: 'The command to run (e.g., "bun add react-router"). Do NOT run long-lived servers here.', required: true },
      },
      execute: async (params) => {
        const projectPath = projectManager.getProjectPath(params.project_id as string);
        if (!projectPath) return 'Error: Project not found';

        const cmd = (params.command as string).trim();

        // Block commands that start long-running dev servers (conflicts with managed server)
        if (BLOCKED_SERVER_PATTERNS.test(cmd)) {
          return 'Error: Do not start dev servers with site_run_command. The dev server is managed automatically — use the Start button in the Sites page or POST /api/sites/projects/:id/start instead.';
        }

        try {
          const proc = Bun.spawn(['sh', '-c', cmd], {
            cwd: projectPath,
            stdout: 'pipe',
            stderr: 'pipe',
            env: sanitizedEnv(),
          });

          // 30-second timeout to prevent hanging
          const result = await Promise.race([
            (async () => {
              const [stdout, stderr] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
              ]);
              const exitCode = await proc.exited;

              let output = '';
              if (stdout.trim()) output += stdout.trim();
              if (stderr.trim()) output += (output ? '\n' : '') + stderr.trim();
              if (exitCode !== 0) output += `\n(exit code: ${exitCode})`;
              return output || '(no output)';
            })(),
            new Promise<string>((resolve) => {
              setTimeout(() => {
                try { proc.kill(); } catch { /* ignore */ }
                resolve('Error: Command timed out after 30 seconds. If you were trying to start a dev server, use the Sites page Start button instead.');
              }, 30_000);
            }),
          ]);

          return result;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'site_git_commit',
      description: 'Stage all changes and commit in the site builder project.',
      category: 'site-builder',
      parameters: {
        project_id: { type: 'string', description: 'The project ID', required: true },
        message: { type: 'string', description: 'Commit message', required: true },
      },
      execute: async (params) => {
        const projectPath = projectManager.getProjectPath(params.project_id as string);
        if (!projectPath) return 'Error: Project not found';

        try {
          const commit = await gitManager.autoCommit(projectPath, params.message as string);
          if (!commit) return 'Nothing to commit — working tree clean';
          return `Committed: ${commit.shortHash} ${commit.message}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    ...(githubManager ? [{
      name: 'site_github_push',
      description: 'Push the current site builder project to GitHub. The project must already be connected to a GitHub repository (via the Git panel). Commits all pending changes before pushing.',
      category: 'site-builder',
      parameters: {
        project_id: { type: 'string', description: 'The project ID', required: true },
        commit_message: { type: 'string', description: 'Optional commit message for any uncommitted changes. If omitted, uncommitted changes are not committed before pushing.', required: false },
      },
      execute: async (params) => {
        const projectPath = projectManager.getProjectPath(params.project_id as string);
        if (!projectPath) return 'Error: Project not found';

        try {
          // Optionally commit pending changes first
          if (params.commit_message) {
            const commit = await gitManager.autoCommit(projectPath, params.commit_message as string);
            if (commit) {
              // continue to push
            }
          }

          const result = await githubManager.push(projectPath);
          if (!result.success) return `Error: ${result.error}`;
          return 'Pushed to GitHub successfully';
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    } as ToolDefinition] : []),
  ];
}
