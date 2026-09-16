# A2: honest desktop action outcomes

## Scope and base

Branch `fix/desktop-action-outcomes` starts from pulled main `07fecdc8`.
The existing Authority boundary, cancellation fences and workflow approvals
remain in force. No additional tool capability is enabled by this change.

The nine desktop tools now throw a typed failure instead of returning an
ordinary `Error: ...` value. The tool registry preserves that type. Remote
handler errors retain their protocol code; disconnects and timeouts are not
classified by matching human-readable error text. Other legacy callers of
`routeToSidecar` retain their existing text interface.

## Shared contract for W7 and subsequent adapters

`src/actions/action-outcome.ts` defines the shared serializable outcome and
required-success assertion:

| Status | Meaning |
| --- | --- |
| `succeeded` | The adapter returned normally. This is not independent verification of a business outcome. |
| `blocked` | A known prerequisite prevented the requested action, such as an offline machine or disabled capability. |
| `error` | The remote handler or a structured negative receipt reports failure. Partial effects may still have occurred. |
| `unknown` | Completion cannot be established, including detached RPCs and lost connections. Reconcile before deciding on another attempt. |

Failures also carry `code`, `message` and `effect`, with `effect` equal to
`not_started` or `may_have_occurred`. Only known pre-dispatch failures claim
`not_started`. Missing local elements and unsupported local actions are
blocked; unclassified local controller exceptions remain unknown.

Classification does not inspect arbitrary returned text for `Error:`. A
window title can legitimately contain that text. Native sidecar negative
receipts (`success: false`) and unverified launch windows are handled as
failure/uncertainty without claiming that the process was never started.

## API and graph behavior

`POST /v1/jarvis/tools/invoke` accepts:

```json
{
  "toolName": "desktop_list_windows",
  "params": { "target": "desktop-1" },
  "requireSuccess": true
}
```

`requireSuccess` defaults to true and must be a boolean when supplied. A
required offline call returns HTTP 409 with:

```json
{
  "toolName": "desktop_list_windows",
  "result": null,
  "outcome": {
    "status": "blocked",
    "code": "SIDECAR_OFFLINE",
    "message": "Error: Sidecar is offline.",
    "effect": "not_started"
  }
}
```

Required errors use 422 and unknown outcomes use 502. Pending approval uses
202 with the existing approval IDs, before any action-outcome assertion.
The piece also asserts the typed outcome independently of HTTP status:
HTTP 200 alone cannot satisfy a required action. Missing/malformed outcome
envelopes fail closed.

For an intentional availability probe, set `requireSuccess: false` and route
on `{{probe.outcome.status}}` or its stable code. The API returns HTTP 200
with the unchanged failure outcome, allowing a router to choose an offline
fallback. This acknowledges a handled probe, not a successful desktop action.
The receipt remains blocked/error/unknown. Authority denial, emergency state,
cancellation, approval requirements and unsupported-capability refusals still
apply. Existing explicit engine failure-handling settings remain explicit
graph policy; this change does not prohibit them.

`requireSuccess` changes receipt handling, not the dispatched operation.
It is excluded from the effect request digest, so a pending approval created
by an older piece can resume when the new piece sends the default explicitly.
Tool name, arguments, workflow version, target and run/step identity retain
their existing validation.

## Durability and recovery limits

The existing workflow effect record stores the typed outcome alongside its
run, version, step, target, reviewed arguments and Authority decision. It uses
`blocked`, `failed` (for outcome `error`), or `unknown`, rather than `succeeded`.
These are terminal receipts. Repeating an invocation, including after the
database is reopened, returns the same failure without dispatching again.
Reconnecting the machine does not silently replay a previously blocked action.
No database migration is necessary: status is text and the receipt is JSON.

This is not automatic reconciliation, a universal UI-success assertion, or a
retroactive repair of historical text-only success receipts. Late detached
completions still require reconciliation. A new run requires an explicit
decision, especially where an effect may already have occurred. Non-desktop
tools have not all adopted typed failures; their normal returns retain the
existing adapter contract. W7 and further effect adapters should reuse this
outcome vocabulary and qualify their own completion evidence.

## Open PR interactions

Open PRs were inspected before implementation: #477 (version ownership),
#476 (native lookup), #475 (small-model interface), #473 (credential
encryption), #381 (command deck/wake), and #280 (project docs).
No unmerged fix was needed. #475 edits desktop action parameter schemas and
registry parameter metadata; preserve those additions alongside these outcome
imports and error propagation. #381 also touches the sidecar manager; retain
its wake work alongside typed RPC error construction.

## Validation

- An isolated unchanged-main worktree reproduced the original defect through
  the real engine and outer worker: the required offline workflow reached
  `SUCCEEDED`. The new integration/compiled-piece cases produced 17 failures
  on main, including HTTP-200 failures being accepted and missing outcomes.
- Branch tests cover all nine offline desktop routes, disabled/unavailable
  capabilities, remote error codes, uncertain dispatch, local missing
  elements, result compatibility, required HTTP status, explicit probes,
  durable restart/replay, Authority/emergency refusal and approval handling.
- Real engine tests prove the required call stops downstream execution and
  an explicit probe selects the offline router branch. Existing worker
  approval pause/resume and cancellation tests remain part of validation.
- Passed 329 tests across 12 relevant files, followed by 83 final outcome and
  Authority tests. TypeScript, daemon build, EE import guard, migration guard,
  template lint and package-content checks passed (Bun packer).
  Full-repository testing is not claimed; its aggregate pre-commit test command
  has an existing timeout/hang limitation. The local commit uses a per-command
  hook override after these explicit checks.
