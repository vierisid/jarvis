# Native connection lookup through the engine

Branch: `fix/native-connection-engine-lookup`, from main `1e2c2fdb`.

## Identity and scope

Stored identity remains `(project_id, piece_name, external_id)`. Existing rows,
upserts and explicit piece lookups keep their current exact-match semantics.
The normal upstream engine request supplies only an external ID and project.
It now resolves a native connection only when exactly one row in the token's
project has that external ID. No prefix inference, wildcard substitution or
first-match selection is used.

The repository reads at most two candidates and checks uniqueness before
decrypting either. Multiple matching rows, even when one is malformed or
inactive, produce an ambiguity error. Explicit piece names remain exact
filters and can disambiguate existing rows. Normal engine workflows using
duplicate IDs must reconnect using distinct external IDs before running.

Alternatives considered were changing the upstream engine to carry piece
identity on every request, or adding a project-wide unique constraint. The
former would require carrying context through property resolution and dynamic
connection-manager requests; the latter would need a migration for existing
duplicates. An unambiguous read preserves the deployed engine protocol and
existing records while rejecting uncertain identity.

## Endpoint contract

`GET /v1/worker/app-connections/:externalId?projectId=<project>[&pieceName=<piece>]`

- The existing bearer-token and live-sandbox authentication remains required.
- The verified token determines the project. A different explicit project,
  including an empty one, returns 403 before any native or managed lookup.
- An omitted piece name uses the unique project-scoped lookup. An explicitly
  empty piece name returns 400; `*` is a literal piece name, never a wildcard.
- Unknown IDs and native `MISSING` connections return 404.
- Ambiguous native IDs return 409 with a fixed message and no candidate values.
- Native results carry their stored piece name and status. `ERROR` remains
  `ERROR` so the engine rejects an expired connection instead of executing it.
- `jarvis:*` IDs still use registered managed sources first and never fall
  back to similarly named native records. No Google or Telegram source logic
  changes, and no credential values are added to the public save/list responses.

This fixes lookup identity, not connector certification or authentication-value
normalization. The real provider test uses OAuth2-shaped native credentials.
Per-piece binding checks, all other native auth shapes and live provider
certification remain separate work. No new claim is made about managed Gmail
delivery or universal integration compatibility.

## Verification

The regression saves credentials through the public workflow API, starts the
real authenticated sandbox endpoint, spawns the unmodified engine and loads
a locally built native fixture using the installed-piece loader. The fixture
uses the resolved OAuth2 token against a loopback fake provider. No credential
resolver, property resolver or action executor is mocked.

Before the fix, five endpoint regressions failed and the native engine run
failed before provider dispatch. The managed engine run already passed.
Coverage includes encoded external IDs, duplicates, corruption in an ambiguous
candidate, exact piece filters, separate projects, mismatched query scope,
missing/invalid/expired/terminated tokens, native statuses and managed-source
priority. Engine ambiguity tests assert that the provider receives no request.

Run the engine integration explicitly with `JARVIS_TEST_ENGINE_BUILD=1`; without
both a cached engine and build dependencies, or that opt-in, it follows the
repository's existing skip convention. All credentials and provider effects
in these tests are synthetic.

## Integration

Main was pulled before branching and now includes goal-review PR #468. Open PRs
were #473 (native credential encryption), #469 (structural runtime), #381
(command deck/wake) and #280 (project documentation). Only #473 touches this
fix's repository module: its encryption change affects write serialization,
whereas this branch adds a separate read helper. Neither branch requires the
other to function; both should be retained when merging. This branch leaves
the known plaintext-insert fix to #473 and introduces no schema migration.

Verification passed 224 tests across sandbox, credentials, DB, public API and
real engine suites, plus TypeScript, the daemon build and all four repository
guards. Packaging used Bun's packer (2 required paths, 2,516 files).

In an isolated checkout on the same main, both actual #473 commits applied
cleanly alongside this fix. The combined change passed 150 tests, including
encrypted API saves through the real engine, native migration/rollback and
managed sources, plus TypeScript. No #473 commit was added to this branch.
After tightening the dependency opt-in, all 11 endpoint/engine tests passed
again in both checkouts, with no skips.
The full repository suite and its aggregate hook retain their previously
documented timeout limitations; a per-command hook override follows the
explicit checks rather than rerunning that aggregate hook.
