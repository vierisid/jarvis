# ON-U-05: highlighted room tutorial

Optional controlled UI. This module does not register itself or replace the released onboarding wizard.

## Design and scope

Native Figma file eNfKeirIKLZLlZEasrurZa, page 1097:16402, checkpoint
“Onboarding · Tutorial focus contour · 2026-10-14”, version 2410205462365531104.
All twelve live prototype cards were inspected. Each descriptor records its node.
The card keeps the blue 2px inside contour, sharp upper-right corner, restrained
shadow and the approved copy, adjusted where the design promised behaviour the
product does not have (Memory cannot forget a fact, approvals are approve/deny,
Awareness asks before drafting). Dark uses the approved Brief material family.

The order is Today, Workflows, Opportunities, Needs you, Goals, Memory,
Connected workspace, Authority, Profile, Settings, Billing, Pebble. The final
primary label is Open Pebble, not Finish. ON-U-06 owns the subsequent reflow.

## Host contract

- Pass a complete `TourModel` and `onNavigate`. B06 owns durable session,
  progress, restoration and legacy migration. These are structural view types,
  not new server endpoints or persistence schemas.
- Each callback contains session, originating step, revision, action and optional
  destination. It is an intent, never proof of saved progress.
- The host must reject stale intents and supply a new revision for every
  acknowledgement, failed attempt or retryable refresh, even at the same step.
  The view keeps the current step and locks repeat actions until that revision.
  A rejected/throwing callback unlocks with a local error; a resolved callback
  alone does not unlock or advance.
- Skip and Open Pebble are separate handoffs. Neither marks onboarding complete.
  Preserve the first-workflow activation after the tour, including when skipped.
- Unknown IDs/revisions/phases and missing navigation fail closed. Missing rooms
  leave Back and Skip available when the session is valid; Next stays disabled.
- On a new session/step, focus moves to the same primary button, or the title
  when advancement is unavailable. Once the room and navigation become ready,
  the primary receives focus only if the user has stayed on that fallback title.
  Leaving the title cancels recovery, including when the user returns to read it.
  Theme/sidebar-only updates retain focus.
  The host must restore focus when unmounting the tour or entering U06.

## Room renderer and safety

Inject `TourRoomRenderer` with `isolation: "fixture-only"`. Its `renderRoom`
receives the descriptor, theme/sidebar, tutorial mode, disabled effects and card
placement. It returns ready content or unsupported/loading/error.

When D rooms are present, reuse their actual presentation components with
in-memory sample bindings. Do not copy their layouts into this module.
Never pass a live room root: it may subscribe, mutate on mount, load private
content, create portals or attach global shortcuts. The adapter must be pure
apart from local rendering, with no real services, account state, storage,
websocket, workflow, OAuth or global action bindings.

The room subtree is inert, hidden from the accessibility tree and pointer
interaction, with click/submit capture as an additional guard. This prevents
ordinary DOM actions, not arbitrary JavaScript or out-of-tree portals. The
isolation declaration is a trusted-host contract, not a security sandbox.
An always-visible Guided tour label identifies all displayed content as a sample preview.
Renderer throws fail closed and show a bounded unavailable state.

On wide screens, keep the highlighted subject above/outside the card's
lower-start footprint (648px wide, sidebar + 40px inset, 36px bottom gap).
At <=1024px width or <=800px height, the room occupies its own scrollable row
and the card reserves separate space. Do not scale the dashboard to fit.
Use `sidebarWidth` only if the owning shell differs from 232px/72px.
The real D-room host must verify each subject's visibility before activation.

## Independent preview and checks

```sh
bun install --frozen-lockfile
bun test ui/src/onboarding-next/views/tour ui/src/v2/onboarding
bunx tsc --noEmit
bun build ui/src/onboarding-next/views/tour/preview/index.html --outdir /tmp/jarvis-on-u-05-preview
bun run build:ui
bun ui/src/onboarding-next/views/tour/preview/serve.ts
```

Open http://127.0.0.1:4414/. Next through twelve cards, Back, then Open Pebble
or Skip. The review output shows only the intent. Switch Light/Dark, sidebar,
reduced motion, 200% CSS preview and absent/loading/error adapters.
To check delayed focus recovery, choose the delayed adapter, wait, then focus Next
and press Enter. Each room takes 1.2 seconds to load in this fixture; focus should
return from the title to Next. Tab away while loading to verify it stays put.
The backdrop is an explicitly labeled renderer fixture, not the D dashboard.
The preview loads the approved Google Fonts; system fonts remain available offline.
No backend, real account, connection or workflow is used.

Tests exercise real mounted React components, host acknowledgements, duplicate
clicks, focus retention, stale failures, inert containment and unsupported states.
Native screen-reader/WebView behavior and full D-room subject placement are
separate acceptance gates, not implied by these fixtures.

## Activation and rollback

Provides tour-view.v1; requires tour.v1. Enable only with ON-U-10, ON-B-06,
ON-B-11 registration and the relevant D rooms in a verified candidate.
No sibling imports or shared registry edits. No new dependency or migration.
Before activation, revert this module. After registration, disable its optional
entry first and retain the legacy experience, journey and profile records.
