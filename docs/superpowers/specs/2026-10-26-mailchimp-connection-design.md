# Mailchimp managed connection, 2026-10-26

Extend the approved ClickUp framework in separate main-based hosting and brain PRs. The framework PRs must merge first. Do not merge or deploy this provider automatically.

## Scope and boundaries

Company OAuth client ID and secret live only in the encrypted Admin integration store. The worker exchanges a browser-bound, one-use code, qualifies its non-expiring lifecycle, resolves the account's server prefix and identity, then atomically delivers the customer token to the instance. No provider-specific environment variables; existing APP_URL supplies the callback. Customer tokens are not persisted centrally.

Use the Google-style connection card in both onboarding paths, Settings and workflow account selection. The hosted Account page supports connect, reconnect and disconnect; Admin already supplies registration configuration.

Qualify the published @activepieces/piece-mailchimp 0.5.10 metadata and five managed actions: find_subscriber, add_subscriber_to_tag, remove_subscriber_from_tag, find_campaign, get_campaign_report. Fixed response projections provide useful output contracts. Explicit audience selection and lowercase email hashing identify a subscriber. Tag changes set is_syncing=true so tag automations do not fire. Campaign sending, bulk audience changes, subscriptions/unsubscribes, arbitrary API calls and triggers are outside this release. The community trust tier stays unchanged.

Mailchimp OAuth grants broad account access; the action allowlist limits Jarvis dispatch, not the provider token. Disconnect removes instance access; upstream consent revocation remains a separate Mailchimp account action. Positive expiry or refresh-token responses are rejected until a refresh implementation exists. Validate the data-center prefix and construct the API host in code; never follow arbitrary metadata URLs or redirects.

## Implementation and evidence

1. Register the provider and extend OAuth exchange/delivery with server_prefix, preserving revision, generation and ownership fencing.
2. Add an instance credential source, fixed endpoint adapter, audience/campaign choices and existing authority/receipt gates.
3. Add matching dashboard/onboarding/workflow UI and catalog output samples.
4. Exercise routes, token lifecycle, atomic delivery, account changes, write approval, malformed responses and failure/retry behavior. Install the pinned published package and run all five actions through the real engine against a local HTTP fixture, checking downstream variables and secret-free outputs.
5. Inspect rendered UI, run repository checks and all applicable CI, then document registration and the remaining live acceptance gate.

Live acceptance needs a company-controlled Mailchimp account, registered app, test audience and test subscriber, and an existing sent campaign with a report. It is not claimed by fixture tests.
