# Durable next-step recommendations (F-13)

F-13 stores the recommendation Q-18 already knows how to make. Opening and returning to it preserves its identity, evidence, rationale, goal context and expiry. Accepting it creates one canonical work item or links existing work, with an atomic receipt. It never executes a workflow, grants permission, scores a goal or records a partner as won.

## Dependencies and activation

This PR is stacked on corrected F-12 (`f8a323060ca496c6e0d42b754d80a841faa1f3e5`) at the owner's request. It compiles against F-12's queue adapter. Q-18 stays an optional runtime dependency: its fixed `src/goals/next-action.ts` entry point must expose `next-action-v1` and the expected synchronous result contract. Missing, incompatible or failing planning returns unavailable; there is no fallback recommendation algorithm.

In an integrated disposable daemon, set both `JARVIS_BRIEF_DECISIONS=1` and `JARVIS_BRIEF_RECOMMENDATIONS=1`, then restart. Exact value `1` is required. Check `GET /api/brief/capabilities`: recommendations must be supported, ready and enabled, with no dependency reason. Both flags default off. No production daemon was enabled for delivery.

Q-18 owns observation, ranking and qualification. It generates a recommendation, asks a question, or says nothing new is worth adding. F-13 copies only the bounded result needed for persistence. No raw snapshot, workflow run, step outputs or arbitrary planner fields are copied. Quoted outside text inside a rationale is display data, never a model instruction. F-13 makes no model call. Existing work/goal services own task identity and execution; any later workflow composition stays on the existing composer path.

## API and reload

All routes are inside the existing daemon session gate and return `Cache-Control: no-store`. Request bodies are limited to 8 KB. Clients cannot submit a recommendation, title, goal, evidence or action of their own.

| Request | Input or result |
| --- | --- |
| `POST /api/brief/recommendations` | `{requestId}` generates and stores a server-selected result. Repeat the request ID to recover the same recommendation. |
| `GET /api/brief/recommendations` | Most recently inserted recommendation, or `null`. A return/reopen does not regenerate. |
| `GET /api/brief/recommendations?requestId=ID` | Recover a generation whose response was lost. |
| `GET /api/brief/recommendations/:id` | Read that historical recommendation and its current availability. |
| `POST /api/brief/recommendations/:id/dismiss` | `{revision}` saves dismissal. It creates no work. |
| `POST /api/brief/recommendations/:id/accept` | `{requestId,revision}` accepts an available recommendation, returning its durable receipt. |

A stored result has `recommendationId`, generation `requestId`, opaque `revision`, `plan`, `state`, `reason` and `acceptance`. The plan contains `planner`, `generatedAt`, `expiresAt`, `basis`, and one of:

- `recommend`: action kind/title, goal ID/read revision/path (or null), work-item ID (or null), rationale, evidence and workload effect;
- `ask`: question and the actions it concerns;
- `none`: reason and evidence.

Only `available` recommendations can be accepted. Questions and abstentions stay `ask`/`none`; they never become tasks. `dismissed` and `accepted` are durable. Expiry is checked against server time. Changed planner input or a changed choice becomes `blocked` with a refresh explanation. Requesting a new recommendation uses a new generation request ID, including after dismissal or expiry.

Reads and acceptance re-observe Q-18's basis and choice. The goal read revision is context, not the concurrency token. Checking the choice as well as the basis covers time-dependent changes even when stored inputs are unchanged. Acceptance checks run under the same SQLite immediate transaction as the work and receipt writes.

## Acceptance and the Today adapter

For a new action, F-13 calls `createWorkItem` and `decideWorkItem` to record accepted intent. It appends a persisted queue position after every current item, preserving the old front and all existing placements. No run is started and no result is verified.

For existing work, F-13 keeps its title, intent decision and placement. It returns its canonical queue identity: if an unresolved effect already represents that work, the receipt points to the effect/approval item instead of adding a duplicate work wrapper. Linking an existing proposal does not decide it; accepting a suggestion to review permission does not grant that permission.

The receipt contains `receiptId`, `recommendationId`, acceptance `requestId`, submitted `revision`, `acceptedAt`, `created`, and `destination: {decisionId,workItemId,title}`. Repeated acceptance and concurrent processes return the same receipt identity and destination. A later retry can echo a new request ID without changing the stored receipt or work. Read by recommendation ID after any lost/uncertain response before offering another action. Historical receipts do not claim their destination is still pending today.

D-10 integration must use these owner facts:

1. Use the stored action's goal ID/revision and evidence; a null-goal or question/abstention result needs the appropriate non-goal presentation.
2. Use the canonical `destination.title` for queue confirmation. A Q-18 action such as “Check the result of ...” may link an existing item whose title differs; do not rename that item or fabricate a matching title. The explanatory action title and queue-item title are separate fields.
3. Correlate request/recommendation/revision with the receipt, then read F-12's current queue and confirm the exact destination. Do not increment the queue count optimistically, especially when `created` is false.
4. Keep visible goal progress unchanged. Result verification and goal measurements remain separate operations.

The numeric queue-position bound remains F-12's. If the current tail is already 1,000,000, acceptance returns `placement_full` and rolls back all work/receipt writes. Reorder the queue before trying again; the service never moves the current front to make space.

## Verification

From this worktree in WSL:

```sh
bun test src/brief/recommendations.test.ts src/daemon/api-brief-recommendations.test.ts src/brief/recommendations-q18.test.ts
```

On the independent F stack, expect 20 pass, 2 skipped, zero failures. The skips need Q-18's separately delivered source; the missing-provider test passes instead. Tests use isolated databases and a Unix socket. They cover durable reload, idempotency, two independent accepting processes, stale goals/workload/capabilities, expiry, dismissal, ask/none, queue order, linked approval identity, rollback and authenticated HTTP. No external provider or message is used.

The actual Q-18 integration was also run with its five source/test/scenario files temporarily overlaid from commit `dd658e0535dd0e365559a065987c5bf4031c8732`, then removed. Running `bun test src/brief/recommendations-q18.test.ts src/goals/next-action.test.ts` in that combined checkout passed 67 tests, with only the missing-provider case skipped. This includes Q-18's approved scenario set unchanged. Its code is not copied into this PR.

The full affected command, logs, two initially failing regressions, and four rejecting mutations are under `docs/brief-delivery/evidence/F-13/`. Mutations remove freshness, duplicate protection, append placement and the atomic write boundary; each fails its check. TypeScript and normal repository commit guards must pass before push.

## Limits and rollback

This is the backend provider/API and canonical Today adapter, not a rendered room change. There is no UI screenshot. D-10's live presentation adapter and the release cutover remain integration work. Q-18's structured-observation and ranking limits still apply; F-13 does not invent missing steps or certify live-model performance. One read returns one stored result, at most 64 KB; history is retrievable by ID, not a new unbounded list.

Rollback: unset `JARVIS_BRIEF_RECOMMENDATIONS` and restart. Retain `brief_recommendation`, existing commitments/work decisions, queue placement and receipts. There is no schema removal or reversal of accepted intent. All PRs stay unmerged. F-14 is not part of this delivery.
