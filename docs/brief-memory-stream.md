# F17: paginated memory stream

F17 adds a read projection over canonical vault facts and provenance. It changes no fact writer, recall qualification, usage ledger, legacy vault route or UI. The branch is stacked on corrected F16 `1cd3d429b1842a831d20d0a9e2e137f49d914c20` at the owner's request. Main inspected: `2281a8235d4987af202e3b99f7ea514ac7ed4ff8`. Both roadmap source files, `src/vault/facts.ts` and `ui/src/v2/rooms/memory/useMemoryData.ts`, have identical blobs on this stack, inspected main and pinned audit `69211511c95355776c6c319c01e1df5acd3b8f1e`.

## Activation and F18 seam

The `memoryStream` provider is registered, with `JARVIS_BRIEF_MEMORY_STREAM=1` as its default-off flag. The existing capability graph also requires enabled `memoryUsage`. This branch has no production usage provider, so setting the stream flag alone still returns unavailable. F18 is intentionally not implemented here. No live Memory room or screenshot is claimed.

F18 must implement `MemoryUsageReader` from `src/brief/memory-stream-contracts.ts`, pass it into `new MemoryStream(db, usage)`, register that exact same instance as `memoryUsage`, and enable that dependency through its own rollout control. `readUses(factIds)` must synchronously read committed, retained records for those IDs from the same vault database. The stream calls it inside the fact read transaction. Missing, failed, malformed or over-capacity instrumentation never becomes an empty usage list. F17 validates and explicitly projects each record; it does not import an unmerged writer or infer associations from text.

An available empty ledger gives `uses: []`; absent instrumentation gives `uses: null` in direct provider reads. `Used in` is unavailable until the returned ledger has at least one supplied or outcome-verified record. Selected-only records remain visible as selected but never satisfy the filter. Supplied means context was supplied, not proof that the model relied on it. Old source revisions and evidence stages are preserved without silently promoting them to current evidence.

## Read API

All three routes are inside the existing authenticated daemon route table, check the exact registered providers and capability dependencies, and return `Cache-Control: no-store`.

- `GET /api/brief/memory`: collection with optional `q`, `source`, `usedIn`, `updatedFrom`, `updatedBefore`, `limit` and `cursor`.
- `GET /api/brief/memory/:factId`: current detail including retained superseded facts, or 404 if absent.
- `GET /api/brief/memory/:factId/history`: up to 100 linked assertions connected by canonical `superseded_by` edges. A missing starting fact is 404; an oversized family is unavailable, never silently truncated. Cycles terminate. This is correction lineage, not a complete event log of every in-place confirmation.

Search is a literal case-insensitive substring of the full subject/predicate/object sentence, at most 256 characters. It never interprets SQL, wildcard or regular-expression syntax. Source matches one exact label in either the canonical fact or its provenance, at most 4,000 characters. It does not fetch a URL or identify an authenticated source account. `sourceId` stays null because these labels are not canonical connection identities.

`usedIn` is exactly `conversation:<id>` or `run:<id>` and uses supplied/outcome-verified records only. `updatedFrom` is inclusive and `updatedBefore` exclusive, both integer UTC milliseconds. Updated means the latest recorded creation, verification or provenance timestamp available in the canonical schema, not an invented edit timestamp. Untimestamped legacy status changes still invalidate cursors through revision fingerprints. Ranges must increase.

Limit defaults to 50, maximum 100. Unknown parameters, duplicates, blank values, invalid cursors and oversized inputs return 400. Each page repeats the same normalized filters and page size along with its cursor. Source, IDs and filter values must be URL-encoded by the client.

The stream includes active and contested assertions, excluding superseded ones. Time-limited facts remain inspectable with explicit validity bounds; this is a memory browser, not a recall eligibility decision. Existing fact IDs, statuses and confirmation precedence are preserved. Every item contains the complete sentence, revision, updated time, provenance IDs, source labels/count, explicit usage references and server-generated local detail/history URLs. Raw evidence quotes, source references and arbitrary adapter fields are excluded. Labels/sentences are text, not markup or URLs to execute. Correction and forget permissions remain false pending their action owners.

## Counts, ordering and continuation

`ready` and `empty` both contain a page. `count.total` counts current nonsuperseded assertions before filters; `matched` is the exact filtered count; `returned` is this page's length. Empty is a successful zero-match result. There is no inference that an unavailable service means zero facts.

Rows sort by Updated descending, then fact ID ascending using a locale-independent string comparison. The first read freezes membership, order and counts for five minutes. A cursor is bound to its filters and page size and signed against offset changes. New facts, including equal-time or backdated inserts, appear on a fresh query and do not shift subsequent pages. Each request uses a new SQLite read transaction; there is no database transaction held open between requests.

A snapshot caches only IDs, revision hashes, counts and filter metadata, never fact text or evidence content. Every continuation rereads canonical data and compares original members. A correction, deletion, verification, entity rename, provenance change or usage change returns HTTP 409 with `state: stale` and no cached content. Refresh without a cursor. Expiry, restart or cache eviction also returns stale. Changes affecting an existing assertion, such as a new conflicting assertion, may therefore require refresh even though unrelated new assertions do not. A stale cursor cannot continue displaying forgotten data.

`unavailable` is HTTP 503 for provider failure, dependency gates, an unavailable Used in filter or exceeded capacity. No provider registration is 501. The feature-specific `MemoryStreamResult` retains count metadata on empty and deliberately omits data on stale, available through the additive `BriefReadProviders.memoryStream` seam while preserving the generic F01 `memory` seam, without requiring consumers to keep possibly forgotten content.

## Bounds and limitations

One collection read permits 10,000 total fact rows (including superseded history), 50,000 evidence rows and 50,000 supplied usage records, with a 16 MiB serialized input bound for facts/provenance and another for usage. Exceeding any bound reports unavailable. Queries read the bounded collection and compute exact counts; they do not silently sample a larger vault. Evidence is read in indexed ID order and sorted within each fact after the row bound. At most 16 active multi-page snapshots are retained per provider; least-recently-created snapshots are evicted. Clients must handle refresh after expiry, restart or eviction.

There is no full-text index or new schema migration in F17. Large vaults beyond these caps need a later scalable query design before activation at that size. History only follows retained canonical supersession links. Physical deletion cannot manufacture a tombstone or a missing predecessor; F19 owns forgetting semantics. No new relationship, attribution, usage writer, source connector, external service call or model call is introduced.

## Verification and rollback

In WSL, run the isolated fixture suite:

```sh
cd /home/vierisid/.cache/codex/jarvis-f-17
bun test src/brief/memory-stream.test.ts src/daemon/api-brief-memory.test.ts src/util/model-exec-env.test.ts
```

It creates temporary vaults and a real authenticated Unix-socket server. It covers exact combined filters/counts, full long sentences, tied timestamps, a second SQLite writer inserting between pages, stale correction/deletion/provenance/usage, signed query-bound cursors, restart/expiry/eviction, missing versus unused records, lineage, capacity errors, authentication and legacy compatibility. Its usage provider is explicitly a test fixture; production still has no F18 ledger. See `docs/brief-delivery/F-17.json` and the adjacent evidence directory for final results and mutation checks.

After F18 integration, an authenticated client can query `/api/brief/memory?limit=2&q=tea`, repeat those filters with `cursor`, then refresh without a cursor to see newly inserted facts. Correction/deletion during paging must produce 409, not an old fact. Before F18, the production route remains 503 even with the stream flag set.

Rollback by unsetting `JARVIS_BRIEF_MEMORY_STREAM` or disabling its usage dependency. No migration or canonical data cleanup is needed. F18, D20 live adapters, deployment and merging are outside this PR.
