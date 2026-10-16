# ON-U-09 — First draft reveal

Optional `ResultView`, discovered through its frozen `result-view.v1` manifest.
No production registration, network client, canvas engine or workflow mutation is
introduced. U10 owns discovery/entry and B11 owns runtime bindings. This card is
independent of those modules and B10/D18 source presence.

## Supplied data and renderer

`ResultModel` is the host-authenticated scope/journey/job/request, a monotonic
presentation revision, theme, optional pinned expected artifact, and the complete
B10 `draft-result.v1` read. Pass the same verified reference received from U08.
The view checks those identities, graph node identities, exact disabled DRAFT
version, recovery/route references and completion descriptor. It never accepts a
composition response as a saved result. Server authorization remains mandatory.

Increment `revision` after every accepted result read or command reconciliation,
including a withdrawal. Do not increment it for theme, sidebar or chat changes.
Equal/older observations cannot revive a withdrawn result. A new scope or job
retires all local commands and canvas state. Preserve the exact job and expected
composition/flow/version in the host route across refresh and later Workflows
navigation; do not resolve “latest workflow”. Content revision may change when
the same draft is edited. Do not replace a dirty buffer with a new observation.

Supply a stable `Canvas` component implementing `ResultCanvasProps` with the
existing D18 editor and inspector. It receives the verified graph, title and exact
reference; selected-node recovery is in `draft.selectedNodeId`. The adapter owns
D18 selection/inspector focus, authenticated request injection and version-bound
reads. Honor a supplied selected node through the renderer's selection binding;
never substitute another step. D18 currently exposes interactive selection but
no controlled initial-selection prop: that binding is an activation prerequisite
for restored non-null selections. The preview starts with null selection and
verifies real interactive node/inspector behavior.

The adapter must report dirty edits synchronously through `onDirtyChange`, and
call `onUnavailable` on a missing/replaced/inaccessible/activated version. Catch
renderer failures and fail closed. A fresh host read can restore the canvas.
Keep the component type stable; theme, chat, sidebar, review mode and same-version
reads preserve its mounted state. Changing the artifact retires its edit buffer.
Run/Enable/Publish are not supplied by this view. Any later action belongs to
existing readiness and Authority; never infer permission from Draft checks passed.

## Actions and recovery

Review opens the full canvas area. The optional `onReview` is a read-only host
notification; it must not run or enable anything. Without it, review is local.
The canvas owns selection and its existing inspector. View draft summary returns
the readiness card without remounting the editor.

`onContinue` receives `action.draft.continuation` exactly as B10 returned it. The
host must submit that descriptor and let the B01/B10 atomic finish guard recheck
the exact authorized draft. No descriptor means no Continue. Do not fabricate a
journey revision or mark completed on callback delivery. U10's result callbacks
are compatible; its trusted adapter re-reads its scoped model for `finish`/`review`
and binds the other callbacks as local ports. An adapter's availability must
include its renderer and B10/finish bindings, not merely module discovery.

`onOpenWorkflow` carries the exact B10 workflow route. `onRefresh` repeats a
read/reconciliation of the same job and retained reference, never a build retry.
`onBack` restores the original request without starting another job. All actions
carry scope/job IDs, presentation revision and a command UUID for host-side
reservation/deduplication. A resolved delivery stays pending until authoritative
acknowledgement/navigation. A rejected delivery requires Check again; late
callbacks from superseded commands or scopes are ignored. Reconciliation can
supersede an uncertain delivery. Save/discard canvas edits before navigating,
continuing or refreshing. The host must also guard shell-level navigation.

Missing/deleted/stale results, pending reads, no saved draft and missing canvas
have distinct recovery presentation; none renders a substitute graph. A saved
draft with missing inputs/connections is still reviewable. Running remains gated.
The view does not claim a failed/cancelled build succeeded because a draft exists.

## Design and accessibility

Figma eNfKeirIKLZLlZEasrurZa, onboarding page 1097:16402, Light first-workflow-ready
frame 1097:48233, contour checkpoint 2410205462365531104. The verified frame uses
the existing canvas, workflow title, review card and review action. Draft/readiness
and recovery copy reflect the roadmap's runtime rules. Dark follows existing
Brief/onboarding tokens. No landing, tutorial, loading or chat styling is changed.
The host supplies navigation and Pebble. The review card yields its width to the
inspector in review mode. Narrow layouts stack the card below the canvas.

The heading focuses on artifact entry; layout/read updates do not steal focus.
Review focuses the canvas region; D18 handles keyboard node selection and inspector
return. Controls are 44px minimum. Long titles, node identities and issue paths
wrap without truncation. This view adds no animation. Native WebView, OS preferences,
screen reader and full assembled-journey acceptance remain U11/B13 release work.

## Isolated preview and checks

Run `bun ui/src/onboarding-next/views/result/preview/serve.ts` and open
http://127.0.0.1:4429/. The preview extracts the locally available D18 object
85b3c554d276677b63918d8c9fee22dc4675ad03 into a temporary directory, injects its
real editor, shell and inspector, and supplies isolated illustrative transports.
No fetching or cherry-picking occurs. Saves only change memory; execution,
connections, installs and publication are denied. The three fixtures are meeting
follow-ups, investor update and competitor brief. Scenario controls include long
labels, missing inputs, deleted/stale results and absent dependencies. All fixture
navigation is explicitly labeled; it is not a live backend or deployment test.

Use `--build` for a preview bundle check, or `ON_U_09_MISSING_CANVAS=1` to check
absence. Tests: `bun test ui/src/onboarding-next/views/result`; optional compatibility
tests run when B10/U10 exist, and skip otherwise. Run TypeScript and UI build too.
Do not commit extracted sibling source or generated UI/runtime catalogs here.

Activation still requires U10/B10/B11 bindings, the selection adapter described
above, the verified D18/19/20/readiness candidate and U11/B13 release evidence.
Before rollback after registration, disable the optional view and retain durable
job/draft data and the legacy entry. Missing providers are unsupported, never
mocked production success.
