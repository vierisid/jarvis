import type {JarvisConfig} from '../config/types';
import {readGitHubConnection} from './github-connection';
import {githubJson, githubRepository, GitHubRequestError} from '../workflows/runtime/managed-github';
export class GitHubOptionsError extends Error {constructor(message: string, readonly status = 502) {super(message);}}
export async function githubOptions(config: JarvisConfig, params: URLSearchParams, request: typeof fetch = fetch) {
  const connection = readGitHubConnection(config.daemon.data_dir);
  if (!connection) throw new GitHubOptionsError('Connect GitHub before choosing a repository.', 409);
  if (params.get('generation') && params.get('generation') !== connection.generation) throw new GitHubOptionsError('GitHub account changed. Reload repositories.', 409);
  try {
    const raw = await githubJson('user/repos?per_page=100&sort=updated&direction=desc', connection, {}, request);
    if (!Array.isArray(raw) || raw.length > 100) throw new GitHubOptionsError('GitHub returned invalid repositories. Try again.');
    const options = raw.filter(item => item?.has_issues === true && item?.archived === false).map(item => {
      const value = githubRepository({owner: item?.owner?.login, repo: item?.name});
      if (!value) throw new GitHubOptionsError('GitHub returned an invalid repository. Try again.');
      return {value, label: value.owner + '/' + value.repo};
    });
    if (readGitHubConnection(config.daemon.data_dir)?.generation !== connection.generation) throw new GitHubOptionsError('GitHub account changed. Reload repositories.', 409);
    return {options, generation: connection.generation, has_more: raw.length === 100};
  } catch (error) {
    if (error instanceof GitHubOptionsError) throw error;
    if (error instanceof GitHubRequestError) throw new GitHubOptionsError(error.message, [401,403].includes(error.status) ? 409 : error.status === 429 ? 429 : 502);
    throw new GitHubOptionsError('Could not load GitHub repositories. Try again.');
  }
}
