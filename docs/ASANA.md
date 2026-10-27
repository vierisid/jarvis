# Hosted Asana

Asana uses the company OAuth app configured once in Jarvis Admin. Company secrets, authorization, callbacks and token exchange stay in hosting. The brain receives an instance-owned grant and renews access through the signed shared hosting route. Google remains unchanged.

## Qualified scope

`@activepieces/piece-asana@0.7.2` remains a community piece, pinned for contract review. The managed account supports only:

| Action | Result | Governance |
|---|---|---|
| Create Task | Task resource, including `gid` | Write, completion receipt |
| Get Task | Task resource | Read |
| Update Task | Updated task resource | Write, completion receipt |
| List Project Tasks | `{data, next_offset}`; one page, 1-100 tasks | Read |
| Add Task Comment | Story resource, including `gid` | Send message, completion receipt |

Connect in the hosted dashboard, both onboarding paths or Settings. In a workflow choose the connected account, workspace and project, or enter IDs/workflow variables. Task IDs are Asana numeric strings. Create Task uses a plain description, an optional YYYY-MM-DD date and an assignee ID or `me`. Tags are not qualified. Update and comment inputs retain the published standard fields, including mutually exclusive plain/HTML content. Project choices are paginated with an explicit Load more action. Other managed actions and all triggers are refused. Manual/self-hosted connections retain their existing path.

## Lifecycle and safety

`connections/asana.json` is owned by hosting delivery and read at each resolution. `managed-refresh.ts` provides a shared helper for stable refresh-token providers: one refresh in flight per grant, exact-body HMAC, strict hosting-origin/path checks, bounded responses, safe errors and a separate atomic 0600 access-token cache. The cache is bound to generation/account/original token and refresh metadata. Reconnect/disconnect wins over an in-flight renewal; permanent revocation exposes Reconnect. Unexpected token rotation is refused. Company secrets and the refresh token are never passed to piece execution. Writes use fixed endpoints with no SDK retry and preserve Authority decisions and durable completion receipts.

Disconnect removes the instance credentials. Provider consent removal is a separate explicit step in Asana Settings > Apps; provider-side revoke and webhooks are not qualified.

## Verification

Follow `docs/PIECE_VERIFICATION.md`. Focused tests cover exchange/renewal, input validation, pagination, credential restrictions, reconnect races, secret-free errors and completion replay. `asana-engine.test.ts` installs the exact npm package, extracts its metadata with the real engine, and executes all five nodes through the worker and a disposable local provider fixture. It checks downstream task references and output contracts. CI runs this with `JARVIS_TEST_ENGINE_BUILD=1`. Tests never touch real Asana data.

The registration and deployed sandbox acceptance checklist lives in hosting's [INTEGRATIONS.md](https://github.com/usejarvis/hosting/blob/feat/asana-connection/docs/INTEGRATIONS.md#asana-registration-and-acceptance). Callback: `https://app.usejarvis.dev/api/integrations/asana/callback`. Live consent, repeated renewal and real task/comment acceptance remain release gates after deployment.
