# ON-U-08: Build progress and recovery

Optional presentation module, unregistered and inactive. It imports no sibling
onboarding module and no unmerged D/F/Q code. ON-U-09 owns the actual
result canvas; this view hands the exact verified reference to the host.

## Approved design

Figma file eNfKeirIKLZLlZEasrurZa, page 1097:16402, loading node 1097:48188.
Checkpoint: Onboarding · Tutorial focus contour · 2026-10-14,
version 2410205462365531104. Live Light loading composition inspected. The title,
workflow name, quiet phase rows, active wash and official mark follow that screen.
The roadmap adds an explicit saving phase and recovery controls not depicted in
the happy-path Figma frame. Dark follows established onboarding/Brief tokens.
The mark inlines the official usejarvis logo path unchanged. No logo redraw or
native Dark verification claim. Figma's timed completion is deliberately not a production timer.

## Host contract

BuildView receives a serializable BuildModel, onIntent callback and optional
reducedMotion preference. Mount within a sized setup viewport using
--on-build-height (100dvh by default; 100% for a sized host).

Bind journeyId/jobId/requestId to the accepted request. Incoming status is scoped
to that job and has its own monotonic revision. Phase updates are snapshots,
including all confirmed completedPhases. Missing phases are not invented from an
array index. Invalid, wrong-job, equal/older and terminal-regressing status updates
are ignored as presentation defense. B-08 still owns durable ordering and must
reject stale events before projecting them. A genuinely new attempt uses a new job
scope; never reuse the terminal job scope to simulate a fresh build.

The separate model.revision acknowledges control commands. Advance it only after
the host has reconciled a command and supplied authoritative cancellation/status
observations. Do not advance it for phases, theme, local layout or transport alone.
Each intent carries the bound identities, control/status revisions and commandId.
No client identity grants authorization. The host derives user/project scope and
reserves/deduplicates commands, including across reloads and multiple clients.

The action flags are explicit host readiness/permission signals, not new product
permissions. The view intersects them with its current state. A resolved callback
means delivered, not completed: controls remain pending until acknowledgement.
A rejected callback shows a safe message and permits status reconciliation;
it does not retry workflow creation. Repeated failed status checks reuse the
same command. A pending cancellation can be reconciled without waiting for its
transport promise; late errors from the superseded command are ignored.

Transport disconnection and timedOut=true with a nonterminal status mean unknown
progress. They never become failed/cancelled because a local timer expired.
A failed status plus timedOut=true is the provider's confirmed timeout outcome.
Cancellation requested/acknowledged is an observation; only a cancelled status
renders cancellation as terminal. A success racing cancellation is retained.

## Verified result and navigation

A result in state ready must come from B-10's authenticated durable read, not a
composition validator or fabricated client reference. Supply matching job and
request IDs, nonempty composition/flow/version IDs, actual readiness and verified
disabled activation. Readiness needs_input can still be a real saved draft;
opening it does not authorize running it.

Only a succeeded status plus that verified reference and openResult readiness
automatically emits open_result once for the same reference in this mount. There
is no success timer or simulated percent. The host performs one stable navigation
and owns destination focus; it must revalidate authorization/version if necessary.
A rejected navigation offers an explicit same-reference retry, never a build
retry. Withdrawal/replacement invalidates an old navigation failure. A changed
job unmounts all previous local state.

A real saved reference attached to a failed/cancelled job is offered as explicit
Open saved draft recovery, not automatic success. Never discard a draft that won
a cancellation race. Explore/Provide input are navigation intents retaining the
original host-owned request/job; the host applies durable journey semantics.

The view never fetches, starts sockets, calls a model, creates a workflow, grants
a connection, enables, publishes, tests or runs anything. Replay/resume persistence
belongs to B-08/B-10 and U-10/B-11. Screen appearance is not backend evidence.

## Accessibility and motion

The heading receives focus on job entry, not phase updates. Existing request
expansion and focus survive theme/phase changes. If an action disappears while
focused, focus moves to the next available recovery action or heading; focus
elsewhere is not stolen. Controls have at least 44px targets. Long content wraps
and the viewport scrolls.

Only the current working pebble breathes; disconnected, cancelled, input and
terminal states stop it. The explicit reducedMotion prop and OS media query
disable it without hiding status. Completed rows remain still. Native WebView,
screen-reader, native zoom and OS preference verification remain separate.

## Preview and checks

Run: bun ui/src/onboarding-next/views/build/preview/serve.ts
URL: http://127.0.0.1:4417/
Tests: bun test ui/src/onboarding-next/views/build ui/src/v2/onboarding
Types: bunx tsc --noEmit
Build: bun run build:ui
Preview build: bun build ui/src/onboarding-next/views/build/preview/index.html --outdir /tmp/on-u-08-preview-build

The preview's Scenario, Next phase, Confirm cancellation and Verify saved draft
controls are explicit illustrative host events. No elapsed time creates success.
Stale update injects revision zero. Fail next action demonstrates uncertain command
delivery/navigation errors. The result destination is a labeled handoff, not a
fake canvas or real workflow. Restart fixture resets demo data, not a production
job. Enlarged 200% uses CSS zoom, not native browser zoom.

## Activation and rollback

Enable only after U-10, B-08 events, B-10 durable result reads, B-11 registration
and a verified D/F/Q candidate. Missing providers/discovery are blocked integration
evidence, not mocked production success. Disable this optional view before
reverting it after registration; retain request/job/draft data and the legacy entry.
