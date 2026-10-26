# Mailchimp managed connection

The first release supports five actions from `@activepieces/piece-mailchimp@0.5.10`: Find Subscriber, Add Subscriber to Tag, Remove Subscriber from Tag, Find Campaign and Get Campaign Report. The package remains community-tier. The version override pins this qualification; it does not mark the entire piece verified.

## What ships

- A company OAuth app configured in **Admin → Infrastructure → Integrations → Mailchimp**. No Mailchimp-specific deployment variables.
- Connect, reconnect and disconnect in the hosted Account page. Google-style cards in onboarding, Settings and workflow account selection.
- Instance-owned `jarvis:mailchimp` credentials, account-specific audience and sent-campaign choices, and explicit IDs or workflow variables.
- Fixed endpoint dispatch through Jarvis authority. Tag changes use completion receipts and `is_syncing: true`, so tag-triggered Mailchimp automations do not fire. No automatic retry after an uncertain write.
- Subscriber lookup requires an audience and an exact email. The identifier is MD5 of the lowercase email, as required by Mailchimp. A missing subscriber returns `found: false` only after confirming the audience exists.
- Search returns `results[].campaign`, `total_items` and `has_more`; reports return `report` and `summary`. Subscriber results expose `subscribers[]` and `primary_subscriber`. Tag actions return `success` and `data`. Output samples describe these managed projections for downstream variables. Custom include/exclude field filters are not supported with managed credentials.

Managed credentials cannot send campaigns, subscribe/unsubscribe contacts, create or delete audiences, call arbitrary API endpoints, or activate Mailchimp triggers. Manually configured community credentials retain the upstream execution path and are outside this qualification.

## Register the company app

1. Sign into a company-controlled Mailchimp account. Use an account owner/admin who can register apps and keep company recovery access.
2. Open Mailchimp's [Registered Apps](https://us1.admin.mailchimp.com/account/oauth2/) page and choose **Register An App**. Use **Jarvis** as the app name, company ownership details, and `https://usejarvis.dev` as its website.
3. Enter this exact redirect URI: `https://app.usejarvis.dev/api/integrations/mailchimp/callback`.
4. Create the app and save its client ID and client secret in the company password manager. Mailchimp shows the secret only once. Do not send it in chat or put it in source control.
5. After the framework and provider are deployed, open **Jarvis Admin → Infrastructure → Integrations → Mailchimp**. Confirm the displayed redirect URL matches, enter the client ID and secret, enable new connections and save. The shared encrypted store, audit log and `integrations.manage` permission apply.
6. Open the Jarvis customer's Account page with an active instance. Select **Connect Mailchimp**, confirm the Jarvis account, sign into the intended Mailchimp account and approve access. Return to Jarvis and wait for **Connected**.

Mailchimp grants broad account access. Jarvis's five-action restriction governs dispatch; it is not a narrower provider OAuth scope. The company secret stays on hosting. The worker exchanges the code, resolves the server prefix through OAuth metadata, probes account identity and delivers only the customer access token, server prefix and safe identity to the instance. It ignores arbitrary metadata endpoint URLs. Access tokens are non-expiring; a new expiring/refresh-token response fails closed until refresh support is implemented.

## Live acceptance before release

Use a company-owned test audience and a test email address you control. Use an **existing sent campaign** to test reporting; this release must not send a campaign to manufacture a report.

1. Connect from the hosted Account page. Verify the correct account appears in onboarding, Settings and workflow account selection. Confirm the token never appears in browser responses, logs or Admin.
2. Install/select Mailchimp 0.5.10 from the workflow library. Choose the managed account and audience, then look up the test subscriber. Confirm `primary_subscriber.email_address` is available to a downstream step.
3. Add a temporary test tag, inspect the subscriber in Mailchimp, then remove that tag. Confirm neither update starts an automation. Confirm Jarvis approval policy is respected and a completed-step retry does not repeat the write.
4. Find the existing sent campaign, pass `results[0].campaign.id` into Get Campaign Report and compare the totals with Mailchimp. Reports for unavailable/unsent campaigns must fail clearly.
5. Exercise denial, reconnect, disconnect and revocation. Disconnect must remove the instance token and prevent workflow use without a restart. Revoke upstream app access separately in Mailchimp's account integrations/authorized-app settings, then verify Jarvis asks to reconnect.
6. Confirm unauthorized actions and triggers fail readiness/dispatch with managed credentials. Switch accounts and verify choices refresh; a stale or inaccessible ID must never silently select another item.

These live checks require the registered app and company test account. Local fixtures and CI do not prove production consent, tenant delivery or live provider behavior.

## Automated verification

- `bun test src/integrations/mailchimp-connection.test.ts src/workflows/runtime/managed-mailchimp.test.ts` covers credentials, reconnect/disconnect, account changes, endpoint/input validation, response projection, MD5 parity, denied actions, authority and receipt behavior, bounded errors and single-attempt writes.
- `JARVIS_TEST_MAILCHIMP_ENGINE=1 bun test src/workflows/pieces-library/mailchimp-engine.test.ts` installs published 0.5.10, extracts real engine metadata, checks auth/output contracts and runs subscriber → add tag → campaign search → report → remove tag with downstream expressions. Only the disposable engine fixture redirects the account API host to localhost. Production code and the published package stay intact.
- The dedicated Mailchimp qualification workflow runs this fixture on PRs. The standard suite checks the rest of the application.
- UI verification uses real components with local API fixtures, including the actual workflow editor, Google-style onboarding, light/dark and narrow layouts. This is distinct from live acceptance.

## Merge and rollout

This branch is based on main plus the still-open ClickUp framework dependency (brain #1176; hosting #31). Merge that framework first, refresh these branches against main, then coordinate shared registry/UI/wrapper edits with Slack and Trello. Keep the hosting migration journal consistent: the main-based hosting baseline consolidates framework tables in migration 0088 because main already owns 0087. Do not apply duplicate framework migrations from both histories.

Deploy the hosting worker/API/dashboard and host wrapper before enabling new Mailchimp connections. Deploy the matching brain package to target instances. This PR does not merge, deploy, register the production app or configure real credentials.

References: [OAuth registration](https://mailchimp.com/developer/marketing/build/start-developing/set-up-an-oauth-app), [token lifetime](https://mailchimp.com/developer/marketing/api-concepts/authentication/oauth-2), [tag updates and automation suppression](https://mailchimp.com/developer/marketing/api/lists/members/create-member-tag).
