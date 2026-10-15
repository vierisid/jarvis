# Brief dashboard boundary

The Brief dashboard is opt-in. A normal URL still renders `AppShellV2`; `ui/src/main.tsx` mounts
`DashboardEntry` around that same element.

## Entry points

- `?brief=1#/brief/<room>` opens a registered Brief room behind the existing onboarding gate. Rooms
  without a `Body` show an explicit "not available in Brief yet" notice with a link back to the
  current dashboard.
- `?brief=preview#/_brief_preview` opens an isolated development preview. It starts no brain API,
  chat WebSocket or voice connection and bypasses the onboarding gate.
- Anything else, including every existing room, panel, task, answer and developer hash, and any URL
  with an `onboarding` query, stays with `AppShellV2`.

Rollback: remove the `brief` query parameter.

## Layout

- `entry/route.ts` owns the exact URL gates and the allow-listed source-ID selection. Unknown
  destinations fall back to the current app.
- `entry/DashboardEntry.tsx` chooses exactly one root. No thread, voice or socket provider belongs here.
- `contracts.ts` holds presentation ports only, not domain schemas. Keep source IDs, `unavailable`
  and `empty` distinct; never infer successful data from a missing provider.
- `rooms/<id>/registration.ts` is owned by that room. The registry imports registrations statically.
- `adapters/view.tsx` binds a room-local read hook to a typed component. The live host refuses to show
  a fixture view as business data. This is a presentation guard, not a security boundary or a
  substitute for provider authorization.
- `components/controls.tsx` is the barrel for the Brief control family (see Controls below).

## Adding a room

Create the view type and read adapter inside the room's directory. Return an explicit `unsupported`
or `unavailable` state until the provider and its activation gate are ready. Bind the room component
with `bindBriefView` and assign the result as `Body` in that room's `registration.ts`. Keep one live
connection owner; do not start a second thread or voice connection to populate a room.

Use `shell.route.selection` for source identities and `shell.navigate` for Brief navigation. Shell
appearance, sidebar and chat state live above the room and survive room navigation.

Sample data must stay in `mode: "preview"` and must never become the fallback for missing live data.

## Styles

`styles/index.css` holds the approved Brief type roles (`brief-type-*`), Light/Dark materials
(`--brief-*`), asymmetric corner families, progress bands and status chips. Every rule is scoped under
`.brief-root`, so the released dashboard's tokens are untouched; `styles/scope.test.ts` fails if a
rule escapes that root.

- Put `brief-root` on a Brief surface. It follows the app's `data-theme`; an explicit
  `data-brief-theme` overrides it for isolated references. Inside the root, D-01's wrapper aliases
  (`--bg`, `--ink`, `--corner` and so on) resolve to Brief materials.
- Use `brief-secondary`, not `brief-tertiary`, for important text on raised paper and menus: Dark
  tertiary on those materials is below 4.5:1 at 12px.
- A paper is `brief-paper-object` around `brief-surface brief-surface--paper`; the outer isolation
  keeps the backing behind the face, and `brief-surface__clip` carries the same radius for clipping.
- Progress bands are visual classes only (near zero 0-19%, early 20-39%, middle 40-74%, near
  complete 75-100%). Always show the value and unit next to the bar; do not reuse a band for errors.
- Fonts come from the app's existing loading (`--sans`, `--mono`). The logo SVGs in `styles/assets/`
  embed Familjen Grotesk (SIL OFL 1.1, license in the font's name table); do not redraw the mark.
- `styles/figma-reference.json` records the extracted Figma values (Brief v6.1, UI-35 checkpoint).

`?brief=preview&specimen=styles#/_brief_preview` opens the style specimen. Its content is
illustrative; the text-size control scales Brief text only, not browser zoom.

## Controls

Import from `components/controls` and render inside a `brief-root`. The barrel loads
`components/controls/controls.css`; every rule is scoped under `.brief-root` and covered by
`styles/scope.test.ts`. These controls are Brief-only: v2's `ui/` components keep their own look and
are not restyled. Domain actions, approvals, Authority and async lifecycles stay with the caller.

| Control | Caller supplies | Control supplies |
| --- | --- | --- |
| `BriefButton` | `onClick`, `variant`, `state`, and every label it can show in `stateLabels` | Native button, default `type="button"`; `pending` keeps focus and blocks repeat click and submit; labels reserve the widest width |
| `BriefIconButton` | A short `label`, the icon, `intent="destructive"` when it deletes | 44px (36px compact) target; the label is the accessible name and a tooltip |
| `BriefLink` | A real `href` | Native link with a directional arrow |
| `BriefInput` / `BriefTextarea` / `BriefSelect` | Native value handling, `label`, `hint`/`error`/`saved`, `reserveMessage` for the longest known error | Label association, `aria-invalid`, `aria-describedby`, reserved feedback space |
| `BriefSwitch` | Controlled `checked` and callback, domain `onLabel`/`offLabel` | Button with `role="switch"` |
| `BriefTabs` | Stable item values, panels, selected value and callback | Manual activation (arrows/Home/End move focus, Enter/Space select), disabled tabs skipped, hidden panels stay mounted |
| `BriefSegments` | Controlled value, options and a group label | Native radio group in a labelled fieldset |
| `BriefMenu` | Stable item ids, labels, callbacks, disabled/destructive/`current` intent; optionally a `trigger` render function, `placement`, `dismissKey` and `reveal` | Top-layer portal that follows the invoking root's theme; arrows, Home/End, typeahead, Escape, Tab and outside-click dismissal with focus return |
| `BriefTooltip` | One focusable child and a short description | 500ms hover delay, immediate on focus, Escape dismisses |

- `pending` is a presentation and duplicate-click guard, not server idempotency.
- Reserve feedback for the longest error you actually author; longer runtime text expands instead of
  clipping. Translated action labels belong in `stateLabels` too.
- Native-disabled controls are not focusable. Explain important unavailability in visible text.
- Tabs keep mounted state only; they do not persist anything.
- A custom `BriefMenu` trigger must spread the props it receives onto one native `<button>` and give
  it an accessible name. Change `dismissKey` (for example the route hash) to close an open menu when
  something outside it navigates; focus returns to the trigger only if it was inside the menu.
  `reveal` keeps the surface mounted for the D-04 exit and makes it `inert` immediately.
- `BriefSwitch` uses its `label` as the accessible name. Show the same words visibly next to it.
- `components/controls/figma-reference.json` records the extracted Figma geometry and colors (UI-04,
  UI-05).

`?brief=preview&specimen=controls#/_brief_preview` opens the interactive control specimen. All of its
actions are local fixtures.

## Motion

Import from `motion/` (`useBriefMotion`, `useBriefReducedMotion`, `createBriefMotion`). It is a thin
Web Animations wrapper with the approved UI-07 timings in `BRIEF_MOTION` (enter/exit ms per kind:
`press`, `reveal`, `selection`, `reflow`, `transfer`, `settle`) and one ease-out curve. No package,
queue or timeline engine.

- One animation per owned element. A new intent reads the current rendered value, cancels the old
  animation and starts from there, so a reversal never jumps to the old endpoint.
- The final style is committed before the animation starts and no completion callback changes state.
  Update semantic state, focus, `inert` and `aria-hidden` immediately; never wait for an animation.
- The first render is placed without animation. An unchanged endpoint does not animate.
- `prefers-reduced-motion: reduce` places every change immediately; a live OS change finishes any
  running animation at its latest target. `useBriefReducedMotion(true)` can ask for less motion but
  cannot override an OS request for less.
- Animate `transform` and `opacity` on text-bearing objects; `width`/`height` only on bounded
  surfaces. Never scale text, blur or interpolate colors. Keep the same properties across calls.
- Keep the ref'd element mounted during an exit. Unmounting cancels the animation and restores the
  inline properties the wrapper owned.
- `motion/figma-reference.json` records the UI-07 source values.

`?brief=preview&specimen=motion#/_brief_preview` opens the interactive motion reference. Its examples
are local fixtures; "Run 20-cycle check" records browser frames (`motion/trace.ts`) and is not a
frame-rate or performance claim.

## Navigation shell

`shell/navigation/NavigationShell.tsx` lays out the sidebar (232px, 72px rail), the breadcrumb header
and the account menu (`shell/account-menu/AccountMenu.tsx`) around the room. `DashboardEntry` always
renders it, so the room's ancestors stay mounted; only the navigation chrome is gated.

- The chrome mounts only when `canMountNavigation` passes: a `navigation` binding whose view is
  `source: "live"` and whose F-01 snapshot has `navigationCompatibility` enabled. Without a binding
  (the default today) the released layout is unchanged and no extra API read happens. Fixture
  bindings are accepted only in `mode: "preview"`.
- Navigation data (`BriefNavigationData` in `shell/navigation/model.ts`) is read-only. Loading,
  unavailable and stale reads show "unavailable", never a healthy connection, a plan or zero counts.
  `planFromBilling` adapts the existing `/api/billing` snapshot (`v2/billing/useBilling`) to a plan
  name; do not fetch billing again or add a plan tier.
- The account menu only navigates to the Profile, Settings and Billing rooms. It performs no account
  action and puts no email or token in the DOM.
- Changing rooms resets the content scroll to the top; sidebar, theme, chat and same-room selection
  changes keep it. Below 700px the rail is forced without changing the saved preference.
- `shell/navigation/figma-reference.json` records the UI-08/UI-09 geometry.

`?brief=preview&specimen=navigation#/_brief_preview` opens the shell with local fixture data. It
starts no API read, socket or account action.

## Pebble workspace

`shell/pebble-layout/PebbleLayout.tsx` wraps the room inside `NavigationShell`. Opening Pebble grows
one clipped 58px surface from the workspace's bottom-right corner into a conversation panel (360-447px)
and reserves that width beside the room; closing reverses toward the same corner. The room, its
selection and drafts, and the supplied conversation stay mounted through open/close, route, theme and
sidebar changes.

- The conversation comes only from the composition root as `conversation: BriefConversationBinding`
  (`source` plus `content`). The host creates no thread, socket, microphone, request or persistence.
  Without a binding (the default today, `main.tsx` passes none) the opener is hidden and inert and the
  released Talk/Pebble overlay is untouched. `source` must be `"live"` in live mode and `"fixture"` in
  preview mode, otherwise nothing mounts.
- The opener is gated by the same `canMountNavigation` check as the navigation chrome. Losing that
  capability hides the panel without remounting the room or the conversation.
- `shell.chatOpen` is the only open state. Escape inside the panel closes it unless an inner control
  already handled it; focus moves to an element marked `data-pebble-focus` (else the panel) on open and
  back to the initiating control (else the opener) on close.
- Below 960px of workspace width (`PEBBLE_SPLIT_MIN` in `layout.ts`) the same panel replaces the work
  viewport; the hidden room stays mounted, `inert` and keeps its scroll.
- Width/height use D-04 `reflow` motion and the reading body a `reveal` fade; resizing the workspace
  follows immediately. `reducedMotion` and the OS setting place every change at once.
- Rooms read `usePebbleWorkspace()` (open, split/single, working and conversation widths) or the
  `brief-work` CSS container to adapt without remounting.
- `shell/pebble-layout/figma-reference.json` records the UI-11 source values.

`?brief=preview&specimen=pebble#/_brief_preview` opens an illustrative review with fixture rooms
(Today, canvas, list, detail, form) and a fixture conversation. It starts no API read, socket or voice.

## Today composition

`today/layout/TodayLayout.tsx` lays out the Today room: greeting, the decision paper, and the goal,
outcomes, activity and opportunities slots. `rooms/today/registration.ts` exports
`createTodayRoom(useToday)` for the composition root; nothing calls it yet, so the registered Today room
is unchanged.

- The decision comes only as a `DecisionBinding` (`today/hero-paper/model.ts`), a `BriefViewPort` over
  an F-01 `BriefDecision` plus its presentation. `decisionView` shows it only when `source` is
  `"fixture"` in preview mode, or `"live"` with the `decisions` capability enabled in live mode;
  anything else renders "unavailable". Loading, empty, stale and unavailable are distinct states.
- Approve, Keep draft and Reject call `binding.onAction(decision, action)` with the exact decision id and
  revision, once, and only while the decision is `ready`, the server listed the action and any approval
  is still `pending`. D-07 performs no write: the owner must route the action through the existing
  approval endpoints and report progress in `binding.operation`. An approved but unconfirmed effect is
  never shown as done.
- Review opens the full document in place below the summary; Escape or Close returns focus to the
  Review button. A new decision id or revision resets hover and review state.
- Slots are plain nodes supplied and gated by their owners; the layout invents no fallback cards.
  `slots.goal` renders through `PebbleCompanion` into the one companion slot `PebbleLayout` keeps above
  the conversation, so the goal stays mounted and above Pebble when chat opens. While chat is closed,
  wheel input over the goal scrolls the room.
- `today/figma-reference.json` records the source values.

`?brief=preview&specimen=today#/_brief_preview` opens the composition with fixture decisions and
fixture goal/outcome/opportunity cards. Its actions only change local state; it starts no API read,
socket or approval.
