# F-22 connected workspace contract

`GET /api/brief/connections` is an authenticated, no-store projection over the daemon's existing stores. The exact `connections` provider must be registered and `JARVIS_BRIEF_CONNECTIONS=1` must be set. It is disabled by default. No credentials store, integration, OAuth broker, enrollment service, workflow execution or new Connected room is introduced.

## Read model

The v1 response contains a server-owned `scopeId`, observation time, stable `rows`, supported `setup` actions, and independent source availability. A failed source is `unavailable`, not an empty collection. Identical labels do not merge identities:

| Kind | Identity | Status evidence |
| --- | --- | --- |
| Device | `device:<enrollment ID>` | Existing enrolled record and current authenticated socket. Revoked/deleted records disappear; disconnected is not connected. |
| Native Google | `native:google` | Existing Google auth classification, stored grant and persisted reconnect marker. No network refresh or account email inference. |
| Channel | `channel:telegram` / `channel:discord` | Enabled configuration, activity state and authentication-aware adapter evidence. A legacy polling flag alone stays unknown. |
| Workflow account | `account:<app_connection ID>` | Project/owner-filtered metadata only. ACTIVE means **configured**, with authentication unknown. ERROR means reconnect required; MISSING means disconnected. |
| Library piece | `piece:<package name>` | Canonical loaded piece catalog, not a public catalog promise. Installed never implies an authenticated account. |

`accountId` is the canonical stored row ID where one exists; it remains null for single-instance services without an exposed account identifier. A `stored_grant` observation is not a live Google health check. Telegram records token validation/rejection from its existing getMe/getUpdates/send responses, with rejection sticky until explicit reconnect/new adapter; Discord uses current SDK readiness and token rejection. The read never causes a network probe. Piece credential shape validation is not a provider authentication test. The runtime still decides whether an action can execute.

Sources remain separate even when `jarvis:google`/`jarvis:telegram` can supply workflow credentials. No ciphertext, credential `value`, connection metadata, external binding ID, token, OAuth state, hosted URL or raw error is selected into the read model. Labels are bounded plain text; consumers must render text nodes. Each source is limited to 1,000 records and the entire response to 2 MB; overflow is unavailable, never a truncated ready source.

The deployed brain is single tenant. Instance sources and the legacy setup surfaces are only offered for the canonical default project/owner; other server-configured scopes can inspect their own piece-account metadata, but get no instance setup actions. HTTP query/body values cannot choose a project. Integration with a future multi-project auth layer must bind the provider and legacy setup writers to the same authenticated scope.

## Setup and return

`ui/src/brief/connections/setup.ts` exports the headless `ConnectionSetup` adapter for D-27. Bind `read` to the authenticated F-22 response (reject non-ready responses), use per-tab `sessionStorage`, and bind `open` to `openLegacyConnectionSetup`. Before leaving, pass the Connected search, anchor ID and scroll offset. Existing account rotation also passes its exact `account:<ID>`; new-account setup leaves that null.

`begin` rereads the supported action and selected identity, saves a bounded, scope-specific attempt before opening anything, then invokes the existing setup surface. An unavailable or failing persistence layer refuses launch. It stores only identity, local handoff nonce, return position, phase and a ten-minute deadline. It never stores credentials or callback URLs. Reload restores that position without reopening a flow or trusting an earlier status result.

| Target | Current setup owner |
| --- | --- |
| Google OAuth / manual client configuration | Settings → Integrations; existing `/api/auth/google/init` and callback own state, one-time consume and PKCE. |
| Managed Google browser | Same Integrations surface delegates to the configured hosting control plane. Missing/unsafe link means no setup action. This PR does not certify a live hosted OAuth grant. |
| Telegram / Discord | Settings → Channels; existing configuration writer and hot reload. |
| Device enrollment / hosted sign-in | Settings → Sidecar; same hosted-install predicate as the existing enrollment refusal. Hosted sign-in retains its nonce-based enrollment outside browser JavaScript. |
| Piece credentials | Workflows → Connections; prefilled package, exact version and auth type, or rotation for the exact selected account. Even OAuth-shaped piece values use the existing **manual** form. No universal OAuth claim. |

`returned(nonce)` accepts only the matching unexpired local attempt. This nonce coordinates the UI; it is **not** OAuth authority and must never replace the existing provider state/PKCE or enrollment nonce. A callback only marks return. `verify(nonce, selectedRowId?)` rereads the canonical source, checks kind/service/exact account, then reports `connected`, `configured`, or `not_connected`. For a new account the user/host must select its actual returned canonical row ID; seeing some pre-existing account for the service cannot automatically complete the attempt. The result is an observation, not proof that this attempt caused the connection. Cancellation, expiry, source errors and deleted rows never synthesize an account. Pending reads cannot overwrite cancellation or a newer attempt.

D-27 owns the visible Connected room, its return button/browser history binding, focus restoration and presentation of partial source failures. F-25 owns wider compatibility navigation. Neither card is implemented or activated here. The existing V2 setup controls remain the credential and enrollment owners; no secrets pass through the new headless adapter.

## Preserved safety fixes from main

F-21's stack predates the connection isolation fixes in main. This card carries only the connection-route/repository parts of #691 (`581c80f9`) and #728 (`2c70cf0f`): server-owned project scoping, updates by ID, recheck after body reads, no update-to-upsert fallback, and no secret resurrection after deletion. Full flow-route scoping and other main changes must still be preserved when integrating the complete stack; this is not a stack-wide rebase.

## Verification and rollback

Run the commands and fixture tests in `docs/brief-delivery/F-22.json`. The route test serves the real authenticated API on a temporary Unix socket and drives the headless consumer with its response. The legacy component test opens the actual credential form without sending any write. Tests use fake providers and temporary tokens/databases; no real service account, OAuth grant, paid model, email or enrollment is created.

You can see this contract at `/api/brief/connections` with the flag enabled in a fixture daemon, then inspect separate source IDs, statuses and supported setup actions. The full Connected room awaits D-27 integration; the production dashboard has not been switched on.

Rollback: disable `JARVIS_BRIEF_CONNECTIONS` and restart; retain all canonical credentials, enrollment records and history. No additive database migration exists. Keep the main connection safety guards when reverting the optional presentation/adapter. Never replay setup or execution to roll back.
