# ON-U-01 verification

Code head `8a18382b519733673093ce8cc75752b29363e1cb`, against
`main` at `1c2737a60d5580abea7d2feb9f2e845fdd491924`.
Only the controlled welcome/setup frame is implemented. The live wizard,
gate, backend and sidecar remain unchanged.

## Demonstrated

- 96 welcome/legacy-onboarding tests passed; nine are new welcome tests.
- TypeScript, production UI and independent preview builds passed.
- Repository hooks passed: license boundary, migrations, templates, package
  files, related tests and typecheck. Existing CSS at-rule build warnings remain.
- Both themes at all three required widths, with the real merged globals and
  v2 primitives loaded. The component is not relying on a clean CSS sandbox.
- Keyboard Enter/Space emitted a single setup/exit intent, respectively.
  Theme update retained the same focused control. Pending/error examples
  retained button rectangles; pending guard behavior is covered by DOM tests.
- Long copy and 200% **CSS preview zoom** remained scrollable and actionable,
  including at 390px. The review removed an exit-button minimum width that
  would otherwise overflow that extreme case.
- Temporary combination with ON-B-01 PR #1050 at `3883ba6f`: clean merge,
  38 tests passed, typecheck and both builds passed. Aborted that temporary
  merge afterwards; the delivery branch never includes the B-line commit.

## Visual evidence

| Width | Light | Dark |
| --- | --- | --- |
| 390 | [Screenshot](welcome-light-390.png) | [Screenshot](welcome-dark-390.png) |
| 768 | [Screenshot](welcome-light-768.png) | [Screenshot](welcome-dark-768.png) |
| 1440 | [Screenshot](welcome-light-1440.png) | [Screenshot](welcome-dark-1440.png) |

[Long enlarged content](welcome-200-long-top.png),
[enlarged actions and error](welcome-200-long-actions.png),
[narrow enlarged actions](welcome-200-long-390-actions.png),
[Dark error](welcome-error-dark.png),
[DOM geometry record](browser-checks.json).

## Limits and release gates

- The standalone host records callbacks. It does not perform actual setup,
  persist a theme, request permissions, start the interview or enable Awareness.
- The preview toolbar, its synthetic pending/error messages, long text and
  intent counter are development fixtures, not production UI.
- CSS preview zoom verifies enlargement/reflow, not native browser or sidecar
  WebView zoom. Actual browser-zoom shortcuts did not change zoom through this
  automation connection. Native zoom and sidecar coverage remain for ON-U-11.
- Reduced-motion CSS was inspected; OS preference switching and screen-reader
  speech were not manually tested. There is no perpetual or entry animation.
- ON-U-10/ON-B-11 registration does not exist on the baseline. The real
  absent/present/revert runtime matrix is **blocked**, not passed. Coexistence
  with ON-B-01 is not end-to-end journey integration.
- Full D/F/Q cutover and paid model behavior are outside this card. CI runs
  the wider repository suite; local validation was focused on affected code.

## Quick verification

Run `bun ui/src/onboarding-next/views/welcome/preview/serve.ts` from the
repository root, then open <http://127.0.0.1:4410/>. Switch Light/Dark; Tab
to **Set up Jarvis**, press Enter and check the toolbar shows one intent.
Use the toolbar to inspect Pending, Error, long content and 200% preview zoom.
No API key, sidecar or hosted brain is required.

Next card: **ON-U-02, Explain what Jarvis does**. It was not started here.
