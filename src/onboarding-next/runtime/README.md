# ON-B-11: optional onboarding runtime

This assembly owns daemon registration and the authenticated v1 HTTP boundary.
It ships **disabled**. No environment flag, request field, manifest or persisted
setting enables it. Legacy onboarding, Google OAuth, native Permissions and
workflow routes remain available with their existing behavior.

## Discovery and packaging

`bun run generate:onboarding-runtime` reads only the eleven provider directories
in `contract.ts`. Each manifest must match its exact v1 ID, entry, capability and
requirements, fit in 4 KiB, and resolve to regular files without symlinks or path
traversal. Discovery neither imports providers nor calls factories. Missing
manifests produce no imports. Malformed present manifests fail the build.

The committed `generated/catalog.ts` contains literal lazy imports. Install, start,
dev, Docker and UI builds never run the generator, so a package install cannot
run or fail on it. After adding/removing a module or changing a manifest, run
`bun run generate:onboarding-runtime` and commit the result. The pre-commit hook
(`bun run check:onboarding-runtime`) and a `bun test` in CI fail when the committed
catalog differs from the generator output. The package-file guard checks the
catalog ships. No startup filesystem scan or arbitrary runtime import is used.

B01's allowlist also loads its owned `settings.ts` companion (the persistence
factory). Other modules use their public entry only.
Every provider must remain inert on import/construction. Build registration and
host service binding are separate: source presence alone never means supported.

## HTTP contract

All routes are under `/api/onboarding-next/v1` and require a **live enrolled panel
session cookie**, even in legacy insecure bootstrap mode. The daemon is one vault
per tenant. Its existing default user/project identify that vault's owner; a
panel device ID is not a new user identity. Each request resolves the session
again. Client IDs, headers and token paths never select a vault or project.

`GET /status` returns `schemaVersion: 1`, `installMode`, `supported`, `ready`,
`enabled`, `released`, `reason` and capability states. Each capability reports
`present`, `registered`, `supported`, `ready` and a bounded reason. It reads
configuration/persistence only; it does not initialize a journey, start services,
refresh OAuth, call a model, or create a workflow. Unknown configuration remains
`unknown`, including hosted deployments with incomplete proxy configuration.

`routes.ts` lists the fixed POST operations. Each uses
`{"schemaVersion":1,"input":{...}}` and returns
`{"schemaVersion":1,"result":...}`. Provider inputs retain the owning module's
contract. The envelope is limited to 32 KiB and a five-second read; timeout or
abort cancels the reader and rejects without dispatch, even if all JSON bytes
arrived before the stream stalled. Unsupported versions receive 409. Errors contain a fixed safe category, never exceptions,
tokens or provider payloads. Responses are uncached. There is no public journey
acknowledgement or composition-commit operation.

All POSTs require the complete ten-provider closure, explicit host enablement,
and a trusted release decision for the exact backend/frontend/sidecar tuple.
Optional diagnostics is never a requirement. Readiness probes have bounded waits;
a timeout cannot authorize work. Mutations are not raced against a timer and an
aborted response never claims an accepted operation was rolled back. Providers
must enforce their own cancellation, lease, idempotency and write fencing.

Old clients continue using the legacy endpoints. A new client must check the
versioned status before entering: 404, invalid JSON/schema, 401, unsupported,
unready, disabled and release-blocked responses mean retain the complete legacy
flow. ON-U-10 owns that client behavior; this card does not claim an absent client
has been verified. Old servers are not modified by this PR.

## Current service bindings

- B01 uses the real existing SQLite settings adapter and canonical legacy
  settings/profile readers. Invalid legacy data fails closed without replacing it.
  Status does not call the journey's initializing `read()` method.
- B02, when installed, uses its canonical daemon setup store, current LLM
  configuration and existing settings reload/startup functions. Setup completion
  rechecks live authorization at persistence and service boundaries, applies
  bindings even when B02 has already updated the live config, and verifies
  completion of startup plus running agent/background services. Awareness is
  required only when enabled (including its default) and local tools are available;
  hosted Awareness-off and headless startup can complete without it. Only a
  confirmed setup result can trigger an internal B01 setup
  acknowledgement. Retry preserves the timestamp and handles acknowledgement
  conflicts without re-running setup writes. Existing Permissions routes stay
  independent; no OS permission request occurs on discovery or status.

The core accepts explicit server-owned binders with injected existing services.
Each returns an observational probe and allowlisted operations; the runtime
supplies resolved dependency providers. Missing binders, missing requirements,
invalid exports and failed probes are unavailable, even if all sources exist.
Provider modules must not import another unmerged module. Bindings must resolve
live authorization again before effects and must never retain a caller's authority
in a global provider. Injected synthetic binders exist only in tests.

B03 is currently **binding_missing**: its canonical account-store binding,
authenticated self-hosted return route/legacy exchange serialization and trusted
hosted public OAuth client ID are not supplied by this daemon seam yet. Stored
token booleans cannot substitute for verified Google access. B04 also lacks B05's
staged interviewer/profile commit port and session retention/Forget binding.
B05–B10 are absent at this baseline. Those adapters must be completed in this
runtime owner as their providers become available; copying their source into a
candidate does not enable them. No fallback model, profile writer or workflow
engine is created here.

The production constructor supplies neither a release tuple nor a decision hook.
The later assembled candidate needs ON-U-10, U11/B13 evidence and the D/F/Q release
record before any cutover. Local fixtures and merging this PR are not release
approval. Provider support, business progress (e.g. setup complete), installation,
service readiness and release permission are separate states.

## Verification and rollback

```sh
bun run check:onboarding-runtime
bun test scripts/onboarding-next-runtime-manifest.test.ts src/daemon/post-setup-services.test.ts src/onboarding-next/runtime src/onboarding-next/journey src/daemon/api-onboarding-hosted.test.ts
bunx tsc --noEmit
bun run build:ui
bun run check:package
```

The manifest matrix builds empty, single, partial and full synthetic registries,
then removes a provider. Runtime tests remove each required capability, exercise
release revocation and scope changes, and ensure no handler runs while blocked.
The real B01 factory uses isolated SQLite. Optional real B02 tests skip when its
module is absent and run in the temporary combined candidate; service-start
functions there are explicit doubles, not a live deployment or paid provider test.

For a safe daemon check with an existing panel session, read only the status URL:
`enabled`, `released` and overall `ready` must be false. Missing modules should
report `module_absent`; present modules without a host adapter report
`binding_missing`. Do not use a production account to exercise mutations.

Rollback removes/disables the runtime registration and regenerates the catalog.
Keep legacy handlers and all additive journey/session/draft records. No token
revocation, data deletion, enrollment change, migration, run or enable operation
is part of this rollback.
