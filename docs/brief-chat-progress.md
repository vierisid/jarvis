# F-06: safe, typed chat progress

F-06 adds conversation-scoped activity data for real tool, sub-agent and task execution. It is stacked on the corrected F-05 commit `f98cd312ca0b450bb5180320fc8c0491757cae67`, following the owner's unmerged F-line stack. It does not mount or change the production UI. D-15 owns presentation and motion.

## Activation

The initialized daemon registers `chatProgress`, default off. A local integration host needs `JARVIS_BRIEF_CONVERSATIONS=1`, `JARVIS_BRIEF_CHAT_TRANSPORT=1` and `JARVIS_BRIEF_CHAT_PROGRESS=1`. The browser adapter also needs `JARVIS_BRIEF_CHAT_STATE=1` and the existing `BriefConversationProvider` mounted with `enabled`. Attachments are optional. Readiness requires the live transport provider and its enabled dependencies. This PR does not enable flags on a running daemon.

`thread.status.progressEnabled` exposes discovery state, refreshed on reconnect. D-15 can read `orderedActivities(thread.current)` from `ui/src/brief/chat/store.ts` when a current conversation exists. Each row includes the original conversation, turn and request IDs; a stable host-generated activity ID; `kind`; per-turn `order`; `phase`; fixed `summary`; and optional canonical references. Existing v1 consumers can ignore the additive fields.

## What is observed

- `ToolRegistry.execute` reports only calls that reach actual dispatch, after validation and the cancellation checkpoint. Model proposals alone do not create a row. An invocation retains one activity ID through completion or failure.
- Turn-bound `runSubAgent` calls report their actual lifecycle. `AgentTaskManager` clears the turn observer for detached work, including its tools and lifecycle callbacks. The calling turn records the handoff tool; background status and results remain available through the task manager. Agent names, prompts, responses and reasoning are excluded. A run that ends without completed success is failed, including pause or exhaustion; this is not a business-outcome assessment.
- The existing scoped task broadcast reports its task lifecycle without copying intent, templates, error details or model prose. Background and legacy broadcasts keep their existing routes.

Observations flow through an optional asynchronous context, separate from authority and tool execution. Concurrent turns cannot share observers. A disabled nested scope clears its inherited observer. Observer exceptions cannot change a tool's return value, replace its exception, retry it or authorize an effect. Storage failures can lose progress observations; progress is not an execution audit ledger.

## Safe projection and bounds

Labels come exclusively from a fixed allowlist. Known tool names select labels such as “Reading a file.” Unknown, malicious and prototype-like names select generic labels. No source text is interpolated. Tool arguments, results, raw errors, source execution IDs, credentials and hidden reasoning are absent from the public projection. Model answer text continues through the existing answer channel and is outside this progress projector.

Thrown errors, including typed `ActionOutcomeError`, produce failed activities. Legacy adapters explicitly mark known failure branches with `failedToolResult`, preserving the exact return value. Built-in file/browser refusals and caught errors, local command exit codes, sidecar RPC failures and remote command exit-code receipts supply this status. Each tool invocation has its own outcome context, so nested or parallel failures cannot contaminate another call. Arbitrary returned strings or object shapes never determine status: reading “Error handling guide” succeeds, while a silent `exit 1` fails. A normal uninstrumented return only means the call returned, not proof that its requested effect succeeded.

A turn admits at most 128 activities. Each admitted row can still finish after the limit is reached. Duplicate starts and events after a terminal phase do not create or regress rows. Internal source identifiers are bounded to 256 characters and replaced with public UUIDs.

Trusted typed producers may attach up to four goal, fact or workflow-run references. IDs must pass a restricted syntax check and exist in the authenticated vault's canonical table. The projector selects IDs only, excludes supplied revisions, and never copies the stored record's title, body or evidence. Missing tables or records produce no link. Current tool/sub-agent/task instrumentation does not infer references from arbitrary arguments or results; a producer must explicitly supply an authoritative reference.

## Completion, cancellation and replay

Activities use the existing durable conversation event log. Completing a tool or task updates the same activity ID. Turn completion, cancellation and restart recovery atomically settle any unfinished turn-bound typed observations as failed before appending the terminal answer event. An interrupted activity is not marked successful just because the model produced an answer. A failed tool can coexist with a completed answer that explains the failure. Late work cannot change a cancelled or recovered terminal turn. Detached agents do not create turn-bound rows that would be incorrectly settled when the answer ends. An additive `(turn_id, sequence)` index bounds settlement to the current turn rather than scanning all retained events; repeated schema initialization preserves existing history.

The browser keeps each row's earliest event sequence for stable placement, including delayed starts arriving after completion. Terminal rows cannot regress. `live` is true only for a newly received live start; completed rows and all snapshot/reconnect rows have `live: false`. Rendering must use this hint to avoid replaying entry animations. Paged replay reconstructs the same final summaries and terminal answer state without executing tools again. The flag is captured at turn admission; disabling it affects subsequent turns and does not erase historical rows.

## Quick verification

From the dedicated worktree, these fixtures use isolated databases, temporary files, harmless local shell commands and fake model/sidecar responses. No account, daemon activation or real desktop action is needed:

```bash
bun test src/brief/progress.test.ts src/brief/progress-transport.test.ts src/actions/progress-context.test.ts src/daemon/agent-service-progress.test.ts src/daemon/ws-service-conversation.test.ts src/agents/sub-agent-runner.test.ts ui/src/brief/chat/store.test.ts src/actions/progress-tools.test.ts src/agents/task-manager.test.ts src/vault/chat-turns.test.ts
```

Expected: 79 passing tests. The suite also checks real file reads and shell exit codes, protocol-shaped sidecar receipts, an actual background runner finishing after the parent answer, preserved execution scope, and indexed lookup on fresh/upgraded databases. They exercise actual registry, AgentService, authenticated WebSocket and sub-agent paths; interleave conversations A and B; cancel A while B finishes; throw errors containing private canaries; restore a disk database after interruption; and replay more than one page into the browser store. Assertions check fixed labels, stable identity/order, no private canaries, no replay animation and truthful failure states.

For a future D-15 preview, start one tool in A and another in B, then cancel A. Only A's unfinished row should stop. Reconnect and confirm the same rows remain in order, final rows stay still, and neither call executes again. There is no visual screenshot for F-06 because this change supplies the producer and adapter only.

The receipt and raw verification evidence are in `docs/brief-delivery/F-06.json` and `docs/brief-delivery/evidence/F-06/`. The original implementation includes five rejected unsafe mutations. Review-fix evidence separately records 13 regression failures on the reviewed implementation before the fixes and the passing corrected suite. No real model or user data is needed. The broader local run passed 1,432 tests with three skips and one existing Chromium 143 DevTools fixture failure; the same failure was reproduced on the reviewed production sources. Exact remote head and full CI status are recorded in the PR description.

## Rollback

Disable `JARVIS_BRIEF_CHAT_PROGRESS` and the later D-15 progress presentation. Preserve conversation history and additive event fields; do not drop tables, delete messages or replay accepted turns. F-03's generic progress fallback and legacy transport remain available. F-07 is outside this PR.
