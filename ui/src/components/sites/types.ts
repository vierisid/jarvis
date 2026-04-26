/**
 * Shared types for the site/workspace IDE components embedded inside
 * the v2 Workspaces Room (Phase 6.7.E).
 *
 * Originally lived in `ui/src/pages/SitesPage.tsx`; that v1 page was
 * deleted in Phase 8 cleanup but the IDE components (SiteTopBar /
 * SiteLeftPanel / SiteRightPanel / SiteEditor / SiteFileTree /
 * SiteGitPanel / SitePreview / SiteNewProjectModal) are still
 * load-bearing for the v2 Workspaces Room's detail view, which embeds
 * them with a CSS-variable retheme cascade. They needed a stable home
 * for their type definitions after SitesPage went away.
 *
 * Kept structurally identical to the original definitions in SitesPage
 * so no consumer logic changes — just the import path moves.
 */

export type Project = {
  id: string;
  name: string;
  path: string;
  framework: string;
  devPort: number | null;
  devServerPid: number | null;
  status: "stopped" | "starting" | "running" | "error";
  gitBranch: string | null;
  gitDirty: boolean;
  createdAt: number;
  lastOpenedAt: number;
  githubUrl: string | null;
};

export type FileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileEntry[];
  size?: number;
  modified?: number;
};

export type GitBranch = {
  name: string;
  current: boolean;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: number;
};
