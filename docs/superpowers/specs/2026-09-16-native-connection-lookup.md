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

The identity comes from the verified engine token's claims, never from the
request: the project is read from the token and a query project that disagrees
is refused. The claim that scopes the read is the project, not the run, so any
live run in a project can obtain that project's connections. The project is
already the unit the builder and the public connection API treat as one
credential set, so this matches the stored scope rather than widening it.
Binding a read to the connections its own locked flow version references would
be narrower and is separate work.

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

Before the fix, seven of the nine endpoint regressions failed and the native
engine run failed before provider dispatch. The managed engine run already
passed.

Coverage includes encoded external IDs, duplicates, corruption in an ambiguous
candidate, exact piece filters, separate projects, mismatched query scope, a
query-less request resolved from a non-default token project, two runs in one
project, missing/invalid/expired/terminated tokens, native statuses and
managed-source priority. Engine ambiguity tests assert that the provider
receives no request.

Run the engine integration explicitly with `JARVIS_TEST_ENGINE_BUILD=1`; without
both a cached engine and build dependencies, or that opt-in, it follows the
repository's existing skip convention. All credentials and provider effects
in these tests are synthetic.

## Integration

The native credential encryption work (#473) is the only other change to this
fix's repository module, and the two do not overlap: encryption owns write
serialization, this fix adds a read helper. Both read helpers go through the
repository's own `rowToConnection`, so the decrypt boundary stays where it
already is and a change to how values are stored needs no change here. This
branch leaves the known plaintext-insert fix to #473 and adds no schema
migration.
