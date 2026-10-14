# ON-U-03 verification

Code head: `aaca32599b812bfacae8746ddb2e1a1d27621e55`.
Base: `5024ea7455a5613be0514475be32c0dee6de0edd`.
Date: 14 October 2026. This is an inactive UI module, not an OAuth release.

## Requirements and observed evidence

| Requirement | Evidence | Outcome |
| --- | --- | --- |
| Single approved Google row | Live Figma 1097:16449 and 1097:16490 inspected; no Telegram in view | Passed |
| Controlled provider states | 14 DOM tests cover every vocabulary state, denied consent and external-window failure | Passed |
| No optimistic connection | Connect/cancel only emit intents; only injected connected displays grant/check | Passed |
| Actual granted access | Provider text rendered, including calendar-only example; no assumed send rights | Passed |
| Deliberate skip | Distinct callback, available while waiting; no UI mutation or grant | Passed |
| Stable focus and controls | Native keyboard Enter/Space/Enter retained the connect/cancel/retry target; DOM tests retain focus across navigation and theme updates | Passed |
| Compact feedback | All ordinary connection states at 390px share card y=436/h=202 and action y=694/h=44 | Passed |
| Themes and widths | 390x844, 768x1024, 1440x1100, both themes; all minimum hit heights 44px | Passed |
| Enlarged/long content | Long account at 390px and CSS 200%; actions reached by keyboard, no component horizontal overflow | Passed |
| Reduced motion | No-motion fixture produces 0s transition; production media query inspected | Passed for fixture; native OS preference not run |
| Native WebView/assistive tech | Not represented by DOM or CSS zoom tests | Not run |
| Real provider and assembly | ON-B-03, ON-U-10 and ON-B-11 absent | Blocked |

## Commands run

- `bun install --frozen-lockfile`: passed, no lock/dependency changes.
- `bun test ui/src/onboarding-next/views/google ui/src/v2/onboarding`: **101 passed, 0 failed**, including 14 new tests.
- `bunx tsc --noEmit`: passed.
- `bun run build:ui`: passed.
- `bun build ui/src/onboarding-next/views/google/preview/index.html --outdir /tmp/on-u-03-preview-build`: passed.
- Normal pre-commit hooks: EE imports, rollback-safe migrations, 100 templates, package contents, 14 related tests and typecheck passed.
- Temporary combined candidate with exact U01/U02/B01 heads in the receipt: **59 tests**, typecheck and both builds passed.
- Remove only Google view from candidate: **45 tests**, typecheck and production build passed. Restored and aborted the candidate merge, leaving it clean.

The combined check proves module coexistence/removal, not registration or runtime integration. No actual sign-in, backend write, permission grant, production route change or deployment occurred. No database was started. Preview uses port 4412.

## Corrections during implementation

- Reserved feedback space for two lines so mobile status changes do not shift buttons.
- Kept the compact row height stable after connection confirmation.
- Scoped disabled hover surfaces so inherited v2 hover styling cannot produce a Light surface in Dark.
- Kept account details below the access description, with reserved space and clean long-address wrapping.

## Limits and warnings

Existing build warnings for `@theme` and `@tailwind` remain. The development browser recorded one Bun "Unknown HMR script" error while source/styles were being edited. A fresh in-app browser tab then loaded and completed keyboard Connect/Cancel with zero captured console errors or warnings. This does not certify the production WebView.

No current assembly exists to exercise optional discovery or provider removal at runtime. Those cases stay blocked, not passed with mock behavior. ON-B-03 must verify callback correlation and late grants; ON-U-10 must map callbacks and manage cross-page focus. The view renders safe provider messages but does not perform server redaction.

## Quick check

Open http://127.0.0.1:4412/. Connect -> Cancel sign-in -> Try again. It remains waiting until you choose `connected` in the fixture selector. Inspect denied/window/expired/unavailable, Light/Dark, Long account and navigation Pending/Error. These are illustrative state transitions, not Google authorization.
