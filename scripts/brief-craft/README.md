# Brief runtime craft verification (D32)

This suite inventories **988 required cases**, independent of feature availability:

- 19 room families × light/dark × expanded/rail × conversation closed/open × ready/long/empty/error: 608 cases.
- Each family at 1024, 1280, 1440, 1920, 800 and 390 CSS pixels with ready and long data: 228 cases. Both work and conversation surfaces are inspected at each width.
- Per family: 20 repeated conversation cycles, keyboard probe, main journey, screen reader, reduced motion, actual 200% browser zoom, sidecar WebView and approved visual reference: 152 cases.

`matrix.mjs` maps the existing isolated specimens and records a main journey for each room. It does not build replacement mock rooms. The workflow preview/draft registrations currently have no Body. Some specimens lack meaningful long/empty/error states. Those requirements remain **blocked**, never skipped or removed from the denominator. In particular, `no-usage` means unavailable provenance, not an empty memory detail; the Goals long example lengthens active goals only.

The harness can land before activation. Its fixture results **cannot authorize release**. D33 still requires D02–D31 enabled integration and the F28/Q22 activation and quality evidence. This PR changes no capability defaults or rollout flags.

## Local checks

```sh
bun install --frozen-lockfile
bun test ui/src/brief/verification
bunx tsc --noEmit
bun run build:ui
bun scripts/brief-craft/serve.ts   # BRIEF_CRAFT_PORT overrides 4422
```

`serve.ts` serves the built `ui/dist` on loopback. It has no database or credentials, rejects `/api/*`, permits only GET/HEAD and sends `connect-src 'none'`, so the page cannot open any connection. Open `http://127.0.0.1:4422/?brief=preview&specimen=billing&craft=1#/_brief_preview`. `craft=1` mounts bounded frame/input/long-task instrumentation in the **explicit fixture preview only**. “Capture craft trace” writes the current trace into a DOM output; it sends nothing externally and does not record input text. Normal previews and live rooms mount no recorder.

## Browser runner

Run `browser.mjs` from the documented CUA REPL with an already selected task tab and its viewport capability. It uses semantic locators, native CUA Tab/Escape input and read-only DOM inspection; no alternate browser driver, page injection or daemon access is needed. Supply `save(relativeName, bytesOrString)` to save artifacts in a dedicated directory. Each case checkpoints its own `.result.json`; `onResult` can also update an aggregate report. Keep batches to at most 24 layout/viewport cases or one room’s 20-cycle probe. The keyboard probe needs a CUA tab with native `pressKey`; a DOM-only tab must leave that case blocked.

```js
// In the initialized CUA REPL, using this checkout's absolute path:
const { requiredCases, newReport } = await import(root + "/scripts/brief-craft/matrix.mjs");
const { runCases } = await import(root + "/scripts/brief-craft/browser.mjs");
const { completeReport } = await import(root + "/scripts/brief-craft/report.mjs");
const report = newReport(fullGitRevision);
// Use small batches, inspect failures, and persist each result before continuing.
const results = await runCases({
  tab, viewport, baseUrl: "http://127.0.0.1:4422",
  cases: requiredCases().filter(test => test.room === "billing"),
  save, onResult: async row => { report.cases.push(row); await save("partial.json", JSON.stringify(report)); },
});
await save("report.json", JSON.stringify(completeReport(report), null, 2));
await viewport.reset();
```

After modifying an imported runner, reload its module in a fresh REPL or bundle it to a fresh temporary module path (`bun build scripts/brief-craft/browser.mjs --target=node --outfile=/tmp/brief-craft-runner.mjs`). Rebuild/reload the UI after source changes. Do not reuse results from a different implementation revision. The runner stops its batch on the first infrastructure/locator error; inspect it before resuming. A layout assertion failure retains its geometry and accessibility snapshot.

Automated checks assert the actual room's route and body, requested/effective sidebar, theme, conversation state, viewport, settled visible content, page/main horizontal overflow, and basic names for visible controls. Open conversation checks require the actual Pebble capability/open state, a visible nonzero surface inside the viewport/workspace, and visible reading/content, close button and composer bounds inside that surface. Hidden work in the compact single-panel layout only passes when this conversation surface is usable. Twenty cycles assert selection, draft text and opener focus survive every open/close, then capture frame intervals, input timestamps, long tasks and animations at rest. The workflow probe first selects a non-trigger node through native keyboard interaction, closes its settings while retaining selection, and checks its stable node ID in both the open and closed observations of every cycle. The trace retains these IDs; an empty selection cannot pass. The keyboard probe checks the skip link, twelve forward Tab stops and the account menu's keyboard/Escape/return behavior.

These are focused regression checks, **not a WCAG certification**. The name heuristic does not replace the browser's accessibility tree or a real screen reader. Page/main geometry does not prove every nested control is unobscured; canvas pan/zoom, vertically scrolling documents and dialogs require the journey review below. rAF intervals and long-task entries are not DevTools CPU/GPU traces or proof of 60fps. Keep failed, backgrounded, truncated or unsupported trace conditions visible.

## Required runtime review

For every room, retain the exact build/host version, capability/readiness evidence, browser or WebView identity, viewport, theme, shell state, source/selection IDs and artifacts. `matrix.mjs` supplies room-specific main journeys. Do not count “destination handoff” placeholders as destinations.

| Case | Required evidence and pass condition |
| --- | --- |
| Main journey | Run the listed journey on a disposable enabled account. Before/after IDs, receipt/status and focus show no duplicate action or lost selection. Exercise error recovery and confirm/cancel dialogs. All destination bodies must exist. |
| Screen reader | Record reader + browser/version and spoken names, roles, selected/expanded/busy state, live feedback, reading order and dialog focus. Traverse forward/backward, open/close chat, Escape/return from dialogs; no trap, unnamed action or lost focus. DOM snapshots alone do not pass this row. |
| Reduced motion | Enable the OS/browser preference; record the actual matching media query in the trace. Repeat the main journey and 20 cycles, verify immediate placement and no essential information depending on animation. A specimen's local “Reduce motion” override is supplementary evidence only. |
| 200% zoom | Set actual browser zoom to 200%, record browser zoom UI and before/after CSS viewport/device-pixel ratio. Repeat the main journey and dialogs at 1024/1280/1440/1920 host widths and a smaller sidecar. CSS transforms or merely halving a viewport do not pass. |
| WebView | Run the room journey and narrow/zoom/reduced-motion checks in the actual supported Jarvis sidecar, record host/WebView versions, focus transfer and external handoff behavior, screenshot and host performance trace. A browser embedded in a development tool is not the Jarvis WebView. |
| Visual reference | Compare the room's full-size light/dark and eight shell endpoints against native UI35 approved references (Figma file `eNfKeirIKLZLlZEasrurZa`, page `81:2`, coverage `898:379724`, handoff `898:379708`). Keep per-room screenshots and document reviewed differences. Capturing a screenshot does not constitute design approval or a pixel-diff pass. |

The existing narrow adaptation uses the rail below 700px and a single conversation surface when split layout cannot fit. Room text reflows and documents retain vertical scrolling; important controls must remain reachable. These inherited adaptations are recorded by the runner. New deviations from the approved desktop reference require explicit review; narrow checks do not establish mobile parity.

## Fail-closed evidence assessment

```sh
bun scripts/brief-craft/verify.mjs path/to/report.json FULL_IMPLEMENTATION_SHA
```

Exit 0 requires all required cases passed, unique and for the expected revision, with nonempty local evidence files and one enabled-capability receipt per room. Exit 1 means release blocked; exit 2 means invalid input. The verifier rejects unknown/duplicate/skipped/missing cases, stale revisions, missing artifact files and external/traversing artifact paths. `completeReport` fills unexecuted rows as blocked; it never invents passes. Evidence paths are relative to the report directory, including capability receipts.

The status of a harness's unit tests is separate from the release report. A successful test run of the verifier is not an all-green dashboard report. Human runtime observations must be recorded truthfully; this checker validates completeness and artifact presence, not the truth of an arbitrary attestation.

Rollback: remove the preview wrapper/import and these verification files, or revert D32. No migration, domain write, rollout or provider change is involved.
