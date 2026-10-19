# ON-U-11 - onboarding fixture preview

A development-only gallery of the actual onboarding views (ON-U-01..09) in every
fixture state, plus four replayable journeys through U10's assembly. It uses
synthetic providers only: no API, no credentials, no live user data. Nothing here
is imported by the production UI build.

## Run

```sh
bun ui/src/onboarding-next/verification/serve.ts          # build and serve on 127.0.0.1:4431
bun ui/src/onboarding-next/verification/serve.ts --build  # build only, prints the output folder
```

`ON_U_11_PORT` overrides the port. The build goes to a temporary folder that the
server removes on exit. The server is loopback-only, answers GET/HEAD only, and
its CSP denies fetch/socket connections; it allows only the Google Fonts hosts
that `ui/index.html` already uses. Restart it after source changes.

## What it shows

- `?case=<view>--<state>--<theme>--<sidebar>` renders one view with the props from
  `fixtures.tsx`. `matrix.ts` lists the states per view; the tour, Pebble tour and
  result also render in the rail sidebar. Tutorial rooms are illustrative slots,
  not the real rooms.
- `?journey=<name>` (optionally `&theme=dark`) mounts `OptionalOnboardingEntry`
  with U10's `previewConfiguration({ mode: 'full' })`, extended by `journey.ts`:
  - `welcome-to-result`: Google already connected, then the full path.
  - `skip-connection-interview`: Google left idle so the skips can be exercised.
  - `failed-build-retry`: the build fails until Retry, which switches to a new job id.
  - `tour-replay`: a control returns the journey to the tour.

  Build phases advance only through the "Advance observed build phase" control.
  The retry and replay controls are fixture behaviour, not production paths.

## Tests

`fixtures.test.tsx` runs in the normal suite: every fixture case renders its
actual view, named states reach the view state they claim, the journey extensions
behave as described, and the preview bundle builds.
