# ON-U-04 verification

14 October 2026. Dedicated worktree: `/home/vierisid/.cache/codex/jarvis-on-u-04`.
Target: main at `5024ea7455a5613be0514475be32c0dee6de0edd`.
The JSON receipt pins the final implementation and temporary combined trees.
No sibling implementation commits are included in the delivery branch.

## Design source

Inspected the live Figma written interview, second question and completion:
`1097:16517`, `1097:16538`, `1097:16607`, file
`eNfKeirIKLZLlZEasrurZa`, page `1097:16402`.
Checkpoint: Onboarding · Tutorial focus contour · 2026-10-14,
version `2410205462365531104`. No Figma edits.
Dark materials reuse the approved Brief tokens; this does not claim a separate
native Dark-frame inspection.

The retained interview uses the existing themes from
`useInterviewSession.ts` and `onboarding-interviewer.ts`: work, current goal,
routine, tools and judgment/approval. Questions remain provider-owned. There is
no microphone or voice entry and no new production questionnaire.

## Executed checks

| Check | Result and actual scope |
| --- | --- |
| Standalone tests | 116 pass, 0 fail: 29 new view tests plus 87 legacy onboarding tests. |
| TypeScript | `bunx tsc --noEmit` passed. |
| Production build | `bun run build:ui` passed; optional view remains unimported by production entries. |
| View build | Explicit standalone HTML preview build passed, so the optional view is also bundled directly. |
| Commit hooks | Normal EE-import, migration, 100-template, package-content, related-test and typecheck guards passed. |
| Dependency footprint | Frozen-lockfile install in this worktree; no dependency, lockfile, legacy onboarding or assembly edits. |
| Temporary combined candidate | U01/U02/U03/B01 plus this module; clean merge, focused tests, typecheck and both builds. Exact refs/results in receipt. |
| Module removal | Only the interview directory removed in the disposable candidate; remaining modules, typecheck and production build pass. Restore/abort returns candidate clean. |

Build logs retain existing `@theme` / `@tailwind` warnings. These are not new
runtime errors. A stale Bun HMR-script overlay during development was cleared by
a deliberate reload; the clean-page interaction checks below were then run.

## Browser evidence

Actual Chromium browser and in-app browser interactions against the standalone
fixture on port 4413. No real backend, account or model was connected.

| Scenario | Observed result |
| --- | --- |
| 1440 × 1100 Light ready | Centered question/Pebble, restrained header, compact composer; [image](light-ready-1440.png). |
| 768 × 1024 Light resumed | Existing answer remains visible, Resumed label and two confirmed illustrative facts; [image](light-resumed-768.png). |
| 390 × 844 Dark reply | No horizontal overflow; Skip and Send measure 44px high; draft remains editable. |
| 390 × 844 Dark done | Green Pebble, Got it, six confirmed fixture facts in Memory, Continue; [image](dark-completed-390.png). |
| Dark save failure | Only the one already-confirmed fact remains counted; no completion claim; Reconnect is available; [image](dark-save-error-1440.png). |
| Failed answer then retry | Original request ID/body retained while a newer draft is typed. Retry uses the original ID. Return reply preserves the newer draft. |
| Keyboard | Enter sends; Shift+Enter inserts a newline. Ten repeated Enter presses after one send produce one submit intent. |
| Retry focus | Enter on Reconnect/Retry answer returns focus to the composer when the control disappears. A user who moves focus elsewhere is not interrupted. |
| Skip focus | Keyboard Skip waits for provider-model confirmation; the fixture-confirmed skipped view is distinct and Continue receives focus. |
| Multiline | Field grows from 44 to 132px; composer and Send share the same bottom at y=766 in the narrow fixture. |
| Responsive retained draft | 1440-to-390 resize grows an existing draft from 44px to 84px including borders; client/scroll height both 82px. Send bottom stays y=766. Ten repeated resize pairs retain text and return to 44px wide; [image](light-resized-draft-390.png). |
| Long-history update | Reading history-2 at offset -28px stays at -28px when Return reply adds a question. |
| Long-history reflow | 390-to-768 resize keeps history-2 at -28px while scrollTop adjusts from 756 to 680. Latest question explicitly returns to the top. |
| Streaming | Partial text changes visibly; the live status remains “Jarvis is preparing your reply.” until completion. It then contains the completed question. |
| Enlarged content | 200% CSS preview zoom has no horizontal page overflow. Keyboard reaches Send and scrolls it into view; [image](enlarged-keyboard.png). This is not native browser zoom. |
| Reduced motion | Fixture sets animation duration to 0s. The production prefers-reduced-motion rule was inspected. |

The screenshot toolbar is a clearly marked test harness, not onboarding chrome.
Illustrative fact counts and replies are never presented as real persisted data.

## Regressions found and fixed

1. Same-tick Skip followed by Send could race before React committed disabled
   state. A synchronous navigation intent guard now suppresses it.
2. Retry could remove the focused button and leave keyboard focus on the page.
   Focus now returns to the composer, without stealing focus from another control.
3. An unchanged draft did not resize on viewport changes. Width observation now
   schedules a bounded resize on the next animation frame, avoiding observer
   delivery warnings and accounting for field borders.
4. The latest question used a different reading identity when moved into history.
   Both positions now share the message ID so the anchor remains findable.

Each has a focused regression. Source review also checked escaping, callback
boundaries, observer cleanup, intent IDs, confirmation counts and absence of
cross-card imports. See [review](review.md).

## Limits and activation

- IME composition is covered by synthetic composition/isComposing/keyCode229
  events. A native IME and screen reader were not exercised.
- DOM live-region inspection does not certify spoken assistive-technology output.
- Native OS reduced motion, browser zoom and packaged desktop WebView behavior
  remain integration checks.
- Resume durability, exactly-once server processing, Memory persistence and
  authenticated session ownership belong to ON-B-04/05. No claim that they work
  is derived from this preview.
- ON-U-10 and ON-B-11 are absent. The temporary candidate demonstrates packaging
  coexistence and removal, not runtime discovery, full provider-present behavior,
  routing, fallback or the integrated D/F/Q journey.
- This view is implemented, unregistered and inactive. Production onboarding
  remains unchanged. Keep the PR unmerged until instructed.

## Quick verification and rollback

Run `bun ui/src/onboarding-next/views/interview/preview/serve.ts`, then open
http://127.0.0.1:4413/. Check Fail next answer, type and send, type a different
draft, Retry answer, then Return reply. Compare done, skipped and unknown.
Use long to check reading position and Light/Dark to check appearance.

Before registration, revert this PR. After registration, disable the optional
UI entry before removal. Retain journey/session/Memory records and the previous
onboarding entry. There are no migrations.

Next: ON-U-05, the highlighted room tutorial. Not started in this delivery.
