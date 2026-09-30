# Validated goal writes

Goal proposals are validated after model generation and again at confirmation.
The API, chat tool and vault creation boundary enforce the same field types and
parent-child order. This changes future writes; it does not rewrite legacy rows.

## Hierarchy and atomicity

The order is `objective -> key_result -> milestone -> task -> daily_action`.
Standalone quick-created goals can still be at any level. An attached goal must
be exactly one level below its existing parent; a daily action cannot have children.
The chat tool's quick create uses that next level when `level` is omitted.

The proposal wire fields remain `objective`, `key_results` and optional `milestones`.
For root creation these mean their named levels. When a parent is supplied,
`objective` is context only, `key_results` contains immediate children, and
`milestones` contains their children, at the next two permitted levels. The
context objective is neither inserted nor used to update the existing parent.
For a task parent, omit milestones or use an empty array. The format supports at
most two child levels per request; further decomposition is a separate request.
Each milestone's integer `key_result_index` must identify an existing child.
Unknown fields, including node-level `level` overrides, are rejected.

Generated decomposition proposals include `parent_id` and `parent_level`.
Confirmation rechecks both against the current row; a conflicting request parent,
deleted parent or changed level fails without creating children. Existing callers
can still supply `parent_id` beside a legacy proposal without metadata; its levels
are resolved from that parent at confirmation. Use the returned metadata to bind
a delayed confirmation to the reviewed parent level.

`createFromProposal` validates the complete structure, resolves deadlines and plans
the hierarchy before inserting it within one synchronous immediate SQLite
transaction. Parent lookup occurs in that transaction. Any later insert failure
rolls back the whole tree and preserves existing goals. Model calls occur before
the write transaction. Clarifying questions must be resolved/removed before
confirmation. The operation does not add acceptance idempotency or route scoring
and status transitions through a shared write contract.

## Dates and timezone

- `deadline_days` is a nonnegative integer count of elapsed 24-hour periods, not
  local calendar days. Zero means the reference instant. All nodes share one
  `deadline_reference_at`; generated proposals return this timestamp, so later
  confirmation does not move their deadlines. A legacy/manual proposal without
  a reference uses one UTC instant captured at confirmation.
- `deadline_at` is an absolute RFC3339 instant with seconds and `Z` or an explicit
  numeric offset, with at most three fractional digits. Date-only strings, local
  timestamps without offsets, invalid calendar dates, leap seconds, `24:00`,
  unknown `-00:00` offsets and out-of-range values are rejected. Do not supply both
  deadline forms on one node.
- `timezone` is an optional validated IANA zone describing the interpretation
  context for generation. Jarvis supplies its configured user zone, falling back
  to the host's zone when self-hosted configuration omits it. Absolute deadlines
  retain their explicitly supplied instants regardless of host timezone; the zone
  label does not reinterpret an offset-bearing timestamp. For local calendar
  deadlines, the model must resolve the user's zone into an explicit offset.
- Persistence stores epoch milliseconds in the existing `deadline` column. Missing
  deadlines remain null. A dated descendant cannot be due after a dated ancestor,
  including across intermediate goals without deadlines. Changing an ancestor's
  deadline cannot strand existing descendants beyond it.

No migration is needed. Direct create/PATCH uses the existing epoch-millisecond
`deadline` field; numeric strings are rejected and PATCH null clears it. Direct
write fields, proposal fields, enums, finite numeric values and string arrays are
checked at runtime. Text is bounded to 20,000 characters, arrays to 100 items
(clarifying questions to 20), and array entries to 512 characters.

## API

`POST /api/goals` modes:

- `{ "mode": "propose", "text": "...", "parent_id": "optional-existing-id" }`
  returns a validated, dated proposal with timezone and optional parent metadata.
- `{ "mode": "create_from_proposal", "proposal": { ... }, "parent_id": "optional-existing-id" }`
  confirms the whole plan and returns the created rows with HTTP 201.
- `"mode": "quick"` (used by the dashboard) or omitting mode keeps direct creation
  with `title`, optional `level` (default `task`), and supported create fields.

Malformed input produces HTTP 400 with `code: "INVALID_GOAL"` and a field `path`
when caught by the shared validator. Malformed JSON/unknown mode is also 400;
write failures are 500 and cannot leave a partially inserted proposal. PATCH
rejects unsupported fields, including hierarchy/status edits, and validates all
fields before changing any of them. Existing dedicated status/score routes remain.

## Verification

`src/goals/proposal-validation.test.ts` uses real SQLite for malformed proposals,
all decomposition levels, failed-child rollback, exact dates, timezone validation,
reference anchoring and database reopen. `src/daemon/api-goal-validation.test.ts`
exercises the real API handlers and chat tool with a synthetic model. These tests
do not measure live-model generation quality or change automatic scoring rules.
