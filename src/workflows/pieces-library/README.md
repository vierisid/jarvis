# Pieces Library Catalog

This directory owns the *curated list* of activepieces community pieces that
Jarvis users can install at runtime via the Library tab in the Workflows
room. Each catalog entry is a promise: "Jarvis verified this piece loads
and runs correctly under our Bun + engine setup at `vettedVersion`, and
we're willing to let users install it within the `versionRange` band."

## What this catalog is (and isn't)

The catalog is hardcoded source. Adding a piece = code change + Jarvis
release. It is NOT a dynamic registry, NOT a marketplace, NOT auto-synced
with activepieces' upstream. We trade discoverability for trust: every
entry here has been audited by a human.

The catalog is the *only* path by which community pieces reach a Jarvis
install. Users cannot side-load arbitrary npm packages as pieces -- the
installer accepts piece ids defined in `catalog.ts`, nothing else.

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

## Adding a new piece

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

5. **Engine end-to-end** (gated):

   ```sh
   JARVIS_TEST_PIECES_LIBRARY=<piece-id> bun test src/workflows/pieces-library
   ```

   Spins up the engine with this piece installed in a temp pieces dir,
   runs `EXTRACT_PIECE_METADATA`, asserts the catalog returns valid
   metadata (actions + triggers + props parse).

6. **Add the catalog entry.** Set `vettedAt` to today's ISO date,
   `vettedVersion` to the exact version step 3 produced, `versionRange` to
   the caret/tilde range you want users to install.

7. **Record what you tested.** In the PR description, paste:
   - The Bun version (`bun --version`)
   - The resolved piece version (`bun pm ls | grep <name>`)
   - The first 5-10 lines of the EXTRACT_PIECE_METADATA output

8. **Update `BRANCH_SUMMARY.md`** if relevant and the project changelog.

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
