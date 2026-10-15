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
- `components/controls.tsx` re-exports the existing v2 Button.

## Adding a room

Create the view type and read adapter inside the room's directory. Return an explicit `unsupported`
or `unavailable` state until the provider and its activation gate are ready. Bind the room component
with `bindBriefView` and assign the result as `Body` in that room's `registration.ts`. Keep one live
connection owner; do not start a second thread or voice connection to populate a room.

Use `shell.route.selection` for source identities and `shell.navigate` for Brief navigation. Shell
appearance, sidebar and chat state live above the room and survive room navigation.

Sample data must stay in `mode: "preview"` and must never become the fallback for missing live data.
