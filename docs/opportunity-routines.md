# Q-11: Evidence-backed routine discovery

Policy `routine-cues-v2` recognizes invoice review, lead follow-up, recurring reports,
meeting follow-ups, expense reconciliation, and support triage. It proposes a question
about recurring work. Screen activity never establishes completion, time saved,
workflow feasibility, authority, or business progress.

## Evidence and recurrence

The classifier interprets a fixed vocabulary, without model calls. Each admitted
capture supplies one role: a source, an operation in that job's context, or a draft
output. Output takes precedence over operation, which takes precedence over source;
a static screen containing all three phrases cannot advance a sequence.

A qualifying episode needs those roles in order, at strictly increasing timestamps
and on the same sidecar. App names cannot supply any role. A gap of at least 30
minutes starts a new episode. Each device also expires its own partial sequence
after 30 minutes without a matching capture; another device cannot bridge that gap. Continuous captures, even across midnight or
with repeated full sequences, count at most once; simultaneous activity on multiple
sidecars also counts at most once. Three qualifying episodes starting on at least
two UTC dates, within 14 days, are needed for a proposal. Captures without sidecar
identity share the legacy unknown-device bucket; cross-device provenance cannot be
established for such inputs.

Each hypothesis carries fixed source/operation/output labels, timestamps and capture
references for every episode. Its existing `evidence` array keeps one output
representative per episode for current consumers. References survive capture expiry;
they do not imply that the raw capture remains available. Existing goal matching for
the original three kinds is unchanged. New kinds have no inferred goal link; Q-12
owns improved relevance.

## Privacy and compatibility

The bounded classifier abstains on explicit reading/research/tutorial contexts,
recognized private windows/password managers, metadata-only captures, excluded
inputs, and oversized input. Bounds are 240 title characters, 20,000 OCR characters
(full-screen OCR often exceeds 2,000), 100 app characters and 200 sidecar-ID characters. No truncation can conceal a
qualifier beyond a bound. These lexical exclusions supplement the existing awareness
enable/disable boundary; they cannot identify every private app or unmarked article.

The additive nullable `opportunity_observations.routine_evidence` column stores only
policy, role and sidecar identity. Existing capture ID, timestamp, app and canonical
cue columns remain. No extra OCR, title, URL, screenshot, content hash or extracted
customer field is retained. The existing 14-day sweep removes these derived rows.

Old writers can omit the new column. Old readers can still select the original
columns. Cue-only or malformed rows cannot become structured evidence; no backfill
reinterprets old screen content. Previously published hypotheses remain readable,
and the durable `job-v1:<kind>` identity preserves dismissals and interest across the
policy upgrade. New discoveries need new qualifying episodes.

## Evaluation

Both fixture files were authored and hashed before the classifier implementation.
They are hand-labeled synthetic episodes, not customer recordings or independent
human field review. The holdout uses different wording and contains unsupported
useful routines. Both splits were visible to the author during implementation,
so the holdout is not independent or blinded and author leakage is possible. No
lexical tuning followed its first run. Labels do not flow into the classifier as
answers. Independent field/consented holdout validation remains not run.

| Split / policy | Correct proposals / all proposals | Missed useful routines / useful routines | Negative cases |
| --- | --- | --- | --- |
| Development / baseline | 3 / 7 | 7 / 10 | 12 |
| Development / v2 | 8 / 8 | 2 / 10 | 12 |
| Holdout / baseline | 3 / 6 | 8 / 11 | 13 |
| Holdout / v2 | 8 / 8 | 3 / 11 | 13 |

V2's 8/8 proposal precision has a Wilson 95% interval of **67.6–100%** on each
split. Holdout misses are 3/11 (**27.3%**, interval **9.7–56.6%**). These intervals
only describe the small synthetic corpus; they do not establish production accuracy.
The baseline can ask tentative questions on weak cues; its false positives here
are unwanted proposals, not false claims of successful execution.

Misses remain visible: hiring and inventory in development; onboarding, renewals,
and an unsupported meeting paraphrase in holdout. English and a few explicitly
listed Italian invoice/meeting forms are supported. Other vocabulary, absent OCR,
oversized screens, incomplete phases and ambiguous contexts abstain. An unmarked
article or replay of a whole changing sequence can resemble activity; user
confirmation and feasibility checks remain necessary. No fake confidence field or
automatic execution was added.

Run from the repository root with Bun 1.4.2:

```sh
bun run scripts/evaluate-opportunity-routines.ts
bun test src/awareness src/vault/awareness.test.ts
bunx tsc --noEmit
```

The JSON report includes every case, false proposals, misses, denominators, corpus
hashes and Wilson intervals.
The `structured hypotheses reference every role` test provides a
reproducible service-level example; lifecycle tests exercise real SQLite, sidecar
ingestion, capture expiry, restart, delivery, feedback and suppression.

## Measuring on real screens

The corpora above are synthetic and use the catalog's own phrases, so they cannot
show how often detection fires on real screens (#1068). No real OCR is committed.
The phrases are not to be changed until it has been measured on real captures.

Stored captures are deleted after `awareness.retention` (1 hour by default, 24
hours for key moments such as an app switch), long before a routine can recur.
A routine is a series of app switches, so both limits matter. On a machine whose
owner has opted in, first keep captures for the measurement period, knowing that
this keeps the screen's OCR text in the brain's database, and the screenshot
files on the desktop machine, for as long:

```yaml
awareness:
  retention:
    full_hours: 336          # 14 days, for the measurement only;
    key_moment_hours: 336    # put both back afterwards
```

and restart Jarvis (a `config.yaml` change is imported at the next start).

After at least a few working days with awareness on:

```sh
bun run scripts/measure-routine-ocr.ts            # $JARVIS_HOME/jarvis.db or ~/.jarvis/jarvis.db
bun run scripts/measure-routine-ocr.ts path/to/jarvis.db   # if daemon.db_path is set
```

It reads the last 14 days of `screen_captures` read-only and prints counts only:
- `spanDays`, the whole days between the oldest and newest capture. A short span
  means captures were deleted, not that detection failed.
- Captures stopped at each gate: oversize, private, reading, and excluded. The
  live pipeline never stores an excluded capture, so that count is expected to
  be 0.
- For each family:
  - how many read captures matched the source, operation and output phrases
    (each alone, and source with operation);
  - the stage each capture was given;
  - how many captures a gate stopped that would otherwise have been given a stage;
  - the ordered episodes and the distinct days they start on, grouped as the
    assessment groups them (recurring reports per cadence).
- The proposals the assessment would make, before dismissals or known patterns.

No OCR text, title, app name, capture id, device id or timestamp is printed, so
the report can be shared. A phrase change
should cite these counts from more than one machine, before and after, and keep
the existing fixtures and the single-repeated-view case passing.

## Turning it off

Discovery follows the existing awareness setting; there is no separate flag.
Disabling awareness stops it. Existing hypotheses, dismissals and user work are
retained.
