# Trello managed connection, 26 October 2026

Vieri selected Trello as the smaller next integration and retained the approved shared company-app design, Google-style connection UI, onboarding, workflow verification and separate PRs. These worktrees start at main and merge the pending ClickUp framework locally. Merge ClickUp first and reconcile migration numbering before deployment.

## Contract

- Shared encrypted Admin app settings hold the traditional Trello API key and secret. No new deployment variables.
- OAuth 1.0a exchanges run on hosting. A fifteen-minute AES-GCM envelope binds the request token to the browser state, owner, instance and app revision. A separate envelope purpose carries the verifier to the worker. Jobs consume and scrub it once. No standing central customer token store.
- Verify member identity, non-expiring token and read/write board permission before delivering the user token and public API key atomically to the instance. Never deliver the app secret.
- The published community piece is pinned at 0.7.1. Managed credentials use its BASIC_AUTH shape: username=API key, password=user token. Its wider action catalogue remains community, not blanket verified.
- Qualified actions: List Boards, List Lists, Get Card, Create Card, Move Card. Managed execution uses fixed endpoints, bounded responses, no SDK retries, safe errors, Authority and completion receipts. No webhooks, deletes, custom API, labels or broad updates.
- Dashboard and both onboarding paths reuse the Google connection pattern. Workflow editor offers account, board and list selection; dynamic references remain possible.
- Disconnect removes local credentials. Trello account settings provide upstream revocation. Reconnection changes the binding fingerprint.

## Implementation and acceptance

1. Add registry, OAuth handshake and worker adapter, shared admin labels and atomic-delivery support.
2. Add instance credential source, status/options APIs, dashboard/onboarding/editor controls and qualified execution contract.
3. Test signing, replay/tenant/revision fencing, expiry, redaction, revocation, reconnect and single-attempt writes. Verify published metadata and chained outputs through the real engine per docs/PIECE_VERIFICATION.md.
4. Inspect rendered Google-style cards in desktop/mobile and light/dark. Run relevant tests, builds, type checks and full PR CI.
5. Document registration and live sandbox acceptance. No live app, token, board, deployment or merge is implied by fixtures.
