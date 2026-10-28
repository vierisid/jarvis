# Hosted Intercom connection

The hosting companion registers the Jarvis company app in Admin > Infrastructure > Integrations. Customers connect through the dashboard, choose their workspace region, approve Intercom consent and return to Jarvis. Company credentials remain in the control plane; the instance receives only the customer token, workspace/admin identity and reviewed regional API host. No per-provider deployment environment variables are needed.

## Included

- Dashboard Connect, reconnect, disconnect and delivery retry through the existing managed-provider framework.
- Google-style connection cards in both onboarding paths, Settings > Integrations and the workflow account picker.
- `{{connections.jarvis:intercom}}` resolves only as the auth of the six qualified actions below. Other actions, arbitrary API calls and triggers are refused in readiness and credential resolution. Manual workflow accounts retain their existing path.
- The account fingerprint binds generation, workspace, admin, region and token. Disconnect and replacement grants invalidate existing run bindings without restarting the daemon.
- US, EU and Australia use fixed regional API destinations. The OAuth region is sealed with the single-use state and checked against `/me` before delivery.

| Published action (`@activepieces/piece-intercom@0.9.2`) | Behavior | Authority |
| --- | --- | --- |
| `get_contact` | Read by ID, email or external ID; ambiguous matches fail | read_data |
| `get_conversation_by_id` | Read a conversation with flattened `parts` | read_data |
| `list-all-tags` | List existing tags | read_data |
| `add_note_to_contact` | Add an internal contact note | send_message |
| `add_note_to_conversation_by_id` | Add an internal conversation note | send_message |
| `add-or-remove-tag-on-contact` | Attach or detach an existing tag by ID | write_data |

The published piece declares multiple auth choices. Catalog projection selects its OAuth definition so Jarvis displays the connection picker. The delivered auth includes the region required by engine validation and the upstream OAuth props shape. Tag dropdowns accept IDs or workflow expressions; List Tags supplies tag IDs. No contact enumeration is needed in the editor.

Managed actions use fixed REST paths with API version 2.11, 15-second timeouts, a 1 MiB response cap and no automatic retries. Provider bodies and transport objects are not exposed in errors. Notes always use `message_type: note`; customer replies are outside this release. Write completion receipts prevent redispatch of confirmed writes; an uncertain result requires checking Intercom before retrying.

## Verification and release gate

Following [PIECE_VERIFICATION.md](PIECE_VERIFICATION.md), the gated engine test installs the actual npm package, extracts its catalog, verifies OAuth and output samples, and executes all six actions in a real engine subprocess against a local fake provider. Seven requests include both tag attach and detach. Downstream expressions consume contact IDs, flattened conversation parts, note bodies and tag IDs; recorded outputs must not contain credentials. Unit tests cover account isolation, tombstones, unsupported actions, endpoint restrictions, bounded responses, ambiguous lookup, sanitized failures, authority categories and held/completed receipts. CI runs the engine test.

Run:

```sh
bunx tsc --noEmit
bun test src/integrations/intercom-connection.test.ts src/workflows/runtime/managed-intercom.test.ts src/workflows/runtime/engine-bundle-purity.test.ts
JARVIS_TEST_ENGINE_BUILD=1 bun test src/workflows/pieces-library/intercom-engine.test.ts
bun run build:ui
```

Browser verification uses the real components with synthetic status/catalog responses, covering the dashboard, Settings, workflow fields and Google-style onboarding in light desktop and dark 390px layouts. This is not a live OAuth test or a claim of provider approval.

Before enabling for customers, complete the hosting guide's **Intercom registration and acceptance** checklist with a company-controlled development workspace. Register the app, choose minimum permissions, obtain any distribution approval and verify real consent, region/identity, all six actions, revocation and reconnect. No app credentials, deployment or live account writes were used during implementation. The documented OAuth response has no expiry or refresh fields; unexpected lifecycle fields fail closed. Google/CASA are unchanged.

When merging alongside the other provider PRs, retain all registry/source/UI entries and engine-test registrations. Reconcile the shared managed-action allowlist and connection-file helper once; preserve all providers' output samples when resolving the catalog schema version.
