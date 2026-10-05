# Brief feature contracts, F-01

F-01 gives independently delivered Brief modules a shared wire vocabulary and an
authenticated way to discover usable capabilities. It does not deliver the features
represented by those contracts. All 26 capabilities are unsupported and disabled in
the production registration shipped here. The existing dashboard and domain writers
keep their behavior.

Source of truth: `src/brief/contracts.ts`, `capabilities.ts`, `providers.ts` and
`registrations/index.ts`. The checked synthetic examples are in
`brief-contract-v1.examples.ts` and `brief-contract-v1.examples.json`.

## Wire contract

- `contractVersion: 1` is the major wire version. Additive fields are allowed within
  v1. Consumers ignore unknown fields, and fail closed for missing capabilities,
  malformed flags, old-server 404s and unsupported major versions. Use
  `isBriefCapabilityEnabled` before offering a new action.
- IDs are opaque canonical source IDs. Field names identify conversation, turn,
  request, event, approval, work item, flow, version, run, fact and connection
  separately. No UI array position is an identity. Revisions are opaque comparison
  tokens, not timestamps to interpret. The legacy goal adapter exposes its source
  `updated_at` as a read projection only, not a concurrency token for future writes.
- Wire times are UTC epoch milliseconds. Pagination cursors are opaque and must
  include a stable tie-breaker. Chat event sequence is a strictly increasing safe
  integer within a conversation. A terminal event belongs to one turn. Cancel must
  carry conversation, turn and request IDs; tab close only hides the tab.
- `loading`, `ready`, `empty`, `stale`, `unavailable` and `unsupported` are distinct
  read results. Ready/stale have data and its `asOf`; empty has a verified `asOf`.
  A failed provider is never converted to an empty list. Unknown measurements and
  unavailable memory-use instrumentation are null, never measured zero.
- Approval status and execution outcome remain separate. Workflow activation uses
  the existing `ENABLED`/`DISABLED`; version lifecycle uses `DRAFT`/`LOCKED`. The
  adapters preserve these source values. No new workflow, goal or memory writer is
  introduced.
- Ready opportunities require evidence, a goal revision, composition ID, exact
  flow/version, readiness check, binding references and explicit preview provenance.
  Preparing/blocked records may lack a workflow. Accepted/dismissed records retain
  historical readiness. Providers must revalidate revision, readiness, permissions
  and bindings at the time of an action; a capability snapshot is not authorization.
- Goals/outcomes carry value, unit, baseline, target, as-of time, provenance and
  qualification. A legacy goal score is not a measurement. Time back needs a
  defensible manual baseline and measured intervention, not engine duration.
- Memory identifies the canonical fact and source, qualifications, permissions and
  actual selected/supplied/outcome-verified uses. Supplied does not mean relied upon.
  Connections retain their store kind, source/account IDs and permissions. An
  installed library piece does not imply an authenticated account.
- These types are compile-time contracts, not validators for untrusted input. Each
  provider PR owns bounded inputs, permission checks, runtime output validation and
  its domain-specific persistence/recovery acceptance checks.

## Capabilities endpoint

`GET /api/brief/capabilities` returns v1, `asOf` and the fixed capability map, with
`Cache-Control: no-store`. It is mounted through `createApiRoutes` under the existing
panel-session authentication. Unauthenticated callers receive 401; POST receives 405.
The existing explicit setup-only `auth.insecure_open_access` exception is preserved.
No credential, provider exception, settings object or source content is returned.

Each capability has three separate booleans:

| Field | Meaning |
| --- | --- |
| supported | A concrete provider is registered in this daemon. |
| ready | That provider currently reports initialized, usable services. |
| enabled | The provider is ready, activation is explicitly selected, and all its feature dependencies are enabled. |

Readiness is recomputed on every read, not cached. `state` is unsupported, loading,
unavailable or ready. `reason` is a fixed code or null. Ready but unselected is
`enabled: false, reason: disabled`. Dependency failure reports
`dependency_not_ready`. Provider errors report `provider_unavailable` without
serializing their exception. Readiness callbacks must be synchronous, bounded,
side-effect-free checks of initialized services; they must not call models or do I/O.

Capability keys follow F-02 through F-27 in the declaration order. F-24 maps to
`hostedAccount`, whose provider will wrap the existing read-only hosted bridge.
F-01 does not alter hosting, credentials, billing or deployment configuration.

## Independent modules and integration ownership

Use optional `BriefReadProviders` interfaces and the gated `readBriefProvider`
adapter. If a provider is absent, unregistered, loading, disabled, blocked or fails,
the adapter produces an explicit non-success state without invoking a disabled read.
Readers require the same provider instance that was registered for that capability.

Each feature PR should add its own `src/brief/registrations/<feature>.ts` factory,
importing only already-merged code. It returns a `BriefRegistration`; it must not
mutate a global registry. `registrations/index.ts` is the single composition point.
There are deliberately no placeholder success providers. The fixed registry has no
plugin discovery, arbitrary feature names or dynamic loading.

F-01 supplies separate typed `conversations.ts` and `decisions.ts` registration
factories to exercise that independent-module contract. Neither contains a provider
implementation or is activated by daemon startup.

| Integration area | Owner / boundary |
| --- | --- |
| Brief contracts, registration composition, API/bootstrap | F implementer, coordinated by Lapo; central API/bootstrap changes are 8 additive lines in F-01. |
| Vault/schema and WebSocket transport | Reserved shared integration areas for later F tasks; F-01 changes neither. |
| Shell/router/layout and view adapters | D implementer; import the contract/optional interfaces without hard imports of future providers. |
| Runtime/composer/goal quality | Q implementer; coordinate overlapping canonical services. |

Merge prerequisites: none. Activation prerequisites for F-01: none, because no
feature is activated. Later activation dependencies are the fixed table in
`capabilities.ts`. F-09 must also satisfy Q-13; F-13 must also satisfy Q-18. Those
quality gates are obligations of their provider's readiness check, not fulfilled by
registering an object or switching on the dashboard shell. Lapo owns shared-file
integration slots. F-28 and D-33 still own the final activation/release records.

## Quick verification

From this worktree in WSL:

```bash
cd /home/vierisid/.cache/codex/jarvis-f-01
/home/vierisid/.bun/bin/bun test src/brief src/daemon/api-brief.test.ts
```

This exercises a real HTTP server on a unique temporary Unix socket, bootstrap and
session authentication, expiry, default-off behavior, explicitly enabled fixture
providers, dependency failure, safe errors, old conversation clients and version
compatibility. Its SQLite fixture is in memory. It makes no paid model calls or real
account/workflow changes and opens no shared dev-server port.

Once running this branch in an authenticated development dashboard, the console can
read the same endpoint:

```js
const response = await fetch('/api/brief/capabilities', { credentials: 'same-origin' });
console.log(response.status, await response.json());
```

Expected: 200, contractVersion 1, 26 entries, each unsupported with all three flags
false. A request without the dashboard session gets 401 under the default access
policy. There is no visible UI change to screenshot in F-01.

## Rollback and limits

Disable activation selections to fall back to existing behavior. Rolling back the
additive route makes new consumers treat it as unsupported. There is no migration,
down-migration, data rewrite or background worker. Preserve later additive records.
Tests establish the seam and fixture behavior, not multi-chat isolation, prepared
opportunity quality or any later feature's readiness. Full CI, live hosted model
quality and deployment are separate gates.
