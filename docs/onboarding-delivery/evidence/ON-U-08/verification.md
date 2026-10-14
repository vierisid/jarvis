# ON-U-08 verification

Date: 2026-10-14. Implementation: 93c9142b4ce23fec81bfc3585bfc277bc9611d78.
Base: 5024ea7455a5613be0514475be32c0dee6de0edd (main). Independent worktree:
/home/vierisid/.cache/codex/jarvis-on-u-08. Unregistered/inactive; no real workflow created.

## Source and design

Reread both onboarding roadmap execution contracts, ON-U-08 and B-08/B-10 boundaries,
and the handoff contract in Drive Product/onboarding-implementation-roadmaps-2026-10-14-v1.
Inspected persisted-workflow-composer.ts and workflow-composition repository on main:
composition validation is not proof of a saved, accessible result. The view requires
an authenticated B-10 result projection before navigation; shape checks are not authorization.

Live Figma Light loading node 1097:48188, file eNfKeirIKLZLlZEasrurZa, page 1097:16402,
checkpoint Onboarding · Tutorial focus contour · 2026-10-14, version 2410205462365531104.
Centered mark, heading, workflow name and phase rows retain that composition.
Saving/recovery states are required by the roadmap. No timed auto-success from the
Figma prototype was copied. Dark follows established onboarding/Brief tokens;
no native Dark frame verification or Figma edit is claimed.

## Checks

| Check | Result |
| --- | --- |
| Module + legacy onboarding | 116 pass, 0 fail, 423 assertions |
| New module alone (normal commit hook) | 29 pass, 100 assertions |
| TypeScript | Pass |
| Production UI build | Pass; existing CSS directive warnings |
| Standalone preview build at implementation head | Pass |
| Normal commit hooks | EE imports, migrations, 100 templates, package contents, related tests and typecheck pass |
| Diff whitespace | Pass |
| Live B08/B10 providers and U10/B11 registration | Blocked; not present on standalone base |
| Full D/F/Q activation | Not certified; independent optional module only |

Behavioral tests cover provider-only phases, explicit completed phases, queued/no-event
truth, scoped monotonic revisions and terminal guards, cancellation confirmation and
success races, failed versus unknown timeout, original request retention, same-command
recovery, durable-reference binding, no fake result, exact-reference navigation retry,
late callbacks, withdrawn references, hanging cancellation reconciliation, absent
capabilities, focus recovery, theme/motion preservation and plain-text rendering.

## Browser evidence

See [recorded matrix](browser-checks.json), [wide Light](wide-light.png) and
[narrow Dark](narrow-dark.png). Tested the served React view in the in-app browser:

- Light/Dark at 1440x1000, 768x900 and 390x844: no horizontal overflow; content fits;
  controls at least 44px and reachable using Tab.
- Ten recovery-state presentations, queued/no-events truth, stale revision ignored,
  cancellation staying pending until explicit confirmation, and disconnected status
  recovery retaining the same job.
- Succeeded without a verified result stays on Finishing your workflow. Only the
  explicit Verify saved draft fixture event enables the labeled exact-version handoff.
- Fail next action before result navigation produces Try opening again, which opens
  the same sample flow/version. No rebuild or actual workflow execution.
- Ten request disclosure, phase-update and stale-event cycles: building, validating,
  saving, then still saving. No elapsed-time success.
- Explicit Reduce motion computes animation-name none. CSS 200% enlargement at
  390px retains the focused Cancel control and no horizontal page overflow.

During preparation, focus on a removed action and late callback/reconciliation
races were repaired and covered by regressions. The preview's stale-event injector
initially disturbed its own subsequent event revisions; its authoritative event
ledger was separated and the ten-cycle sequence retested. Hot-reload createRoot
warnings from editing were addressed with dispose/unmount and a fresh reload;
historical browser warnings are not represented as an empty console history.

These are representative browser and unit checks, not screen-reader, native WebView,
native browser zoom or OS preference certification. The local fixture has no actual
job, saved workflow or result canvas. Provider cancellation, durable resume and
navigation persistence are explicit integration gates.

## Combined and removal candidates

The receipt lists every pinned U01-U07/B01-B04 head. A temporary detached worktree
at the implementation commit merged those pins without committing or publishing.
Combined tree: 615eb77c9308e6e4f17bff3f8c72b6f15d47d708.
262 UI/legacy tests (1049 assertions) and 332 module tests (1914 assertions) passed;
these scopes overlap. Typecheck and production UI build passed.

Reverse-applying only this implementation yielded tree
efcf2d91e0c9cfe78423c37b95bb3986c2591ab6. The remaining 233 UI/legacy tests
(949 assertions), typecheck and production UI build passed. Merge aborted and
clean temporary worktree removed. This proves bounded packaging compatibility,
not live provider/assembly behavior or arbitrary future sibling compatibility.

## Quick verification

Run bun ui/src/onboarding-next/views/build/preview/serve.ts and open
http://127.0.0.1:4417/. Use Next phase; open View your request; send a stale update.
Cancel build then Confirm cancellation. Select disconnected and Check status.
Select succeeded, enable Fail next action and Verify saved draft, then Try opening
again. Switch Appearance and Reduce motion. The destination explicitly labels
its illustrative saved-reference handoff; ON-U-09 owns the result canvas.

## Rollback and remaining gates

No production registration, route, package or legacy onboarding changed. After
future registration, disable the optional view before reverting owned paths;
retain user request/job/draft data and legacy entry. Activation requires B08 events,
B10 authenticated durable reads, U10/B11 discovery and verified D/F/Q integration.
Independent review and GitHub final-head CI are not supplied by this local record.
Next card: ON-U-09; not implemented here.
