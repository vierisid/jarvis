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
- Tab-strip styles target only `.brief-tabs__list > button`, so buttons and selectors inside a tab
  panel keep their own control styles.
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
- Confirm and settle (`today/decision-transition/`): a press calls `onAction(decision, action, requestId)`
  with a fresh opaque `requestId` and holds the same paper ("Confirming decision"). It is a correlation
  token only; durable idempotency and execution belong to the owner (F-14). A resolved promise means
  nothing. The paper shows a receipt only when `binding.operation` is `confirmed` for the same decision
  id, revision, `requestId` and action, with the expected `effect` (`committed` only for an executing
  approve) and, for approve, the `result` matching `DecisionPaper.approveResult` (`accepted`,
  `permission_granted`, or `executed` when omitted). Anything else, or a failed/unknown execution
  outcome in the view, blocks on the same paper with Refresh decisions; nothing is retried. After the
  receipt (380ms) the paper settles (220ms) and waits for a ready different decision or `empty` before
  the next one arrives. Refresh decisions on a blocked paper hands it back to the owner's view.
  Reduced motion drops settlement travel and the arrival animation but keeps the receipt. Reject is
  offered only inside Review. The preview's `useDecisionPreview` simulates the owner; it sends nothing.
- Slots are plain nodes supplied and gated by their owners; the layout invents no fallback cards.
  `slots.goal` renders through `PebbleCompanion` into the one companion slot `PebbleLayout` keeps above
  the conversation, so the goal stays mounted and above Pebble when chat opens. While chat is closed,
  wheel input over the goal scrolls the room.
- `today/figma-reference.json` records the source values.
- Outcomes and Recent activity (`today/outcomes/`, `today/activity/`) are read-only. `Outcomes` and
  `RecentActivity` take an `OutcomeBinding`; `outcomeView` passes it through only when `source` is
  `"fixture"` in preview mode, or `"live"` with both the `outcomes` and `goalMeasurements` capabilities
  enabled in live mode; anything else renders "unavailable". No live provider is wired yet.
- A figure renders only if its F-01 `BriefMeasurement` is finite, has a unit, an `asOf`, at least one
  provenance reference and `qualification` `measured` or `user_reported` (`qualified` in
  `outcomes/model.ts`). Time saved also needs `minutes` and a baseline at or above the value. The view
  never sums runs or derives a value; a missing measurement shows "Not enough evidence yet" or "Progress
  not measured yet", and a measured zero shows 0. "Data basis" lists each figure's qualification, as-of
  time and evidence count.
- Only changed digits fade (`BRIEF_MOTION.selection.enter`); mount, remount and a new window or goal do
  not animate, and reduced motion places values immediately. Animated figures expose their full value
  as visually hidden text. Activity rows render owner text as plain React text; a row is a button only
  when it has a `destination` and the caller passes `onOpen`.
- `today/outcomes/figma-reference.json` records the UI-14 source values.
- Goal card (`today/goal-card/`): `GoalCard` and `GoalQueueCue` share one `useGoalHandoff` state.
  `goalView` passes a `GoalCardBinding` through only when `source` is `"fixture"` in preview mode, or
  `"live"` with `goalMeasurements` in live mode; recommendations and `onAccept` additionally need the
  `recommendations` and `decisions` capabilities. Recommendations, suppression (Q-14) and planning
  (Q-18) are owner-side; the card renders the owner's recommendation as given and invents none. No
  live provider is wired yet.
- "Add to Today" calls `onAccept(request)` once per recommendation identity with a fresh `requestId`;
  it writes nothing itself. Success needs a receipt matching every request field and a destination
  that appears exactly once in a fresh owner `queue`; conflict, failure, unknown or a lost response
  locks the card until the recommendation changes or is refreshed, and nothing is retried. Progress
  never changes from an acceptance. The destination cue holds 1800ms (1200ms reduced) beside the hero
  status, once per receipt. `today/goal-card/figma-reference.json` records the UI-15 source values.
- Opportunity stack (`today/opportunity-stack/`): `opportunityView` passes an `OpportunityBinding`
  through only when `source` is `"fixture"` in preview mode, or `"live"` with `preparedOpportunities`
  in live mode; `onAction` and `receipts` additionally need `opportunityActivation`. Each card carries
  the F-01 `BriefPreparedOpportunity` unchanged plus owner-written title, observation, automation and
  goal-title strings; the UI infers no copy and never falls back to the preview fixtures. No live
  provider is wired yet.
- The provider may report a proposal `ready` only for a Q-13 `ready` qualification of that exact
  snapshot (`src/awareness/prepared-qualification.ts`), and suppression (Q-14) is owner-side: a
  suppressed proposal is simply not returned. "Approve & enable" stays disabled unless the snapshot and
  its readiness are `ready`, the goal, composition, flow and version are present and every binding is
  `ready`; preparing or blocked proposals show the owner's reason instead.
- "Approve & enable" and "Dismiss" call `onAction(request)` once per proposal identity with a fresh
  `requestId` and the exact proposal revision, flow and version; the UI writes and runs nothing. The
  owner must enable through the existing gated enable path (Authority card, Q-05 binding pins) and must
  not also run the flow. Success needs a confirmed result echoing every request field with a receipt
  ID; conflict, failure, unknown or a lost response keeps the card locked until a matching `receipts`
  entry or a new revision arrives. Stale data allows local Next browsing but no action. Local locks are
  not durable; the owner restores accepted/dismissed state after reload.
  `today/opportunity-stack/figma-reference.json` records the UI-16 source values.

`?brief=preview&specimen=today#/_brief_preview` opens the composition with fixture decisions,
fixture outcomes and activity (`today/preview/outcomeFixtures.ts`), a fixture goal with a simulated recommendation owner (`today/preview/goalFixtures.ts`) and a fixture opportunity stack with a simulated owner (`today/preview/opportunityFixtures.ts`). Its actions only change local state; it starts no API read,
socket or approval.

## Conversation tabs

- `chat/tab-strip/` renders the UI-17 tab strip. It owns no messages, drafts, persistence, streams or
  close policy: `bindConversationTabs(owner, source)` projects the F-04 owner (`useBriefConversation()`,
  or a fixture) to ids, titles, `activeId` and the three metadata writes `add`/`select`/`close`.
  `owner.test.tsx` pins that the provider's value satisfies the port and drives the real
  `BriefConversationClient`.
- Tabs and actions render only when `status.mode` is `scoped` with a workspace id and the binding's
  `source` matches the mode (`"live"` in live, `"fixture"` in preview). Loading, legacy, disabled and
  unavailable show a status line and no actions. Closing the last tab leaves `activeId` null; only `+`
  creates a conversation. Writes are blocked while one is pending, and a failure keeps the tabs and
  reports locally. A changed workspace id resets local state.
- Arrows/Home/End move focus without writing; Enter/Space select; Delete closes. Tabs stop shrinking at
  112px and scroll; width changes use the D-04 controller, and reduced motion places them immediately.
  The caller owns the panel id and `role="tabpanel"` linkage (`chatTabId(panelId, id)`).
- Not mounted in the live shell yet. Mount `BriefConversationProvider` once above rooms when wiring it;
  do not open a second socket. Do not mount the provider or enable `JARVIS_BRIEF_CHAT_TRANSPORT` /
  `JARVIS_BRIEF_CHAT_STATE` until Brief-turn approval cards are visible (#1075). Since #1075 the
  daemon also sends the ordinary dashboard card for Brief-owned approvals, the provider passes every
  `useWebSocket` output except the chat it re-derives (approvals, clarifiers, repeat-backs, room
  actions...), and the message thread shows the card under its waiting line; mounting is still the
  mount work's own step, and it must render those outputs as the v2 shell does.
- `chat/tab-strip/figma-reference.json` records the UI-17 source values.

`?brief=preview&specimen=chat-tabs#/_brief_preview` opens the strip inside the Today specimen with a
fixture owner (add, select, close, reopen, failing writes and each status mode). It sends nothing.

## Conversation composer

- `chat/composer/` renders the UI-18 compact composer and send pebble. It owns no persistence, send
  acceptance or cancellation: `bindConversationComposer(owner, source)` projects the F-04 owner
  (`useBriefConversation()`, or a fixture) to the active conversation's draft, its queued/running or
  pending turn, error and connection, and the writes `setDraft`/`send`/`cancel`. `owner.test.tsx` pins
  that the provider's value satisfies the port and drives the real `BriefConversationClient`.
- The draft is kept until the owner accepts the send; a rejected or failed send keeps it. Stop cancels
  the exact selected turn (conversation, turn and request ids) and shows "Stopping response..." until
  the owner reports the turn ended or an error, so a terminal failure after Stop stays visible.
  Enter sends (not during IME composition); Shift+Enter adds a line. Drafts over 65,536 bytes are
  refused locally, matching the client.
- Attachments: the composer only reserves the 44px slot (`attachmentControl`). Attachments must go
  through F-05's `client.attachments` flow (`JARVIS_BRIEF_CHAT_ATTACHMENTS`), which `client.send`
  already includes; never add a parallel upload here. The binding projects the active chat's
  attachment count and readiness: ready attachments can be sent without text, and Send waits while
  any attachment is uploading, removing or failed, matching `client.send`.
- Not mounted in the live shell yet, and it calls `client.send`: the same #1075 rule as the tab strip
  applies. Do not mount the provider or this composer live until Brief-turn approval cards are visible.
- `chat/composer/figma-reference.json` records the UI-18 source values.

`?brief=preview&specimen=composer#/_brief_preview` opens the composer inside the Today specimen with
a fixture owner (send, hold, stop, failing send/stop, offline and each status mode). It sends nothing.

## Attachment fan

- `chat/attachment-fan/` renders the UI-19 Document / Image / Screenshot fan in the composer's
  `attachmentControl` slot. It owns no files, upload, preview, retry, removal or send admission.
  `bindAttachmentFan(owner, pickers, source)` captures the active conversation and workspace when it
  is bound and delegates to F-05's `client.attachments.upload` / `capture` (`DraftAttachments`, gated by
  `JARVIS_BRIEF_CHAT_ATTACHMENTS`), so F-05's size/type limits, SQLite-only storage, one-turn binding
  and untrusted framing apply unchanged. Never add a second upload path or render attachment content
  here; the fan shows only its own fixed labels and status strings.
- The host supplies `pickers`: a native file picker, and for Screenshot a device chooser that shows the
  device and returns `confirmed: true` only after explicit confirmation. A result arriving after the
  workspace changed, the chat closed, the connection dropped or the request was aborted is refused or
  reported as cancelled, and success needs F-05's `ready` reference for the same conversation.
  `owner.test.ts` drives the real `BriefConversationClient` and `DraftAttachments`.
- The fan renders through a body portal (it must escape Pebble's clip) with its own outside-click,
  focus-out and Escape handling, because `BriefMenu` has no staggered fan geometry. It reuses
  `BriefTooltip` and D-04 `useBriefMotion`; reduced motion places choices immediately. Short
  conversations fan sideways so the tab strip stays reachable.
- Not mounted in the live shell yet: the same #1075 rule as the tab strip and composer applies. Do not
  mount the provider or this fan live until Brief-turn approval cards are visible.
- `chat/attachment-fan/figma-reference.json` records the UI-19 source values.

`?brief=preview&specimen=attachments#/_brief_preview` opens the fan in the composer specimen with a
fixture binding (Screenshot availability and failure toggles). It picks, uploads and captures nothing.

## Conversation messages

- `chat/message/` renders the UI-20 thread: a quiet user surface, expandable activity rows and
  unboxed assistant replies. It owns no transport, history or persistence:
  `bindConversationMessages(owner, source)` projects the F-04 owner (`useBriefConversation()`, or a
  fixture) to the active conversation's messages, turns, activity, approvals, saved scroll and
  `loadOlder`. Items match by conversation/turn/request id, never by array position; tool and system
  messages are not rendered. `owner.test.tsx` pins that the provider's value satisfies the port and
  renders the real `ConversationStore`.
- Activity rows come from F-06 progress events and show only F-06's fixed public labels
  (`activityText` allowlist); an unknown label falls back to a generic phase string, never raw tool
  data. Only the newest live start animates; replayed rows never move. Reduced motion stops it.
- Reply text is untrusted and renders through `components/SafeMarkdown` (#1065): no raw HTML, no image
  loads, restricted URL schemes. Never add a second markdown renderer or `dangerouslySetInnerHTML`.
- Failed or cancelled turns keep the partial answer and show a fixed notice; the raw error is not shown.
- Reading position is kept by semantic anchors (`reading.ts`) across activity toggles, history
  prepend, width changes and tab switches, and only a reader already at the bottom follows new content.
- A running turn with a pending approval shows "Waiting for your approval before continuing." and,
  under it, the existing dashboard `ApprovalCard` for that approval id (#1075). F-04 keeps only the id
  and status; the card's details come from the owner's `approvals` (useWebSocket's pending list: REST
  on socket open, then the ordinary `approval_request` / `approval_update` notifications, which the
  daemon now sends for Brief-owned approvals too). Approve and Cancel post to the existing
  `/api/authority/approvals/:id/approve|deny` routes, the same dashboard decider as the v2 thread; a
  fixture owner never decides, and the `messages` specimen passes no approvals, so it shows the line
  only. An id the dashboard list does not hold shows the line only. Once both the v2 thread and this
  thread are visible, a Brief-owned approval shows a card in each; deciding either removes both
  through `approval_update`. Whether to show both is the mount work's decision.
- Not mounted in the live shell yet: mounting the provider and this thread is the D-12..D-15 mount work.
- `chat/message/figma-reference.json` records the UI-20 source values.

`?brief=preview&specimen=messages#/_brief_preview` opens the thread with the tab strip, composer and
attachment fan in the Today specimen with a fixture owner (start, finish, partial failure, long reply,
replay, offline and unavailable). It sends nothing.

## Workflow creation

- `workflows/create/` renders the UI-21 Workflows page: a centred prompt over the shared D-13
  composer (only `sendingLabel` / `suggestionsLabel` are added; chat defaults are unchanged) and
  `workflows/recent-rows/` below it. Suggestions only fill the prompt. It is a room body plus an
  opt-in `workflowCreationRegistration(useBinding)`; it is not in the production registry, and the
  released `WorkflowsRoom` is unchanged. It does not mount the Brief chat provider or call
  `client.send`, so the #1075 rule does not gate it, but it must not be mounted live until the
  workflow destinations it navigates to exist.
- Creation goes only through F-07: `createCompositionPort(capabilities, authenticatedFetch)` calls
  `/api/brief/workflow-compositions` (`JARVIS_BRIEF_WORKFLOW_COMPOSITION`) and re-checks the
  `workflowComposition` capability before every request. Types and the prompt limit come from
  `src/brief/composition-contracts.ts`. F-08 ingredient pins come only from D-17's picker (below);
  without one the request is prompt-only.
  Never add a second composer, write flows directly, or enable, publish or run from this page: F-07
  only prepares a DISABLED draft, and enabling stays on the existing gated path (Q-05 enable card).
- `WorkflowCreationController` is one instance per authenticated account and vault, held above room
  navigation and disposed when that ownership ends. It persists the request id with the exact prompt
  (`sessionCreationStorage(scopeId, sessionStorage)`) before the POST. A lost or invalid response keeps
  that request: **Check request** (and a one-second follow-up while a job is queued or running) looks it
  up by its exact `requestId` and, only if absent, replays the same request under the same id, so a
  retry never creates a second draft. A receipt must echo the request id, prompt, name and exact ordered
  ingredient pins, and keep its job id; a ready receipt navigates once to `workflow-draft` with its exact
  `flowId` and `versionId`. Unreadable saved state makes the record read-only rather than replacing it.
- Recent rows (`readRecentWorkflows(authenticatedFetch, signal)`) read the existing workflow API with
  four workers, at most 200 flows and each flow's latest run page (`{ items, nextOffset }`); no implicit
  polling. A missed read or a larger inventory reports `stale`/`unavailable`, never complete recency.
  Rows show status-derived copy only (never step output) and open `workflow` with flow, version and
  run ids. The host owns invocation, caching and abort on scope change.
- `workflows/create/figma-reference.json` records the UI-21 source values.
  `f07-compatibility.test.ts` drives F-07's real provider, routes and SQLite through this port with a
  fake model: a lost POST recovers one populated disabled draft and starts no run.

`?brief=preview&specimen=workflow-create#/_brief_preview` opens the page with a fixture composition
port (ready, blocked, failed, lost-response, unavailable) and fixture recent rows. It sends no request.

## Workflow ingredients

- `workflows/ingredient-picker/` is the D-17 connection and library picker in the creation composer's
  `+` slot. It only drives F-08 (`JARVIS_BRIEF_COMPOSITION_INGREDIENTS`, which also needs
  `JARVIS_BRIEF_WORKFLOW_COMPOSITION`); see `docs/brief-composition-ingredients.md`. A selection is the
  exact `{selection}` object from discovery (ids and versions only, typed as F-08's
  `CompositionIngredient`), sent with the prompt and echoed by the receipt. Display names are never
  identities. No credential, connection metadata or catalog internals are read or stored.
- `readIngredientCatalog(capabilities, signal, authenticatedFetch)` pages
  `/api/brief/composition-ingredients` to the end (re-checking the capability before every read and
  failing closed on a short, duplicated or malformed page). The public
  `/api/workflows/pieces/library` catalog only supplies service names and non-selectable
  "Not installed" rows when the Library is not host-managed; it never grants a selection. The host
  owns invocation and abort, and binds the result with the controller's `source` and `scopeId`; a
  catalog for another scope is not rendered. It is not wired into a live host yet.
- The picker does not install pieces or connect accounts. An empty connection list points to the
  existing Connected workspace flow; no OAuth or credential entry happens here.
- Selections persist with the draft in the creation controller. A selection without the
  `compositionIngredients` capability blocks send (it is never silently dropped); removing the chips
  restores prompt-only creation. Server-side revalidation at job start, attach, readiness, enable,
  publish and dispatch stays F-08's job.
- `f08-compatibility.test.ts` drives F-08's real discovery, provider, routes and SQLite through the
  reader, port and controller with a fake model and a credential canary.

`?brief=preview&specimen=ingredient-picker#/_brief_preview` opens the creation page with fixture
ingredients (ready, loading, unavailable). It sends no request.

## Workflow canvas

- `workflows/canvas/` is the D-18 full-workspace workflow page. It is not a second editor: it mounts the
  released `WorkflowEditor` with `workspace` set inside `WorkflowEditorEnvironment`, which supplies the
  request function, the portal host for floating pickers and per-page sample drafts. Serialization, save,
  undo, validation and the `/api/workflows` contract stay in `useWorkflowEditor`. The released
  `WorkflowsRoom` mounts the editor without the environment and keeps the floating popover and the
  horizontal layout.
- Workspace mode only: a vertical default layout (saved positions are kept as authored), the settings
  inspector inline at 320px with Configure / Input / Output on `BriefTabs`, Enter/Space on a focused
  node opening it and Escape returning focus to the node, and a viewport that keeps its focal point
  when the Pebble or sidebar reflows the work area (no refit or zoom change).
- `WorkflowCanvasRoom` renders only when `canvasAvailable` holds: a non-empty scope, flow and version,
  a `source` matching the shell mode, the routed `flowId`/`versionId`, and the `workflowContext`
  capability. The key is `[scopeId, flowId, versionId]`, so a change of owner or version drops the edit
  buffer. `versionBoundRequest` refuses a flow detail whose editable version is not the bound one.
- Run is the host's `binding.run`, disabled while dirty or after the version changed; it is never
  retried here. Runs and Context & rules are navigation handoffs (D-19, D-20). It is an opt-in
  `workflowCanvasRegistration(useBinding)`, not in the production registry; F-21 supplies the scoped,
  redacted request before it is mounted live.
- `workflows/canvas/figma-reference.json` records the UI-23 source values and bounded deviations.

`?brief=preview&specimen=workflow-canvas#/_brief_preview` opens the page over an in-memory fixture flow
(with branches, loops and a detached chain). Save stays in memory; anything else answers 403.

## Workflow runs

- `workflows/runs/` is the D-19 Runs view: run history beside one inline inspection card, never a
  second overlay. `WorkflowViewHeader` is the Canvas / Runs / Context & rules header shared with the
  canvas; switching views is a plain room navigation (no document-wide View Transition, whose
  `::view-transition-*` rules cannot be scoped under `.brief-root`).
- `WorkflowRunsController` owns one scope + flow + version: selection by immutable run ID (a missing
  deep link stays missing, never the latest run), late or aborted reads cannot replace the selected
  run, refresh rebuilds the loaded prefix through the last loaded run (at most 20 pages, then stale with
  its continuation), and an 8-second poll re-reads projections only. The host keeps the controller
  across room, chat and sidebar changes and calls `retire()` only when the owner or workflow changes.
- Run is the optional `port.start`: single-flight, and a lost or mismatched acknowledgement leaves it
  `uncertain` and locked for that controller. Nothing is retried or re-sent; `not_submitted` is only for
  a request that was never sent.
- `readRunHistory(scope, request)` is the `list` half of the port over `GET /api/workflows/:id/runs`
  (`{ items, nextOffset }`, the offset as the cursor). It copies identity, status and time only, maps a
  stop whose in-flight call may have completed to `uncertain`, and treats a 404 as unavailable. The
  `detail` half is F-21's: it must build the redacted projection (step fields, effect receipts with
  `unknown` kept distinct, waitpoints without resume URLs, Q-19 failure wording) before binding. The
  card renders strings as text and shows `Redacted` for fields marked so; it is not a redaction layer.
- Opt-in `workflowRunsRegistration(useBinding)`, not in the production registry. `runsAvailable`
  requires a non-empty scope, flow, version and title, a `source` matching the shell mode, the routed
  flow/version, a controller bound to the same scope and the `workflowContext` capability.
- `workflows/runs/figma-reference.json` records the UI-24 source values and bounded deviations.

`?brief=preview&specimen=workflow-runs#/_brief_preview` opens the view over in-memory fixture runs (all
seven states, an older version, partial receipts and a waitpoint). Run creates a fixture run only.

## Workflow context and rules

- `workflows/context/` is the D-20 Context & rules view behind the shared `WorkflowViewHeader`. It shows
  two separate answers: what the bound version is configured to use (`Configured`) and what a selected
  run recorded (`Used by run`). A recorded view is never filled by joining today's configuration to an
  old run; a missing, removed, stale or redacted source stays labelled as such.
- `WorkflowContextPort.read(scope, query, signal)` is the only input. There is no live implementation on
  main: F-21 supplies the authorized, project-scoped and redacted projection before this is bound.
  `validateContext` rejects a document for another scope, flow, version or run, caps sizes, copies only
  whitelisted fields and replaces anything marked `redacted` before it is cached. It is a presentation
  safeguard, not the redaction layer.
- `WorkflowContextController` owns one scope + flow + version with separate caches per query
  (configured, or recorded by run ID), coalesced reads, stale data kept with a qualifier when a refresh
  fails, and per-query scroll positions. The host keeps it across room, chat and sidebar changes and
  calls `retire()` only when the owner or workflow changes. The view is read-only: it writes nothing.
- Values render as plain text. Source actions hand the exact source ID to the host's `openSource`; only
  available or stale sources offer one.
- Run reuses the Runs view's `WorkflowRunsController` (same instance, same scope), so an uncertain
  request stays locked across both views and an accepted one opens its receipt in Runs.
- Opt-in `workflowContextRegistration(useBinding)`, not in the production registry. `contextAvailable`
  requires a non-empty scope, flow, version and title, a `source` matching the shell mode, the routed
  flow/version, a controller bound to the same scope and the `workflowContext` capability.
- `workflows/context/figma-reference.json` records the UI-24 source values and bounded deviations.

`?brief=preview&specimen=workflow-context#/_brief_preview` opens the view over in-memory fixture context
and runs (missing, partial, long, slow, unavailable, unsupported and empty examples, and an illustrative
run response). It sends no request.

## Workflow management

- `workflows/manage-list/` is the D-21 All workflows list: the name opens the exact flow/version, the
  Enabled/Paused switch and the bin are separate targets, and Delete confirms inside its own row.
  Publication and readiness are secondary facts beside the switch; Draft is never a switch state.
- `WorkflowManagementController` holds one owner scope and survives room, chat and sidebar changes;
  the host calls `retire()` on logout or owner change. Each command carries scope, flow, version,
  expected revision and a request ID. A lost or `pending` answer locks that row as uncertain until
  `Check result` reads the same request through `port.reconcile`; nothing is re-sent. Refresh is blocked
  while any row is unresolved. A fresh (`ready`) list replaces settled feedback and restores a workflow
  undone elsewhere into its slot; a `stale` list keeps every removal receipt and slot.
- Deletion is reversible only: an acknowledged remove carries a server receipt, and Undo restores the
  same flow and slot paused. There is no adapter to the legacy irreversible `DELETE
  /api/workflows/:id`. The receipt-backed remove/restore commands are F-20's, which is not on main, so
  the port is fixture-only until F-20 and its host adapter land.
- Activation adds no gate of its own and bypasses none (see the `WorkflowManagementPort` doc): enabling
  goes through the person path, which pins connections and the computer (Q-05; a changed binding shows
  as the readiness blocker, and enabling again accepts it), and the readiness and contract checks still
  refuse. Turning a workflow off stops its queued and waiting runs (Q-06); the list says so above the
  rows and in the result.
- Opt-in `workflowManagementRegistration(useBinding)`, not in the production registry.
  `managementAvailable` requires a non-empty scope, a controller bound to it, a `source` matching the
  shell mode and the `workflowRemoval` capability.
- The collapse uses the D-04 reflow exit timing and is placed immediately under reduced motion.
  `workflows/manage-list/figma-reference.json` records the UI-25 source values and bounded deviations.

`?brief=preview&specimen=workflow-manage#/_brief_preview` opens the list over in-memory fixture
workflows (blocked enable, lost response, expired Undo, long list, stale and unavailable examples).
Nothing is enabled, deleted or run on an account.

## Opportunities room

- `opportunities/` is the D-22 Opportunities room: a proposal selector beside one finished brief
  (observation, prepared output, goal contribution, workflow steps) for the selected proposal ID and
  revision. Selector and brief scroll independently; with Pebble open the selector becomes a bounded
  horizontal strip.
- `OpportunitiesPort.read()` returns the complete authorized F-09 collection (aggregate every page; never
  call the first page complete). Terminal proposals are filtered out. Ready, Q-13 qualification and Q-14
  suppression are owner-side: the room renders the provider's `state`, `readiness` and `canApprove` and
  infers none. "Approve & enable" stays disabled unless `approvalBlock` passes (ready snapshot and
  readiness, `canApprove`, goal, composition, evidence, preview basis, a LOCKED + DISABLED reviewed
  version and every binding `ready`).
- Output, steps, schedule and target come from the same authorized prepared revision; F-09 exposes no
  raw sample output, so a missing preview is `output: null` and renders as unavailable. The basis label
  follows `previewBasis` (verified output, sandbox sample, illustrative); the UI never upgrades it.
- `act` maps to F-10 `POST /api/brief/opportunity-actions/:id/approve|dismiss` with exactly
  `{ revision, idempotencyKey }`; `recover` maps to the F-10 `GET` for the original receipt and never
  resends. `ActionReceipt` is F-10's `OpportunityActionReceipt`. There is no other enable path: the
  room never enables or runs a flow itself. A receipt must match proposal, revision, decision and the
  reviewed flow/version; only registered + enabled (or dismissed) advances. Pending or blocked
  registration stays "Approval saved". A lost response stays locked behind "Check result"; only an
  adapter-certified `ActionRefusal` releases the attempt, and only after a fresh read.
- `OpportunitiesController` belongs to one authenticated scope, survives room unmounts and is retired
  on logout or scope change. Pending decisions are in memory only: before live registration the host
  must reconcile durable F-10 receipts on reload and share one owner with the Today opportunity stack.
  Motion and the approve label are the D-11 `OPPORTUNITY_TIMING` / `OPPORTUNITY_APPROVE_LABEL`.
- Opt-in `opportunitiesRegistration(useBinding)`, not in the production registry. `opportunitiesAvailable`
  requires a non-empty scope, a `source` matching the shell mode, a controller bound to the same scope
  and, live, the `preparedOpportunities` capability; writes additionally need `opportunityActivation`.
  No live adapter is wired yet.
- `opportunities/figma-reference.json` records the UI-26 source values and bounded deviations.

`?brief=preview&specimen=opportunities#/_brief_preview` opens the room over fixture proposals (pending
or blocked registration, lost response, refusal, long content, missing preview, many proposals). Its
actions only change local fixture state.

## Needs you decisions

- `decisions/` is the D-23 Needs you room: a selector list beside one document paper where reading,
  editing and acting happen in place. It reuses Today's `DecisionPaper`, stable decision ID, action
  labels and revision; only `document.attention` is highlighted. Document text is untrusted and is
  rendered as plain text only.
- `DecisionsController` owns one authenticated scope and survives room, theme, sidebar and Pebble
  changes; the host calls `retire()` on logout or scope change. Actions need a fresh `ready` read whose
  revision and `actions` match the rendered item. One request is in flight at a time.
- The room handles F-14 permission documents only (`approveResult: "permission_granted"`). F-12 intent
  and effect-recovery actions (`accept_intent`, `reject_intent`) stay with their canonical owners.
- Each action captures decision ID, revision, action and one request ID before dispatch. Nothing
  settles locally without a matching receipt: same request and decision, the expected outcome, an
  approval ID, result revision and generation, and `executed: false`. Permission granted says
  sending is not confirmed; Keep draft keeps the row with Reopen. A lost response stays pinned and
  locked; Check result reads the ORIGINAL request receipt and never re-sends. A refusal needs a fresh
  read before retry.
- Editing buffers a complete typed email or calendar document. Save does not approve: it yields a new
  revision and approval to review. A read that changes or removes the decision keeps the unsaved
  text and Cancel, and disables Save.
- Wiring (not done here): aggregate every F-12 `GET /api/brief/decisions` page and restart on
  `queue_changed`; join each item with F-14 `GET /api/brief/decisions/:id/document` only when the
  revisions match. POST the F-14 document endpoint with `{ requestId, revision, action }` plus
  `document` for save only (`decisionId` is the path, not a body key). Map recovery to
  `GET .../document?requestId=<original>`. Persist requests before dispatch and reconcile them after
  reload; network errors, 5xx and timeouts are unknown, never refusals. Today and Needs you must share
  one decision owner before activation.
- Opt-in `decisionsRegistration(useBinding)`, not in the production registry. `decisionsAvailable`
  requires a non-empty scope, a `source` matching the shell mode, a controller bound to the same scope
  and, in live mode, the `decisions` capability.
- `?brief=preview&specimen=decisions#/_brief_preview` opens it over in-memory fixtures; the example
  menu covers ready, long, many, calendar, read-only, stale, deferred, uncertain, refused, empty and
  unavailable.
- `decisions/figma-reference.json` records the UI-27 source and bounded deviations.

## Goals

- `goals/` is the D-24 Goals room (`goals` and `completed-goals`): goal selectors above one ordered
  path of stage cards, and settled summary cards with milestones under Completed. The room only
  reads and navigates; it has no goal writer, calculation or approval path. `onCreate` is optional and
  must open the host's existing goal-creation flow.
- Each goal is a `GoalDatum`: `BriefGoal` plus owner-written title strings, with F-15's
  `progress { value, basis, rollup: "independent" }` required. The percent comes from `progress.value`
  (0..1) only, never from value/target, a title or child stages. A count is shown only with a
  qualified measurement (`qualified()` from Today outcomes) with finite baseline and target; a legacy
  score stays labelled "Score"; anything else reads "Not measured yet". Data basis shows measured vs
  user reported, baseline, as-of time and provenance.
- `stages` is an explicit, owner-ordered path. Status is always shown as text, including beside a
  caption. The filter exposes the real `active`, `draft`, `paused`, `failed` and `killed` statuses;
  completion never forces 100 percent.
- The next step is navigation only: `nextGoalRoute` opens the existing Needs you decision
  (`workItemId`, optional `approvalId`) only for an active goal on a fresh `ready` read whose
  `next.goalRevision` matches the goal revision, and in live mode only with the `recommendations` and
  `decisions` capabilities.
- `GoalsController` owns one authenticated scope; selection is remembered per tab and filter and
  survives theme, sidebar, Pebble and route changes. Revoking access or `retire()` clears rows and
  selection, and late reads cannot repopulate a scope. Invalid projections (duplicate roots or stages,
  missing revision/title, unknown status) fail closed.
- Opt-in `goalsRegistrations(useBinding)`, not in the production registry. `goalsAvailable` requires
  a non-empty scope, a `source` matching the shell mode, a controller bound to the same scope and, in
  live mode, the `goalMeasurements` capability.
- Wiring (not done here): an adapter over F-15's `GET /api/brief/goals/:id` must supply the complete
  authorized roots with their owner-ordered paths and titles, pass `measurement` and `progress`
  through unchanged (see `docs/brief-goal-measurements.md`), and share Today's decision identity so a
  decision resolved in another room reconciles here.
- `?brief=preview&specimen=goals#/_brief_preview` opens it over in-memory fixtures (ready, mixed
  status, score only, decreasing, unknown, long, many, loading, empty, stale, unavailable,
  unsupported). `goals/figma-reference.json` records the UI-35 source and bounded adaptations.

## Memory

- `memory/stream/` is the D-25 Memory room: Search, Source, Used in and Updated filters, an exact
  result count, rows grouped by Today / Yesterday / Earlier and sorted by Updated descending, then
  fact ID. It only reads. There is no Add memory action, category tab, writer or second memory engine;
  detail and correction belong to D-26, which receives only the canonical fact ID through
  `onOpen(factId)`. Without `onOpen` a row is `aria-disabled`.
- `MemoryPort.read(query, signal)` is the only input, and only a fixture port exists so far. The live
  port over F-17's `/api/brief/memory` (#823) is a follow-up; the room also needs F-18 usage records
  (#833) and both capabilities before it can go live. Main's paged legacy reader (`/api/vault/page`)
  has no search or filters and is not used here.
- Search, Source and Used in go to the server, never filter one fetched page. Search is literal text up
  to 256 characters; Source is an exact label (whitespace kept, up to 4,000 characters); Used in is
  `conversation:<id>` or `run:<id>` and counts supplied use only, not selected-only. Source and Used in
  suggestions come from host-supplied authorized catalogs; exact entry works without them.
- `validPage` rejects a page as a whole (never drops rows, which would falsify counts): wrong counts,
  duplicate IDs, unreadable rows, an order break, or a status other than `active` / `contested`, so
  superseded or forgotten facts cannot render. Continuation repeats the frozen query with the opaque
  cursor and must keep totals, order and identity.
- `MemoryController` owns one authenticated scope and survives room, theme, sidebar and chat changes;
  the host calls `retire()` on logout or scope change. A filter edit clears rows at once and late reads
  of an older query or page are ignored. Stale, unavailable, unsupported and error states carry no
  cached rows (a fact may have been forgotten) but keep the applied filters. Losing access clears both.
- Memory text is untrusted (it can hold captured page text) and renders as plain text only.
  Recorded use means a retained provider handoff, not model reliance; `uses: null` reads "Usage
  unavailable".
- Opt-in `memoryRegistrations(useBinding)`, not in the production registry. `memoryAvailable` requires
  a non-empty scope, a `source` matching the shell mode, a controller bound to the same scope and
  source and, in live mode, both the `memoryStream` and `memoryUsage` capabilities.
- `?brief=preview&specimen=memory#/_brief_preview` opens it over in-memory fixtures (ready, loading,
  empty, stale, error, unavailable, unsupported, long, many with a match beyond page one, no-usage).
- `memory/detail/` is the D-26 detail: one fact's sentence, qualification, sources ("Where it came
  from"), recorded use ("Where it helps") and linked correction history, with Edit memory and Confirm
  fact. It is review and correct only: there is no Forget or delete until F-19 / Q-16 land on main,
  and per-fact `canForget` is ignored.
- `MemoryDetailPort` (`read`, `history`, `decide`) is the only input and has no live implementation on
  main: the detail read needs F-17's `/api/brief/memory/:id` (#823). When that lands, the HTTP port
  must send `decide` to main's existing `/api/vault/facts/:id/correct` and `/confirm` routes
  (`confirmed: true` plus a reason), which own supersession and provenance; it never writes the
  display sentence and keeps F-17's `canCorrect=false` gate.
- `MemoryDetailController` lives beside the stream controller for one scope. A correction follows the
  replacement fact ID, invalidates the stream's cached rows, and keeps earlier evidence in history. A
  conflict or rejection keeps the draft; "Reload current fact" reapplies it to the fresh value. An
  unknown save result is never retried automatically. Unavailable, missing or conflicting reads clear
  cached content in both rooms.
- Leaving never drops an unsaved edit silently: "All memories", "View current value" and history
  links refuse with a message until Save or Cancel; leaving through the shell keeps the draft, and
  choosing another row reopens the drafted fact first.
- Return restores the applied filters, the loaded page window (bounded, never the whole vault), the
  scroll offset and focus on the original row, its replacement, or the nearest surviving neighbour.
  The sentence transfer uses `BRIEF_MOTION.transfer` and is skipped under reduced motion.
- Opt-in `memoryDetailRegistrations(useBinding)`, not in the production registry. `detailAvailable`
  adds to `memoryAvailable` a detail controller bound to the same scope and source.
- `?brief=preview&specimen=memory-detail#/_brief_preview` opens it over in-memory fixtures (ready,
  long, many, conflict, save-error, lost-save, unavailable, read-only, loading, no-usage).

## Connected workspace

- `connections/` is the D-27 Connected workspace: Devices and Services rows, a searchable "Connect a
  service" catalog, one setup panel per attempt (start, open settings, check, cancel, expire, start
  again) and a device panel. It owns no OAuth, callback, token, credential form or device effect:
  setup always hands off to the existing settings surfaces, and device actions hand off to device
  settings.
- `ConnectionsPort` is the only input. There is no live implementation on main: `createF22ConnectionsPort`
  bridges to F-22's headless setup adapter (#943) through an injected `F22Binding`, and without one it
  returns `unsupported`. Its real-module tests run against F-22's `ui/src/brief/connections/setup.ts`.
- Connected comes only from the canonical projection: after a check the controller re-reads and
  requires the exact account (`connectionKey`) with `authenticated === true` and `availability ===
  "ready"`. A browser return or launch is never confirmation, and saved credentials show as
  configured but not verified. With several candidate accounts the person picks the one they set up.
- Reconnecting or editing a workflow connection, and revoking a device, say that workflows using it
  pause until enabled again (Q-05 `BINDING_STALE`).
- `ConnectionsController` owns one authenticated scope; the host calls `retire()` on logout or scope
  change. Losing access clears rows, attempts and saved scroll positions. Search, scroll and focus
  survive setup and return. A setup that could not be verified is never retried automatically.
- Opt-in `connectionsRegistration(useBinding)`, not in the production registry. `connectionsAvailable`
  requires a controller bound to the same scope and source as the binding and, in live mode, both the
  `connections` and `navigationCompatibility` capabilities.
- `?brief=preview&specimen=connections#/_brief_preview` opens it over in-memory fixtures (ready,
  empty, stale, unavailable, read-only, expired, lost-start, lost-cancel, long, configured, partial).

## Authority

- `authority/` is the D-28 Authority room: the default authority level (1-10 slider, continuous drag,
  integer on release, keyboard steps) and the thirteen governed-category switches. It adds no policy:
  it edits only `default_level` and `governed_categories` through main's existing
  `POST /api/authority/config` (Q-08 validation), and sends only the fields that changed, so
  overrides, context rules, learning and background restrictions are never written from here.
- Edits stay a draft until an explicit Save. Before posting, the adapter re-reads
  `/api/authority/status` and reports a conflict if an edited field changed elsewhere (the endpoint has
  no revision, so this narrows but does not close the race). Saved is shown only after `ok: true` and a
  fresh readback that matches. A failed or lost response is never replayed automatically; after a
  reload the person can choose Retry save or discard it.
- The emergency banner comes from `EmergencyController` (`emergency_state` on the status route), not
  the engine's startup config copy. Pause holds tool actions; Kill refuses tools and stops agent runs.
  Pause, Kill, Resume, Reset and per-action overrides are not here: they stay in the existing controls,
  reached through the F-25 `advanced-authority` and `emergency-controls` destinations.
- A stored level of 0 (accepted by main's route) displays; the slider itself sets 1-10.
- `createAuthorityPort(scopeId, host)` needs an authenticated, scope-bound `AuthorityHost`; there is no
  live host on main. Opt-in `authorityRegistration(useBinding)`, not in the production registry. In
  live mode `authorityAvailable` requires the `navigationCompatibility` capability and both F-25
  destinations.
- `?brief=preview&specimen=authority#/_brief_preview` opens it over in-memory fixtures (ready,
  read-only, save-failure, persistence-failure, lost-response, conflict, paused, killed, unavailable,
  error, unsupported).

## Profile

- `account/profile/` is the D-29 Profile form: six fields in two groups (About you, Your context).
  Full name belongs to the sign-in provider and is shown read-only and empty; it is never sent or
  aliased to an assistant answer. The other five edit F-23 canonical answers (`preferred_name`,
  `company`, `work_role`, `current_projects`, `communication_preferences`), up to 4,000 characters
  each; a blank field clears its answer. Unrelated answers and interview facts are never written.
- It reads and writes only through `ProfilePort`. F-23 (#945, `/api/brief/profile-settings`) is not
  on main, so there is no live port yet: the form runs over in-memory fixtures only, and the live
  room needs both a port and the `profileSettings` capability (`profileAvailable`). It does not
  touch `/api/user-profile`, the onboarding profile writes or the vault's user-profile source.
- Edits stay a draft until an explicit Save, survive polls, chat/sidebar changes and remounts, and
  are dropped only by a confirmed Cancel or leave. Saves are revision-bound partial patches; Saved
  is shown only when the confirmed profile matches what was submitted. A failed or lost save keeps
  the draft; Retry re-reads first and reports a conflict instead of overwriting a correction made
  elsewhere. Permission or scope loss purges the draft.
- Leaving with edits asks first. Install `guardProfileNavigation(shell, controller)` at the shell
  host so the sidebar and account menu share the guard; other route sources call `navigateAway`.
  `beforeunload` warns while a draft exists. Profile values are personal: nothing is logged or
  shared with other rooms.
- Opt-in `profileRegistration(useBinding)`, not in the production registry.
- `?brief=preview&specimen=profile#/_brief_preview` opens it over in-memory fixtures (ready, empty,
  read-only, save-failure, lost-response, conflict, unavailable, unsupported, error).
