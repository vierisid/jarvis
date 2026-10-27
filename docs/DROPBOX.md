# Dropbox managed connection

Hosting registers the company app through its shared Admin registry and delivers the customer grant
into `connections/dropbox.json`. The instance validates it on each use. Access-token renewal calls
only the matching configured hosting origin, with the shared HMAC protocol. A separate mode-0600
`dropbox-access.json` cache is bound to the entire delivered grant. The brain never overwrites the
hosting-owned grant file; reconnect/disconnect wins a renewal race. Revocation requires reconnect;
transient network, configuration and rate-limit failures preserve the grant. Concurrent calls in one
process share renewal, and the persistent cache survives restarts. Dropbox refresh tokens do not rotate.

The managed account is scoped to `@activepieces/piece-dropbox` and these four 0.9.2 actions:

| Action | Category | Output |
|---|---|---|
| `search_dropbox` | read_data | matches, has_more, optional cursor |
| `list_dropbox_folder` | read_data | entries, cursor, has_more |
| `get_dropbox_file_metadata` | read_data | id, name, paths and metadata |
| `create_new_dropbox_folder` | write_data | metadata |

Managed dispatch uses fixed Dropbox API endpoints, bounded JSON, a home-root header, no redirects
and one transport attempt. Folder creation has Authority approval and durable completion receipts.
Triggers, custom API calls and all other managed actions are refused at readiness and credential resolution.
The upstream package keeps its community badge. Only these actions have been qualified.

Search matches file names and active entries. Advanced search filters and advanced metadata flags
are not enabled. The OAuth write scope is broader than folder creation; hosting consent discloses this.
This first release uses the user's home namespace, including mounted folders, not team-space roots.
Use `/` to list the home root; the adapter translates it to Dropbox's empty root path after engine
validation. Folder paths and workflow variables use the published action fields. Search/list are
bounded pages, with `has_more` exposed rather than silently claiming a complete listing.

## Verification

Follow `docs/PIECE_VERIFICATION.md`. The fixture installs the published 0.9.2 package, extracts
its actual metadata, checks authentication and output samples, and runs all four chained nodes through
the real queue, engine, credential resolver and Authority boundary. Only the API host in a disposable
engine copy is redirected to a local fixture. Production endpoints and published package bytes stay intact.

```
JARVIS_TEST_ENGINE_BUILD=1 bun test src/integrations/dropbox-connection.test.ts src/workflows/runtime/managed-dropbox.test.ts src/workflows/runtime/engine-bundle-purity.test.ts src/workflows/pieces-library/dropbox-engine.test.ts
bunx tsc --noEmit
bun run build:ui
```

Hosting's `docs/INTEGRATIONS.md` owns app registration and the exact callback. After both PRs deploy,
register the company app, save credentials in Admin, connect a sandbox account, and verify the editor's
account control, required fields, output chips and real runs. Then test expiry renewal, disconnect,
reconnect and provider-side revocation. Local fixtures do not prove live OAuth or deployed acceptance.
