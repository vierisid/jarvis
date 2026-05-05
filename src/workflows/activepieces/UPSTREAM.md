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

## Curated pieces

Initial bundled pieces (Phase 1, ~30):

```
schedule, webhook, http, branch, loop, delay, approval, files-helper,
store-storage, gmail, google-calendar, google-drive, slack, discord,
telegram-bot, github, notion, openai, anthropic
```

Plus the Jarvis-native pieces (Phase 3): `jarvis-ask`, `jarvis-agent`, `jarvis-tool`, `jarvis-context`, `jarvis-notify`, `jarvis-trigger`.

Additional pieces can be added later by re-running the sync script with an expanded curated set.

## Sync procedure (placeholder)

The sync script lands in Phase 1. Until then, this directory is empty (apart from this file) and serves as a placeholder for the planned vendored tree.
