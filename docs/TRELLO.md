# Trello connection

Trello follows the shared company-app model in [CLICKUP.md](CLICKUP.md). Customers use Connect from Account, onboarding or the workflow editor. The company registers one app; customers do not paste API tokens.

## Registration for Vieri

1. Sign in to a company-controlled Trello account. Create or choose a company workspace. Create a private **Jarvis integration sandbox** board with **To do** and **Done** lists, containing no customer information.
2. Open [Trello app administration](https://trello.com/apps/admin). Create an app/Power-Up named **Jarvis** under that workspace. Use company contact details. A marketplace listing is not part of this release.
3. Open **Trello Auth**, then generate the traditional **API key**. Copy that key and its **API secret**. Do not copy a manually generated user token, and do not register OAuth 2.0 credentials for this implementation.
4. Under **Allowed Origins**, add `https://app.usejarvis.dev`. The callback base is `https://app.usejarvis.dev/api/integrations/trello/callback`. Jarvis supplies the full callback, including a one-use state, when requesting an OAuth 1.0a request token. Do not add wildcard origins.
5. After the required hosting and brain changes are deployed, open **Jarvis Admin → Infrastructure → Integrations → Trello**. Enter the API key and API secret, leave **Allow new connections** enabled, and save. This requires `integrations.manage`; ask Lapo for that role if needed. There are no Trello deployment variables or Coolify changes.
6. Open your customer **Account → Trello → Connect**. Confirm the Jarvis account, approve Trello read/write access and return to Jarvis. Wait for **Connected**. This grants access to the Trello account's accessible boards; it is not a per-board grant.
7. Complete the live acceptance checklist below on the sandbox board before announcing availability.

Keep the API secret in Admin or the company password manager, not chat or a PR. The public API key is delivered to each instance because Trello requires it alongside the user's token. The API secret stays on hosting.

Source: [Trello authorization documentation](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/), checked 26 October 2026. Trello still supports traditional OAuth 1.0; its newer OAuth 2.0 rotating-token flow is a separate integration project.

## Implementation

- Registry-owned endpoints/scopes. OAuth 1.0a HMAC-SHA1 request and access-token exchanges use POST, no redirects and bounded, timed responses.
- The confirmation ticket and callback state are single-use and instance/owner/app-revision bound. A fifteen-minute authenticated envelope protects the temporary request-token secret in an HttpOnly, Secure, SameSite=Lax browser cookie. The callback validates the returned request token and seals a separate-purpose worker payload containing the verifier. The worker checks the same owner and instance before exchange.
- The worker consumes and scrubs the queued payload before network work. It verifies the member, token owner, non-expiring lifecycle and board read/write permissions. The shared store never keeps a standing customer access token.
- The worker delivers `{api_key, access_token, account, generation}` through `set-managed-connection`; the instance owns the resulting mode-0600 `connections/trello.json`. Reconnect replaces it atomically; disconnect writes a tombstone. The generation fences stale jobs.
- Disconnect removes this instance's access. Upstream token revocation is available in the user's Trello account settings. Revocation can affect other consumers of the same token.
- Dashboard pending/error/retry/disconnect states and Google-style onboarding are included. The instance resolves the community piece's BASIC_AUTH shape using `username=api_key`, `password=access_token`; the user never enters them in the node.

## Qualified workflow scope

Pinned community piece: `@activepieces/piece-trello@0.7.1`.

| Action | Supported behavior |
|---|---|
| List Boards | Connected member's boards; open, closed or all |
| List Lists | Lists on a chosen board; open, closed or all |
| Get Card | Read a card by its full Trello ID |
| Create Card | Board/list, name, description and top/bottom position |
| Move Card | Full card ID and destination list ID |

The managed adapter uses fixed endpoints and header authentication, strips transport details, bounds response size and never retries internally. Create checks board/list membership before writing. Both writes use Authority and completion receipts; an uncertain result must be inspected before a new run. Published metadata remains the source for node properties; explicit output samples make downstream references usable. Triggers, labels, attachments, deletes, broad updates and custom API calls are not qualified and are blocked with managed credentials. Manual connections retain their existing wider community behavior.

## Verification and release gates

Local evidence: 18 hosted OAuth/route/worker tests; hosting full suite 3,451 passed, 8 skipped, 0 failed; 20 brain connection/adapter/dependency tests; a real-engine fixture extracts published metadata then runs boards → lists → create → read → move with downstream references. Browser fixtures verify the actual onboarding, dashboard, admin and workflow-editor components. These are fixtures, not live Trello acceptance.

Before release:

- Merge the pending ClickUp framework (hosting #31, brain #1176), then refresh these main-based Trello branches. Hosting main already has migration 0087; this branch regenerates the combined framework as 0088. Reconcile against the final merged migration journal; never apply both histories blindly. Coordinate with Slack's changes to the same registry, wrapper version and connection surfaces.
- Require green CI on the final PR heads. Deploy the host wrapper before issuing connection jobs and deploy the compatible brain. Register and configure the app as above.
- Verify real OAuth approval, denial, reconnect, provider revocation, local disconnect and recovery from an expired consent link.
- Install Trello from the workflow library, choose the managed account, select the sandbox board/list, list boards/lists, create a uniquely named card, read it by returned ID and move it to Done. Inspect actual run outputs and downstream fields. Check that rejected access and archived/moved lists fail clearly.
- Confirm unsupported managed actions/triggers are refused and no credentials appear in browser status, job logs, run history or approval cards. Delete the test card manually after verification.

No production app registration, live provider request, deployment or merge was performed during fixture verification.
