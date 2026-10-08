# D-24 evidence

Captured on 8 October 2026 from the isolated Goals specimen and signed-in native Figma prototype.

- `focused-tests.log`: 28 model/controller/React tests, 116 assertions.
- `brief-regression.log`: 547 passing Brief tests, 2 existing optional skips, 4,986 assertions.
- `typecheck.log`: empty successful TypeScript output.
- `build.log`: successful UI build; inherited @theme/@tailwind warnings.
- `browser-checks.json`: observed results, dimensions and limitations. This is an observation record, not a portable browser automation script.
- `final-active-light.jpg`, `final-active-chat.jpg`: final active composition. The latter shows the simulated seven-partner update.
- `{light,dark}-{expanded,rail}-{closed,chat}.jpg`: eight shell combinations. All preserve goal identity, readable horizontal path and theme.
- `completed-light-wide.jpg`, `completed-dark-chat.jpg`: completed summary/milestone treatment.
- `figma-*.jpg`: reference prototype captures. They are not Figma exports and do not establish pixel identity.
- `long-1024-closed.jpg`, `score-only.jpg`: long-content and honest legacy-score examples.
- `long-1024-chat.jpg`: inherited narrow-shell conversation-only state, not a side-by-side long-goal proof.

Keyboard checks: ArrowRight moves focus to Completed without selecting it; Enter activates. Enter opens Data basis. Ten Pebble close/open cycles preserved selected goal and typed chat text. A settled wide 6-to-7 update leaves every path-card rectangle unchanged and retains the first three values. An earlier compact sample had less than 0.5px residual shared-shell reflow; this is recorded instead of claiming exact stationary geometry for that sample.

The full Brief suite covers the shared controls/motion primitives. No OS reduced-motion emulation, live backend verification, all-browser or screen-reader certification is claimed. Fixtures are illustrative and do not authorize any real action. See `../../D-24.md` for integration gates and manual reproduction steps.
