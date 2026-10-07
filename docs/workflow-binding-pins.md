# Workflow binding pins

A workflow that was right when it was enabled can become wrong later: the
credential behind a connection is replaced, the default computer changes, or a
fact a recipient came from is superseded. Binding pins make that visible
instead of letting the work move to another account, computer or address.

Source: `src/workflows/db/repos/binding-pins.ts` (pins, admission, per-run
connection bindings), `src/workflows/runtime/machine-binding.ts` (the computer a
run uses) and `src/workflows/runtime/fact-bindings.ts` (recipient facts). Tests:
`binding-pins.test.ts`, `workflow-binding-pins.test.ts`,
`fact-bindings.test.ts`, and the Q-05 cases in `native-connections.test.ts`,
`google-source.test.ts` and `manager.test.ts`.

## What is pinned, and when

Publishing or enabling a flow is a person accepting its bindings. At that
moment the flow's `binding_pins` column records, for the version it will run:

- **Each connection the version names**, in `auth` or any other input, the
  trigger included:
  - a saved connection: its row id and its `credential_generation`;
  - a managed one (`jarvis:google`, `jarvis:telegram`): a fingerprint of the
    grant or token the source holds;
  - one that does not resolve when pinned (only the startup pass below pins
    such a flow): `unresolved`, so resolving later is a change like any other.
- **The computer it runs on**:
  - a literal step `target` that names one enrolled computer exactly pins that
    computer;
  - otherwise, the most recently enrolled computer serving the first machine
    step's capability, preferring a connected one, so a laptop asleep at
    publish time is still the one pinned;
  - this computer, only when no enrolled computer serves the capability.

Pins are written again when a person enables or publishes again, or attaches a
version to an enabled flow. Publishing with nothing new to publish publishes
the published version again, so "publish again" works on the dashboard and in
chat. A metadata PATCH writes nothing.

Saving the draft an enabled, unpublished flow runs is an edit, not an
acceptance. The pins it already holds stay, so a credential replaced since the
flow was enabled is still a blocker after any save, and a connection the draft
stops naming keeps its pin in case it is named again. Only a connection no pin
has named yet is pinned as it resolves. The computer stays while it serves the
steps, including a pinned computer that is no longer enrolled, which stays a
blocker. Steps that name a computer pin that one; otherwise a new choice is made
as at startup, never by which computer happens to be connected.

At startup the daemon pins every enabled flow that has none yet, so flows
enabled before this build are protected from then on. Nobody is choosing then,
and computers may not have reconnected yet, so a computer is pinned at startup
only when no guess between enrolled computers is needed: a literal target, the
only enrolled computer serving the steps, or this computer when none does. With
one, runs now wait for it while it sleeps instead of running on this computer,
as they did before this build. With several, the flow stays unpinned to a
computer until a person enables it again.

`credential_generation` counts each time a different credential is stored in a
saved connection through `upsertConnection` (the create and update routes). A
rename, a status change or saving the same credential again does not count.
Jarvis stores no account identity, so a rotated key cannot be told from another
account pasted under the same name: both pause the flow. Re-encryption (key
rotation, credential migration) writes the ciphertext directly and does not
count. Several accounts of the same service are simply several connections
with different names; each step names the one it uses.

## Who accepts a change

On the dashboard, the person enabling or publishing is the acceptance. In chat,
`manage_workflow` `enable` and `publish` need a person's approval card whenever
they would accept a change: the card names each connection whose identity
changed and the computer the flow would move to. Without a change they stay at
the `write_data` floor, as before. The assistant never accepts a change on its
own.

## When a pinned binding changes

| Change | At run admission | During a run |
| --- | --- | --- |
| Credential replaced under the same connection | `BINDING_STALE` blocker | The engine's next fetch is refused |
| Connection deleted and created again | `BINDING_STALE` blocker | Refused |
| Google reconnected (any account) | `BINDING_STALE` blocker | Refused |
| Unresolved when pinned, connected later | `BINDING_STALE` blocker | Refused |
| Google grant revoked | Not ready (`CONNECTION_BINDING`) | The source hands out nothing |
| Connection removed or revoked after the resolver found it | Not ready | Refused |
| Connection renamed, status changed, same credential saved | No change | No change |
| Pinned computer no longer enrolled | `BINDING_STALE` blocker | `WORKFLOW_MACHINE_REPLACED` |
| Pinned computer offline | Admitted | `WORKFLOW_MACHINE_OFFLINE` at dispatch; no other computer takes over |
| A newer computer enrolled | Admitted | The run still uses the pinned computer |

Admission covers every entry: manual and chat runs, schedules, webhooks,
events, polling, child workflows, work items and evaluation. A refused trigger
fire is recorded as a failed run with the reason, as other readiness refusals
are. To accept the change, a person checks the connection or computer, then
enables or publishes the workflow again.

## A run keeps the identity it started with

The engine asks the daemon for a connection's credential at every step, retry
and resumed approval. The first fetch in a run records the identity it handed
out (`workflow_run_connection_binding`), checked against the flow's pins. Every
later fetch must resolve to the same identity; otherwise the daemon refuses
with 409 and records why on the run. A connection removed or revoked after the
resolver found it is refused the same way rather than handed out unbound.
Re-enabling the flow accepts a change for later runs, never for a run already
under way.

The engine reports any refused fetch as a bare loading error, so the reason is
shown where people look: `GET /api/workflow-runs/:runId` (`connectionBindings`:
the connection, its kind and any refusal, never a grant's fingerprint) and
`manage_workflow get_run` (`bindingRefusals`). Run lists and status updates
leave the bindings out.

## Recipient facts

Workflows never read facts as data, so a value carries no fact id. A governed
action that sends to or addresses people (a send, a draft, a calendar invite,
a share) matches each recipient email address against memory's `email` and
`primary_email` facts, ignoring case, when its effect is recorded, and keeps the
matching fact ids on the record (`bindings.facts`, outside the request digest
and the target). Addresses are read from bare values, `Name <address>` forms and
comma or semicolon lists. Before any approval, before dispatch, and before the
engine's own retry hands the authorization out again, those facts must still
hold:

- none current (superseded, expired, or deleted after the effect was
  recorded): `WORKFLOW_FACT_STALE`;
- every current one contested: `WORKFLOW_FACT_AMBIGUOUS`.

The effect is recorded as blocked with that outcome and audited as denied. Its
arguments stay frozen, so it never switches to the address memory holds now; a
person updates the workflow or the fact and starts a new run. When the engine's
retry of an authorization that already succeeded is refused, the effect stays
succeeded and keeps the refusal as `replayRefusal`. An address memory does not
know is not checked, and reads are never blocked.

## Limits

- The dashboard does not show readiness issues yet. A paused workflow shows as
  failed runs with the reason, and in chat (`run`, `get_run`); nothing notifies
  anyone when a binding goes stale.
- A flow that picks its target computer from run data, names a computer by a
  partial name or not at all yet, or uses only agents, is not pinned to a
  computer; its runs choose one as before.
- Pins belong to the version a person enabled (publishing enables). A run of a
  flow never enabled, or of another version such as a draft test run, binds
  connections per run only.
- Facts are matched by value, so only email addresses memory already holds are
  checked, and only on governed actions. A fact deleted before the effect is
  recorded leaves nothing to match.
- A Google refresh-token rotation by Google itself also changes the grant
  fingerprint and pauses the flow until it is enabled again.

## Rollback

Revert the commits. The new columns and table are additive and ignored by
older builds; pins and run bindings then have no effect. Flows keep running as
they did before, including falling back to this computer when their only
capable computer is asleep.
