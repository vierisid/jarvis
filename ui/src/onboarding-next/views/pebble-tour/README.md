# ON-U-06: Pebble tutorial

Optional presentation module. No production route, registry or wizard imports it.
Merge independently into main. Enable only with ON-U-10, ON-B-06, ON-B-11
registration and a verified D-line Pebble host. Removing this directory leaves
the existing onboarding path intact.

## Source of truth

Figma file `eNfKeirIKLZLlZEasrurZa`, onboarding page `1097:16402`.
Checkpoint: **Onboarding · Tutorial focus contour · 2026-10-14**, version
`2410205462365531104`. Closed node `1097:42287`; open node `1097:44821`.
Both states were inspected in the live prototype. Tutorial copy, blue contour,
Familjen Grotesk/Spline Sans Mono and asymmetric corners follow that reference.

## Host contract

`PebbleTourView` takes a controlled journey model and an optional
`PebbleTourAdapter`. The adapter's stable `Surface` component must bridge to the
existing D-line layout, opener, close button, focus handoff and reduced-motion
behavior. It must retain the previous room/selection and conversation instances.
Mount the view in the workspace below the header, beside the sidebar. Its shell
slot has the remaining height. On smaller workspaces the tutorial reserves its
own row so a single-pane conversation cannot cover tutorial actions.

`isolation: "tutorial-sandbox"` is a host assertion, **not a security boundary**.
Only trusted host code may supply it. Room data must be illustrative/read-only;
do not pass live mutation handlers, message send, uploads, provider startup,
portals into live rooms or executable workflow controls. There is no new chat
engine here. The host should compose existing D/F conversation presentation with
side effects disabled, as ON-B-06 requires.

`open` is an observation, not an optimistic local toggle. The button calls
`onOpenChange(true)`; the open copy and Next appear only after the adapter reports
ready/open. An absent/loading/unsupported adapter cannot satisfy that condition.
Back and Skip remain escape paths, both owned by the host journey. Skip leads to
the first-workflow step, never completed onboarding.

Navigation emits session/revision-tagged intents. Map `back` to the Billing tour
step and `next`/`skip` to the first-workflow prompt. Resolve the callback only as
an acknowledgement of delivery; advance the model revision (or leave the step)
when the authoritative journey changes. Reject/throw to recover a failed intent.
One intent per revision prevents repeated button activation. Late rejected
requests from older revisions/sessions cannot unlock current work.

Keep adapter identity and selected room stable while changing theme/sidebar or
open state. Do not key its Surface on `open`, and do not rebuild the engine here.
On missing capability, leave the optional view unregistered and preserve the
previous entry path. Runtime persistence, initial chat state restoration when
leaving the entire tour, and discovery belong to ON-B-06/U-10/B-11.

## Reproducible isolated preview

```sh
bun ui/src/onboarding-next/views/pebble-tour/preview/serve.ts
# http://127.0.0.1:4415/
bun ui/src/onboarding-next/views/pebble-tour/preview/serve.ts --build
ON_U_06_MISSING_SHELL=1 bun ui/src/onboarding-next/views/pebble-tour/preview/serve.ts --build
```

The preview builder reads the **local** Git object
`f77b6e712f2e223ac2d781dbcf38f606c324ba03` (D-06, PR #736) into a unique temporary
directory and bundles its actual PebbleLayout, motion code, controls and official
logo. It never fetches, changes the checkout, registers a feature or imports an
unmerged path from production code. If that object is absent it builds the
unsupported-adapter fixture. The only remote preview resource is the same Google
Fonts stylesheet already used by `ui/index.html`.

Preview room/sidebar/header and unsent conversation content are labeled samples,
not a claim that all D rooms or the final conversation are assembled. The imported
D-06 opener/reflow itself is real and unchanged. No send action exists. The first
workflow button shows the emitted handoff; ON-U-07 owns the subsequent prompt.

Quick check: Open Pebble, type a draft, close/reopen, then toggle appearance and
sidebar. The draft remains. Try keyboard Enter/Escape, Reduce motion, Missing
adapter and widths 1440/768/390. Continue emits `next → first-workflow`.

## Checks and limitations

See `docs/onboarding-delivery/ON-U-06.json` and its evidence directory. No native
WebView/screen-reader certification or live B-06 persistence is implied by a
browser fixture. This is not a rollout or backend change. Rollback: disable this
optional view, then revert its owned files without removing journey/user data.
