# ClickUp: hosted connection and task node qualification

Status: ready for code review, pending live company-app verification. Google and CASA remain outside this change. Hosting companion: `usejarvis/hosting`, branch `feat/clickup-connection`, `docs/CLICKUP.md` for registration and deployment.

## User flow

Connect through hosted **Account → ClickUp**, brain **Settings → Integrations**, the Connected Workspace setup action, or either onboarding experience. The hosted account page owns sign-in, reconnect and disconnect. No client secret or personal token is pasted into the brain.

For a task node, select **Use this account**, then choose its workspace, Space and List. Folderless lists and lists inside folders are included. **Enter IDs or variables** remains available for computed destinations. Read/update task IDs can come from an earlier node's `id` output. Optional status values and assignee ID arrays can be entered directly.

For **Create Task**, choose **Use standard task fields**. Upstream 0.9.1 declares `custom_fields` as a required dynamic property even when no custom fields are used. The button saves an explicit empty schema and empty object, with `check_required_custom_fields: true`. ClickUp rejects a task if the List actually requires custom fields. Existing nonempty custom-field input is not overwritten. Advanced custom-field schema editing is outside this first release.

## Qualified scope

| Action | Behavior | Permission | Output |
| --- | --- | --- | --- |
| `create_task` | Create a task using standard fields | write_data | task object |
| `get_list_task` | Read a task by ID | read_data | task object |
| `update_task` | Update task name, description, status, priority or assignees | write_data | task object |
| `get_task_by_name` | Find an exact task name in a List | read_data | first matching task, or error |

The package is pinned to **@activepieces/piece-clickup 0.9.1**. Its community badge remains. These four actions are mapped to the workflow permission boundary; all other actions fall back to the highest permission category. Create/update use the existing completion receipt protocol to avoid repeating a mutation after an ambiguous outcome. Triggers and the rest of the upstream actions have not been qualified.

## Credential contract

The hosting worker atomically delivers `~/.jarvis/connections/clickup.json`, mode 0600:

```json
{
  "version": 1,
  "provider": "clickup",
  "status": "connected",
  "generation": "<uuid>",
  "access_token": "<secret>",
  "account": {"id": "<clickup user id>", "label": "<account label>"},
  "workspaces": [{"id": "<workspace id>", "name": "<workspace name>"}],
  "connected_at": "<ISO timestamp>"
}
```

The managed reference is `{{connections.jarvis:clickup}}`. Like `jarvis:google`, it is valid only as the whole `auth` of a ClickUp step: readiness refuses any other reference (a CODE or HTTP step, another piece, a non-auth input), the engine's credential route refuses a run whose graph has one, and a ClickUp `custom_api_call` with it may only reach a path under the piece's base URL or an https URL on `api.clickup.com`. The brain refuses a connection file that is not a regular file or is over 64 KiB; it does not check the file mode, which the hosting worker owns. Metadata APIs expose account/workspace labels, connection state and setup URL, never the token. A generation/account/token fingerprint participates in existing run binding checks. Reconnect changes the fingerprint; disconnect makes resolution return null immediately. A stored grant means connected locally, not a live probe of remote revocation.

The public setup link comes from the system-owned `usejarvis_integrations.page_url` config block, e.g. `https://app.usejarvis.dev/account`. User settings cannot change this block. Deploy the hosting config convergence before expecting Connect on existing instances.

## Verification against PIECE_VERIFICATION.md

| Stage | Evidence / remaining gate |
| --- | --- |
| 1 source shape | Inspected published 0.9.1 auth, props and the four action implementations. Output samples added for stable task fields. |
| 2 build | Community npm bundle is used directly; Jarvis-authored piece compilation is not applicable. |
| 3 daemon bootstrap | Managed source is registered in daemon startup. Gated engine test uses a disposable piece root; live hosted startup remains a deployment gate. |
| 4 catalog API | Production catalog projection preserves auth/required fields and provides downstream samples. Workspace/Space/List selectors use fixed read-only provider routes. |
| 5 engine extraction | Real engine EXTRACT_PIECE_METADATA succeeds, auth and scoped actions asserted. |
| 6 editor | Browser fixture checks managed account selection, hierarchy choices and standard task fields with actual editor components. |
| 7 engine execution | Actual published action code runs in a real engine subprocess through managed credential resolution, authority and queue handling. Only the provider base URL is replaced in a disposable copy. |
| 8 tests | Credential, chooser, workspace projection, permission and gated engine tests pass. Create → read → update → find uses real references and asserts output without token leakage. Live ClickUp read-back remains pending. |

```sh
bun test src/integrations/clickup-connection.test.ts src/integrations/clickup-options.test.ts src/brief/connected-workspace.test.ts src/workflows/runtime/governed-pieces.test.ts
JARVIS_TEST_CLICKUP_ENGINE=1 bun test src/workflows/pieces-library/clickup-engine.test.ts
bunx tsc --noEmit
bun run build:ui
```

The gated engine test installs the npm package and builds the engine if needed. It verifies source transport behavior against a local HTTP fixture, not the real provider. It must not be presented as a live OAuth test.

## Live acceptance, after company app registration

Register the OAuth redirect `https://app.usejarvis.dev/api/integrations/clickup/callback` from a company-owned ClickUp workspace. After the companion hosting change is deployed, open **Jarvis admin console → Infrastructure → Integrations → ClickUp**. With **Manage integrations** permission, paste the company Client ID and Client Secret, enable new connections, and save. The existing encrypted store holds the pair; the API and worker read it on demand. No ClickUp environment variables or service restart is required. Keep a backup in the company password manager and give the tester only the sandbox List URL. No secret in chat or this repository.

The hosting framework owns the reviewed provider registry, company app configuration, shared connection routes/jobs and revision checks. Saving changed credentials expires older sign-ins and queued connects. Disabling blocks new sign-ins while existing grants and customer disconnect remain available. Google remains on its existing path under Lapo. The instance document may include a non-secret `definition` containing provider ID, capabilities and API hosts; current ClickUp credential resolution remains compatible.

Use a sandbox List without required custom fields. Complete sign-in, inspect workspace/Space/List choices, and run the four-node sequence. Confirm the created task and changed name in ClickUp. Inspect downstream output chips and run records. Deny/cancel sign-in, disconnect/reconnect, revoke the provider grant, and check write approval and recovery behavior. Record evidence before release.

[ClickUp authentication](https://developer.clickup.com/docs/authentication) documents workspace authorization and currently non-expiring OAuth tokens. No token refresh flow is assumed. [Get Spaces](https://developer.clickup.com/reference/getspaces), [Get Folders](https://developer.clickup.com/reference/getfolders) and [Get Folderless Lists](https://developer.clickup.com/reference/getfolderlesslists) define the chooser endpoints.
