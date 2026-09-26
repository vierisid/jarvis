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
import { sanitizedEnv } from '../util/subprocess-env.ts';
import { forCard as cardText } from '../util/card-text.ts';

/** Block patterns for long-running dev servers that conflict with the managed server */
const BLOCKED_SERVER_PATTERNS = /\b(make\s+dev|bun\s+--hot|vite\s*$|next\s+dev|npm\s+run\s+dev|yarn\s+dev)\b/i;

/**
 * One model-supplied value, safe to put in an approval headline.
 *
 * The card renders the intent sentence and nothing else -- no surface renders
 * `tool_arguments` -- so these strings ARE the review, and there are two ways
 * to get them wrong in opposite directions.
 *
 * Too long: a crafted value runs past the real sentence and appends
 * reassuring prose after it, or newlines push the real verb out of view.
 * Too SHORT: the truncation hides the part of the command that matters. That
 * is the worse failure for `site_run_command`, whose card fires mainly on a
 * tainted turn -- exactly the injected-content case, where the payload is
 * unlikely to be in the first few words.
 *
 * So the rule is placement, not brevity: the interesting free-text value goes
 * LAST in the sentence, where there is nothing after it to impersonate, and
 * gets a budget big enough to show the whole thing. Values in the middle of a
 * sentence keep the short cap, because those are the ones that can forge an
 * ending. Whitespace is always collapsed so nothing can scroll the verb away.
 */
function forCard(value: unknown, fallback = '', max = 80): string {
  return cardText(String(value ?? '').trim() ? value : fallback, max);
}

/** A trailing free-text value: shown in full up to a card-sized budget. */
const TRAILING = 600;

export function createSiteBuilderTools(
  projectManager: ProjectManager,
  gitManager: GitManager,
  githubManager?: GitHubManager,
): ToolDefinition[] {
  return [
    {
      name: 'site_create_project',
      description:
        'Create a new site builder project from a template. Returns the new project id, name, framework, and path on success. Use this whenever the user asks for a NEW project (vs editing an existing one). Available templates: vite-react (default, React + TS + Vite), vite-vue, vite-svelte, vite-vanilla (vanilla HTML/JS), next (Next.js app), bun-react (Bun + React with HTML imports). Project ids are derived from the name (lowercased, dashes); avoid duplicating an existing name.',
      category: 'site-builder',
      parameters: {
        name: {
          type: 'string',
          description: 'Display name for the new project (e.g., "marketing-landing"). Used to derive the project id.',
          required: true,
        },
        template: {
          type: 'string',
          description:
            'Template id. One of: "vite-react", "vite-vue", "vite-svelte", "vite-vanilla", "next", "bun-react". Defaults to "vite-react" when omitted.',
          required: false,
        },
      },
      /**
       * Scaffolding installs software. `createProject` spawns the template's
       * CLI (`bunx create-vite` and friends) and then `make install`, so
       * third-party package code -- including npm lifecycle scripts -- runs on
       * the user's machine. `install_software` is the honest category; the
       * TOOL_ACTION_MAP floor is `execute_command` because that is what the
       * spawn itself is, and `confirm: 'above_level'` turns the level-7
       * shortfall into an approval card for an agent that already clears the
       * floor, instead of a refusal.
       */
      authorityGate: (params) => ({
        actionCategory: 'install_software',
        actionCategories: ['install_software', 'execute_command'],
        confirm: 'above_level',
        intent: `Scaffold a new "${forCard(params.template, 'vite-react')}" site project. Downloads and runs third-party package code. Project name: ${forCard(params.name, '', TRAILING)}`,
      }),
      execute: async (params) => {
        try {
          const name = String(params.name ?? '').trim();
          if (!name) return 'Error: name is required';
          const template = (params.template ? String(params.template) : 'vite-react');
          const project = await projectManager.createProject(name, template);
          return `Created project "${project.name}" (id: ${project.id}, framework: ${project.framework}) at ${project.path}. Use this id as project_id in subsequent site_* calls.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
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
      // Intent only: no category raise, no `confirm`, so gating is unchanged.
      // It exists because the card is the whole review and, without a
      // sentence, `synthesizeApprovalIntent` falls through to its default and
      // renders the bare tool name -- "Site write file", with no path.
      authorityGate: (params) => ({
        actionCategory: 'write_data',
        intent: `In site project "${forCard(params.project_id)}", write file: ${forCard(params.path, '', TRAILING)}`,
      }),
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
      /**
       * `delete_data` is the honest category for an `rmSync`, but it is level
       * 9 -- above every role this product ships -- and a bare level
       * shortfall is a refusal, not a prompt. So the TOOL_ACTION_MAP floor is
       * `write_data` (the same level the sibling `site_write_file` needs to
       * truncate the very same file) and `confirm: 'above_level'` promotes
       * the shortfall to an approval card. The card is still labelled
       * delete_data, so it reads as destructive and cannot be resolved by
       * voice.
       */
      authorityGate: (params) => ({
        actionCategory: 'delete_data',
        confirm: 'above_level',
        intent: `In site project "${forCard(params.project_id)}", delete file: ${forCard(params.path, '', TRAILING)}`,
      }),
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
      /**
       * Intent only -- the category is already `execute_command` and matches
       * the builtin `run_command`, so nothing here changes what is gated.
       *
       * What it changes is whether the gate is reviewable. `run_command` has
       * a dedicated case in the daemon's approval-intent synthesiser that
       * renders `Run: <command>`; `site_run_command` matched nothing and its
       * card read "Site run command" with the command nowhere on it. That
       * makes the one control standing between injected content and a shell
       * unusable at the moment it fires, which is the opposite of the point.
       */
      authorityGate: (params) => ({
        actionCategory: 'execute_command',
        intent: `In site project "${forCard(params.project_id)}", run: ${forCard(params.command, '', TRAILING)}`,
      }),
      // Deliberately NOT refused under --no-local-tools (#522): the project
      // lives on this host and there is no sidecar to route to, and refusing
      // it would not stop the builder running project code here anyway
      // (scaffolding, `make dev`). The daemon warns at startup instead; see
      // docs/SELF_HOSTING.md.
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
      // Intent only; see site_write_file.
      authorityGate: (params) => ({
        actionCategory: 'write_data',
        intent: `In site project "${forCard(params.project_id)}", commit all changes with message: ${forCard(params.message, '', TRAILING)}`,
      }),
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
      /**
       * Intent only. Worth stating what this tool does NOT get, because the
       * `write_data` floor borrows its reasoning from `browser_upload_file`
       * and the two are not equally protected: `browser_upload_file` is in
       * REVIEWED_UI_TOOLS, so `rawUiGate` forces `confirm: 'always'` on every
       * call -- a mandatory click, refused for sub-agents and refused on an
       * open mic. This tool has none of that, so at `write_data`/impact
       * 'write' it auto-runs for an untainted agent and its card is
       * voice-resolvable. That is not a regression (it was read_data and
       * equally ungated before #503), but it is the weakest link left in the
       * site set: it is the only one that moves local bytes off-device.
       * Raising it needs a product call about whether pushing should always
       * stop for a click.
       */
      authorityGate: (params) => ({
        actionCategory: 'write_data',
        intent: `Push site project "${forCard(params.project_id)}" to its configured GitHub remote`,
      }),
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
