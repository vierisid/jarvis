# Workflow job contract

Structural validation proves a composed graph can run. It does not prove the
graph does the job that was asked for. A job contract states the parts of the
job that can be checked, and the composer holds every candidate graph to it.

Source: `src/actions/tools/job-contract.ts`. Tests:
`src/actions/tools/job-contract.test.ts` (the check) and
`src/actions/tools/workflow-contract.test.ts` (the composer, the journal and
`manage_workflow`).

## Who writes it

The caller, explicitly. `manage_workflow compose` (and `create` with a
description, which reroutes to compose) takes an optional `contract` beside
`name` and `description`. The chat model fills it with what the user actually
said; nothing derives a contract from free text, and the description is never
rewritten. Without a contract, or with `contract: null`, composition behaves
exactly as before. Opportunity composition passes none.

```json
{
  "trigger": { "kind": "schedule", "cron": "0 9 * * 1", "timezone": "Europe/Rome" },
  "sources": [{ "tool": "read_file", "params": { "path": "/Users/me/invoices.csv" } }],
  "outputs": [
    { "piece": "gmail", "action": "gmail_create_draft", "target": { "receiver": ["ana@example.com"] } },
    { "notify": { "channels": ["dashboard"] } }
  ],
  "recipients": ["ana@example.com", "dashboard"],
  "forbidden": { "effects": ["send_email"] },
  "review": ["The reminder names the overdue invoices."]
}
```

| Field | Meaning |
| --- | --- |
| `trigger` | `kind` is `manual`, `schedule`, `webhook`, `event` (a Jarvis event, with `eventType`) or `piece` (a service's own trigger, with `piece` and optional `trigger`). A schedule may state an exact `cron`, a cadence `every` (`hour`, `day`, `week` or `month`, for "weekly" without a day or time), and a `timezone`. |
| `sources` | What the job must read: `{tool, params}` or `{piece, action, target}`, read by a step or by the trigger. |
| `outputs` | What the job must produce: the same shapes plus `{notify: {channels}}`. With outputs, everything the flow sends or addresses must be one of them. |
| `recipients` | The only addresses, channels and ids the flow may send to or address. |
| `forbidden` | `effects` (Authority categories such as `send_email`, `delete_data`), `pieces`, `actions`, `tools`, `channels`, `agents`. |
| `review` | Requirements no check can verify, for a person to confirm. |

A piece is named by npm name or short name (`@activepieces/piece-gmail`,
`gmail`). Values in `params` and `target` compare the same way on both sides: a
single value is a list of one, and numbers match their text, so
`receiver: "ana@example.com"` matches `["ana@example.com"]`. Otherwise values
must match exactly, so `Ana@Example.com` and `ana@example.com` differ.

## Refused before composing

The contract is validated before any provider request. Unknown fields, empty or
oversized values (20 items, 500 characters), unknown effects, trigger kinds or
cadences, and `auto` as a notification channel are refused as
`Invalid job contract: ...`.

A contract no graph can keep is refused as `Job contract cannot be met: ...`,
judging each required step by the same rules the check applies to a graph:

- it requires a step, tool, piece, action, channel or agent it also forbids;
- it requires a step whose effect it forbids (`gmail send_email` with
  `send_email` forbidden);
- it requires an output whose effects are decided when it runs while forbidding
  something that output could reach (an agent with a forbidden tool);
- it requires an output addressed to someone `recipients` excludes or
  `forbidden.channels` names;
- it requires reading from a step that does not read (`write_file`);
- it limits recipients and requires a send that cannot state its recipient
  (`gmail_send_draft`);
- its cron does not run at its stated cadence;
- it names a time zone other than the one schedules run in. Every schedule runs
  in Jarvis's configured time zone (`src/lib/cron-scheduler.ts`), so a flow
  cannot carry its own.

## The check and the repair loop

Every candidate, on the tool loop (`submit_flow` and inline JSON) and the
one-shot path, is checked after structural validation, through one
`acceptComposedFlow` that forwards every validation argument. Each departure
becomes a focused error prefixed `job contract:` that names the step and the
value, for example
`job contract: step "draft" has receiver bob@example.com; the job asks for ana@example.com`.
These errors go back through the existing bounded repair loop. Every repair
prompt still carries the job specification, which includes the contract, and
every repaired candidate is checked against the same contract. A repair cannot
drop a requirement and pass.

A provider failure is never turned into an abstention: it stays a failure with
its `errorCode`, also after a contract violation. The model abstains only by
calling `report_blocked`.

## Who a step reaches

A step reaches people when it sends (a notification, or a governed action in a
send category) or when a write addresses them: a calendar event's attendees, a
Drive share's user, a draft's receiver, a file posted to a channel. Recipients
are read from the step's inputs (`receiver`, `to`, `cc`, `bcc`, `channel`,
`channel_id`, `user`, `userId`, `user_id`, `users`, `recipients`, `email`,
`user_email`, `chat_id`, `attendees`, `attendee_email`). A draft reaches no one
until someone sends it, but it is addressed, so it is checked like a send.

## What it rejects

- **Trigger:** a different kind, cron, cadence, event, piece or trigger name.
- **Sources and outputs:** a missing source or output, or the nearest step with
  a wrong stated value. A source must be read by a step that reads, or by the
  trigger.
- **Unwanted reach:** with outputs, a send or an addressed write no output
  names, including a notification to an extra channel and a second draft to
  someone else, also inside router branches and loops.
- **Destinations the job constrains:** with `recipients`, a step that sends to
  or addresses anyone else (cc and bcc included), a recipient decided at run
  time, or a send that does not state its recipient. With outputs, a
  notification whose channels are decided at run time, including "the connected
  channels". A destination the job does not constrain is not checked, and the
  report does not claim it: replying to whoever wrote is a valid job.
- **Forbidden:** a step whose effect is forbidden, one of the forbidden pieces,
  actions, tools, channels or agents, and a trigger on a forbidden piece.
- **Unresolved tool:** a tool chosen at run time, whenever the contract states
  outputs, recipients or anything forbidden.

## Steps whose effects are known

| Step | Effect for the check |
| --- | --- |
| Trigger | Reads |
| Notify | `send_message` to its stated channels |
| Ask, context, regex, validate | `read_data` |
| Bounded tool (`effect-capabilities.ts`) | Its `TOOL_ACTION_MAP` category |
| Governed piece action (`piece-effects.ts`) | The adapter's category for that action |
| Agent, run another workflow, any other tool | Open: decided when it runs |
| Ungoverned piece, a governed `custom_api_call` or `rawGraphqlQuery`, an unmapped action | Open, acting only through its own service |

An open step blocks when the job forbids something it could reach. A step
acting only through its own service can reach any effect and address there, but
no Jarvis tool, agent or other piece; agents, other workflows and other tools
can reach everything. Otherwise, with outputs or recipients, an open step
becomes a review item, for example
`confirm step "research" sends nothing the job did not ask for and reaches only ana@example.com, dashboard: it delegates to an agent, which chooses its own tools when it runs`,
and the report withholds the claims it could break. Only an output that pins an
open step's action and values (`{piece, action, target}` or `{tool, params}`)
counts as asking for what it sends; naming a piece as a source does not vouch
for its other actions.

## The report

A passing composition returns `contractReport: { verified, review }`, first in
the `manage_workflow` result so the result's length cap never cuts it.
`verified` lists only what the check proved, such as
`reaches only ana@example.com, dashboard`. `review` holds the caller's items and
one per open step.

The report is not stored. The journal keeps the contract as the caller gave it,
and `manage_workflow publish` and `enable` recheck the graph about to run (the
draft being published, or the published version being enabled) and return
`contractReport` with `violations`, also after the draft was edited. Like the OS
warnings, it is advisory: nothing refuses a publish or an enable on it, and the
dashboard's enable path does not show it yet.

## Limits

- It checks stated structure, not arbitrary language. Tone, content and
  anything else only a person can judge go in `review`.
- Connection credentials stay deferred to activation, which already refuses to
  run without them.
- A bounded tool counts at its mapped category. Authority can raise a single
  call when it runs (a `write_file` to a shell startup file is
  `execute_command`); the check does not predict that raise.
- A router branch may not run. An output is produced when a step produces it,
  conditional or not.
- Evaluation task specifications can carry a contract; no shipped task set does
  yet.

## Rollback

Callers stop passing `contract`, or the change is reverted. There is no schema
or data change: the contract is an optional field of the journaled
specification, which older binaries ignore.
