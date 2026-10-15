# Optional onboarding UI assembly (ON-U-10)

The production `OnboardingGate` keeps its complete legacy branch by default.
The new host has no enabled production configuration, release decision or fake
feature bindings. This card supplies discovery, gate selection, sequencing and
adapter ports; it does not certify a live end-to-end onboarding release.

## Discovery

`bun run generate:onboarding-ui` reads only the nine directories in `contract.ts`.
Manifests have exactly six v1 keys and pinned IDs, capabilities, requirements and
`./index.tsx` entry points. Files must be regular, contained files without
symlinks; manifests are limited to 4 KiB. View requirements are backend-only, so
there are no view dependency cycles. Discovery never executes a view.

The committed `generated/catalog.ts` contains literal lazy imports for present
modules only. After adding/removing a module, regenerate and commit it. The
pre-commit hook, `bun run check:onboarding-ui` and the CI test reject stale output.
This follows the runtime catalog convention: install/start/build never generate
source files, and published packages need only the compiled UI. Empty, single,
partial and full registries compile; malformed manifests fail discovery.

## Selecting a journey

A trusted `onboarding` prop on `OnboardingGate` supplies `Configuration`. It must
provide an explicit enable flag, exact backend/frontend/sidecar candidate and
release-owner decision, all nine views, all ten ready B capabilities, and the
required local feature bindings. Diagnostics is optional. URL parameters,
local storage and module presence cannot enable the journey. The default-off
path makes no new network calls, loads no views and creates no adapters.

Before entry, 404, unauthorized, invalid schemas, unknown install mode, absent
modules, failed imports, incomplete bindings or blocked release retain the whole
legacy experience. Once selected, the host stays on the new journey. Later
failures mask the view with bounded reconnect recovery, preserving scoped draft
records. It never falls into the old wizard midway through a journey. Scope,
journey or revision regressions require recovery instead of replacing the screen.
Configuration is selected once per mount; each operation rechecks readiness.

The approved order is welcome → explainer → Google → written interview → room
tour → Pebble demonstration → activation → build → saved result. Self-hosted
pending setup uses the injected existing provider-setup port after the explainer.
Hosted setup calls B02 completion and verifies its acknowledgement before Google.
The welcome Exit control leaves this UI mount without marking durable completion.
B01 allows the durable Explore action at activation. Finishing/skipping a tutorial
keeps activation visible; old tutorial flags cannot dismiss it. Result completion
uses B01's guarded `finish` transition, never a Talk request or workflow run.

## Wire boundary and feature adapters

`transport.ts` implements the B11 v1 status and four core journey/setup operations
at `/api/onboarding-next/v1`. Commands use `{schemaVersion:1,input}` and responses
use `{schemaVersion:1,result}`. Status is a versioned GET. Cookies stay same-origin,
redirects are rejected, caching is disabled and response reading is bounded to
five seconds/1 MiB. No client field grants authority. Timeout or cancellation is
an uncertain observation, not rollback; the host never automatically retries a
mutation. Reconnect rereads authoritative state.

Each feature binding exposes `available()` and a fresh adapter factory. Factories
must be inert and tolerate React StrictMode recreation. Adapters validate owner
responses, map serializable view models, supply trusted local render ports, and
own scoped drafts, event ordering, cancellation and idempotency. `available()`
includes required services and renderers, not just source presence. Adapter
subscriptions request an authoritative refresh; only the active feature is read.
Commands receive server-returned journey identity/revision plus the session's
abort signal. An adapter must reconcile a timed-out operation before permitting
another attempt, preserving its original request key/body. Disposal stops its
subscriptions and releases resources without deleting durable records.

| Binding | Model / local ports | Commands from host |
| --- | --- | --- |
| Google | U03 connection model | connect, cancel(exact attempt), skip, continue |
| Interview | U04 session/turn/cursor/facts and saved draft | answer, retry, skip |
| Tour | U05 tour model; existing isolated room renderer | U05 navigation intents |
| Pebble | U06 tour model; existing sandboxed Pebble adapter | U06 navigation intents |
| Activation | U07 intent/build state and saved request | create, recover, connection intents |
| Build | U08 ordered events and durable result reference | cancel, resume, retry, open_result |
| Result | Proposed U09 model and canvas port | review; finish is handled by B01 |
| Self setup | Existing provider setup model and `View` port | complete, back |

Google skip/back cancels through its owner before navigation. Interview Continue
and result Finish remain guarded by B01. Back/Explore from activation persist the
current draft first. Render callbacks carry the current journey/revision/view key;
old callbacks and overlapping actions cannot advance a newer screen. Focus moves
to the new heading after saving, while background updates preserve input focus.
The build's automatic result callback waits until the host can accept it.

`createDraftStore` is an optional per-tab storage helper, keyed by server scope,
journey and draft kind. It never stores authority, release permission or progress.
Corrupt/future/unwritable records block the action without overwriting text. The
adapter owns the draft shape and stable request identities.

## What remains before activation

U01–U08 are present. U09's `ResultView` export and `onReview`/`onContinue` mapping are
reserved proposals to confirm when that card lands; the result view/canvas is not
implemented here. Production feature adapters are deliberately unbound. They must
connect existing B owners and approved D room/Pebble/canvas renderers as the missing
providers arrive. B11 currently binds real journey/setup only; Google and interview
need additional host services and B05–B10 are missing. Completing these adapters,
U09, U11/B13 and candidate-bound D/F/Q release evidence is required before cutover.
Source discovery alone must never satisfy those checks.

## Verification and preview

```sh
bun run check:onboarding-ui
bun test scripts/onboarding-next-ui-manifest.test.ts ui/src/onboarding-next ui/src/v2/onboarding
bunx tsc --noEmit
bun run build:ui
bun ui/src/onboarding-next/host/preview/serve.ts
```

Open `http://127.0.0.1:4420/`. The isolated preview uses the real present views and
D06 Pebble layout with synthetic providers, illustrative room content and a clearly
labelled U09 result slot. It does not access accounts, a model, a daemon or a workflow
engine. Advance build phases manually; elapsed time never produces success. Check
partial/empty/disabled fallback, Google/interview skip, tutorial→activation, draft
retention through Disconnect/Restore/Reconnect and the exact fixture result IDs.
The toolbar resets are preview controls, not production release controls.

Tests cover missing modules/capabilities, old-server envelopes, strict mount
lifetimes, focus, retained activation/drafts, stale identities, cancellation,
stream deadlines and exact result handoff. The optional runtime compatibility test
uses B11's real route/envelope code with explicit synthetic service bindings.
Missing B11 skips that combined check rather than claiming it passed. Existing
legacy endpoint tests verify old clients remain supported by the new runtime.
Live Figma and live provider/canvas verification are not claimed by this fixture.

Rollback uses the default configuration or reverts the gate wrapper, preserving
the legacy body. Regenerate the catalog when removing a view. Keep all additive
journey, interview and draft data; rollback performs no token revocation, deletion,
workflow creation, run or enable action.
