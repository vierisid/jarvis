# ON-U-07 verification

Date: 14 October 2026. Base: 5024ea7455a5613be0514475be32c0dee6de0edd.
Implementation: 6883696d7d28ee4b92ea733b01b6bed349ab15f3.
Optional view only; unregistered, inactive and intended to remain unmerged pending owner review.

## Scope and design

Implements the approved first-workflow request screen: heading, three editable examples, compact upward-growing prompt, review note, Create, Back and Explore. Suggestions never send. Validation, clarification and connection feedback stay on the same surface. Explicit create emits a versioned request; uncertain delivery retries the same identity/body. The host must persist and reconcile that request. This view cannot publish, enable, test, run, send or create a real workflow.

Live Figma inspected: [empty screen](https://www.figma.com/proto/eNfKeirIKLZLlZEasrurZa/Jarvis?node-id=1097-48090&page-id=1097%3A16402), meeting 1097:48110, weekly 1097:48130, competitor 1097:48150.
Checkpoint: **Onboarding · Tutorial focus contour · 2026-10-14**, version 2410205462365531104.
Light copy/layout inspected directly. Dark uses established onboarding/Brief tokens; no native Dark-frame inspection claim. Official static mark path reused unchanged from D-16 at 20e4d1a30fea4b24a753320dd313fdc680f2f697. No production D imports or Figma edits.

## Commands actually run

- bun test ui/src/onboarding-next/views/activation ui/src/v2/onboarding: **111 pass, 0 fail, 406 assertions**; 24 new tests / 83 assertions.
- bunx tsc --noEmit: pass.
- bun run build:ui: pass; existing production CSS directive warnings remain.
- bun build ui/src/onboarding-next/views/activation/preview/index.html --outdir /tmp/on-u-07-preview-build: pass, rebuilt at final implementation head.
- Normal implementation commit hooks: pass (EE boundaries, migrations, 100 templates, package contents, related tests and typecheck).
- git diff --check: pass.

Tests cover accidental duplicate submission, same-turn Explore/create races, callback acknowledgement versus actual acceptance, authoritative pending restoration, same-key retry, stale revisions/journeys, missing provider, blank/long input, IME/composition guards, theme/focus identity, safe text rendering and observer cleanup. These are view tests, not backend authorization or durability evidence.

## Browser evidence

Live local browser UI, not screenshots inferred from code:

| Viewport | Light | Dark |
| --- | --- | --- |
| 1440 × 1000 | checked | checked |
| 768 × 900 | checked | checked |
| 390 × 844 | checked | checked |

No horizontal overflow. Actions remain keyboard reachable and scroll into view in narrow/long layouts. Geometry is recorded in [browser-checks.json](browser-checks.json).

- All three examples visibly prefill editable text and focus the field.
- Desktop input grows from 124px to 224px; Create stays at top coordinate 743px.
- Missing-detail response preserves the multiline original prompt; the answer is separate keyed context.
- Missing connection emits an intent only, not OAuth or a connection success.
- Transport error then retry emits byte-equivalent intent, including UUID, prompt and references.
- Explore and fixture return retain the prompt. Missing provider disables creation while leaving an intentional exit.
- 2,001-character input remains intact, reports the limit and cannot submit.
- CSS 200% enlargement retains keyboard-reachable controls. Ten enlarge/restore cycles after the repair show no ResizeObserver error overlay or application error.

During browser verification, synchronous ResizeObserver height writes produced an undelivered-notification warning at enlarged size. Repaired with width-only observation, deferred animation-frame writes and unmount cancellation. Added a regression and repeated the browser sequence. This is the final tested implementation.

Screenshots: [wide Light](wide-light.png), [narrow Dark](narrow-dark.png). They show illustrative local states.

## Coexistence and module removal

Temporary isolated candidate merged U01–U06 and B01–B03 at the exact heads in the delivery receipt. No sibling production imports, shared registry edits or lockfile changes were needed.

- Combined tree f73578378145424c0667578e97d9bd7d40c05afb: 233 UI/legacy tests, 949 assertions; 267 onboarding-module tests, 1,610 assertions; typecheck and UI build pass. The two test scopes overlap.
- Reverse-applied only ON-U-07. Tree c33ef4da67f89204d125a4c66779874789cb8cf4: 209 remaining UI/legacy tests, 866 assertions; typecheck and UI build pass.
- Temporary merge aborted and candidate worktree removed. Primary dirty checkout and other agents' worktrees preserved.

These checks establish optional packaging and coexistence at those pins. They do not certify a complete runtime assembly.

## Activation gates and limitations

ON-U-10/ON-B-11 discovery and ON-B-07/08 providers are absent from the independent base. Real draft creation, request persistence across reload, authenticated job reconciliation and complete D/F/Q release evidence remain **blocked**, not passed. D-33 was still gated when inspected.

The preview uses explicitly illustrative host responses. “Return to request” resets that fixture; it is not a production reconciliation operation. Native WebView, screen reader, native IME, native browser zoom and OS reduced-motion behavior were not tested. CSS enlarged mode and synthetic composition tests do not certify those environments. No real account, workflow, connection, permission, pricing or production entry changed.

## Quick verification

Run the preview command from the module README, then open [the preview](http://127.0.0.1:4416/).

1. Click Weekly update; edit the text. It must not submit until Create.
2. Set Response to Missing detail, then Create. The original request stays visible.
3. Reset the fixture, choose Transport error, Create and Retry same request; compare the receipt.
4. Try Explore and return, Dark, and a narrow browser width.

Rollback: disable registration if later activated, then revert this module's files. Preserve journey/draft/request data and the legacy entry.

Next card: **ON-U-08**. It has not been started here.
