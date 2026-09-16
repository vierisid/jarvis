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
  entity and four relationships per entity. Preserve complete fact values and
  qualifications. Bound the attached evidence view with explicit omissions and
  a canonical ledger reference. These are not model-token counts.
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

## Review fixes (2026-09-15)

R1: ranked profiles carry `matchedAliasIds`. Hydration reserves those records
before the ordinary finalists, and context packing includes all matched aliases
as required dependencies. They count toward both fact limits. A missing, expired
or unrepresentable dependency prevents the subject's facts and relationships
from appearing without its selection qualifications.

R2: the prompt evidence array is capped at 2,000 characters per fact. Entries
retain IDs, basis, source, confidence, time and source references where they fit;
confirmed evidence is selected first, then recent evidence. Oversized quotes
are omitted whole, never cut mid-qualification. Omitted entries are counted by
basis, with a total, omitted-quote count and `fact:<id>` ledger reference. The
stored ledger, fact qualifications and binding eligibility remain unchanged.

R3: empty/stopword-only requests return before any database reads. Explicit
self-overview requests retain the existing profile behavior.

R4: a value-based query matching a contested fact retains its current confirmed
counterparts for the same subject, canonical predicate and scope. C8 supplies
the conflict state; active multi-valued records are not treated as corrections.
Profiles carry `factDependencies: { factId, requiredFactIds }[]`, including
transitive requirements for mutually contested confirmations. Hydration reserves
confirmed counterparts, and packing includes complete dependency groups or omits
the dependent claim. A confirmed answer may appear alone; unrelated task facts
remain eligible. Missing, expired or oversized counterparts cannot leave an
isolated inference in context. No truth records or binding eligibility change.

R4 added eight cases. Six unit regressions and the actual-C8 value-query case
failed before the fix; all now pass, including canonical predicate aliases,
scope/validity boundaries, tight budgets, crowding and restart. Fresh R4 checks
passed 181 backend tests here (four skips) and 215 with C8 (one existing skip),
TypeScript in both checkouts, the daemon build and all four guards. Existing
development/held-out fixtures still pass as regression coverage. The full suite
was not rerun, and the package-test timeout and hook-bypass limits remain.

Seven new branch regressions and one actual-C8 regression failed before these
R1-R3 fixes. Their eleven added cases cover crowded aliases, tight/shared limits,
missing/expired dependencies, large quotes, evidence counts, empty-query reads
and correction/alias/evidence recovery after a real database restart. Fresh
validation passed 174 backend tests (three skips) and 207 with C8 (one existing
keychain skip), TypeScript in both checkouts, the daemon build and all four
guards. Package verification used the supported Bun fallback with a Bun-only
PATH because of the previously recorded npm stall. The full suite was not rerun;
the unchanged package-test timeout below remains a validation limit.

The existing frozen v2 set was rerun as regression coverage, with 32/32 passing
in both configurations and all four quality ratios at 100%. Maximum context is
1,932 characters here and 3,124 with C8, including evidence IDs. No new held-out
quality or scale-performance claim is made. The results below and adjacent JSON
retain the original pre-review measurements at `05054c91`.

## Review fixes (2026-09-16)

R5: scoring walks each record's own terms instead of the query. The previous
form was O(facts x query terms squared), so a pasted document stalled the
synchronous recall call the daemon makes on every message: 13.7 s for a
3,000-word message over 2,000 facts, now 40 ms. Frozen results are unchanged.

R6: a subject whose facts were all rejected by the character budget no longer
contributes a heading and its relationships. Relationships are unverified and
carry no qualification, so they cannot stand in for the facts that justified
retrieving the subject. Same rule as R1, reached through the budget.

R7: the relevance floor is computed from a score that includes the flat name
bonus, so a subject matched only by name hid the subjects whose facts actually
answered the request ("Where does John work?" returned John's birthday and
dropped Google's `employee: John`). When the top subject matched on its name
alone, the floor is now waived for the subjects that name it back. A merely
lexical hit on a generic task term is not such a cross-reference, so unrelated
subjects still do not enter. Development, both held-out splits and every quality
ratio are unchanged at 100%.

R8: ranking drops candidates before packing sees them, through the per-subject
task filter and the floor. Those drops now set the same incomplete-record notice
that the packing limits set, so a filtered slice is never presented as the whole
record.

R9: whole-word self detection. An embedded "me" (melatonin, meeting, same) no
longer reads as a self-overview request, which had both bypassed the empty-query
read guard and injected the whole user profile into unrelated requests. One
narrow predicate now serves the read gate and the profile boost: the self
reference has to be the object of the knowing and stay inside the same clause,
so "what do you know about the Q3 budget? send it to me" is not a self request.
Widening the gate instead would have leaked the profile far more often than the
original bug withheld it.

R10: `line()` defangs the " | " separator as well as newlines. Predicates,
values and names come from untrusted extraction, so a value could otherwise
carry a forged qualification blob ahead of the real one. Same rule as
`defangDelimiters` in roles/untrusted.ts.

R11: smaller corrections. A relationships failure degrades to facts only again,
as it did before ranking. A subject whose records are all out of period reads as
having none rather than vanishing. The reflexive stopwords dropped in the list
reformat (himself, herself, themselves, yourselves) are restored; work/works/
working stay out, deliberately, because they carry meaning in operating
requests. The benchmark qualification check reuses the line it counted instead
of re-finding the first match, so duplicate values cannot let a qualified record
vouch for an unqualified one. The scale script reports a median and a maximum,
which is what ten warm samples support; the earlier run's "p95" was the maximum.

Known limitation, unchanged: naming a subject with no matching fact returns that
subject's current facts, so mentioning the owner's own name returns the profile
even when the request is unrelated to it. That is the same behaviour main had for
any named subject, and the caps now bound it, but it is not data minimisation.

R12: a possessive drops its ending before the remaining apostrophes are
removed, so "Ann's" anchors on the subject Ann. Names normalise the same way on
both sides, so a subject actually named "Ann's Diner" keeps matching itself.
Scores also compare with a 1e-9 epsilon: the same record can sum its term
weights in a different order, and an exact-equality tiebreak would otherwise be
bypassed by float noise. That is inert on this schema and observable once C8
populates scope, so it lands before the merge rather than after.

Known limitation, unchanged: matching is whole-token, so an inflected query term
does not reach an uninflected stored value ("projects" does not match
"project"). Stemming is language-specific and this recall path is multilingual,
so it is not attempted here; the English possessive is handled in normalisation
rather than by a stemmer. No held-out case covers inflection; a fix needs a
fresh evaluation set.

## Initial results at 05054c91 (2026-09-15)

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
