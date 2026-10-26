# GitHub connection

Use the approved shared managed-connection architecture in a separate provider PR. Hosted admin stores encrypted company OAuth credentials; per-instance credentials are delivered atomically and read on demand. Match the existing Google onboarding card and expose independent Settings and workflow account selection.

First scope: create issue, get issue, update issue, find issue by title, comment on issue. Qualify published Activepieces GitHub 0.7.3 (the existing vetted pin) in the real engine. Reject pull requests, arbitrary API/GraphQL, code changes, additional actions and triggers for the managed account. Preserve manually configured accounts.

OAuth App, GitHub.com only, repo scope, PKCE S256 and browser-bound single-use state. repo is broad provider permission, including private code; the runtime action allowlist does not narrow that grant. Expiring access tokens must be disabled at app registration; reject refresh/expiry responses. GitHub Apps with selected repositories and rotating installation tokens are a later lifecycle implementation.

Implementation: add reviewed provider and exchange; deliver account identity; wire status and repository choices; enforce fixed endpoint issue adapter with existing authority and completion receipts; add dashboard/onboarding/editor surfaces; run lifecycle, abuse, engine and UI verification; open linked PRs. No live provider mutation, app registration, merge or deployment in this task.

Dependencies: hosting #31 and brain #1176 shared framework. Reconcile registry, wrapper version, catalog schema and UI composition with other pending provider PRs before merging. Current brain main includes piece-scoped managed credentials (#1193); both existing ClickUp and GitHub sources implement that interface.
