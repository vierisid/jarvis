# ON-B-09: compose and save a disabled draft

Default-off `compose-draft.v1`, `requires: []`. The factory is inert; B11 owns
binding and release gating. Composition is an internal B08 operation, with no
HTTP command or automatic daemon registration. B08 owns jobs, worker claims,
revisions and cancellation; B10 owns the public exact-artifact reader. This
module imports no optional onboarding sibling.

## Binding and input

Explicitly provision `initializeComposeDraftStore(db)` on the selected workflow
database, then retain one `createSqliteDraftStore(db)` per binding. Supply live
`authorize`, immutable `servicesFor` generations, draft-creation `access`, a
read-only B07-compatible `validate`, authorized canonical `resolveContext`,
and `composer()` returning the actual configured model/catalog/tool schemas,
roles and Q policy. Missing services have no production fixture fallback.
The store refuses writes after the global workflow database changes.

Call `compose(context, { schemaVersion: 1, intentId, submission }, control)`.
`submission` is the exact B07 Create request and answers. Inputs are bounded,
snapshotted and checked; actor/project never come from the request. The live
validator must reproduce the expected intent, scope, body digest and disabled
creation policy before model work and again before saving. Canonical readers
must return only authorized bounded data for those exact reference revisions,
never credentials, arbitrary URL fetches, tool execution or inferred selections.
Changes during context reads or model work require fresh intent validation.

`control.mayCommit()` is mandatory and synchronous. B08 must check its durable
worker ownership and cancellation state in the **same SQLite database**. B09
calls it within the immediate save transaction, before and after repository
writes. An HTTP disconnect alone must not cancel a durable job: B08 supplies its
worker signal and owns the final cancellation/recovery decision. No transaction
is held while awaiting model, authorization or reference services.

## Model admission (Q-20)

B09 sets no LLM origin or admission class; model calls inherit the caller's.
With the production `createComposerLlmClient`, a call with no origin runs as
`background` and passes the shared background admission budget. That is the
expected path for a detached B08 worker and for any retry after a restart. A
`background_throttled` refusal fails that composition (journal `FAILED`, result
`composition_failed`) before any save: the receipt stays `pending` and B08
decides when to retry. Only a binding
that runs the attempt for a person waiting on it may mark it foreground, as
F-07's Brief composition does (`runWithAdmission('foreground', () =>
runWithOrigin('user', ...))`); it must not grant an exempt class.

## Composition compatibility patch

The existing `composePersistedFlow` remains the only planner and validator.
B09 uses main's (F-07) optional `projectId` and `onJournal` parameters: the
synchronous association hook runs in the journal's creation transaction before
the first model call, so a failed association leaves no journal and no model
work. `ComposeRequest.context` retains clarification answers, qualifications
and canonical selected data beside the exact original `description`. It uses
the existing Q-line untrusted context framing and is snapshotted in the journal
and repair prompts. Neither optional field changes prompt policy, validators,
tool access, activation, or execution. Future F07 ingredient integration must
preserve these semantics and its own authorized ingredient resolver.

## Persistence and recovery

An additive receipt is keyed by actor/project/request ID and binds the exact
versioned body digest. Reusing the key with different wording, references or
answers conflicts. Object key order is immaterial. The original wording and
supplemental data are retained in the real composition journal.

The flow, exact draft version and committed receipt are saved atomically using
the existing repositories. Flows are explicitly DISABLED, unpublished, and have
no engine schedule/listeners or execution. A unique flow external ID adds a
second persistence guard. Competing attempts converge on one committed artifact.
B08 serializes model work: without its worker claim, concurrent internal callers
can produce multiple journals, but only one flow/version. This is not a second
job scheduler or lease system.

`reconcile(context, input)` checks current authorization and the durable receipt
without calling the model or requiring unchanged intent/reference revisions.
It returns `absent`, `pending`, or the exact `saved` artifact and its current
readiness. A committed artifact wins over a late cancellation or lost response.
A crash before the atomic save may leave a journal and pending receipt; an
authorized B08 retry can compose again, never creating a second saved draft.
Pending does **not** prove a live worker has stopped: B08 must fence it before
confirming cancellation/no draft. Deleted/mismatched artifacts are unavailable
and are never recreated automatically. Receipt rows deliberately survive flow
deletion. Keep them and the journals during rollback.

Success includes real `flowId`, `versionId`, `compositionRecordId`, scoped request
identity, qualifications, current flow/version states and current readiness.
`compositionValidated` records historical journal acceptance by the composer; it
does not certify later edits to that version, runnable readiness, or semantic
fidelity. Missing/stale connections can leave an
inspectable disabled draft with readiness issues. Replay recomputes readiness
and reports any later enabled/locked state truthfully. No publish, enable, test,
run, send, desktop action, tool grant or goal link is available on this path.

The workflow-data reader inventory in `untrusted-reach.test.ts` records this
store's boundary. Results project identity, state, qualifications and bounded
readiness, never whole versions, captured sample outputs/inputs or journal
payloads. Recovery does not send stored data to a model. Readiness can quote
graph text and qualifications are supplied data: any future model consumer must
frame them at its prompt boundary. Regression tests seed hostile stored payloads
and verify both replay and reconciliation preserve this projection.

## Verification and rollout

`bun test src/onboarding-next/compose-draft src/actions/tools/persisted-workflow-composer.test.ts`
exercises recorded editable meeting, weekly investor update and competitor
examples through the real composer/journal/repositories/readiness. It covers
bad output, missing context, stale bindings, save rollback, cancellation,
concurrent saves, restart, lost response, scope changes and zero workflow runs.
Optional integration runs the actual B07 validator when present; its semantic
assessment/reference services and the model remain deterministic doubles.
B11 discovery/removal is exercised without exposing internal compose as HTTP.

There is no visual redesign: the existing result checkpoint `2410205462365531104`,
Figma node `1097:48233`, remains the UI reference. Live model/native/provider
evidence and full candidate release approval remain separate prerequisites.
Enable only with B11, B08 and verified current Q safeguards. Rollback disables
or omits this provider/binding and regenerates the catalog; retain all receipts,
journals and created drafts. Legacy handlers are unchanged.
