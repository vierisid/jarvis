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
import { siteExecOnWrite } from './project-exec-paths.ts';
import { sanitizedEnv } from '../util/subprocess-env.ts';
import { modelExecMarkers } from '../util/model-exec-marker.ts';
import { forCard as cardText, commandForCard } from '../util/card-text.ts';

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
 *
 * One value is not a label and does not come through here: the command of
 * `site_run_command`, which `commandForCard` (util/card-text.ts) shows whole (#707).
 */
function forCard(value: unknown, fallback = '', max = 80): string {
  return cardText(String(value ?? '').trim() ? value : fallback, max);
}

/** A trailing free-text value: shown in full up to a card-sized budget. */
const TRAILING = 600;

/**
 * A path for a card, ellipsized from the LEFT.
 *
 * `forCard` cuts the tail, which is the wrong end for a path: a 691-char path
 * produced "write a file the project runs as code (a makefile the daemon
 * runs): aaaa/aaaa/aaa..." and named neither the file asked for nor the file
 * it runs. The basename is what identifies a file, so it is the part that must
 * survive -- for the trailing value as much as for one in the middle, since a
 * long LANDING path was being truncated to nothing useful too.
 *
 * The whitespace collapse and the invisible-character strip come from
 * `cardText` with a budget nothing reaches, so its own right-truncation (and
 * the `...` it appends) can never be what this then trims from the left.
 */
function pathForCard(value: unknown, max = 120): string {
  const s = cardText(value, 1_000_000);
  return s.length > max ? `...${s.slice(s.length - (max - 3))}` : s;
}

/**
 * The `site_run_command` card's tail is `commandForCard` (util/card-text.ts):
 * the command whole, verbatim when it is plain one-line ASCII and one escaped
 * string otherwise (#707). It lives there since #720 so the builtin
 * `run_command` card is the same text. Trimmed, exactly as `execute` trims it,
 * so the card is what `sh -c` receives.
 *
 * WHAT #707 MOVED. The deferred executor refuses an approved call whose gate
 * intent no longer equals the approved one. So a site_run_command approval
 * still PENDING at upgrade whose card text changes -- a command holding a run
 * of whitespace, a tab, a line break, any non-ASCII character, or longer than
 * 600 characters -- is refused after the person approves it ("what it would do
 * changed after approval"), and the agent asks again with the new card. A
 * plain one-line ASCII command of 600 characters or fewer with single spaces
 * has the same text as before, so its approvals stand. (#720's move changes
 * no byte of this card.)
 */

/**
 * The project's path for a gate, or null.
 *
 * A gate must be total: `resolveToolGate` turns a throw into `confirm:
 * 'always'` with "business effect unknown", which would replace the sentence
 * that names the file with one that names nothing. An unresolvable project id
 * is not a way to be rated lower either -- `siteExecOnWrite` still judges the
 * spelling without a project path.
 */
function projectPathOrNull(projectManager: ProjectManager, projectId: unknown): string | null {
  try {
    return projectManager.getProjectPath(String(projectId ?? '')) ?? null;
  } catch {
    return null;
  }
}

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
      /**
       * `write_data` is the floor, and for most of a project it is honest:
       * `src/App.tsx` is content the browser renders.
       *
       * It is not honest for the part of the tree the DAEMON runs. `make dev`
       * runs the project's Makefile for the life of the preview, its recipe
       * runs `bunx vite`, which loads `vite.config.ts` as a module, and
       * `make install` runs `bun install`, which runs a `postinstall` hook. A
       * write there is a command that runs later, so it is rated
       * `execute_command` -- the same reading `execOnWrite` already applies to
       * a write to `~/.bashrc` for the generic `write_file` (#558). See
       * sites/project-exec-paths.ts for how that set is derived from what the
       * daemon actually spawns, and for what is deliberately NOT in it (app
       * source, so the rating discriminates instead of firing every turn).
       *
       * `confirm: 'above_level'`, as on `write_file`: an agent below level 5
       * gets a card naming the file instead of a refusal.
       *
       * The un-raised branch is intent only -- no category raise, no
       * `confirm`, so gating is unchanged. It exists because the card is the
       * whole review and, without a sentence, `synthesizeApprovalIntent`
       * falls through to its default and renders the bare tool name -- "Site
       * write file", with no path.
       */
      authorityGate: (params) => {
        const project = `In site project "${forCard(params.project_id)}"`;
        const hit = siteExecOnWrite(projectPathOrNull(projectManager, params.project_id), params.path);
        if (!hit) {
          return {
            actionCategory: 'write_data',
            intent: `${project}, write file: ${forCard(params.path, '', TRAILING)}`,
          };
        }
        // The file that will RUN goes LAST and in full (d1879828): it is the
        // value being approved, and nothing after it can pose as the rest of
        // the sentence. When a symlink or a `..` spelling sends the write
        // somewhere else, that landing file is the one that matters, so it
        // takes the trailing slot and the requested spelling moves into the
        // middle -- kept short, and ellipsized from the left so its basename
        // survives.
        if (hit.lands) {
          return {
            actionCategory: 'execute_command',
            confirm: 'above_level',
            intent: `${project}, write "${pathForCard(hit.path)}", which lands on a file the project runs as code `
              + `(${hit.kind}): ${pathForCard(hit.lands, TRAILING)}`,
          };
        }
        return {
          actionCategory: 'execute_command',
          confirm: 'above_level',
          intent: `${project}, write a file the project runs as code (${hit.kind}): ${pathForCard(hit.path, TRAILING)}`,
        };
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
       *
       * The same argument is why the command is not reduced like a label
       * (#707): `commandForCard` shows it whole, line breaks and all.
       */
      authorityGate: (params) => ({
        actionCategory: 'execute_command',
        intent: `In site project "${forCard(params.project_id)}", ${commandForCard(params.command)}`,
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
            // Still the site-builder allowlist -- this shell runs a command the
            // model wrote, in a tree the model wrote -- plus the model-exec
            // markers (#524; util/model-exec-marker.ts). The allowlist drops
            // JARVIS_WORKFLOW_ENCRYPTION_KEY, so `jarvis restart` from here
            // starts a daemon without it; unmarked, that daemon would MINT a
            // fresh key and the credentials it then saved would be unreadable
            // to the user's own Jarvis. The flag makes it refuse and say so.
            //
            // What decides which site spawns are marked is whether the child
            // EXECUTES CONTENT OUT OF THE PROJECT TREE, not whether the command
            // line is model-authored: `make dev` is marked too, because its
            // recipe comes from a Makefile the model can write. Still unmarked,
            // deliberately: the git spawns, whose argv the daemon builds and
            // whose project config the #523 lint keeps from naming a program;
            // and `make install` / the scaffolders, which run against a
            // daemon-authored Makefile at the instant createProject writes it.
            //
            // What the flag costs here: the check value is also visible to the
            // lifecycle scripts of any package the model installs from this
            // shell (`bun add` with no --ignore-scripts, unlike the daemon's own
            // installs in util/sanitized-install.ts). It identifies the workflow
            // key and cannot recover it -- see the marker module on what that
            // gives away, which rests on the key being random.
            env: sanitizedEnv(modelExecMarkers()),
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
