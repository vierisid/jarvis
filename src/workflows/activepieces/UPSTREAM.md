# Activepieces Upstream

This directory contains a vendored subtree of the [Activepieces](https://github.com/activepieces/activepieces) project, used as the foundation of the Jarvis Workflow system.

## Pinned version

| Field | Value |
|---|---|
| Tag | `0.82.1` |
| Commit SHA | `d04e6807c485ecd788a72af0d04abffba78563c7` |
| Published | 2026-04-24 |
| Source | https://github.com/activepieces/activepieces |

When syncing to a newer version, update this table and re-run `scripts/sync-activepieces.ts` (added in Phase 1).

## License

Activepieces is dual-licensed. We vendor only the **MIT-licensed** portions. The original MIT copyright notice is preserved verbatim in `LICENSE.activepieces` alongside this file (added in Phase 1 with the actual code).

## Excluded paths (Enterprise License -- DO NOT VENDOR)

The following upstream paths are licensed under the Activepieces Enterprise License, which forbids redistribution. They must never appear in this directory:

- `packages/ee/**`
- `packages/server/api/src/app/ee/**`
- Any file or directory whose path contains a `/ee/` segment.

A CI guard (`scripts/check-no-ee-imports.ts`) enforces this on every push and pre-commit. If it fires, the import or vendored path must be removed before merging.

## Excluded by design (not licensing -- just out of scope)

We also intentionally do not vendor:

- `packages/server/api` -- NestJS HTTP server. Replaced by integration into the Jarvis daemon's HTTP surface (Phase 2).
- Anything depending on Postgres or Redis. Replaced by `bun:sqlite` and an in-process queue (Phase 2).

## Post-copy patches

The sync script applies the following modifications after copy. These keep diff vs upstream small while removing dependencies we don't want at runtime.

- **Stubbed:** `packages/server/engine/src/lib/core/code/v8-isolate-code-sandbox.ts`. The original imports `isolated-vm` (a Node N-API native addon). We never use V8 isolate sandboxing -- the engine runs in `SANDBOX_PROCESS` mode (see `SPIKE-SANDBOXING.md`). The stub preserves the import path and throws a clear error if `AP_EXECUTION_MODE` is ever set to `SANDBOX_CODE_ONLY` or `SANDBOX_CODE_AND_PROCESS`.
- **Scrubbed:** `isolated-vm` removed from `packages/server/engine/package.json` `dependencies`.

Both are driven by `STUB_FILES` and `SCRUB_DEPS` constants in `scripts/sync-activepieces.ts`. To extend, add entries there and re-run the sync.

## Curated pieces

Initial bundled pieces (Phase 1):

From `packages/pieces/core/` (built-in primitives):

```
approval, delay, file-helper, http, schedule, store, webhook
```

Community pieces (Gmail, Slack, Notion, ...) are NOT vendored. They install
on demand at runtime via `bun install` from the curated catalog in
`src/workflows/pieces-library/`. See that directory's README for the
catalog policy and per-piece pin strategy.

Plus the piece SDK and shared utilities: `packages/pieces/framework`, `packages/pieces/common`.

Plus the Jarvis-native pieces (Phase 3): `jarvis-ask`, `jarvis-agent`, `jarvis-tool`, `jarvis-context`, `jarvis-notify`, `jarvis-trigger`.

Additional pieces can be added later by editing `VENDOR_PATHS` in `scripts/sync-activepieces.ts` and re-running the sync.

## Vendored top-level paths

- `packages/server/engine` -- the flow runner.
- `packages/shared` -- shared types and utilities (the `/ee/` subtree is filtered during copy).
- `packages/pieces/framework` -- the piece SDK.
- `packages/pieces/common` -- shared piece utilities.
- `packages/pieces/core/<curated>` -- built-in primitives (see list above).
- community pieces are NOT vendored -- they install at runtime; see `src/workflows/pieces-library/README.md`.
- `packages/web` -- the Vite-based visual builder app (formerly `packages/react-ui` before 0.82).
- `packages/react-ui` -- locale assets the web app references at runtime.

`LICENSE.activepieces` (a copy of upstream's MIT LICENSE) sits next to this file.

## Sync procedure

To re-sync to a different upstream version:

1. Update `PINNED_TAG` and `PINNED_SHA` in `scripts/sync-activepieces.ts` and the table at the top of this file.
2. Run `bun run scripts/sync-activepieces.ts --check` to confirm the pinned SHA matches and all paths still exist.
3. Run `bun run scripts/sync-activepieces.ts` to perform the sync.
4. Run `bun run check:no-ee` to confirm the EE guard is still green.
5. Resolve any local patches against new upstream.
