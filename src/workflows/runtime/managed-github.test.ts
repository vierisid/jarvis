import {expect, test} from 'bun:test';
import {managedGitHubIssue, runManagedGitHubAction} from './managed-github';
import {authorizePieceDispatch, executeAuthorizedPiece} from './piece-effect-guard';
import {compileWorkflow} from './workflow-readiness';
const input = {auth: {access_token: 'SECRET', jarvis_managed: 'github'}, repository: {owner: 'octocat', repo: 'Sandbox'}, issue_number: 42, title: 'Bug', state: 'open', comment: 'Investigating'};
const rawIssue = {id: 10, number: 42, title: 'Bug', body: 'Description', state: 'open', url: 'https://api.github.com/repos/octocat/Sandbox/issues/42', html_url: 'https://github.com/octocat/Sandbox/issues/42', transport: 'SECRET'};
const fake = (fn: (...args: any[]) => Promise<Response>) => fn as unknown as typeof fetch;
test('allowlist rejects unsupported actions, paths, query injection and hidden fields', () => {
  for (const action of ['create_branch','rawGraphqlQuery','custom_api_call','new_issue','github_create_pull_request_review_comment']) expect(managedGitHubIssue(action, input)).not.toBeNull();
  for (const value of [{repository: {owner: 'octocat', repo: '..'}}, {repository: {owner: '../evil', repo: 'repo'}}, {issue_number: 0}, {issue_number: '1/labels'}, {labels: ['bug']}, {assignees: ['owner']}, {state: 'other'}]) expect(managedGitHubIssue('update_issue', {...input, ...value})).not.toBeNull();
  for (const title of ['a" OR repo:other/repo', 'repo:other/repo', 'x\ny', 'x\\y']) expect(managedGitHubIssue('find_issue', {...input, title})).not.toBeNull();
  expect(managedGitHubIssue('getIssueInformation', {...input, repository: '{{find.repo}}', issue_number: '{{created.body.number}}'}, false)).toBeNull();
});
test('create uses fixed host, header auth and one POST; output strips private transport', async () => {
  let calls = 0;
  const result = await runManagedGitHubAction('github_create_issue', {...input, description: 'Description'}, fake(async (url, init) => {
    calls++; expect(url).toBe('https://api.github.com/repos/octocat/Sandbox/issues'); expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer SECRET'); expect(JSON.parse(init.body)).toEqual({title: 'Bug', body: 'Description'});
    return Response.json(rawIssue, {status: 201});
  }));
  expect(calls).toBe(1); expect(result).toMatchObject({status: 201, body: {number: 42}}); expect(JSON.stringify(result)).not.toContain('SECRET');
});
test('update and comment preflight an actual issue and reject pull requests before writing', async () => {
  for (const action of ['getIssueInformation','update_issue','createCommentOnAIssue']) {
    let calls = 0;
    await expect(runManagedGitHubAction(action, input, fake(async (_url, init) => {calls++; expect(init.method).toBeUndefined(); return Response.json({...rawIssue, pull_request: {url: 'pr'}});}))).rejects.toThrow('pull request');
    expect(calls).toBe(1);
  }
  const methods: string[] = [];
  expect(await runManagedGitHubAction('update_issue', {...input, title: 'Fixed', state: 'closed'}, fake(async (_url, init) => {
    methods.push(init.method ?? 'GET'); return Response.json(init.method === 'PATCH' ? {...rawIssue, ...JSON.parse(init.body)} : rawIssue);
  }))).toMatchObject({body: {title: 'Fixed', state: 'closed'}});
  expect(methods).toEqual(['GET','PATCH']);
  expect(await runManagedGitHubAction('createCommentOnAIssue', input, fake(async (url, init) => {
    if (!init.method) return Response.json(rawIssue);
    expect(url).toEndWith('/issues/42/comments'); expect(JSON.parse(init.body)).toEqual({body: 'Investigating'});
    return Response.json({id: 99, body: 'Investigating', issue_url: rawIssue.url, private: 'SECRET'});
  }))).toEqual({status: 201, body: {id: 99, body: 'Investigating', issue_url: rawIssue.url}});
});
test('wrong issue, repository, incomplete search and unconfirmed changes fail closed', async () => {
  for (const value of [{...rawIssue, number: 43}, {...rawIssue, url: 'https://api.github.com/repos/other/repo/issues/42'}]) await expect(runManagedGitHubAction('getIssueInformation', input, fake(async () => Response.json(value)))).rejects.toThrow('different');
  await expect(runManagedGitHubAction('update_issue', {...input, title: 'Changed'}, fake(async () => Response.json(rawIssue)))).rejects.toThrow('confirm every');
  await expect(runManagedGitHubAction('find_issue', input, fake(async () => Response.json({total_count: 0, items: [], incomplete_results: true})))).rejects.toThrow('incomplete');
  const result = await runManagedGitHubAction('find_issue', input, fake(async url => {
    const query = new URL(url).searchParams; expect(query.get('q')).toBe('repo:octocat/Sandbox is:issue in:title "Bug" state:open'); expect(query.get('per_page')).toBe('1');
    return Response.json({total_count: 2, items: [rawIssue], incomplete_results: false});
  }));
  expect(result).toMatchObject({found: true, has_more: true, result: [{number: 42}]});
  expect(await runManagedGitHubAction('find_issue', input, fake(async () => Response.json({total_count: 0, items: [], incomplete_results: false})))).toMatchObject({found: false, result: []});
});
test('network/provider failures and oversized or broken bodies do not retry or leak', async () => {
  for (const failure of ['network','429','401','403','404','500','json','large','stream']) {
    let calls = 0;
    try {await runManagedGitHubAction('github_create_issue', input, fake(async () => {calls++;
      if (failure === 'network') throw Error('PRIVATE');
      if (failure === 'large') return new Response('x'.repeat(1048577));
      if (failure === 'stream') return new Response(new ReadableStream({start(c) {c.error(Error('PRIVATE'));}}));
      return new Response('PRIVATE', {status: Number(failure) || 200});
    })); throw Error('expected failure');} catch(e) {expect(String(e)).toContain('GitHub'); expect(String(e)).not.toContain('PRIVATE');}
    expect(calls).toBe(1);
  }
});
const params = {apiUrl: 'http://unused', engineToken: 'test', piece: '@activepieces/piece-github', action: 'github_create_issue', stepName: 'step', executionPath: [], input};
test('authority binds credentials, blocks unsupported actions and suppresses completed writes', async () => {
  await expect(authorizePieceDispatch({...params, action: 'rawGraphqlQuery', fetchImpl: fake(async () => {throw Error('must not call');})})).rejects.toThrow('not enabled');
  await expect(executeAuthorizedPiece(params, {governed: false}, async () => {})).rejects.toThrow('not authorized');
  expect(await executeAuthorizedPiece(params, {governed: true, dispatch: 'completed', result: {done: true}}, async () => {throw Error('must not run');})).toEqual({done: true});
  await expect(executeAuthorizedPiece({...params, input: {...input, repository: {owner: '..', repo: 'bad'}}}, {governed: true, dispatch: 'authorized', effectId: 'effect'}, async () => {})).rejects.toThrow('repository');
  let sent: any;
  const fetchImpl = fake(async (_url, init) => {sent = JSON.parse(init.body); return Response.json({governed: true, dispatch: 'authorized', effectId: 'effect'});});
  await authorizePieceDispatch({...params, fetchImpl}); const first = sent.credentialDigest;
  expect(first).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(sent)).not.toContain('SECRET');
  await authorizePieceDispatch({...params, input: {...input, auth: {...input.auth, access_token: 'OTHER'}}, fetchImpl}); expect(sent.credentialDigest).not.toBe(first);
});
test('readiness rejects managed triggers and unsupported mutations', () => {
  expect(JSON.stringify(compileWorkflow({name: 'trigger', type: 'PIECE', settings: {pieceName: params.piece, triggerName: 'new_issue', input: {auth: '{{connections.jarvis:github}}'}}}))).toContain('MANAGED_GITHUB');
});
