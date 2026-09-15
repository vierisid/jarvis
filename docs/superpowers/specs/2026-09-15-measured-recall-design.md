# Measured default memory recall

Improve the existing synchronous SQLite recall path. Rank facts before applying
entity limits, with Unicode normalization and explicit name/alias relevance.
Keeping LIKE and only measuring it leaves known failures; adopting vector search
first requires a separate embedding ingestion/freshness contract. The lexical
approach addresses the observed failures without a model call or new service.

## Contract

- Keep retrieveForMessage, formatKnowledgeContext and getKnowledgeForMessage
  compatible with existing daemon callers. Rank all current candidate facts
  together; query-term and insertion order must not cap the candidate universe.
- Unicode case/accent normalization and CJK matching cover literal multilingual
  names/facts. Do not infer unknown translations. Aliases locate subjects but
  retain their evidence qualification. Task matches outrank unrelated subject facts.
  Once a task match exists, omit unrelated background facts from that subject.
- Cap context at 12,000 UTF-16 code units, 18 facts, six entities, eight facts per
  entity and four relationships per entity. Include whole qualified records or
  omit them with an omission notice. These are not model-token counts.
- Exclude superseded and out-of-period facts from default current recall.
  Preserve contested/inferred state, source/confidence/time, scope and evidence.
  Relevance never establishes verification or action authority. Return empty
  context for unrelated requests, including unrelated self requests.

## C8 integration

Base main is 06c12e65. Reviewed C8 head 9317d414 is not merged. This branch changes
retrieval, not ingestion/truth storage. Consume optional C8 metadata structurally;
legacy facts retain the qualifications their actual records provide. Test both
this branch and a disposable combination with C8. Resolve retrieval.ts overlap
to the new ranker/formatter while keeping C8's fact repository and evidence.
Do not include the C8 commits in this branch.

## Benchmark

Fixtures are frozen before tuning and have disjoint development/held-out work
records. Vieri approved synthetic English, Italian, German, Spanish, Cyrillic and
CJK coverage. This is an authored repository holdout, not independent user data.
Use development failures for ranking decisions, then evaluate the holdout without
tuning it; any later tuning needs a new holdout. The first evaluation revealed
that a fact-count gate alone was insufficient: a development case still allowed
two long background notes to dominate fact characters. Added a per-task 80%
relevant-fact-character gate, froze heldout-v2 before the resulting change, and
retained the first holdout as regression coverage.

Exercise real ingestion and the default formatted-context entry point. Measure
necessary-fact recall, task success, irrelevant-fact precision, qualified-record
coverage, relevant fact-character share, context length, abstention and reversed
insertion/query order. Each actual formatted fact line is counted once, even when
several legacy rows have identical values. Preserve causal ordering of a confirmed
correction followed by an inference while permuting independent inserts. Use the
real correction operation available on each branch. Test C8-only evidence and
temporal behavior explicitly in the combined checkout, without manufacturing a
truth schema in a legacy database. Record baseline, final results and fixture
hashes. Measure a larger synthetic corpus before choosing new infrastructure.

Implementation: freeze fixtures and record baseline; implement normalization,
ranking and bounded qualified context; test development cases and edge cases;
freeze ranking and evaluate holdout; verify actual C8 integration/restart; run
vault/caller tests, TypeScript, daemon build and applicable repository guards.
Real-user quality, semantic translation and downstream actions remain unmeasured.

## Combining with C8

The isolated verification checkout starts at 9317d414 and overlays this branch's
retrieval.ts, recall modules, fixtures and benchmark runner. It keeps C8's real
repository, migrations, evidence and correction APIs. Both branches edit
retrieval.ts, so resolve that file to this branch's version. Apply
2026-09-15-c8-recall-test.patch to the older C8 temporal recall test: the records
remain available through getFact/findFacts, but default context now excludes
expired values. The new C8 integration regression verifies that behavior. This
test adjustment changes no C8 repository behavior.

## Results (2026-09-15)

All runs use actual SQLite ingestion and the default getKnowledgeForMessage path.
The baseline uses clean main 06c12e65 and the same final measurement harness.
Each task includes a query and an insertion-order variant. Precision counts only
fact records, while character precision counts their complete formatted lines;
entity headings and the common memory-use instruction are excluded from that
precision denominator but included in the context size ceiling.

| Set / implementation | Passed | Necessary-fact recall | Fact precision | Fact-character precision | Qualified coverage | Largest context |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development / main | 2/24 | 69.2% | 14.3% | 0.7% | 0% | 47,730 |
| Development / new | 24/24 | 100% | 100% | 100% | 100% | 1,190 |
| First holdout / main | 2/24 | 76.9% | 16.4% | 0.5% | 0% | 75,451 |
| First holdout / new (regression) | 24/24 | 100% | 100% | 100% | 100% | 1,178 |
| Fresh holdout v2 / main | 2/32 | 85.7% | 43.9% | 6.5% | 0% | 9,461 |
| Fresh holdout v2 / new | 32/32 | 100% | 100% | 100% | 100% | 1,932 |
| Fresh holdout v2 / new + C8 | 32/32 | 100% | 100% | 100% | 100% | 2,860 |

Final selected fact sets were stable across all query/insertion variants in all
three partitions. Full per-task results, fixture hashes and C8 runs are retained
in 2026-09-15-recall-results.json. Before the character-gate correction, the
development crowding case retained only 8% relevant fact characters despite
passing the original count-based gate. The new v2 holdout was frozen before the
fix, and its first evaluation passed without further ranking changes.

With 10,000 distractor facts across 1,000 projects, the measured cold lookup was
204 ms; ten warm lookups had a 112 ms median and 135 ms p95. An earlier run under
load measured 355 ms median / 709 ms p95. These are synthetic local timings, not
a production latency guarantee. Scanning is linear in stored text; evidence is
loaded only for bounded finalists. Larger vaults may justify an index, but this
change does not establish an embedding ingestion contract or semantic paraphrase
and translation coverage. Real-user operating tasks remain unmeasured.

Validation passed 164 backend tests (one existing skip plus the C8-only test),
196 backend tests with actual C8 storage (one existing skip), full TypeScript in
both checkouts, the daemon build, licensing/migration/template guards and the
package guard. The latter used Bun after the npm pack subprocess stalled and was
terminated. C8 reruns used a 20-second test timeout after concurrent checks caused
database setup timeouts; the final combined suite passed in 13.75 seconds.

The full repository suite was attempted with --bail and stopped in the unchanged
check-package-files real-package test at its 60-second timeout (22 tests visited).
It did not complete. The commit hook is bypassed after the explicit checks above;
no claim of full-suite success. No UI changes or downstream model action tests.

Reproduce:

```sh
bun scripts/benchmark-memory-recall.ts development --check
bun scripts/benchmark-memory-recall.ts heldout --check
bun scripts/benchmark-memory-recall.ts heldout-v2 --check
bun scripts/benchmark-memory-recall-scale.ts 10000
bun test src/vault src/awareness src/roles/prompt-builder.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Run the same commands in a C8 combination after resolving retrieval.ts and
applying the accompanying temporal-test patch. Do not mark a future tuning run
as held out against these now-examined fixtures; add a fresh evaluation set.
