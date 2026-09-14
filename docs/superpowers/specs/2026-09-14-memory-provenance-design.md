# Qualified memory and corrections

Extend facts and retain a source ledger. Formatting alone would leave duplicate
claims and stale corrections intact; replacing the graph would split existing IDs.

- Recall includes fact ID, state, source, confidence, recorded/verified dates,
  validity interval, scope and source references/quotes. Missing dates remain
  unspecified. Repetition and a model score never establish confirmation.
- A small explicit predicate registry defines aliases and single-value semantics.
  Birthday, name and named current preferences are single-valued within one scope
  and period. Locations, aliases, emails, jobs and unknown predicates preserve
  multiple values. Paths, URLs and unknown values retain case when deduplicated.
- Duplicate assertions share a fact and retain distinct provenance. Upgrade keeps
  historical duplicate IDs as superseded rows. Conflicting unconfirmed claims are
  contested; a conflicting inference cannot replace an explicitly confirmed value.
- Confirmation replaces competing values only for known single-value predicates
  in the same scope and validity period. Other corrections target one fact ID.
  Overlapping but different periods are not silently collapsed. Superseded rows
  remain inspectable through history and never enter ordinary recall.
- The active Memory room provides confirmation and targeted correction. Ordinary
  creation remains unconfirmed, including voice-classified values. Correction APIs
  require explicit confirmation and a reason. Changed stale corrections fail.
- Recall is evidence, not execution permission. Single-value lookup requires a
  current, uniquely resolved confirmed value. Contested, expired and ambiguous
  values require confirmation. Ranking and workflow authority remain separate.

Implementation order: schema/policy and repository transactions; extraction and
recall formatting; authenticated correction routes and active Memory room controls;
restart, temporal/multi-value, provenance, extraction trust and UI regressions.

The extraction model remains probabilistic. Quotes are checked against actual user
input, but substring matching cannot establish entailment. Extracted user quotes
therefore remain reported evidence, not confirmation. Extraction cannot confirm
a fact or supersede a confirmed correction.

## API and consumers

- `GET /api/vault/facts`: current and contested records; `include_superseded=true`
  adds history. Existing subject/predicate/object filters remain. Entity facts and
  unified search return the same qualified fact objects.
- `GET /api/vault/facts/:id`: exact retained record, including supersession link.
- `POST /api/vault/facts/:id/confirm`: `{confirmed: true, reason}`.
- `POST /api/vault/facts/:id/correct`: `{confirmed: true, reason, object}`.
- Existing `POST /api/vault/facts` accepts optional `scope`, `valid_from` and
  `valid_to` (epoch milliseconds), but cannot establish confirmation. The end of
  an interval is exclusive. Missing temporal bounds stay null.

Writes are synchronous database transactions behind the existing authenticated
daemon boundary. Missing records return 404, invalid decisions 400, and stale
changed corrections or confirmation of superseded records 409. Identical retry
of a targeted correction returns its existing current replacement.

Facts expose `basis`, `status`, `evidence[]`, `predicate_key`, `value_key`, `scope`,
`valid_from`, `valid_to`, `superseded_by` and `binding_eligible`, alongside existing
fields. The eligibility flag is not authorization. `queryFact(name, predicate,
scope)` refuses ambiguous entities, unconfirmed/contested/out-of-period values
and multiple current values of a multi-valued predicate. Critical actions still
need their own approval. No downstream model action is claimed to be verified.

Legacy `updateFact` retains revisions and refuses to overwrite confirmed facts;
explicit corrections use `correctFact`. Profile saves retain superseded answer
history. Relationships have no verification record and are labelled unverified
when included in recall, preventing a parallel unqualified claim surface.
