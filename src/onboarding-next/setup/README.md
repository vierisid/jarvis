# ON-B-02: setup.v1

An optional, unregistered provider for the explicit transition after the new
explainer. The factory has no startup effects. It compiles on main without any
other onboarding module. ON-B-11 owns runtime/API registration; ON-U-10 owns the
UI entry. No flag, endpoint, legacy view or default capability is changed here.

## Host contract

Instantiate `createSetupProvider` with server-owned ports. `authorize(context)`
must derive the actor/project on **every** read and mutation. Bind one
`createDaemonSetupStore` and one provider instance per authorized existing vault.
The adapter refuses a different actor/project. Do not take vault paths, actor IDs,
project IDs, install mode or panel sessions from a request body. For multiple
vaults, route through existing authenticated tenancy before selecting the adapter.

- `read(context)` is observational. Wire explainer mounting to this, if needed.
  Unknown installation state stays `unknown`; a hosted instance whose proxy is
  unavailable stays `hosted`. Neither exposes self-hosted provider setup.
- `complete(context, {action: 'complete_setup'})` is the explicit Continue action.
  No other body fields are accepted. Hosted completion reuses existing settings
  services, writes the completion marker last and preserves it on retry. Concurrent
  calls through the owner provider share one operation. A new factory or daemon
  retry reads the persisted marker; it never trusts a cached success response.
- Hosted setup preserves system AI/STT/TTS credentials and providers. It records
  the existing multi-tier mode and enables included voice only for a user with no
  explicit enabled/disabled choice. An explicit voice decline stays off. It
  persists Awareness **off before completion** (only the `enabled` key, never
  the in-memory defaults) unless the stored row proves a user choice, guarding
  the legacy service starter and daemon restart. A stored `false` is kept; a
  stored `true` is kept only with the `enabled_chosen_at` marker that
  `persistAwarenessChoice` (the pebble long-press) writes, because builds before
  #262 stamped the default `true` into config.yaml and the legacy import copied
  it. So a choice survives setup running again after `/api/onboarding/reset`
  with scope `setup` (#1070); a malformed one blocks setup before any write.
  A hand-edited `awareness.enabled: true` in config.yaml carries no marker, so
  setup turns it off; the user re-enables it with a long-press. A long-press
  made before this change (#390 persisted it unmarked) is unmarked too, so it
  is also turned off once and needs one long-press again. Setup is not
  Awareness consent.
- Self-hosted results return `next: 'legacy_setup'` until the existing setup path
  has persisted completion **and** the injected existing LLM check confirms
  configuration. A skip marker alone is insufficient. This module accepts no
  self-hosted credentials and does not recreate that form or its validation.
- Inject existing binding/hot-reload and post-setup startup through `services`.
  `read` must verify current LLM/voice/background/executor readiness as appropriate;
  resolving `startPostSetupServices()` is not proof. In current main that function
  can return early after partial startup. The host must reconcile incomplete
  startup before reporting `running`, serialize the idempotent starter across
  callers, and leave Awareness off unless separately enabled by the user.
  Missing/failed services return `ready: false` with saved completion retained.
  Reads never start services; explicit retries can.

`schemaVersion: 1`, `installMode: unknown|hosted|self`, `supported`, `ready` and
`reason` are the frozen capability semantics. `completedAt` and `services` report
separate facts. Only `ready: true` permits the host to advance and acknowledge
`setup_completed` to an optional journey provider. There is no journey import or
reverse dependency. Endpoints remain for ON-B-11 to map and authorize.

## Native access and Awareness

`checkAction(context, {action})` reads existing native permissions. Only
`requestAction` may request access, in response to an explicit action requiring
it. Actions map to one existing permission each: `screen_observation` to screen,
`voice_input` to microphone, `desktop_control` to accessibility, and `notifications`
to notifications. Existing action-level Authority checks still apply downstream.

`createDaemonPermissions` reuses the existing sidecar resolution, RPC validation
and timeout logic. It pins requests to the checked device. Opened System Settings
is not a grant; macOS screen denial after opening its pane offers conditional
restart advice. Windows and Linux `na` are reported as `not_required`, never `granted`.
No sidecar, offline, ambiguous, old and unreadable reports remain unavailable.

Neither native method starts capture or enables Awareness. A usable grant is
not opt-in and can become stale; the actual capture/desktop operation must recheck
its own OS access, service availability and consent. Awareness enable/disable
continues through existing explicit controls. Merely viewing or continuing the
explainer supplies no opt-in. No blanket OS or Authority bypass is added.

## Verify and activate

From this checkout, `bun test src/onboarding-next/setup` runs isolated vault tests,
setup replay/failure cases and native recovery cases. SQLite/settings are real;
service startup/readiness and native RPC replies are controlled fixtures. No API
key, model call, OAuth, native prompt or observation is performed. There is no
live preview URL because this functionality PR registers no routes or views.

Activation requires ON-B-11's real service adapter and authenticated registration,
ON-U-02/10's controlled transition and self-hosted path, a combined D/F/Q candidate,
and actual hosted plus macOS/Windows device evidence. Synthetic assembly evidence
does not certify those gates. Roll back by omitting/unregistering this module and
using legacy onboarding. Keep the additive settings and any workflows. Do not
silently restore Awareness on during rollback.
