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
it applies. `review_needed` codes: `effect_ungoverned` (CODE or a community piece
Authority does not govern), `effect_unreviewable` (an agent, a nested workflow, or
a tool whose per-call gate depends on runtime values) and `constraint_unverified`.
Every other code blocks.

## Checks

| Roadmap check | Rule |
| --- | --- |
| Source access | Every connection and machine the graph binds is available now. Connections are project-scoped and read as metadata only, with the same rules readiness applies. |
| Exact version | The live version's digest equals the pinned one. `versionReadiness` passes. The composition record is `VALIDATED` and the flow's metadata names it. The goal is active at the prepared revision. |
| Required account and target | The bindings shown equal the bindings required, with unchanged revision and availability. A delivery step (send email or message) has a recipient that is not a placeholder. Readiness accepts an empty recipient list; this does not. |
| Authority behavior | Each Authority-checked step is judged as `effect-boundary.ts` judges it for the workflow principal, with the same fold, above-level substitution and mandatory review. A refusal blocks. A parity test runs the real boundary beside the prediction under six Authority configurations, for notify, model, context, governed piece and tool steps, including tools with mandatory review and above-level substitution. |
| Job-constraint fidelity | `review_before_effects`: anything that reaches another person or cannot be undone must ask first; the owner's own notification is exempt. `forbid`: no step reaches the listed categories. `recipients`: literal recipients stay in the list. |
| Preview honesty | The basis is backed by evidence. Every effect is described once. "Asks first" matches Authority. "Completed" needs a succeeded effect record from a successful run proven to be this version. "Simulated" needs the dry sample to have reached that step. |

Verified output proves the version through the run's effect records, which carry
the digest they ran under, or through a `LOCKED` version, which cannot change. A
draft run with no effect records proves nothing, because drafts are edited in place.

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

- **Supported steps:** Jarvis ask, notify, context, tool, regex and validate
  steps, routers and loops, under any trigger. The trigger output comes from the
  fixture.
- **Model replies, tool results and context reads** come from the fixture by step
  name. A step the fixture does not cover fails the run instead of inventing a
  value.
- **Notifications** are recorded and never delivered.
- **Agent delegation, nested workflows and governed piece dispatch** are not
  configured, so the sandbox API refuses them and the step fails closed.
- **Community pieces and CODE** are refused before the engine starts, because
  they reach the network without the sandbox API.
- **Isolation:** the run executes a scratch copy of the version, which is deleted
  afterwards. It never uses the job queue that the daemon's worker drains with
  real services. Runs are serialized.

A sample records the runner, the flow, version and digest, the fixture digest, the
status, the simulated steps and bounded step outputs. Outputs and errors are
captured step output, as trusted as the fixture they came from: show them to a
person, and frame them before a model reads them.

## Limits

- Only typed constraints are checked. Free-text conditions need `unverified`.
- Placeholder recipients are a fixed list: RFC 2606 example and invalid domains,
  `<...>`, `[...]`, and TBD, TODO, FIXME, placeholder and changeme. A recipient
  computed at run time is checked at dispatch.
- A connection's revision excludes its `updated` time so token refreshes do not
  invalidate proposals. Re-authorizing a different account under the same row is
  not detected.
- An Authority rule with a time window can change the fingerprint by time of day.
- A dry run shows that the version executes on the fixture. It does not show that
  the model's real draft is good. The workflow evaluations (Q-01, Q-02) measure
  that.

## Quick verification

```bash
bun test --preload ./src/test-preload.ts src/awareness/prepared-qualification.test.ts
JARVIS_TEST_ENGINE_BUILD=1 bun test --preload ./src/test-preload.ts src/awareness/prepared-dry-run.test.ts
```

Expected: 16 pass, then 4 pass. The first engine run builds the bundle and pieces.
