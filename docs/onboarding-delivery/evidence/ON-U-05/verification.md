# ON-U-05 verification

## R1 follow-up

Fixes the review of `0ef5525dab47b25d3ae2eee8d4aaeb211f5bc4b1`; use the current
PR head for this follow-up. Original implementation evidence remains below.

- Deferred focus now completes when both the room and navigation are ready.
  It only moves from the fallback heading; leaving that heading cancels recovery.
- Added six regressions: delayed ordinary/final room, delayed host readiness,
  Back/Skip choice preservation and leaving/returning to the heading.
- Before the fix: three recovery tests fail ([log](r1-before.log)). After:
  130 tests, zero failures, 516 assertions ([log](r1-tests.log)).
- TypeScript, production UI and preview builds passed. Existing CSS warnings
  remain. An initial preview build command lacked Bun on PATH; rerunning with
  the installed absolute executable succeeded without code changes.
- In-app browser: actual Enter advances into a loading room, focus temporarily
  rests on its heading, then returns to Next. Verified in Light and Dark.
  Actual Tab during loading moves to Skip and stays there once ready.
- Preview now offers a delayed adapter with a 1.2-second fixture delay. Select
  it, wait, focus Next, press Enter and leave the keyboard idle to see recovery.
  Repeat and press Tab during loading to check user focus is respected.
- The delta was reread against R1: no routing, persistence, capability or
  production registration changes. No new code findings. Original native
  screen-reader and actual D-room integration limitations remain.

Source: 5c8869439f5a5ff3cc83a0bdd30f0b6366172314.
Base: 5024ea7455a5613be0514475be32c0dee6de0edd.
Branch: onboarding/on-u-05. Dedicated worktree, no sibling source imports.
This verifies a controlled optional tutorial view, not the assembled onboarding.

## Roadmap acceptance

| Requirement | Evidence | Outcome |
| --- | --- | --- |
| Approved highlighted card | All twelve live Figma cards read; 2px inside blue contour, sharp upper-right, quiet shadow, approved copy | Implemented |
| Twelve ordered rooms | Descriptors, mounted tests and live browser Next sequence | Passed |
| Stable title/count/actions | 1440px primary at x732/y980 during initial sequence; all twelve 390px endpoints at the same y after label correction; stable DOM primary | Passed |
| Theme/sidebar/readable compact layout | Both themes, expanded/rail, 390/768/1440 matrix, zero horizontal page overflow, 44px controls | Passed in fixtures |
| Safe room-render port | Trusted fixture-only adapter, inert subtree, capture guards; no network/socket/storage in view; actions emit intents | Passed in fixtures |
| Actual D-room reuse and subject visibility | Adapter contract provided, no D rooms copied; D room host absent from independent base | Blocked until assembly |
| Back/Next/Skip/focus | Ten actual keyboard forward/back pairs; same primary retains focus; unavailable Next disabled | Passed |
| Progress truth | No optimistic step advance; duplicate intents locked to session/step/revision; stale rejection ignored | Passed |
| Last step | Open Pebble emits a separate handoff, does not complete onboarding | Passed; U06 still required |
| Reduced motion/enlargement | CSS 200% example, Enter reaches Next, reduced transitions 0s | Passed as preview examples |
| Native accessibility/WebView | No native screen-reader, OS preference or WebView verification | Not run |

The standalone backdrop explicitly says Room renderer fixture. It is not a
redesign of the dashboard or a screenshot standing in for a live implementation.
The tutorial sandbox label remains visible. An adapter declaration is a trusted
host contract, not a sandbox for arbitrary JavaScript: hosts must never supply
live room controllers, effects, portals, global shortcuts or real data bindings.

## Commands and independence

- `bun install --frozen-lockfile`: passed.
- `bun test ui/src/onboarding-next/views/tour ui/src/v2/onboarding`: 124 pass,
  0 fail, 496 assertions; 37 tour tests and 87 existing onboarding tests.
- `bunx tsc --noEmit`: passed.
- `bun build ui/src/onboarding-next/views/tour/preview/index.html --outdir /tmp/jarvis-on-u-05-preview`: passed.
- `bun run build:ui`: passed, existing @theme/@tailwind warnings.
- Normal pre-commit checks: EE imports, migration safety, 100 webapp templates,
  package contents, 37 related tests and typecheck passed.

Temporary candidate combined the exact U01/U02/U03/U04/B01/B02 heads listed in
the delivery receipt with this implementation. Merge was clean. Tree
`1ef4ab4acb005970449cceb9e583368362918b10` passed 180 tests (1,231 assertions),
typecheck, production UI and tour-preview builds. Removing only the tour module
yielded tree `1c9f9efdb1e3ba320d04430ca4c215f3ed106f57`: 143 tests (1,058
assertions), typecheck and production build passed. The temporary merge was
aborted. None of these sibling commits are on the delivery branch.

This proves coexistence and safe removal, not U10/B11 discovery, B06 persistence,
old/new server rollout or actual D/F/Q runtime compatibility.

## Repairs found during verification

1. Narrow dock retained its desktop inset. Reset placement explicitly; retested
   all twelve compact cards with zero horizontal page overflow.
2. Connected workspace's wrapped utility label shifted the action row by 6px.
   Reserved the two-line utility height; all twelve compact primaries aligned.
3. Broad button/heading selectors could restyle an injected D room.
   Scoped them to the tutorial card and used the approved exact Brief palette.
4. CSS enlargement exposed viewport-only spacing and Bun's logical-property
   specificity conversion. Added container breakpoints and consistent physical
   dock positioning; the enlarged card and its controls remain contained.
5. Unknown model phases could be treated as usable. Fail closed alongside
   unknown step IDs/invalid revisions; included in mounted tests.

## Browser evidence

- [Light desktop](light-1440.png), [Dark rail](dark-rail.png).
- [Light compact](light-390.png), [Dark compact](dark-390.png).
- [Enlarged text example](enlarged-768.png).
- [Recorded geometry](browser-matrix.json). Initial step geometry and final
  layout matrix are labeled separately; toolbar wrapping is outside product UI.

Screenshots are isolated samples, not live account data. Browser checks used
Chrome through computer use. Synthetic DOM tests are not real browser/native
security or accessibility certification.

## Quick check and rollback

Open http://127.0.0.1:4414/. Next through all twelve cards, Back, Skip and
Open Pebble. Watch the intent output; no action executes. Switch theme/sidebar
and select an absent adapter: Next must disable. Resize to 390px to see the
card's reserved row rather than a scaled screenshot.

No production entry changed. Revert the optional module, or disable its
registration first if a later host activates it. Preserve journey/profile and
all account/connection/job/draft records. Next card: ON-U-06, not started.
