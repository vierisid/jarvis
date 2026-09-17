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
window title can legitimately contain that text. A native negative receipt
(`success: false`) is a failure the handler reported about itself, and the
whole reply travels in the message so the pid and the handler's own note are
not lost.

`window_visible: null` is deliberately NOT a failure. The sidecar sets it
beside `success: true` for "the process is alive and I could not look for its
window" -- a Wayland session, a box without xdotool, an unprompted Mac -- and
`launchResultLinux` / `launchResultDarwin` exist to stop that being reported
as failure, because a model told the launch failed launches the app again.
That reply is returned as data, note included.

A typed failure is still a tool result. On the daemon's own tool paths the
message is capped and framed with the same untrusted-content wrapper, and
taints the turn the same way, as the text did when it was returned rather
than thrown: an outside-content tool's failure text can carry a sidecar's own
error string, so moving to typed failures must not quietly hand the model
unframed content.

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

`requireSuccess` changes receipt handling, not the dispatched operation. It
is read in the route and never passed to the service function, so it cannot
reach the effect record or its request digest: a pending approval created by
an older piece resumes when the new piece sends the default explicitly.
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

Terminality itself is not new: any non-`pending` effect already refused replay
before this change, and the CAS dispatch fence plus the re-`checkpoint()`
immediately before dispatch are untouched. What is new is that the receipt is
legible -- a caller learns `blocked` versus `error` versus `unknown` and a
stable code instead of a prose string, and a failure can no longer arrive
shaped like a successful result.

The record remains a dispatch AUTHORIZATION, not a completion receipt. A
`succeeded` status still means only that the adapter returned; `outcome` is
written on the failure path alone, and `{ status: 'succeeded' }` is synthesized
at the route rather than stored. A daemon that dies between the claim and a
reply leaves `dispatching`, which still blocks automatic replay and still
requires a human decision.

This is not automatic reconciliation, a universal UI-success assertion, or a
retroactive repair of historical text-only success receipts. Late detached
completions still require reconciliation. A new run requires an explicit
decision, especially where an effect may already have occurred. Non-desktop
tools have not all adopted typed failures; their normal returns retain the
existing adapter contract. W7 and further effect adapters should reuse this
outcome vocabulary and qualify their own completion evidence.

## Validation

- An unchanged-main checkout reproduces the defect through the real engine and
  outer worker: the required offline workflow reaches `SUCCEEDED` and its
  effect record stores the offline text as a successful result.
- `src/workflows/runtime/desktop-outcomes.test.ts` covers the API statuses,
  the durable receipt across a database reopen, a reconnected machine not
  replaying a blocked action, Authority/emergency/cancellation refusal of an
  explicit probe, approval pause and resume, and approval identity across a
  piece upgrade. Its engine and compiled-piece cases are deliberately NOT
  gated on `JARVIS_TEST_ENGINE_BUILD=1`, so the headline evidence runs in CI
  rather than skipping there.
- `src/actions/tools/sidecar-route.test.ts` covers all nine offline desktop
  routes, missing machines, disabled and unavailable capabilities, remote
  error codes, uncertain dispatch, a negative receipt carrying its reply, an
  unverified launch window staying a success, and data containing `Error:`.
- `src/agents/untrusted-results.test.ts` and `src/agents/taint-gating.test.ts`
  hold a typed desktop failure to the untrusted-content wrapper and the turn
  taint.

This is not automatic reconciliation, a universal UI-success assertion, or a
retroactive repair of historical text-only success receipts.
