# ON-U-02 verification

14 October 2026. Implementation head `641ed92c141a09f93a734bd18552e0b537107ddc`; target base `a02343c6cedb49769424237429de58a1081a634b`. Dedicated worktree `/home/vierisid/.cache/codex/jarvis-on-u-02`. The dirty primary product checkout and other implementation worktrees were preserved.

## Design and behavior

Inspected native Figma nodes `1097:16424` and `1097:68538` on the approved onboarding page. Read actual copy, position/size data and both theme fills. The explainer keeps the approved 48px monochrome pebble, three-part sequence, asymmetric cards, conditional Awareness sentence and self-directed alternative. Desktop group width is 840px; the 660px alternative and navigation remain centered. At narrow widths, the ordered cards become a vertical sequence. Tablet descriptions align below two-line titles. Height is content-driven and the view scrolls inside the real fixed-height application shell.

No permission request or setup mutation occurs here. Back and Continue call injected callbacks only. No legacy wizard, onboarding gate, production route or provider was edited. No Figma design changes were made.

## Executed checks

| Check | Evidence |
| --- | --- |
| New view plus existing onboarding tests | 94 passed, 0 failed; seven new tests |
| TypeScript | `bunx tsc --noEmit` passed; repeated by normal commit hooks |
| Production UI | `bun run build:ui` passed |
| Explainer bundle | `bun build ui/src/onboarding-next/views/explainer/preview/index.html --outdir /tmp/on-u-02-preview-build` passed; final code also bundled in the combined candidate |
| Repository hooks | EE boundary, migrations, 100 templates, package contents, related tests, typecheck passed |
| Browser matrix | Light/Dark at 1440x1100, 768x1024 and 390x844; fonts loaded, no horizontal overflow, 44px controls; see `browser-matrix.json` and named PNGs |
| Keyboard | Enter on Continue and Space on Back produced one intent each; focus visibly outlined; narrow internal scrolling brought controls into view |
| Pending | DOM test retains control identity/focus and suppresses both callbacks; browser shows pending status and aria-disabled actions. Browser automation declines activation of aria-disabled buttons, so guard correctness is proven by the DOM test |
| Error | Plain-text alert; retry emits a new intent; no injected markup |
| Enlarged content | 390px viewport, long copy, 200% CSS preview zoom: controls reachable through internal scrolling, Continue retains a complete label |
| Reduced motion | Diagram has no animation; no-motion preview verified; production reduced-motion media rule inspected |

Existing build warnings about `@theme` and `@tailwind` remain. A browser HMR reconnect warning was observed when the local server was deliberately restarted; no product error was observed.

Browser testing caught two issues and both were corrected/retested: theme changes originally animated the button surface independently of its text; extremely enlarged content originally compressed Continue into letters. Theme surfaces now change together, and the action row wraps before shrinking labels. The final screenshot `dark-390-long-200pct-actions.png` shows the corrected enlarged control.

## Combined and removal checks

Temporary candidate `/home/vierisid/.cache/codex/jarvis-on-u-02-coexistence` combined this implementation with ON-U-01 PR #1051 at `30664ba286ef1697548c3b573aeb7fa224b5dc91` and ON-B-01 PR #1050 at `e7a5e668e3287231197dc238978e2bb9bb86703e`.

- Clean merge tree `02c6a67f6ebce7d9ba3ffeafc560ef2f28f198a2`: 45 tests, TypeScript, production UI and explainer bundle passed.
- Removed only this explainer folder from that candidate. Tree `5edbe2fe362e24678562d40f83037999a999a47b`: 38 remaining tests, TypeScript and production UI passed.
- Restored the explainer and aborted the temporary merge. The temporary checkout returned clean to `641ed92c`. No sibling commit was added to the delivery branch.

This proves module coexistence and removal at the build/test boundary. It does not prove actual host discovery, missing-provider runtime fallback or Welcome-to-explainer navigation. ON-U-10 and ON-B-11 are absent, so those cases remain blocked. A complete D/F/Q candidate, real OS permission behavior, native browser/WebView zoom and screen-reader output were not exercised.

## Verify quickly

Run `bun ui/src/onboarding-next/views/explainer/preview/serve.ts`, then open `http://127.0.0.1:4411/`. Read the sequence; try Light/Dark, Back/Continue, Pending/Error and long copy. The toolbar is a development fixture and reports navigation intents without pretending to navigate the assembled journey. The production flow stays unchanged until its later assembly and release gates pass.
