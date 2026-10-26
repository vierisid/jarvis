# Managed GitHub workflows

The hosted GitHub connection appears in Google-style onboarding, independent Settings, the connected workspace and the workflow editor. The editor offers the connected account and repositories; manual entry uses `owner/repository`, and a workflow variable must resolve to `{owner, repo}`.

Company OAuth registration and deployment instructions live in [hosting's GitHub guide](https://github.com/usejarvis/hosting/blob/feat/github-connection/docs/GITHUB.md). Callback: `https://app.usejarvis.dev/api/integrations/github/callback`. Save the company client ID and secret in Admin → Infrastructure → Integrations after deployment. Disable GitHub's default expiring-token option; this rollout rejects refresh/expiry grants.

The `repo` OAuth grant includes private repository/code permissions. Managed workflow actions are narrower, but the token itself remains broad. GitHub Apps with selected repositories and short-lived installation tokens are deferred.

## Qualified nodes

The existing vetted `@activepieces/piece-github` **0.7.3** stays pinned. Its published tarball was checked against npm's SHA-512 integrity.

| Action | Supported input | Output used by later steps |
| --- | --- | --- |
| `github_create_issue` | Repository, title, optional description | `body.number`, `body.title`, `body.html_url` |
| `getIssueInformation` | Repository and issue number | `body.number`, `body.title`, `body.body`, `body.state` |
| `update_issue` | Repository, issue number; title, body and/or open/closed state | `body.number`, `body.state` |
| `find_issue` | Repository, plain title, open/closed/all state | `found`, `result[0].number`, `total_count`, `has_more` |
| `createCommentOnAIssue` | Repository, issue number, comment | `body.id`, `body.body`, `body.issue_url` |

Search returns the first match and explicitly reports more results. It does not accept query operators. A no-match result is an empty array. Branch the workflow on `found` before reading its first result.

Labels, assignees, milestones, state reasons, pull requests, code/repository changes, arbitrary API/GraphQL and triggers are rejected for `jarvis:github`. Existing manual credentials retain their existing paths. GitHub's issue API also accepts pull requests, so managed reads reject `pull_request` objects and update/comment operations preflight the target before writing.

## Verification

Following `docs/PIECE_VERIFICATION.md`, qualification uses published package metadata, the real engine bundle and sandbox service backends, actual credential resolution and authority/receipt handling. A local fixture redirects only the test engine's GitHub host; production has no redirect switch.

```sh
bun test src/integrations/github-connection.test.ts src/workflows/runtime/managed-github.test.ts
JARVIS_TEST_GITHUB_ENGINE=1 bun test src/workflows/pieces-library/github-engine.test.ts
```

The engine test executes create → get → update → search → comment, passing issue numbers and titles through downstream expressions. It verifies each request and excludes token leakage. A dedicated PR workflow runs this qualification. Tests cover stale/mismatched accounts, disconnect, invalid input, unsupported actions/triggers, wrong repository/issue responses, PR rejection, incomplete search, bounded responses, provider failures, no implicit retries and completed-write reuse.

UI verification renders the actual components: light desktop onboarding, dark phone-width onboarding, Settings without Google status, the workflow account/repository fields, manual entry and retained unavailable selections. Hosted connect/reconnect/disconnect states use a local fixture. Live provider sign-in and disposable-repository writes remain pending company app registration and deployment.

Dependencies are hosting #31 and brain #1176. This branch starts from current main with the shared framework, including main's piece-scoped credential rules (#1193). Reconcile provider additions and catalog schema version with pending integration PRs before merge.
