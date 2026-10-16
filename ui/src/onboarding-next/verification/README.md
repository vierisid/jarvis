# ON-U-11 — Onboarding visual acceptance

This optional, development-only suite inventories all nine controlled views and
four journeys without importing absent modules. It owns no production registration,
provider, workflow engine or component repair. Missing modules remain **blocked**
in the fixed denominator. A green harness test is not a green release report.

## Build and discover

Use the checkout's pinned Bun (this base: 1.4.2):

```sh
bun test ui/src/onboarding-next/verification
bunx tsc --noEmit
bun run build:ui
bun ui/src/onboarding-next/verification/serve.ts --build
bun ui/src/onboarding-next/verification/serve.ts
```

Open http://127.0.0.1:4431/. `ON_U_11_PORT` overrides the port. Build output lives in
a unique temporary directory, printed with the exact revision/tree, dirty state
and discovered inventory. Restart the server and reload after source changes.
A dirty checkout is useful for development but cannot produce release evidence.
The loopback server allows GET/HEAD only, has no API and denies network connections
through CSP. No credentials, database or live user data are used.

Discovery validates the pinned six-key manifests, relative entries, versions,
requirements and regular contained files before generating imports **in memory**.
It does not execute manifests, fetch code, register capabilities or write catalogs.
No package scripts or central U10/B11 files are changed. Empty, single, partial,
full and physically removed modules use the same build. The base's ordinary UI
build never imports this verifier or its fixtures.

## Coverage and meaning

`matrix.ts` is the fixed case inventory. Every state has its U owner. Layout cases
cover light/dark at 390/768/1440 CSS pixels, and expanded/rail on the tour, Pebble
and result. It includes every tutorial room/contour, open/closed Pebble, long copy,
pending/errors, interview recovery, missing connections, all build phases,
disconnect/cancel/timeout and saved/deleted results. Separate rows require keyboard,
actual 200% zoom, actual reduced-motion preference, screen reader, native WebView,
approved visual reference and runtime binding for every view in both themes.

`fixtures.tsx` supplies only serializable illustrative data to the **actual views**.
The tutorial background is explicitly an illustrative slot; contour/layout checks
cannot certify real room integration. Pebble uses the existing D06 layout when
present. No replacement D18 canvas is fabricated: result-ready/review/missing-input
and long-canvas cases remain blocked until a real adapter is supplied. Missing
canvas and deleted/pending recovery can still be inspected with U09 present.

The optional journey fixture uses U10's actual entry, view discovery and session,
with its explicitly synthetic provider fixture. No absent-result placeholder is
accepted. It extends that fixture with deliberate failed-build/retry and tour
replay controls. Phase advancement is a visible test control, never elapsed-time
success. These controls are not production retry/replay implementations.
The four named journeys run at desktop/compact in both themes:

- welcome-to-result: verified fixture Google, written answer, every room, Pebble,
  prompt, four observed phase events, disabled result, review, dashboard.
- skip-connection-interview: explicit skips, then the same full remaining path.
- failed-build-retry: failed terminal build, explicit retry, then saved result.
- tour-replay: return from activation to Today, deliberately skip the replay and
  verify activation remains available before building.

The journey trace retains each endpoint, focus, theme, commands and screenshot.
Successful fixture walks remain blocked for runtime acceptance while actual D room
and canvas bindings are absent. ON-B-13 owns durable/provider acceptance; it must
join this evidence with U10/B11 and D/F/Q gates on one exact candidate.

## Browser runner and evidence

`browser.ts` uses documented CUA semantic locators, native keyboard and read-only
DOM observations. Run it from the CUA REPL with a selected local test tab and the
viewport capability. Compile these TypeScript entries for the REPL first:

```sh
bun build ui/src/onboarding-next/verification/{browser,matrix,report}.ts \
  --target=node --outdir=/absolute/private/evidence/runner
```

Import those modules in the REPL. Read the server's printed `candidate.json` from
its output directory. Create a report with schemaVersion 1, that candidate and
inventory, scope `fixture`, empty cases and gates. Supply a `save(path, data)`
function that writes beneath a dedicated evidence folder and returns
`{path, sha256: reportModule.hash(data)}`. Use small batches (at most 24 cases) and
persist results after each case:

```js
await browserModule.runCases({
  tab, viewport, baseUrl: 'http://127.0.0.1:4431',
  cases: matrix.requiredCases().filter(c => c.kind === 'layout').slice(0, 24),
  candidate: report.candidate, inventory: report.inventory, save,
  onResult: async row => {
    report.cases.push(row);
    await fs.writeFile(evidenceDir + '/partial.json', JSON.stringify(report));
  },
});
// Use runJourney({...same ports, test}) for each journey and retain its row.
await reportModule.writeReport(report, evidenceDir);
await viewport.reset();
```

Do not continue blindly after infrastructure/locator failures. Inspect the current
screen, fix the harness if necessary, and rebuild on a new clean candidate before
recording final evidence. Never mix revisions or silently replace failed outcomes.
`complete` fills unexecuted rows as blocked. The generated `index.html` links the
screenshots, metrics/accessibility snapshots and four replay URLs. `report.json`
is the machine-readable handoff. Failed rows are bounded repair cards: owner,
exact case/viewport/state, observation and artifacts. Repairs belong to that owner.

The geometry check detects horizontal overflow, hidden/clipped ancestors and
obscured visible controls. Scrollable content is not presumed clipped solely
because it is currently below the fold. Names are a DOM heuristic, not an axe or
WCAG certification. Keyboard probes traverse forward/backward beyond the view;
they do not replace full assistive-technology review. Screenshots and matching
theme attributes alone do not establish visual approval. Record observed design
differences against native Figma, not against another screenshot of the fixture.

For manual/runtime rows, retain a screenshot and `.review.json` containing the
exact `candidate`, `caseId`, nonempty `environment` (browser/WebView/reader and
versions) and `observations`. For 200% zoom, capture the browser zoom UI and
before/after CSS viewport/DPR, then traverse controls; CSS transforms/viewport
halving cannot pass. For reduced motion, verify the actual media query and
interaction, not a component prop. For screen readers, record spoken names, live
feedback, order and focus escape/return. Native permission/provider checks remain
blocked when the relevant runtime/access is unavailable.

## Fail-closed report verification

```sh
bun ui/src/onboarding-next/verification/verify.ts /path/to/report.json FULL_CANDIDATE_SHA
```

Exit 0 requires a runtime report, every required row passed, a clean exact
revision/tree and same-candidate U10/B11/B13/D/F/Q gate receipts. Exit 1 means
blocked/failed evidence; exit 2 is invalid input. The verifier rejects missing,
unknown, duplicate, stale or skipped rows; absent views cannot pass. Artifacts
must be local nonempty regular contained files, with matching SHA-256 digests.
Metrics/traces/reviews also bind their case and candidate inside their content;
a renamed old file is not fresh evidence. Gate JSON contains owner, revision and
outcome. The verifier validates evidence integrity, not the truth of arbitrary
human attestations. Fixture reports always remain release-blocked.

Approved reference: Figma `eNfKeirIKLZLlZEasrurZa`, page `1097:16402`, contour
checkpoint `2410205462365531104`. Today Light `1097:16634` and Dark `1097:68695`
were inspected; this is not approval of every state or a full visual diff.

Rollback removes this verification folder and stops its local server. It changes
no release flag or stored journey/profile/connection/job/draft data. Retain the
previous onboarding entry and the runtime owners' default-off gates. ON-B-13 is
the next card; this PR does not implement or activate it.
