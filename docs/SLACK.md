# Slack connection and workflow qualification

Scope: hosted bot connection using the shared ClickUp framework, with channel discovery, channel info, bot messages and thread replies. Registration/deployment instructions and the importable app manifest live in the companion hosting repository's `docs/SLACK.md`. Google/CASA remain on their existing path.

## Contract

The worker atomically delivers `~/.jarvis/connections/slack.json`, owner-only mode 0600. It contains version 1, provider `slack`, status `connected`, UUID generation, access_token, account `{id: bot_user_id, label}`, one workspace `{id, name}`, connected_at, and `settings.scopes`: the granted scopes comma-joined, which must be exactly `channels:read`, `groups:read`, `chat:write`. A disconnected document carries no token. The brain resolves `{{connections.jarvis:slack}}` as OAuth with the bot token and workspace metadata. Company client credentials never enter the brain.

Status endpoints expose labels, setup URL and local grant state, never credentials. Connected means a stored grant, not a continuous Slack revocation probe. Generation/account/token fingerprint changes invalidate existing workflow bindings on reconnect; disconnect removes resolution immediately. The channel endpoint is a fixed read-only Slack API request with a bounded response, explicit pagination and membership filtering. It never accepts an arbitrary destination URL.

## Qualified actions at @activepieces/piece-slack 0.23.1

| Action | Permission | Output contract |
| --- | --- | --- |
| `slack_find_channel` | read_data | Channel object including `id`, `name` |
| `slack_get_channel_info` | read_data | `{ok, channel: {id, name, ...}}` |
| `slack_post_message` | send_message | `{ok, channel, ts, message}` |
| `send_channel_message` | send_message | Same receipt; use `threadTs` for a reply |

The existing verified catalogue status is not broadened. Hosted managed credentials reject other actions and all Slack triggers during readiness validation; runtime also checks the action, channel, bot identity options and thread timestamp. Manual Slack accounts retain their existing behaviour. The setup panel states the supported subset. No history, workspace search, files, DMs, user impersonation, events or org-wide installs are included.

### Deliberate send-transport adaptation

The published package's Slack SDK retries internally, outside the workflow completion boundary. For these two send nodes using **managed Slack credentials only**, Jarvis performs one fixed `chat.postMessage` POST after the normal Authority decision. This avoids duplicate sends after an uncertain response. Text, blocks, destination channel, thread timestamp, broadcast and unfurl options are mapped explicitly. Attachments, custom sender identity and origin-flow attachments are rejected. Find Channel and Get Channel Info execute the published node code.

Successful sends persist the existing completion receipt before returning. Errors or transport loss remain uncertain and cannot automatically replay the step. The application does not retry rate-limited sends. An operator must check Slack before an intentional new run. Channel-history reconciliation is not supported by these scopes. Normal bot-only posting needs `chat:write`; channel discovery uses `channels:read` and `groups:read` ([Slack API](https://docs.slack.dev/reference/methods/chat.postMessage/), [channel listing](https://docs.slack.dev/reference/methods/conversations.list/)).

## Verification against PIECE_VERIFICATION.md

| Stage | Evidence and remaining gate |
| --- | --- |
| 1 source | Inspected published 0.23.1 auth helpers and the four action implementations. Added downstream samples where needed. |
| 2 build | Community npm bundle is installed directly; engine hash includes the managed-send adapter. |
| 3 bootstrap | Credential source and status routes wired at daemon startup. The test uses an isolated engine; live hosted startup remains a rollout gate. |
| 4 catalog API | Production projection retains required/auth fields and stable message/channel outputs. |
| 5 extraction | Gated test extracts metadata using the real engine and published npm package. |
| 6 editor | Slack account control, joined-channel picker and Google-style onboarding card are rendered with actual UI components in a local fixture. Live deployed output-chip interaction still requires acceptance. |
| 7 execution | Real queue/engine/resolver/Authority flow: find -> info -> post -> reply, with downstream channel and timestamp references. Both the package read URL and the engine adapter send URL are redirected to a disposable localhost fixture. No live Slack request occurs. |
| 8 tests | Connection, chooser, permission, single-attempt transport, readiness and real-engine tests; manual acceptance below remains pending. |

```sh
bun test src/integrations/slack-connection.test.ts src/workflows/runtime/managed-slack.test.ts
JARVIS_TEST_SLACK_ENGINE=1 bun test src/workflows/pieces-library/slack-engine.test.ts
bunx tsc --noEmit
bun run build:ui
```

The engine test checks published metadata, exact calls, parent timestamp mapping and absence of the fixture token in run history. It is not a live OAuth test.

## Deployment and live acceptance

Deploy the ClickUp framework first, then both Slack changes and hosting wrapper 48. Converge the existing system-owned `usejarvis_integrations.page_url`, normally `https://app.usejarvis.dev/account`. Install/pin Slack 0.23.1 in the shared piece tree; rebuild the engine and catalogue (schema version 10).

Register one company bot app with rotation disabled and exactly the three bot scopes. Configure its Client ID/Secret in Jarvis Admin -> Infrastructure -> Integrations -> Slack. Connect through customer Account, then invite the app to a company-controlled sandbox channel. No service environment variable is needed for Slack credentials.

Complete `PIECE_VERIFICATION.md` stages 4, 6 and 7 on the deployed instance: select the managed account, pick the sandbox channel, inspect output chips, execute the four-action sequence, and confirm the parent/reply in Slack. Test cancellation, expired consent, disconnect/reconnect, revoked access, missing membership, approval denial and uncertain-send recovery. Record actual run IDs and provider evidence before release.

Local disconnect removes this instance's token only. Uninstalling the app in Slack removes the shared bot installation and affects every Jarvis connection to that workspace. Slack's [distribution guide](https://docs.slack.dev/app-management/distribution/) permits unlisted pilots and directs commercial apps to Marketplace review. Neither registration nor review has been completed by these PRs.
