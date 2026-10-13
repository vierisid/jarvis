# D33 reversible dashboard release switch

The shipped `BRIEF_RELEASE` is **off**. D32's live craft gate, F28's activation/migration gate, Q22's quality gate, the integrated live composition and team deployment approval are still required. Passing these switch tests does not pass those gates.

## Quick verification

Use the stack's Bun 1.3.14 and frozen lockfile:

```sh
bun install --frozen-lockfile
bun test ui/src/brief/entry
bun scripts/brief-release/serve.ts
```

Open `http://127.0.0.1:4433/`. This server binds loopback and serves only a synthetic test entry, with no daemon/API proxy or database. It is outside the production entry graph. `D33_PREVIEW_PORT` selects another dedicated port.

1. Choose **Opt-in cohort**, then **Open test fact**. This exercises the actual `DashboardEntry` and shell against explicitly synthetic composition/evidence inputs.
2. Edit **Fixture draft**, then **Simulate configuration rollback**. The open draft remains mounted; the next document's decision is off.
3. Save the fixture draft, then **Reload with switch off**. The legacy Memory route opens, the fixture value remains, and `briefReturn` retains the fact ID. This fixture uses session storage; it does not claim to test actual database migration/rollback.
4. **Cohort without opt-in**, **Unknown brain**, and **Missing Q22 proof** stay on legacy. **Sidecar panel** retains its native panel owner. **Released foreground** demonstrates the eventual default-on switch with synthetic inputs.

## Integration contract

`DashboardEntry` accepts `release` and `runtime` at composition. The default remains off and `ui/src/main.tsx` supplies no runtime binding. The integration owner must supply the authenticated runtime and all live room bodies/navigation/conversation before mounting; no guessed version or provider registration belongs in D33.

- `candidate` is the full SHA of the **integrated UI candidate**, not this PR or a dependency PR. All three gate records, team approval and runtime must refer to that candidate. Evidence-only receipt commits may follow the tested code; document this relationship in the release receipt.
- `gates` contains reviewed D32, F28 and Q22 results. Each must be `passed`, `source: live` and identify its reviewed artifact. Failed, blocked, not-run, missing or fixture evidence keeps the switch off.
- `combinations` enumerates exact supported brain, hosting, sidecar, schema and enabled-feature-flag sets. Use explicit `null` for absent hosting/sidecar. Both migration and rollback records must pass on that candidate for the matching combination. Unsupported/unknown combinations stay on v2; no version-range assumptions.
- `approval` references the team's deployment authorization for that candidate. It is not inferred from tests or CI.
- `rollout: cohort` uses the existing `?brief=1` opt-in on selected sessions. There is no new account targeting service, percentage rollout or backend feature flag. Distribute opt-in links only to the approved small cohort. `released` aliases foreground routes by default after the cohort observation/approval process. `off` disables production entry.

`assessBriefRelease` validates the record's structure, provenance labels and candidate/combination match. **It does not open artifacts, execute the three upstream suites, authenticate attestations or certify their truth.** The integration/release owner reviews the actual evidence. Nothing in this PR supplies a passed production record.

The composition check requires every registered room body, live ready navigation and one live conversation. This catches missing destinations and fixture owners; it cannot prove an arbitrary body has no dead controls. Room adapters and F28 still enforce capability/readiness and action guards. Do not replace them with gate booleans.

## Entry and rollback

| Input | Owner after approved activation |
| --- | --- |
| `#/` (or empty hash) | Brief Today |
| `#/_room_workflows`, memory, goals, authority, usage, settings | Corresponding Brief foreground room (usage → Billing) |
| `#/brief/<room>?<source IDs>` | Brief room and exact typed selection |
| `#/_panel_*`, task/answer windows, palette, advanced rooms/showcases | Existing v2 owner |
| Any `onboarding` query | Existing reset/resume owner |
| `briefMaintenance=1`, or a settings hash with `settingsTab`/`sidecarId` | Existing maintenance/device-settings owner, including older F25 bookmarks |
| `?brief=0` | Explicit v2 override, even with a released default |

The configuration and developer-tools setting are read once per document. Polling or a new config object cannot destroy open work. Feature action guards still respond to outages. Rollback applies on the next load: set `rollout: off` in the same release configuration and reload after saving; ordinary `beforeunload` guards remain in force. An individual session can use `?brief=0` immediately on a fresh load. Never trigger a background reload to enforce the UI flag.

A bookmarked Brief path under a disabled gate is replaced with its usable legacy parent **before** v2 mounts. Query connection parameters survive. `briefReturn` carries the normalized Brief route and selection IDs; v2 intentionally does not attempt to interpret those IDs. To revisit after reactivation, use that hash with an approved `brief=1` link. No writes, effect replay, schema downgrade, deletion or cleanup of the old implementation occurs.

Internal per-room review requires the existing developer setting `localStorage.setItem("jarvis-devtools", "1")`, then reload, plus an explicit `?brief=preview&specimen=<room>#/_brief_preview` fixture URL or `?brief=1#/brief/<room>` live-adapter URL. A normal production document cannot enter fixtures from the URL alone. Internal review does not enable foreground aliases or providers. Remove that setting and reload to return to normal gate behavior.
