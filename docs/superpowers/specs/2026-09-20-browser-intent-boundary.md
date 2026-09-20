# Browser intent boundary (A5)

## Contract

`access_browser` grants access to browser observations. It does not establish
the business meaning of a click, keystroke, form submission, URL, or script.
Known business mutations should use the existing governed connector adapters
(for example Gmail send and Slack post), whose action and target are explicit.

| Route | Policy |
| --- | --- |
| Typed connector mutation | Keep the adapter's business category, target, approval and durable receipt. |
| Browser snapshot/screenshot | Keep the existing browsing/read policy. |
| Raw browser navigation, click, type, key, upload, hover, scroll or evaluate | Preserve the static category, add `control_app`, and require a dashboard review. The card says the business effect is unknown. |
| Raw desktop mutation | Require the same review; desktop input can also operate a browser. |
| Structural `ui_act` mutation | Review the captured control and add business-effect hints from its name and captured page/window context. A recognized Gmail Send control must clear `send_email` as well as browser/app access. |
| Recorded skill | Check every inferred and author-declared category. Unclassified acting steps require review of the procedure. Recognized/declared effects retain existing Authority rules; labels remain heuristic evidence. |
| Direct workflow raw UI/code | Remains unsupported under A1. Explicit approval does not make it a typed adapter. |

## Invariants

- The shared agent gate applies the raw UI restriction by tool identity. The
  isolated background browser, text agent, voice path and sub-agent path do
  not get different defaults. Model-supplied `intent` or `effect` cannot lift it.
- Explicit denials win. Above the permitted static floor, a numeric level
  shortfall can become an approval request, including a mandatory-review call.
  Missing approval infrastructure cannot execute the action. Voice auto-approval
  and sub-agents cannot satisfy a dashboard-only review.
- Browser reads are not added to the background/taint governed sets. Mutations
  reach their existing `control_app` restriction and require review even when
  those profiles are disabled or an owner override allows ordinary browsing.
- Every category matters. Declaring a deletion or payment cannot replace a
  detected send and thereby hide its separate deny rule.
- A broken per-call classifier requests review instead of silently reverting
  to an autonomous static category.
- Structural action IDs remain tied to their captured surface. Before acting,
  a changed page URL, title, control name or role requires a fresh snapshot and
  review. The action is still dispatched at most once.
- Agent UI approvals retain their originating tool registry and any captured
  session/subject guard until resolution. Deferred background actions execute
  on the isolated background browser, never the main browser. A stopped,
  disconnected or replaced background session cannot reuse an approval.
- Structural approvals retain the addressed snapshot entry, not just its
  numeric ID. Agent UI bindings are deliberately process-local: after restart,
  approving a pending request or resolving a never-started request records a
  blocked outcome and asks for a fresh review. Non-UI approval recovery and
  workflow-owned effect recovery keep their existing contracts.
- Capability-specific mandatory review is carried into workflow effect
  approvals. It cannot be removed by an allow override. Existing frozen
  arguments, waitpoints, target checks and receipts still own resume/replay.
- Pending category-only approvals from before this change cannot dispatch a
  newly review-required UI action. Chat requests need a fresh dashboard card;
  workflow effects need a new reviewed run. Committed receipts remain intact.

## Integration

Built on main `00afd022`, including A1, A2, A4, A6 and cp/6. No unmerged PR is
required. The open PRs at implementation time were #492 (delegated continuation),
#493 (Windows recording) and #494 (workflow skill capability), plus older #381
and #280. The staged Jev experiment is in a separate worktree.

When combining #494, retain its version/surface subject and all-category
workflow check, and retain this change's conditional `confirm` on `run_skill`.
`toolsInvoke` must pass mandatory review to `WorkflowEffectBoundary`; gating a
skill by categories alone drops the uncertainty review. Keep #493's default
parameter resolution when combining the effect classifier changes. For #492,
preserve its principal-bound decision and approval-required flag alongside
the mandatory-review confirmation. Do not replace those with workflow defaults.

The #494 partial-failure test must approve the previously unclassified Archive
step before exercising its failure. Apply the adjacent
`2026-09-20-a5-pr494-test.patch` after combining that PR. It asserts no click
before review, preserves the click-only approval context, then exercises the
original failure and no-replay assertions. The three source overlaps are in
`skills.ts`, `effect-boundary.ts` (keep both intent and confirmation), and
`service-backends.ts` (keep both categories and confirmation).

## Limits

This is a supported capability boundary, not universal semantic governance.
UI labels, URLs, app names and declared skill effects cannot prove an arbitrary
event handler's behavior. A misleading or localized label may miss a business
hint; unknown controls require review, but a misleading recognized label can
still misclassify a recorded skill. Prefer typed connectors for unattended
business mutations. No live message delivery or browser-provider certification
is claimed.

A review authorizes the displayed procedure/arguments and acknowledges the
unknown effect; it does not certify recipients, remote commitment or unchanged
page script. Raw browser numeric IDs and coordinates are not durable semantic
identities. Structural recapture catches visible target changes, not every
same-label state change or a race after capture. Arbitrary code, authenticated
HTTP and low-level sidecar RPC remain outside this semantic guarantee.

This change increases review friction, including navigation, hover and scroll:
those operations can execute page handlers too. Snapshots/screenshots remain
available for inspection. Durable safe retry and reconciliation retain A4's
limits; this change does not add automatic replay or a new effect executor.
