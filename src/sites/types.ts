/**
 * Site Builder — Type Definitions
 */

export type ProjectStatus = 'stopped' | 'starting' | 'running' | 'error';

export type Project = {
  id: string;              // directory name (sanitized)
  name: string;            // display name
  path: string;            // absolute path on disk
  framework: string;       // 'vite-react' | 'next' | 'bun' | 'custom'
  devPort: number | null;  // dynamically assigned port when running
  devServerPid: number | null;
  status: ProjectStatus;
  gitBranch: string | null;
  gitDirty: boolean;
  createdAt: number;
  lastOpenedAt: number;
  githubUrl: string | null; // e.g., "https://github.com/owner/repo"
};

export type ProjectMeta = {
  name: string;
  framework: string;
  createdAt: number;
  lastOpenedAt: number;
  github?: {
    owner: string;
    repo: string;
    remoteUrl: string;
    lastPushedAt: number | null;
  };
};

export type ProjectTemplate = {
  id: string;
  name: string;
  description: string;
  command: string;         // e.g. 'bunx' or 'scaffold' for internal
  args: string[];
  framework: string;
};

export type FileEntry = {
  name: string;
  path: string;            // relative to project root
  type: 'file' | 'directory';
  children?: FileEntry[];
  size?: number;
  modified?: number;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: number;
};

export type GitBranch = {
  name: string;
  current: boolean;
};

export type GitRemoteStatus = {
  hasRemote: boolean;
  remoteUrl: string | null;
  owner: string | null;
  repo: string | null;
  ahead: number;
  behind: number;
  lastPushedAt: number | null;
};

export type GitHubRepoOptions = {
  name: string;
  description?: string;
  private: boolean;
};

export type SiteBuilderConfig = {
  enabled: boolean;
  projects_dir: string;
  port_range_start: number;
  port_range_end: number;
  auto_commit: boolean;
  max_concurrent_servers: number;
};
