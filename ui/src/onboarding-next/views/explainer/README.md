# ON-U-02: What Jarvis does

An independently mergeable, controlled onboarding explanation. Source: Jarvis onboarding UI/UX roadmap v1, 14 October 2026. Figma file `eNfKeirIKLZLlZEasrurZa`, page `1097:16402`, Light `1097:16424`, Dark `1097:68538`; checkpoint **Onboarding · Tutorial focus contour · 2026-10-14**, version `2410205462365531104`.

## Host contract

`ExplainerView` receives a serializable `ExplainerModel`, `onBack` and `onContinue`. The host supplies the theme and ready/pending/error state. Each enabled activation emits one intent. Pending keeps the same focusable controls and suppresses both intents. The host must set pending while resolving asynchronous navigation and must present safe, user-facing error text.

The view is an ordinary labelled, vertically scrollable section, not a modal. Its default height is `100dvh`; an embedded host can set `--on-setup-height: 100%` inside a bounded flex/grid area with `min-height: 0`. It does not steal focus on mount. ON-U-10 owns focus transfer when changing pages.

There are no service calls, permission requests, setup writes, route imports or imports from sibling onboarding PRs. "With Awareness on" is conditional, not an active-observation indicator. The self-directed alternative explains the later Workflows room; it does not skip setup. The three cards are an illustrative sequence and need no animation to make sense.

## Integration and rollback

The static manifest declares `explainer-view.v1` and requires `journey.v1` and `setup.v1`. It is not registered or enabled. ON-U-10 owns the optional UI host, ON-B-01 the journey, ON-B-02 setup/capability truth, and ON-B-11 runtime assembly. Keep the live wizard and operating-system permission protections intact here. The later host removes the wizard's Permissions page, not the operating system's permissions.

Merge after: no sibling onboarding PR. Enable only when ON-U-10 and the required providers are ready, Awareness availability is truthful, and the combined D/F/Q candidate is verified. Until then the existing onboarding remains unchanged. Reverting this unregistered module needs no data rollback. After registration, disable the optional entry before removing it.

## Quick verification

From this worktree:

```sh
bun ui/src/onboarding-next/views/explainer/preview/serve.ts
```

Open `http://127.0.0.1:4411/`. The development-only toolbar changes Light/Dark, Ready/Pending/Error, long copy, CSS preview zoom and a no-motion example. Back/Continue report intents in that toolbar; they do not claim to navigate a live journey. The fixture loads the real merged global and button styles. `ONBOARDING_PREVIEW_PORT` can select another unused local port.

Check the three cards, the build-your-own alternative, keyboard activation, and narrow-screen scrolling to both actions. Pending must not emit an intent. At 200% CSS preview zoom, very narrow action rows stack without splitting Continue into letters. This zoom fixture does not verify native browser/WebView zoom or screen-reader behavior.

```sh
bun test ui/src/onboarding-next/views/explainer ui/src/v2/onboarding
bunx tsc --noEmit
bun run build:ui
bun build ui/src/onboarding-next/views/explainer/preview/index.html --outdir /tmp/on-u-02-preview-build
```

The delivery receipt and evidence are under `docs/onboarding-delivery/ON-U-02.json` and `docs/onboarding-delivery/evidence/ON-U-02/`. Missing optional assembly is recorded as blocked, never counted as a runtime pass.
