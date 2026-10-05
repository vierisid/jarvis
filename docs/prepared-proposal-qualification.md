# Prepared proposal qualification (Q-13)

A prepared proposal may say Ready only when its exact workflow version can do
what the proposal promises, with the accounts and machines it needs, under the
Authority behavior the preview describes. `src/awareness/prepared-qualification.ts`
decides that. F-01's `preparedOpportunities` provider (F-09) must hold a current
`ready` qualification before it returns `ready`.

The validator reads live state and returns a verdict. It never composes,
publishes, enables or runs the proposal's workflow, and it persists nothing.
F-09 stores the qualification beside its snapshot. The opportunity hypothesis's
own `feasibility` field is left as it is.

## Use

```ts
const services = liveQualificationServices({ authority, tool, targets, credentials });
const qualification = qualifyPreparedProposal(request, services);
const { current, stale } = recheckQualification(qualification, request, services);
const readiness = briefReadiness(current, stale); // F-01 readiness
```

`targets` is the sidecar inventory, with each machine's unavailable capabilities.
When F-09 prepares a proposal it:

- pins `workflow.versionDigest` to `versionDigest(version.trigger)`, the identity
  the effect boundary records for every effect;
- shows the bindings `briefBindings(requiredBindings(...))` returns;
- uses `JOB_CONSTRAINTS[kind]` for opportunity jobs, and adds an `unverified`
  constraint for anything the user stated that no typed constraint captures;
- runs `PreparedDryRunner` when `drySupport(trigger)` returns null, and passes the
  sample;
- describes every effect step in `preview.effects`, and no other step.

## Verdicts

| Verdict | Meaning | F-01 readiness |
| --- | --- | --- |
| `ready` | Every check passed for this exact snapshot. | `ready` |
| `blocked` | Something must change first. | `blocked` |
| `review_needed` | Nothing here is wrong, but something this cannot verify needs a person. | `blocked` |
| (recheck `stale: true`) | The fingerprint changed since the earlier result. | `stale` |

Each reason has a code, a severity and a one-line message, plus a step name when
it applies. These codes need review:

- `effect_ungoverned`: CODE, or a piece Authority does not govern.
- `effect_unreviewable`: something decided only at run time. That covers an agent,
  a nested workflow, or a tool chosen at run time. It covers tool parameters, a
  machine or a gated value computed at run time. It covers a delivery whose
  recipients are not modeled, and an Authority rule with a time window.
- `constraint_unverified`: a stated constraint, a recipient chosen at run time
  under a `recipients` constraint, or a shared write that runs unasked.

Every other code blocks. `authority_denied` is an Authority refusal.
`effect_unavailable` is a tool or capability the boundary refuses before
Authority is asked.

## Checks

| Roadmap check | Rule |
| --- | --- |
| Source access | Every connection and machine the graph binds is available now. Connections are project-scoped and read as metadata only, with the same rules readiness applies. A machine is found as dispatch finds it: enrolled sidecars only, by id, then name, then a unique partial name, ignoring case. It must offer the capability the tool needs. |
| Exact version | The live version's digest equals the pinned one. `versionReadiness` passes. The composition record is `VALIDATED` and the flow's metadata names it. The goal is active at the prepared revision. |
| Required account and target | The bindings shown equal the bindings required, with unchanged revision and availability. A delivery has a real recipient, read per action from its manifest props. A reply, a saved draft or an edit is addressed by the message it continues; a forward is not. A gist has no recipient. Readiness accepts an empty recipient list; this does not. A test keeps the recipient table in step with the verified adapters. |
| Authority behavior | Each Authority-checked step is judged as `effect-boundary.ts` judges it for the workflow principal: the same fold, above-level substitution and mandatory review. Tool params given as JSON text are parsed as readiness and the engine parse them. A refusal blocks. A parity test runs the real boundary beside the prediction under six Authority configurations. It covers notify, model, context, governed piece and tool steps, including tools with mandatory review, above-level substitution and params as JSON text. |
| Job-constraint fidelity | `review_before_effects` blocks a send, deletion, payment, settings change, command, browser action or ungoverned step that would run without asking. The owner's own notification is exempt. A third-party write that runs unasked needs review: it may reach whoever shares that space, unless it stays with the user (mailbox drafts, labels and archive, or a model provider). `forbid` checks every category a step reaches, not only its worst. `recipients` keeps literal recipients in the list. |
| Preview honesty | The basis is backed by evidence. Every effect is described once. "Asks first" matches Authority. "Completed" needs a succeeded effect record and the step's own SUCCEEDED status from a full run proven to be this version. "Simulated" needs the dry sample to have reached that step. |

Verified output must come from a full run, not a single-step test. The run's
effect records carry the digest they ran under, and one that differs disproves the
run even on a `LOCKED` version, because publishing locks the draft in place.
Without records, only a `LOCKED` version unchanged since the run started proves
it. A governed piece's effect record means dispatch was authorized; the step's
own status says whether the call then completed.

## Fingerprint and recheck

`snapshot.fingerprint` is the SHA-256 of canonical JSON over the qualifier
version, the request and the observed facts. The verdict is a pure function of
that same input, so an equal fingerprint means an identical result.

Changes that make an earlier result stale include:

- an edit to the graph;
- a connection or machine that changes identity or availability;
- an Authority decision that changes;
- a goal revision or status change;
- a composition record change;
- a readiness report change;
- a change to the preview or the sample.

Editor sample data and OAuth token refreshes do not change it.

## Dry runner

`PreparedDryRunner` runs the exact version once in the real engine, on a fixture,
with every service it can reach simulated:

- **Supported steps:** Jarvis ask, notify, context, tool and regex steps,
  routers and loops, under any trigger. The trigger output comes from the
  fixture.
- **Model replies, tool results and context reads** come from the fixture by step
  name. A step the fixture does not cover fails the run instead of inventing a
  value.
- **Notifications** are recorded and never delivered. They answer as a
  successful delivery, so later steps take the path they would take in
  production.
- **Agent delegation, nested workflows and governed piece dispatch** are not
  configured, so the sandbox API refuses them and the step fails closed.
- **Credentials:** no connection resolves, so a stored credential never reaches
  a step; a step that references one fails.
- **Community pieces, CODE and the validate fixture piece** are refused before the
  engine starts. Community pieces and CODE reach the network without the sandbox
  API; the validate piece reads a credential and the piece store.
- **Isolation:** the run executes a scratch copy of the version. The copy is
  deleted afterwards with its run and the run's log file. It never uses the job
  queue that the daemon's worker drains with real services. Runs are serialized.

A sample records the runner, the flow, version and digest, the fixture digest, the
status, the simulated steps and bounded step outputs. A step in a loop keeps its
last iteration's output. Outputs and errors are captured step output, as trusted
as the fixture they came from: show them to a person, and frame them before a
model reads them.

## Limits

- Only typed constraints are checked. Free-text conditions need `unverified`.
- Placeholder recipients are whole values from a fixed list: RFC 2606 example and
  invalid domains, `<...>`, `[...]`, `{...}`, and TBD, TODO, FIXME, placeholder,
  changeme and xxx. A recipient computed at run time is checked at dispatch.
- A delivery action outside the verified adapters, or a tool that sends, has no
  recipient model and needs review.
- A tool step with no machine named binds none. The runtime routes it to a
  capable machine at dispatch, and that choice is not part of the proposal.
- A connection's revision excludes its `updated` time so token refreshes do not
  invalidate proposals. Re-authorizing a different account under the same row is
  not detected.
- A dry run shows that the version executes on the fixture. It does not show that
  the model's real draft is good. The workflow evaluations (Q-01, Q-02) measure
  that.

## Quick verification

```bash
bun test --preload ./src/test-preload.ts src/awareness/prepared-qualification.test.ts src/awareness/prepared-dry-run.test.ts
```

Expected: 30 pass. The dry-run tests always use the real engine; the first run
builds the bundle and pieces, and later runs reuse them.
