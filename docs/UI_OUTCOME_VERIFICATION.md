# UI outcome verification (Q-09)

Execution completion and verification of a postcondition are separate. A click
returning normally is not confirmation that a message was sent, a payment was
made, or a document was saved. Use a typed governed connector with a provider
receipt for those effects when available.

## Supported evidence

| Adapter | Verified postcondition | Insufficient evidence |
| --- | --- | --- |
| `browser_snapshot`, `browser_navigate` | `page_observed`: browser-confirmed page URL and document loader ID held across the snapshot | Legacy text, missing/malformed identity, document race |
| `desktop_launch_app` | `window_visible`: structural `success: true`, `window_visible: true`, positive integer PID | Process start alone, null/absent visibility, legacy result text |
| Other desktop/browser calls | None; `unverified: no_supported_postcondition` | Normal return is only execution completion |

A page observation names the actual landing page, including redirects, not the
requested URL. It does not certify that the expected destination was reached or
that a later action succeeded. Evidence is historical at the call's completion,
not a promise that the page or window remains current. Document identity cannot
be supplied by page text or tool parameters.

Windows, macOS, and Linux have different observation capabilities. An app can
start while its window cannot be inspected (for example, a missing native probe
or unavailable accessibility support). That remains unverified and must not
cause a relaunch. A structural negative launch receipt remains a typed failure
with possible partial effects.

## Consumers and durability

The effect boundary records `outcome.verification` for supported desktop/browser
workflow calls alongside the unchanged result and frozen machine binding. The
sandbox tool response returns that outcome. Reopening the database or repeating
the same invocation returns the recorded evidence without dispatching again.
`requireSuccess` continues to assert execution success; it does **not** assert a
business postcondition. Consumers requiring one must inspect verification and
the exact postcondition, or use provider confirmation.

Current workflow restrictions remain in force: raw browser navigation, clicks,
typing, app launch, and other opaque UI writes cannot be introduced as direct
workflow capabilities. Supported reads such as `browser_snapshot` gain durable
evidence. This card does not enable raw UI writes or replace the Q-07 recovery
state machine.

The existing approval executor collects evidence for approved desktop/browser
calls. Its live `ApprovedReceipt.verification` carries the structured observation;
the bounded durable approval text starts with an authored verification summary.
Existing result payloads, image handling, and trusted/untrusted trailer boundaries
remain intact. `execution_outcome: committed` means the call completed; the
separate summary states whether a supported postcondition was verified. Failed
or uncertain browser calls do not create a committed approval receipt.

Collection uses a per-call async scope. An observation from a nested or concurrent
tool with another name cannot certify the enclosing action. No observation is
accepted from model input, rendered result text, or generic provider JSON.

## Failure and machine behavior

Authored local browser refusals stay typed in workflow and approved execution.
Remote approved element actions negotiate `browser_action_outcomes` as described
in the [sidecar protocol](sidecar/SIDECAR_PROTOCOL.md). Missing feature support
blocks dispatch. Lost responses, disconnection after dispatch, and focus loss
after clearing or inserting text retain possible partial effects.

Reviewed desktop writes and routed browser UI actions also capture the canonical device and
connection session at review. Missing/offline devices, capability loss, same-ID
reconnection, and changed automatic defaults invalidate the approval before RPC.
Local approvals cannot switch to a newly connected remote device. The existing
run/device/session fences remain authoritative. Reordering default
devices, reconnecting the same device with another socket generation, capability
loss, stale snapshots, and changed documents cannot redirect an existing effect.
A receipt already obtained from the original dispatch remains historical evidence
after that device disconnects; it never permits a fresh dispatch on a replacement.
Existing tests cover simultaneous bindings, socket generation fences, approvals,
restarts, real engine execution, pause/kill, and local/hosted selection.

## Integration, limits, and rollback

This card starts from main `75bf90b1bf92849c3f1c18f90e5f05d2e61f8fb0`, which contains
desktop bridge removal, bounded native calls, reviewed browser snapshot binding,
and remote snapshot serialization absent from the older Q stack. It has no merge
or enable dependency on Q-07/Q-08 and does not merge that stack. When integrating
Q-07/Q-08, preserve both their held/recovery outcomes and this additive verification
field on replay, fresh completion, and API responses. F-21 is a read-only consumer.

There is no guarantee for arbitrary third-party UIs, no automatic replay or new
retry mechanism, and no business success inferred from a screenshot or a normal
tool return. Unapproved legacy chat browser calls keep their prior text format;
this card certifies workflow reads and approved UI execution. No deployment or
Brief activation is included.

Rollback: revert the Q-09 commits and restart the daemon. The fields are additive,
with no schema migration; old readers ignore them. Updated sidecars preserve the
old protocol without opt-in, so they can remain installed. Rolling back the brain
also removes its typed browser refusal and verification guarantees. Never use
rollback as permission to repeat an uncertain action. Native Windows/macOS runtime
checks require their respective hosts; cross-platform protocol fixtures do not
certify native behavior there.

Quick verification: use Bun 1.4.2, install with `bun install --frozen-lockfile`, and
run the commands in `brief-delivery/Q-09.json`. Run native Linux tests under
`xvfb-run -a`; browser fixtures use isolated temporary profiles and local pages.
The test-only `JARVIS_TEST_ENGINE_CACHE_ROOT` isolates generated engine and piece
outputs and is stripped from model-launched environments.
