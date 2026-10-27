# Brief feature contracts (v1)

Brief modules share one wire vocabulary and discover usable capabilities through an
authenticated endpoint. Every capability is default off; hosted installs turn a set
of them on (see [hosted dashboard](hosted-dashboard.md)).

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
  provider owns bounded inputs, permission checks, runtime output validation and
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

## Adding a module

Use optional `BriefReadProviders` interfaces and the gated `readBriefProvider`
adapter. If a provider is absent, unregistered, loading, disabled, blocked or fails,
the adapter produces an explicit non-success state without invoking a disabled read.
Readers require the same provider instance that was registered for that capability.

Each feature adds its own `src/brief/registrations/<feature>.ts` factory,
importing only already-merged code. It returns a `BriefRegistration`; it must not
mutate a global registry. `registrations/index.ts` is the single composition point.
There are deliberately no placeholder success providers. The fixed registry has no
plugin discovery, arbitrary feature names or dynamic loading.

The workflow trust-boundary inventory in
`src/workflows/adapters/untrusted-reach.test.ts` includes both Brief consumers.
Contracts import workflow status types only; their browser bundle has no runtime
workflow-repository dependency. `projectWorkflowRef` copies only identity and
status fields, verifies version ownership, and never reads or forwards captured
step payloads. Regression tests enforce both properties. A later provider that
returns workflow payloads must review and protect its model boundary separately.

Activation dependencies between capabilities are the fixed table in
`capabilities.ts`. Quality gates a provider depends on (for example prepared
opportunities on `src/awareness/prepared-qualification.ts`, recommendations on
`src/goals/next-action.ts`) are obligations of that provider's readiness check, not
fulfilled by registering an object.

## Tests

```bash
bun test src/brief src/daemon/api-brief.test.ts src/workflows/adapters/untrusted-reach.test.ts src/roles/untrusted-import-guard.test.ts
```
