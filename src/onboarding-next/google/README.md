# ON-B-03: authoritative Google connection

Optional `google-state.v1` provider. Unregistered and default-off. This directory
has no dependency on another onboarding PR. It does not change the legacy wizard,
Google routes, Telegram, runtime bootstrap, credentials schema or journey state.

## Assembly contract

ON-B-11 selects a binding from the authenticated actor/project for every operation.
Never construct a binding from a request's actor ID, project ID or token path.
`id` identifies that canonical store/configuration generation and must change when
its account-store selection, OAuth configuration or ownership changes. A binding
contains immutable, owner-bound services, not functions that follow a mutable
global current account. The provider checks the selection before and after queued
work. ON-B-11 also maps safe `GoogleStateError.code` values to its authenticated
transport and exposes missing bindings as unsupported/unavailable.

For self-hosted installs inject the existing `GoogleOAuthFlowStore`, a
`GoogleAuth` constructed with the same trusted `redirectUri` and canonical
`tokensPath`, and the existing Google settings reload notification. Route the new
flow's callback to `callback(authenticatedContext, {state, code, error})`. The
unchanged legacy handler still owns legacy attempts. A callback needs both an
authenticated owner and its one-time state. Do not expose this method as a public
unscoped callback; the assembly owner must arrange authenticated browser return.
Do not let two provider instances own the same scope concurrently. Serialize
legacy/onboarding exchanges to the same canonical store at the host seam.

For hosted installs inject the existing trusted control-plane `connect_url`.
OAuth remains on that service; no client secret is requested or stored here.
Hosted callback messages are never accepted locally. Fresh canonical grant reads
confirm actual access after the user returns. Hosted grant changes have
`attemptId: null`, since the existing handoff does not prove local attempt
provenance. No callback, poll or timeout advances any journey; Continue/Skip are
separate explicit host actions.

Use `createGoogleGrantReader` for `readGrant`. Its `auth()` must select the existing
GoogleAuth service with the bound token path (including `makeGoogleAuth` for
managed refresh). Supply the trusted public OAuth client ID in both modes; it is
not a secret or a new provider setup field. If hosted configuration cannot supply
that ID, keep this capability unavailable until the host/control-plane contract
does. Never substitute the legacy status response: its stored-token boolean and
fixed scope labels cannot establish a verified account/grant.

The reader uses existing token reload/refresh/storage and checks the issued token's
audience, expiry and actual scopes, then Gmail profile identity. Tokens remain in
the existing store and never appear in snapshots or URLs. Inspection errors are
redacted. Both requested scopes are unchanged: Gmail readonly and Calendar
readonly. The account label is display data, not an authorization identifier.
Google's [token inspection implementation](https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/oauth2client.ts)
and [Gmail profile reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
document these read-only checks. No send scope or second OAuth broker is added.

## Waiting, cancellation and browser return

`begin` first checks current access, then returns one launch URL for a pending
attempt. Opening it is not success. Duplicate begins reuse the pending state;
duplicate, foreign, superseded or expired callbacks cannot exchange codes.
Cancellation stops waiting. A valid callback already in flight, or delivered
after cancellation but before expiry, may still save a grant. A fresh read shows
that real grant without attributing it to a cancelled or newer attempt.

Attempts are bounded, in-memory, ten-minute records, matching the existing OAuth
store. A daemon restart requires retrying an unfinished attempt; existing grants
are recovered from canonical storage. Snapshots carry a monotonic revision within
the provider lifetime. The transport must scope cursors to its current instance
and discard lower revisions; snapshots are observations, not durable journey
completion receipts. Re-entering never relaunches OAuth automatically.

ON-U-10 imports `createGoogleController` from `controller.ts` and the client-only
`googleBrowserPorts` from `browser.ts`. The controller accepts authenticated
transport functions and a render callback. Pass its `snapshot.connection` to the
ON-U-03 controlled view. Return/focus always reads server status; there is no
success-message listener. The browser adapter reuses the existing external-open
service, including its WebView handoff detection. Cancel stops polling; Skip and
leave remove timers/listeners and abort transport reads. A late begin result is
cancelled without opening its URL. Each request has a 15-second UI deadline;
`failure()` must replace pending UI with safe retry/skip feedback. It must never
show Connected. Dispose the controller when the authenticated identity changes.

## Verification and rollback

Run `bun test src/onboarding-next/google`, `bunx tsc --noEmit` and
`bun run build:ui`. Tests use isolated token files, the real GoogleAuth/PKCE store
and HTTP doubles. No real account, grant, external window or provider action is
performed. No live preview URL exists before ON-B-11 and ON-U-10 registration.

Activation additionally needs the Google view, authenticated callback routing,
owner-bound canonical services, hosted public client-ID availability, combined
D/F/Q evidence and real browser/WebView OAuth verification. Merge readiness does
not establish activation readiness. Roll back by omitting this provider and its
host registration; keep canonical grants, journey records and drafts intact. The
legacy OAuth path remains available. Do not revoke tokens as a rollback action.
