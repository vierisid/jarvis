# Quiet awareness delivery (F-11)

F-11 stops ambient awareness from starting an assistant turn or interrupting chat when `JARVIS_BRIEF_QUIET_AWARENESS=1` is set at daemon startup. The default is off. This capability has no activation dependency on another Brief feature.

## Behavior

| Event or action | Quiet delivery |
| --- | --- |
| Detected screen error, struggle or stuck state | Keep the awareness notification and canonical workflow event; do not launch automatic agent research, chat, voice or desktop delivery. |
| Awareness suggestion | Keep its inbox/card signal; do not append a proactive chat message, speak or use an external-channel fallback. |
| Durable opportunity with an accepting dashboard socket | Send the existing `notification` / `awareness_event` card envelope with its stable opportunity ID; record the existing WebSocket transport receipt. |
| Durable opportunity without an accepting socket | Leave delivery pending. The existing outbox retries after five minutes and recovers after restart using the same identity. |
| Explicit chat, research or enabled workflow subscription | Keep existing behavior and Authority checks. An explicitly configured workflow may still react to awareness. |
| Authority request, emergency state or execution failure | Keep the existing governed delivery paths, including a dashboard connection with no open chat. |

The policy is limited to the AwarenessService callback and opportunity delivery callback. Screen capture, retention, configured perception, suggestion evaluation, goal activity routing, preparation records and the explicit research queue remain intact. Quiet mode prevents ambient events entering the automatic event reactor/coalescer as well as removing the direct error/struggle research calls. No database migration or second inbox is added.

Prepared opportunities continue to use their existing durable records and reader. F-09/Q-13 preparation readiness is independent of quiet delivery. An opportunity card is not a claim that its proposal is qualified, approved or executed.

A WebSocket receipt means a transport accepted the card, not that the user read it or the UI rendered it. Network failure around acknowledgment can still replay an existing ID. The existing durable state and client identity handling retain their semantics. Delivery retries do not publish a second workflow event.

## Verify without live providers

From this worktree, run:

```bash
bun test src/daemon/awareness-delivery-policy.test.ts
```

The fixture uses the real WebSocket service, workflow event bus, trigger manager, AwarenessService capture ingestion and a file-backed outbox reopened after restart. Models, desktop notifications and external channels are synthetic. It checks:

1. Error, struggle, stuck and suggestion events produce no automatic research, chat, voice, desktop or channel calls in quiet mode.
2. A persisted offline opportunity remains pending, then delivers the same card identity once after restart and the retry deadline, without reopening chat or republishing the workflow event.
3. A connected dashboard with no open conversation still receives an approval request, emergency state and execution failure.
4. Explicit workflow subscriptions still enqueue work; real capture ingestion still stores evidence.
5. Only the exact flag value `1` enables quiet delivery. Unset, `0`, `true` and `yes` retain legacy behavior. The capabilities API reports the gate independently of other Brief features.

The broader command and output are in `docs/brief-delivery/evidence/F-11/affected-command.txt` and `affected.log`. TypeScript uses `bun node_modules/typescript/bin/tsc --noEmit`.

For an integration deployment, set `JARVIS_BRIEF_QUIET_AWARENESS=1` in that daemon's environment and restart, then check the authenticated `/api/brief/capabilities` response for `quietAwareness.enabled: true`. Keep chat closed while generating synthetic awareness and governed notification events; observe card/safety envelopes without proactive chat or TTS. This task did not change a running daemon or enable the flag in production.

## Rollback and scope

Unset the flag and restart to restore legacy delivery. Retain awareness captures, suggestions, opportunity delivery receipts, preparation records and decision history. No data cleanup is needed. Legacy automatic research and interruption behavior returns when quiet mode is off.

This is a backend delivery change. The sole UI edit corrects a stale comment; no layout or screenshot claim is included. F-12 is outside this PR. The branch is stacked on corrected `brief/f-10` at the user's request and stays unmerged until the stack is reviewed.
