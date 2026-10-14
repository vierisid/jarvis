# ON-U-01: Welcome and setup frame

Controlled UI only. `WelcomeView` and `SetupFrame` compile on main without any
other onboarding, D, F or Q module. The existing onboarding entry is untouched.
`manifest.json` declares a view; it neither registers nor activates a route.

## Host contract

Pass a serializable `WelcomeModel`, `onSetUp`, `onExit` and `onThemeChange`.
The host owns persistence, supported/ready gating, routing and async results.
Each deliberate activation emits one intent. While `state.kind` is `pending`,
setup and exit are guarded and visibly disabled but retain keyboard focus.
Theme controls remain available. Errors are plain text in an alert region;
the same setup button can retry. Only pass safe, user-facing messages.

`unknown` install mode has neutral copy, never the hosted-plan claim or a
provider picker. This view does not resolve the mode or save a theme itself.
Callbacks return void; catch async failures in the host and update the model.
The optional `copy` projection supports long-content/localization checks.

The host must explicitly supply the selected theme. All local theme tokens
change in the same render, without modifying the root/document preference.
Reuse the merged v2 Button and scoped brand styling rather than importing
unmerged Brief controls. Fonts are supplied by the app's existing font load.
The fixture uses that same font link and the merged global/primitive styles.

`SetupFrame` owns scrolling within `100dvh`. A bounded host can override
`--on-setup-height` (for example, `100%` within a definite-height container).
Automatic vertical margins center short content and collapse to zero when
content needs scrolling, so enlarged/long content never clips above the frame.

## Design

[Welcome Light](https://www.figma.com/design/eNfKeirIKLZLlZEasrurZa/Jarvis?node-id=1097-16403)
and [Welcome Dark](https://www.figma.com/design/eNfKeirIKLZLlZEasrurZa/Jarvis?node-id=1097-68522).
Checkpoint: **Onboarding · Tutorial focus contour · 2026-10-14**,
version `2410205462365531104`.

Preserved: copy, compact cofounder heading, red onboarding Pebble, gray `use`
wordmark, 400px reading column, asymmetric control corners and theme palette.
The mark uses the existing onboarding geometry. Figma's positive 45-degree
rotation maps to CSS negative 45 degrees; the tip remains downward.
The mark is static decoration, not an indication that a microphone is active.

Accessibility adjustments: meaningful utility copy is at least 12px in the
existing muted text color, controls have 44px targets, focus is a clear edge,
and motion-reduced controls have no transition. Pending/error copy has a
reserved feedback area instead of changing the setup button's label or width.
Longer messages may use additional vertical space and remain scrollable.

## Isolated preview and checks

From the repository root:

```sh
bun ui/src/onboarding-next/views/welcome/preview/serve.ts
# http://127.0.0.1:4410/ (ONBOARDING_PREVIEW_PORT overrides the port)
bun test ui/src/onboarding-next/views/welcome ui/src/v2/onboarding
bunx tsc --noEmit
bun run build:ui
bun build ui/src/onboarding-next/views/welcome/preview/index.html --outdir /tmp/on-u-01-preview-build
```

The preview toolbar is development-only. Select a state/mode, switch themes,
or enable long copy and 200% preview zoom. Its intent counter is illustrative;
it never starts setup. Preview zoom uses CSS zoom and a matching half-size
layout viewport. It tests enlarged/reflowed content, not native WebView zoom.

## Activation and rollback

ON-U-10 owns discovery and the entry seam. Enable only with `journey.v1`
(ON-B-01), `setup.v1` (ON-B-02) and the approved combined release checks.
An absent module/provider must leave the legacy entry available. No runtime
registry exists on this baseline, so actual discovery/revert integration
remains blocked until those owners supply it; the standalone test host is
not a substitute for that evidence.

To roll back this PR before activation, remove this view folder and its
delivery receipt. There are no route, database, provider or account changes.
Once registered, disable its optional entry through ON-U-10 first.
