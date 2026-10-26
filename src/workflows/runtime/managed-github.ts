/** Managed issue operations. Fixed endpoints, bounded responses, no SDK retries. */
export const MANAGED_GITHUB_ACTIONS = ['github_create_issue', 'getIssueInformation', 'update_issue', 'find_issue', 'createCommentOnAIssue'] as const;
export function managedGitHubInput(input: unknown): Record<string, unknown> | null {
  return (input as {auth?: {jarvis_managed?: unknown}} | null)?.auth?.jarvis_managed === 'github' ? input as Record<string, unknown> : null;
}
export function githubRepository(value: unknown): {owner: string; repo: string} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const {owner, repo} = value as Record<string, unknown>;
  return typeof owner === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner)
    && typeof repo === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(repo) && repo !== '.' && repo !== '..' ? {owner, repo} : null;
}
const issueNumber = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && /^[1-9][0-9]{0,14}$/.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) > 0;
export function managedGitHubIssue(action: unknown, input: Record<string, unknown>, resolved = true): string | null {
  if (!(MANAGED_GITHUB_ACTIONS as readonly unknown[]).includes(action)) return 'This GitHub connection supports finding, reading, creating and updating issues, and issue comments. Other actions and triggers are not enabled.';
  const dynamic = (v: unknown): boolean => !resolved && (typeof v === 'string' ? v.includes('{{') : !!v && typeof v === 'object' && Object.values(v).some(dynamic));
  if (!dynamic(input.repository) && !githubRepository(input.repository)) return 'Choose a GitHub repository or a workflow variable containing owner and repo.';
  if (['getIssueInformation','update_issue','createCommentOnAIssue'].includes(String(action)) && !dynamic(input.issue_number) && !issueNumber(input.issue_number)) return 'Enter a positive issue number.';
  const requiredTitle = action === 'github_create_issue' || action === 'find_issue';
  if ((requiredTitle || input.title !== undefined) && !dynamic(input.title) && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 256)) return 'Enter an issue title of 1 to 256 characters.';
  for (const key of ['description','body','comment']) {
    if ((input[key] !== undefined || (action === 'createCommentOnAIssue' && key === 'comment')) && !dynamic(input[key])
      && (typeof input[key] !== 'string' || (input[key] as string).length > 65536 || (key === 'comment' && !(input[key] as string).trim()))) return 'Enter valid issue text or a comment, up to 65,536 characters.';
  }
  if ((input.state !== undefined || action === 'find_issue') && !dynamic(input.state) && !(action === 'find_issue' ? ['open','closed','all'] : ['open','closed']).includes(String(input.state))) return 'Choose a valid issue state.';
  for (const key of ['labels','assignees','milestone','state_reason']) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '' && !(Array.isArray(input[key]) && !(input[key] as unknown[]).length)) return 'Hosted GitHub supports title, description and open/closed state. Remove labels, assignees, milestone and state reason.';
  }
  if (action === 'update_issue' && !['title','body','state'].some(k => input[k] !== undefined)) return 'Choose at least one issue field to update.';
  if (action === 'find_issue' && !dynamic(input.title) && /["\\\r\n:]/.test(String(input.title))) return 'Search by a plain title without quotes, backslashes, newlines or query operators.';
  return null;
}
export interface GitHubAuth {access_token: string}
export class GitHubRequestError extends Error {constructor(message: string, readonly status: number) {super(message);}}
export async function githubJson(path: string, auth: GitHubAuth, init: RequestInit = {}, request: typeof fetch = fetch): Promise<unknown> {
  if (!auth || typeof auth.access_token !== 'string' || !auth.access_token || auth.access_token.length > 16384) throw new GitHubRequestError('Reconnect GitHub.', 401);
  if (!/^(?:repos\/|user\/repos\?|search\/issues\?)/.test(path) || path.includes('..') || path.includes('#') || path.includes('\\')) throw new GitHubRequestError('Invalid GitHub endpoint.', 400);
  let response: Response;
  try {response = await request('https://api.github.com/' + path, {...init, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: {Authorization: 'Bearer ' + auth.access_token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Jarvis'}});}
  catch {throw new GitHubRequestError('GitHub did not confirm the request. Check the repository before trying again.', 502);}
  if (response.status === 401) throw new GitHubRequestError('GitHub refused the token. Reconnect GitHub.', 401);
  if (response.status === 403 || response.status === 429) throw new GitHubRequestError('GitHub refused access or limited requests. Check repository and organization permissions, then wait before trying again.', response.status);
  if (response.status === 404) throw new GitHubRequestError('GitHub could not find this repository or issue. Check its name and account access.', 404);
  if (!response.ok) throw new GitHubRequestError('GitHub did not confirm the request. Check the repository before trying again.', response.status);
  try {
    const reader = response.body?.getReader(); if (!reader) throw new Error('empty');
    const chunks: Uint8Array[] = []; let size = 0;
    try {for (;;) {const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > 1048576) throw new Error('large'); chunks.push(value);}}
    finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {throw new GitHubRequestError('GitHub returned an invalid response. Check the repository before trying again.', 502);}
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubRequestError('GitHub returned an invalid object.', 502);
  return value as Record<string, unknown>;
}
function project(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {const v = value[key]; if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string') out[key] = v;}
  return out;
}
function issue(value: unknown, repository: string, number?: number): Record<string, unknown> {
  const raw = object(value);
  if ('pull_request' in raw) throw new GitHubRequestError('This number is a pull request. Choose an issue.', 400);
  if (!issueNumber(raw.number) || typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || raw.id <= 0 || (number !== undefined && raw.number !== number)
    || typeof raw.title !== 'string' || !['open','closed'].includes(String(raw.state))
    || typeof raw.url !== 'string' || raw.url.toLowerCase() !== `https://api.github.com/repos/${repository}/issues/${raw.number}`.toLowerCase()) throw new GitHubRequestError('GitHub returned a different or invalid issue.', 502);
  return {...project(raw, ['id','number','title','body','state','html_url','url','created_at','updated_at','closed_at','comments','locked']),
    user: raw.user ? project(object(raw.user), ['id','login','html_url']) : null};
}
export async function runManagedGitHubAction(action: string, input: Record<string, unknown>, request: typeof fetch = fetch): Promise<unknown> {
  const reason = managedGitHubIssue(action, input); if (reason) throw new Error(reason);
  const repo = githubRepository(input.repository)!, repository = repo.owner + '/' + repo.repo;
  const auth = input.auth as GitHubAuth, base = 'repos/' + repository + '/issues', number = Number(input.issue_number);
  if (action === 'find_issue') {
    const q = `repo:${repository} is:issue in:title "${input.title}"` + (input.state === 'all' ? '' : ` state:${input.state}`);
    const raw = object(await githubJson('search/issues?' + new URLSearchParams({q, per_page: '1'}), auth, {}, request));
    if (!Array.isArray(raw.items) || raw.items.length > 1 || typeof raw.total_count !== 'number' || !Number.isSafeInteger(raw.total_count) || raw.total_count < raw.items.length || typeof raw.incomplete_results !== 'boolean') throw new GitHubRequestError('GitHub returned invalid search results.', 502);
    if (raw.incomplete_results) throw new GitHubRequestError('GitHub search was incomplete. Try again before using the result.', 502);
    return {found: raw.items.length > 0, result: raw.items.map(v => issue(v, repository)), total_count: raw.total_count, has_more: raw.total_count > raw.items.length};
  }
  if (action === 'github_create_issue') {
    const body = {title: input.title, ...(input.description !== undefined ? {body: input.description} : {})};
    return {status: 201, body: issue(await githubJson(base, auth, {method: 'POST', body: JSON.stringify(body)}, request), repository)};
  }
  // GitHub's issue endpoints also accept PR numbers. Validate before any mutation.
  const existing = issue(await githubJson(base + '/' + number, auth, {}, request), repository, number);
  if (action === 'getIssueInformation') return {status: 200, body: existing};
  if (action === 'update_issue') {
    const body = Object.fromEntries(['title','body','state'].filter(k => input[k] !== undefined).map(k => [k, input[k]]));
    const updated = issue(await githubJson(base + '/' + number, auth, {method: 'PATCH', body: JSON.stringify(body)}, request), repository, number);
    if (Object.entries(body).some(([k,v]) => updated[k] !== v)) throw new GitHubRequestError('GitHub did not confirm every issue change. Check the issue before trying again.', 502);
    return {status: 200, body: updated};
  }
  const raw = object(await githubJson(base + '/' + number + '/comments', auth, {method: 'POST', body: JSON.stringify({body: input.comment})}, request));
  if (typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || raw.id <= 0 || raw.body !== input.comment
    || typeof raw.issue_url !== 'string' || raw.issue_url.toLowerCase() !== `https://api.github.com/${base}/${number}`.toLowerCase()) throw new GitHubRequestError('GitHub did not confirm the issue comment. Check the issue before trying again.', 502);
  return {status: 201, body: project(raw, ['id','body','html_url','issue_url','created_at','updated_at'])};
}
