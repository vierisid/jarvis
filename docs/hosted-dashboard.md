# Hosted dashboard default

Hosted installs now open the connected Brief dashboard at the ordinary root URL.
This supersedes the default-off hosted UI policy in v0.17.1 and the earlier local-only
integration scope. It requires a new brain build and rollout; updating the hosting
website alone cannot change an instance's bundled dashboard.

## Runtime ownership

After loading system configuration, `configureHostedDashboard` enables the existing
Brief provider flags for a hosted install. Hosted identity uses the existing
`isHostedInstall` predicate, including Unix-socket instances. Explicit feature flag
values are preserved. Provider readiness, capability dependencies, authentication,
Authority, approvals and workflow activation checks remain enforced.

The authenticated, uncached `/api/brief/host` descriptor supplies `dashboard: brief`.
The ordinary production UI uses that descriptor to select the connected host, with
one conversation/socket owner. It does not use `JARVIS_LOCAL_INTEGRATION`, developer
tools, browser storage or a URL as release authorization. Its choice is fixed for
the document lifetime, preserving drafts through navigation and temporary outages.
Network/authentication failures offer reconnect; an older daemon's missing endpoint
or missing dashboard field retains the legacy UI.

This is an explicit hosted product default, not an attestation that the historical
D32/F28/Q22 audit manifests passed. Those audit helpers and their evidence records
remain unchanged. The optional onboarding-next release also remains separate;
hosted users keep the existing onboarding wizard and its Brief draft handoff.

## Compatibility and rollback

- Self-hosted installs retain their previous default.
- Existing foreground bookmarks open their matching Brief rooms. Selected workflow,
  version, run and memory IDs are retained.
- Native panels, result windows, onboarding/reset, advanced settings and device
  setup links keep their existing owners.
- `?brief=0` opens the previous dashboard for that browser URL.
- Set `JARVIS_HOSTED_DASHBOARD=legacy` in the instance service environment and restart
  to restore the previous default and stop applying automatic feature defaults.
  No data is reset or downgraded. Explicit operator feature flags still apply.
- Unset the variable, or set it to `brief`, and restart to use the hosted default.
  Unknown values select legacy. Reload existing tabs after a server-side rollback.

## Verification

Run the hosted-default, real API and browser-entry tests, the Brief/provider/entry
regressions, TypeScript and `bun run build:ui`. The existing integration fixture can
also serve the actual production bundle with synthetic hosted identity:

```sh
bun run build:ui
run_dir="$(mktemp -d /tmp/jarvis-hosted-ui.XXXXXX)"
mkdir -p "$run_dir/home" "$run_dir/tmp"
env -i PATH="$PATH" HOME="$run_dir/home" TMPDIR="$run_dir/tmp" \
  LOCAL_INTEGRATION_DIR="$run_dir" LOCAL_INTEGRATION_UI=hosted \
  LOCAL_INTEGRATION_PORT=3199 bun scripts/integration/serve.ts
```

Open the private `bootstrap-url.txt` in that directory. It establishes the fixture
session and redirects to `/`, with no opt-in parameter. Check Today, Workflows,
Memory, Goals, Settings, reload, one socket and `?brief=0` rollback. The fixture uses
real routes, persistence and workflow engine with synthetic data/model replies and
blocked external fetch. It does not prove real hosting billing, OAuth, device or
production deployment acceptance.
