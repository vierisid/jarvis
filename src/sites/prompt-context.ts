/**
 * Site Builder — what the chat system prompt is told about projects.
 *
 * Everything here is written by the model or arrives with a pulled
 * repository: the `.jarvis-project.json` name, framework and GitHub owner/repo
 * (site_write_file and site_run_command can rewrite that file), the directory
 * name that becomes the project id, the branch, and the file names. The site
 * context is rebuilt into the system prompt on EVERY later turn, so text
 * planted in any of them would outlive the turn that planted it (#524).
 *
 * Short fields sit inside trusted sentences, so they are reduced to one
 * capped line with inlineUntrusted(). The file listing is free-form, so it is
 * framed as data with wrapUntrusted(), the same framing untrusted tool output
 * gets. Every interpolation of a project field lives in this file so the tests
 * can cover all of them.
 */

import { inlineUntrusted, wrapUntrusted } from '../roles/untrusted.ts';
import type { FileEntry, Project } from './types.ts';

type ProjectFields = Pick<Project, 'id' | 'name' | 'path' | 'framework' | 'gitBranch' | 'githubUrl'>;

export type PromptSafeProject = {
  id: string;
  name: string;
  path: string;
  framework: string;
  branch: string;
  githubUrl: string | null;
};

/** The project fields the site prompts interpolate, each safe to place inline. */
export function promptSafeProject(project: ProjectFields): PromptSafeProject {
  return {
    id: inlineUntrusted(project.id),
    name: inlineUntrusted(project.name),
    path: inlineUntrusted(project.path, 300),
    framework: inlineUntrusted(project.framework, 40),
    branch: inlineUntrusted(project.gitBranch ?? 'main'),
    githubUrl: project.githubUrl ? inlineUntrusted(project.githubUrl, 200) : null,
  };
}

export const FILE_NAMES_SOURCE = 'site project file names (written by the model or a pulled repository)';

/** Past this many top-level entries the listing says how many it left out. */
export const MAX_LISTED_ENTRIES = 200;

/**
 * The project's top-level entries, one per line (directories with a trailing
 * slash), framed as untrusted data. Empty when there is nothing to list. Each
 * name is flattened first: a file name may legally contain a newline, which
 * would otherwise let one entry pose as several lines of prompt.
 */
export function formatProjectStructure(tree: Pick<FileEntry, 'children'> | null): string {
  const children = tree?.children ?? [];
  if (children.length === 0) return '';
  const lines = children.slice(0, MAX_LISTED_ENTRIES).map((child) =>
    child.type === 'directory' ? `${inlineUntrusted(child.name, 200)}/` : inlineUntrusted(child.name, 200));
  if (children.length > MAX_LISTED_ENTRIES) lines.push(`... (${children.length - MAX_LISTED_ENTRIES} more)`);
  return wrapUntrusted(lines.join('\n'), FILE_NAMES_SOURCE);
}

/** The system-prompt block for a chat scoped to one project (Site Builder page). */
export function buildProjectSiteContext(
  project: ProjectFields & Pick<Project, 'status'>,
  tree: Pick<FileEntry, 'children'> | null,
  autoCommitEnabled: boolean,
): string {
  const safe = promptSafeProject(project);
  const structure = formatProjectStructure(tree);
  return `# Site Builder Context

You are working on project "${safe.name}" (${safe.framework}).
- Path: ${safe.path}
- Branch: ${safe.branch}
- Dev server: ${project.status}
${safe.githubUrl ? `- GitHub: ${safe.githubUrl}` : ''}
${structure ? `\n## Project Structure (top level)\n${structure}` : ''}

## Rules
- Use site_read_file, site_write_file, site_list_files, site_run_command, site_git_commit, site_github_push tools with project_id="${safe.id}".
- Do NOT use regular read_file, write_file, or run_command — always use the site_* variants.
- Do NOT start dev servers via site_run_command. The dev server is managed by the dashboard (make dev runs automatically).
${autoCommitEnabled
  ? '- Changes are auto-committed after this conversation turn completes.'
  : '- Changes are NOT auto-committed. Commit with site_git_commit only when the user asks.'}
- For the "bun-react" framework: the server uses Bun.serve() with HTML imports (import from "./index.html"). Run with "bun --hot index.ts", NOT vite or webpack.`;
}

/**
 * The project list for the general-chat prompt, plus the most recently opened
 * project as the fallback the prompt points at when no name matches.
 */
export function formatProjectList(
  projects: Array<ProjectFields & Pick<Project, 'lastOpenedAt'>>,
): { projectList: string; fallbackLine: string } {
  const projectList = projects.map((p) => {
    const s = promptSafeProject(p);
    return `  - "${s.name}" (id: ${s.id}, framework: ${s.framework}, branch: ${s.branch}${s.githubUrl ? `, github: ${s.githubUrl}` : ''})`;
  }).join('\n');

  // Most-recently-opened, used as a fallback default when the user's request
  // offers no name hint at all.
  const mostRecent = [...projects].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0];
  const recent = mostRecent ? promptSafeProject(mostRecent) : null;
  const fallbackLine = recent
    ? `\nFALLBACK PROJECT (most recently opened, use ONLY if no project name keyword matches the user's request): "${recent.name}" (id: ${recent.id}).`
    : '';
  return { projectList, fallbackLine };
}
