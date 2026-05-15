# Pieces Library Catalog

This directory owns the list of activepieces community pieces that Jarvis
users can install at runtime via the Library tab in the Workflows room.
The catalog is split into two tiers:

- **Verified** -- hand-reviewed by a Jarvis maintainer + smoke-tested
  end-to-end through the engine. Each entry is a promise: "this piece
  loads and runs correctly under our Bun + engine setup at `vettedVersion`."
- **Community** -- auto-discovered from upstream + npm. Has not been
  individually reviewed. Installs run inside the engine sandbox; the
  Library UI surfaces a "third-party code" preamble so users opt in
  with their eyes open.

## How the catalog is built

The CATALOG export in `catalog.ts` is a merge of two inputs:

1. **`catalog-generated.ts`** -- auto-generated. Every `@activepieces/piece-*`
   package known to upstream at the pinned SHA, cross-checked against npm.
   Refreshed weekly by the `sync-pieces-catalog` GitHub Action (or on
   demand: `bun run scripts/sync-pieces-catalog.ts`). DO NOT EDIT.
2. **`catalog-overrides.ts`** -- hand-edited. Holds:
   - `VERIFIED` -- the set of ids that get the verified tier
   - `VERIFIED_METADATA` -- per-id audit dates
   - `EXCLUDED` -- ids we never want to ship (deprecated, broken, license)
   - `VERSION_PIN` -- hold-back pins for known-broken upstream releases
   - `SIZE_OVERRIDE` -- hand-measured disk-after-install sizes
   - `DESCRIPTION_OVERRIDE` -- better descriptions where upstream's is poor

The merge logic + tier resolution lives in `catalog.ts`; callers read
exclusively from there.

## What the catalog is (and isn't)

The catalog is committed source. Adding a Verified piece = code change +
review. It is NOT a dynamic registry, NOT a marketplace. Community
discovery is automated through the sync action; trust elevation is manual.

The catalog is the *only* path by which pieces reach a Jarvis install.
Users cannot side-load arbitrary npm packages -- the installer accepts ids
defined in the merged CATALOG, nothing else.

## How a piece reaches a user

1. Catalog entry says "we trust `@activepieces/piece-gmail@^0.12.2`."
2. User clicks Install in the Library UI.
3. Daemon writes the requested piece into `~/.jarvis/pieces/installed.json`,
   then synthesizes `~/.jarvis/pieces/package.json` from the manifest and
   runs `bun install` in that directory.
4. Bun resolves `^0.12.2` against npm to a concrete version (e.g. 0.12.3)
   and places it under `~/.jarvis/pieces/node_modules/@activepieces/piece-gmail/`.
5. The daemon records the resolved version in `installed.json` and asks the
   engine to extract metadata for the new piece.
6. The piece appears in the in-memory `PieceCatalog` and the flow editor's
   piece picker. Uninstall = remove from manifest, run reconcile, drop from
   catalog.

The directory layout after a couple of installs:

```
~/.jarvis/pieces/
  installed.json                    # source of truth: {id, npmPackage, versionRange, resolvedVersion, installedAt}
  package.json                      # synthesized from installed.json on each install/uninstall
  bun.lock                          # bun's resolution lock
  node_modules/
    @activepieces/piece-gmail/      # the piece itself; main: ./src/index.js
      package.json
      src/index.js                  # pre-built JS shipped by npm publish
    @activepieces/piece-slack/
    googleapis/                     # transitive deps deduped here
    @slack/web-api/
    ...
```

Docker: `~/.jarvis` should be mounted as a persistent volume. The manifest
+ reconciler make a restored-from-backup install self-healing -- the daemon
re-runs `bun install` on startup if any catalog-installed piece is missing
from `node_modules`.

## Catalog entry schema

```ts
{
  id: "gmail",                        // stable Jarvis-side id; do not rename
  npmPackage: "@activepieces/piece-gmail",
  versionRange: "^0.12.2",            // semver range bun resolves at install
  displayName: "Gmail",
  description: "Send + read email via Google API.",
  iconUrl: "...",                     // optional; falls back to a generic icon
  vettedAt: "2026-05-08",             // ISO date of the audit
  vettedVersion: "0.12.3",            // exact version Jarvis verified
  sourceUrl: "https://github.com/activepieces/activepieces/tree/main/packages/pieces/community/gmail",
  licenseSpdx: "MIT",                 // license of the piece, not its deps
}
```

`id` is the user-visible handle (URL slug, manifest key) and must never
change once shipped. `npmPackage` can be anything bun can resolve, but in
practice every entry today is under `@activepieces/`.

## Pin style policy

Every activepieces community piece is currently in the 0.x range. npm's
semver semantics in pre-1.0:

- `^0.12.2` resolves to `>=0.12.2 <0.13.0` (caret tightens to minor-floor)
- `~0.12.2` resolves to `>=0.12.2 <0.13.0` (tilde is identical here)

So for 0.x packages, `^` and `~` are interchangeable -- both float patches
only. The choice signals intent and matters post-1.0.

**Defaults**:

- **`^x.y.z`** -- our default. "Once this piece hits 1.0, we'll auto-pick up
  minor + patch bumps." Use for stable pieces that historically ship clean
  minors.
- **`~x.y.z`** -- "patch-only, even after 1.0." Use when the piece has a
  history of breaking on minor bumps, or when you want a tighter freeze
  until the next audit.
- **`x.y.z`** (exact, no operator) -- escape hatch. Use only when a specific
  newer version is known broken AND we haven't found a patch fix. Document
  the reason in a code comment next to the entry.

When in doubt, use `^`. Re-resolution on each install lets users pick up
upstream patch fixes between Jarvis releases.

## Promoting a piece to Verified

Once a piece exists in `catalog-generated.ts` (auto-populated) you can
promote it to the Verified tier by adding its id to `VERIFIED` and
`VERIFIED_METADATA` in `catalog-overrides.ts`. The checklist below
matches what the original "Adding a new piece" flow was for, retargeted
at the verification path.

1. **Verify license.** Browse the piece's source on GitHub. Look for an
   `LICENSE` file in the piece directory and confirm it's MIT (or another
   permissive license we accept). Activepieces' EE pieces live in
   `/packages/ee/` -- those are off-limits, the EE-import guard would
   catch any leak anyway.

2. **Bun smoke test under a fresh dir.**

   ```sh
   mkdir /tmp/piece-spike && cd /tmp/piece-spike
   echo '{"name":"spike","private":true}' > package.json
   bun add @activepieces/piece-<name>@^<x.y.z>
   bun -e 'const p = require("@activepieces/piece-<name>"); console.log(Object.keys(p));'
   ```

   - Confirms bun resolves and installs without errors.
   - Confirms the package's pre-built `src/index.js` loads via `require`.
   - Inspect the exported keys: there should be a piece object (usually
     named after the piece, e.g. `gmail`) with `actions()` and `triggers()`
     methods that return non-empty records.

3. **Native-deps check.** If transitive deps include native bindings,
   confirm they ship in the install:

   ```sh
   find node_modules -name "*.node" -o -name "*.wasm" 2>/dev/null
   ```

   Anything found needs verification that it loads under the Jarvis Bun
   version. As of this writing, googleapis is pure JS, openai is pure JS,
   tiktoken ships WASM (works under Bun).

4. **No EE / isolated-vm.** The engine runs in `SANDBOX_PROCESS` mode; it
   doesn't ship `isolated-vm`. Confirm nothing transitively imports it:

   ```sh
   find node_modules -name "isolated-vm" 2>/dev/null   # should print nothing
   ```

5. **Gated install integration test**:

   ```sh
   JARVIS_TEST_PIECES_LIBRARY=1 bun test src/workflows/pieces-library/integration.test.ts
   ```

   Runs a real `bun install` of the gmail catalog entry into a temp pieces
   dir, then `require()`s the published bundle and asserts its exported
   piece object has the expected shape (`name`, `actions`, `triggers`).
   Network-bound -- skipped by default. Run before bumping `vettedVersion`
   for the gmail entry (or any other entry you add to the integration
   test's allowlist).

   This test stops at the bundle-loads-via-require boundary. Verifying
   the *engine subprocess* can extract metadata for an npm-installed
   piece is a future test that would need to spin up the full engine
   bootstrap; today's coverage is the regular engine-end-to-end suite
   plus the manual spike described in step 2.

6. **Add to the override layer.** In `catalog-overrides.ts`:
   - Add the id to `VERIFIED`.
   - Add an entry to `VERIFIED_METADATA` with today's ISO date as `vettedAt`.
   - If the latest upstream version is broken, add a `VERSION_PIN` entry
     with the holdback versionRange + vettedVersion + reason.
   - If you want to override the upstream description, add a `DESCRIPTION_OVERRIDE`.

7. **Measure disk footprint** (optional but recommended). After step 2's
   `bun add`, run `du -sm node_modules` and round to the nearest 5MB.
   Add the value to `SIZE_OVERRIDE` in `catalog-overrides.ts`. The Library
   UI shows this to users before they click Install -- googleapis-heavy
   pieces (165MB+) deserve the heads-up. Omitting the field hides the
   badge; not wrong, just less helpful.

8. **Record what you tested.** In the PR description, paste:
   - The Bun version (`bun --version`)
   - The resolved piece version (`bun pm ls | grep <name>`)
   - The first 5-10 lines of the EXTRACT_PIECE_METADATA output

9. **Update `BRANCH_SUMMARY.md`** if relevant and the project changelog.

## Updating versions

**When the range stays the same** (bun re-resolves within the existing
caret/tilde to a newer version):

- Re-run steps 2 + 5 from "Adding a new piece" against the new version.
- Bump `vettedVersion` and `vettedAt`. `versionRange` stays.
- This is the common case -- activepieces patches a bug, we re-vet.

**When the range needs to widen** (upstream went `0.12.x` -> `0.13.x` and
we want to allow that):

- Treat this like adding a new piece. Pre-1.0 minor bumps may include
  breaking changes.
- Bump `versionRange`, `vettedVersion`, `vettedAt`.
- If schema changes affect existing user flows, document migration in the
  changelog. The reconciler reports a warning when a user's resolved
  version differs from `vettedVersion`.

**When a version is broken in the wild** (an installed user is seeing
crashes):

- Pin tighter immediately: switch `^` to `~`, or pin exact. Document the
  reason in a comment next to the entry.
- A future Jarvis release widens it back once upstream fixes.

## Removing a piece

A piece comes out of the catalog when:

- Upstream marks it deprecated or stops publishing.
- A security advisory is filed. Yank it immediately, even before
  patches land.
- We discover it pulls EE-licensed code transitively.
- Maintenance burden outweighs value (rare; document the call).

Removal from the catalog does NOT uninstall the piece from existing user
installs. The reconciler keeps respecting `installed.json` and surfaces a
warning when an installed piece is no longer in the catalog. Users can
uninstall explicitly via the Library UI; future Jarvis releases can ship a
forced migration path if the situation warrants it.

## Trust model

Every piece in this catalog gets full daemon access via the SandboxApi at
runtime: engine token, vault reads, LLM calls, tool execution. We do NOT
sandbox piece code -- the upstream engine runs in `SANDBOX_PROCESS` mode,
which is process-level isolation but not capability-restricted.

Auditors should treat adding a catalog entry with the same scrutiny as
merging a third-party dependency: read the piece's source, check the
package's npm publish history for suspicious recent releases, verify the
license, and prefer pieces with a known maintainer.

We trust npm's tarball integrity (Bun verifies SHAs against the lockfile)
but do not run additional supply-chain checks. A `npm audit`-style step
would be a useful follow-up.
