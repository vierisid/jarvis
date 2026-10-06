# Workflow job contract

Structural validation proves a composed graph can run. It does not prove the
graph does the job that was asked for. A job contract states the parts of the
job that can be checked, and the composer holds every candidate graph to it.

Source: `src/actions/tools/job-contract.ts`. Tests:
`src/actions/tools/job-contract.test.ts` (the check) and
`src/actions/tools/workflow-contract.test.ts` (the composer, the journal and
`manage_workflow`).

## Who writes it

The caller, explicitly. `manage_workflow compose` takes an optional `contract`
beside `name` and `description`. The chat model fills it with what the user
actually said; nothing derives a contract from free text, and the description is
never rewritten. Without a contract, composition behaves exactly as before.
Opportunity composition passes none.

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
| `trigger` | `kind` is `manual`, `schedule`, `webhook`, `event` (a Jarvis event, with `eventType`) or `piece` (a service's own trigger, with `piece` and optional `trigger`). A schedule may state `cron` and `timezone`. |
| `sources` | Steps the job must read from: `{tool, params}` or `{piece, action, target}`. |
| `outputs` | Steps the job must produce: the same shapes plus `{notify: {channels}}`. With outputs, every message the flow sends must be one of them. |
| `recipients` | The only addresses, channels and ids a message may reach. |
| `forbidden` | `effects` (Authority categories such as `send_email`, `delete_data`), `pieces`, `actions`, `tools`, `channels`, `agents`. |
| `review` | Requirements no check can verify. A person confirms them before enabling the flow. |

Values in `params` and `target` are literal and compared exactly. A piece is
named by catalog id, npm name or short name (`gmail`, `@activepieces/piece-gmail`).

## Refused before composing

The contract is validated before any provider request. Unknown fields, empty or
oversized values (20 items, 500 characters) and unknown effects are refused as
`Invalid job contract: ...`. A contract that can never be met is refused as
`Job contract cannot be met: ...`: it requires a step it forbids, notifies a
channel its recipients exclude, or names a time zone other than the one
schedules run in. Every schedule runs in Jarvis's configured time zone
(`src/lib/cron-scheduler.ts`), so a flow cannot carry its own.

## The check and the repair loop

Every candidate, on the tool loop and the one-shot path, is checked after
structural validation. Each departure becomes a focused error prefixed
`job contract:` that names the step and the value, for example
`job contract: step "draft" has receiver bob@example.com; the job asks for ana@example.com`.
These errors go back through the existing bounded repair loop. Every repair
prompt still carries the job specification, which now includes the contract,
and every repaired candidate is checked against the same contract. A repair
cannot drop a requirement and pass.

Only an explicit `report_blocked` is an abstention. A provider failure after a
violation stays a failure with its `errorCode`.

## What it rejects

- **Trigger:** a different kind, cron, event type, piece or trigger name.
- **Sources and outputs:** a missing step, or the nearest step with a wrong
  stated value.
- **Unwanted sends:** with outputs, a send no output names, and a notification
  to a channel no output names. Router branches and loop bodies are included.
- **Destinations:** with outputs or recipients, a send whose recipient is
  missing or computed at run time, or a notification to "the connected
  channels". With recipients, a send to anyone else, including cc and bcc.
- **Forbidden:** a step whose effect is forbidden, or one of the forbidden
  pieces, actions, tools, channels or an agent.
- **Unresolved tool:** a tool chosen at run time, whenever the contract states
  outputs, recipients or anything forbidden.

A draft is `write_data`: it reaches no one until someone sends it, so its
receiver is checked through the output's `target`, not `recipients`.

## Steps whose effects are known

| Step | Effect for the check |
| --- | --- |
| Notify | `send_message` to its stated channels |
| Ask, context, regex, validate | `read_data` |
| Bounded tool (`effect-capabilities.ts`) | Its `TOOL_ACTION_MAP` category |
| Governed piece action (`piece-effects.ts`) | The adapter's category for that action |
| Agent, run another workflow, other tool, ungoverned piece | Open: decided when it runs |

An open step is a blocker when the job forbids any effect, because it cannot
be shown to avoid it. Otherwise, with outputs or recipients, it becomes a
review item, for example
`confirm step "research" sends nothing the job did not ask for and reaches only ana@example.com, dashboard: it delegates to an agent, which chooses its own tools when it runs`.
A step the job names as a source or output is asked for; who it reaches is
still for a person to confirm.

## The report

A passing composition returns `contract: { verified, review }`. `verified`
lists only what the check proved, such as `messages reach only ana@example.com, dashboard`.
It never claims what an open step might do. `review` holds the caller's items
and one per open step. `manage_workflow compose` returns the report with the
disabled draft, so the user sees it before enabling. The journal row keeps the
contract as given, so the report can be recomputed from the flow's graph.

## Limits

- It checks stated structure, not arbitrary language. Tone, content and
  anything else only a person can judge go in `review`.
- Connection credentials stay deferred to activation, which already refuses to
  run without them.
- A bounded tool counts at its mapped category. Authority can raise a single
  call when it runs (a `write_file` to a shell startup file is
  `execute_command`); the check does not predict that raise.
- Values are compared exactly, so `Ana@Example.com` and `ana@example.com`
  differ.
- Evaluation task specifications can carry a contract; no shipped task set does
  yet.

## Rollback

Callers stop passing `contract`, or the change is reverted. There is no schema
or data change: the contract is an optional field of the journaled
specification, which older binaries ignore.
