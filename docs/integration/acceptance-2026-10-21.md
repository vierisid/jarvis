# Local onboarding and workflow acceptance, 21 October 2026

Scope: authenticated local app on `main`, real provider setup, native Windows sidecar, onboarding through a saved workflow, publication, manual execution, run inspection, and Figma comparison. Hosting and deployment remain deferred.

## Result

The result screen now lives inside the actual workspace shell. Its canvas, inspector, navigation, unsaved-edit guard and completion controls share the dashboard owners. A published version opens as a pinned read-only canvas; a newer draft cannot silently replace it. Saved drafts can be published and manually run. Cancelling the run dialog releases its button, and an uncertain request is reconciled by receipt rather than automatically submitted again.

The Pebble lesson uses the actual shell, conversation tabs and composer with explicit sample behavior. Short windows keep the conversation usable. Interview summaries now enter the canonical Memory projection, with stable provenance, correction and Forget suppression. Startup reconciles interviews saved by the previous writer. The local entry restores the saved theme and loads the normal product fonts.

Additional fixes: invalid sample JSON cannot clear the stored sample or claim success; rich-text fields in published inspectors are read-only; the node chooser has a close control; voice-preview failures release the button and show an error; leaving a voice setup step cancels its pending preview.

## Live environment and execution evidence

- Brain: port 3145, data directory `/home/vierisid/.jarvis-acceptance-flow-20261021`.
- Native sidecar: Windows 0.11.0, isolated `C:\\Users\\vieri\\JarvisFlowAcceptance-20261021` bundle/profile, enrolled as `acceptance-flow`.
- Provider: real OpenAI gpt-5.5 setup and connection test. No scripted model substituted in this walkthrough.
- Real interview: 11 saved summaries; reload retained progress. After the integration repair and daemon restart, Memory displayed all 11.
- Flow: `zuRWSalCX8suf0JdmCiMu`; published version `s1g7wQG8xO56II74PGLKo`; later draft `jFfq8LCN56nEWzRGuaf4G`.
- Isolated step test `BUyiq5frr58eY6YbyLImm` and explicit manual run `xLOnuYBBKHDlcRK7VBbYO` both SUCCEEDED. Database verification found the expected “Acceptance check complete” output and exactly one manual-run receipt.
- The test workflow used a manual trigger and a text-only agent task. It sent no email or external messages and remains disabled for automatic triggering.
- User instances on 3143/3144 and their saved workflow were preserved. Their email-related workflow was never run.

## Button and state checks

| Surface | Live checks |
| --- | --- |
| Welcome and setup | Light/Dark, Set up, explainer Back/Continue, connected sidecar, permission continuation, provider selection and connection test, setup Back with validated provider retained, hearing selection and text-only Skip, No voice continuation |
| Google | Connect reported unavailable configuration; Back/Continue/Skip stayed navigable |
| Interview | Submit real answers, intermediate reload, completion, saved-count and final reload |
| Twelve tour rooms | Every Next and Back; Skip and re-entry; final Pebble lesson |
| Tutorial Pebble | Corner opener and Open Pebble, X, Escape, Back, suggestion chips, add/select/close chat tabs, per-tab draft retention, finish; sample Send and attachment intentionally disabled |
| Activation/build | All three examples, edit request, Back/Skip/reload preservation, Create, request disclosure and Check status, saved-draft handoff |
| Result | Reload without finishing, Review steps, inspector X and Configure/Input/Output, Save/Discard, dirty navigation lock, zoom in/out/Fit, summary disclosure, Check again, request disclosure, Open in Workflows |
| Samples | Invalid JSON rejected; valid Save; Clear Cancel and confirmation; Reset to declared; isolated Test this step |
| Canvas | Title edit cancelled with Escape; step rename/save; add node, categories/search, chooser X, delete Cancel/confirm, Undo, Discard, drag/Arrange; sidebar collapse/expand |
| Publication/run | Publish, Run Cancel/reopen, invalid array input rejected, valid object input accepted once, Refresh, successful step inspection and effect receipt |
| Version/context | Canvas/Runs/Context tabs, Configured/Used by run, Refresh, Edit a new draft; reopen old published version while newer draft exists, verify published fields locked and draft edits retained |
| Workspace | Every main navigation destination loaded; native device connected; live Pebble new chat/X/Escape/room navigation preserved draft; theme survived reload |
| Tutorial replay | Settings Replay, Keep settings, confirm replay, all steps to Pebble, finish returns to workspace without changing provider/profile |

Build cancellation raced with completion during the real run, so its cancellation/retry/late-event branches are covered by the automated provider and view tests, not claimed as a successful live cancellation. Alternate result completion and disabled/error branches are exercised by component/adapter tests. The matrix covers this onboarding-to-workflow path, not every optional connector or library node in the catalog.

## Figma comparison

Inspected the authenticated **Jarvis · Brief · Working design** file:

- [Brief · Pebble workspace v6.1, workflow canvas](https://www.figma.com/design/eNfKeirIKLZLlZEasrurZa/Jarvis-Brief-Working-design?node-id=81-1715)
- [Onboarding result](https://www.figma.com/design/eNfKeirIKLZLlZEasrurZa/Jarvis-Brief-Working-design?node-id=1097-48233)
- [Onboarding Pebble lesson](https://www.figma.com/design/eNfKeirIKLZLlZEasrurZa/Jarvis-Brief-Working-design?node-id=1097-44821)

Checked shell/sidebar/breadcrumb, dark palette and fonts, workflow title and tabs, vertical node cards, selected-state outline, inspector containment, visible zoom controls, Pebble placement and close behavior. The test graph has two nodes rather than Figma's illustrative five. Node zoom adapts to the viewport. At 1280 × 720 the tutorial card takes a separate row so it cannot cover the conversation. This is visual alignment and functional verification, not a claim of pixel-identical screenshots.

The saved request is currently a read-only disclosure; editing a durably generated workflow happens in its draft canvas. The Figma “Back to your request” interaction has no canonical revise-build command and is not presented as a working regeneration control.

## Verification and limits

- 568 UI/host/workflow/onboarding tests passed across 43 files.
- 72 profile/vault/interview-provider tests passed across 6 files.
- 245 memory, workflow-context, composer and related integration regressions passed across 13 files.
- 1,166 broader onboarding/workflow-route tests passed across 76 files. Scopes overlap and must not be added.
- Local UI build passed. Impeccable detector found no findings across 18 changed UI targets. Commit uses normal repository hooks, including type checking.
- Google consent, microphone/OS permission prompts and successful live voice output were not exercised. Local Google was unconfigured; Edge voice preview failed and its recovery was fixed/tested. No hosting/deployment acceptance is claimed.
- Run input/output privacy redaction remains in the inspection UI. Success and literal output were also verified directly in the isolated test database.
- Browser screenshots and private test logs are kept outside the repository; no credentials, enrollment tokens, personal logs or database files are committed.

Restart the existing dev command after checkout changes; the launcher does not hot reload. The [launcher guide](local-dashboard-onboarding.md#run-the-real-daemon-with-a-fresh-sidecar) explains fresh data directories and sidecar enrollment.


## Walkthrough pass 1: provider models and paid-plan copy

2026-10-21, `fix/local-walkthrough`, primary checkout only. Refreshed Anthropic,
OpenAI, Gemini, Groq, Ollama and OpenRouter suggestions and shared them between
onboarding, Settings and the corresponding provider fallbacks. NVIDIA and gateway
live discovery remain in place. Catalog source links and verification date live
in `src/llm/model-catalog.ts`. Existing saved model selections are not migrated.
Jarvis AI now says "Paid / Available on paid plans" on self-hosted setup; hosted
provisioning still controls availability.

GPT-6 uses the official Responses endpoint, including streaming, tools, images,
usage, cancellation and typed HTTP errors. Compatible gateway URLs keep Chat
Completions. Current Claude models omit unsupported temperature parameters.

Verification: provider/onboarding/Settings tests passed, TypeScript passed, UI
build passed, and the design detector returned zero findings. GPT-6 regressions
fail against the previous transport and pass with the fix. The real localhost
screen was checked for all six updated provider choices and the paid-plan label.
These are protocol fixture tests and browser checks, not paid live calls to every
provider. Account-specific model access is checked by Test connection.

Owner's iteration rule: commit locally on this same branch, restart the actual
checkout on port 3146 with fresh brain data and a fresh native profile after each
pass, and let the owner replay onboarding. Preserve prior data/profile directories
as local backups; do not create worktrees or deploy.


## Walkthrough pass 2: OpenAI connection-test HTTP 400

The first GPT-6 integration passed the connection probe's five-token budget
straight through to Responses as `max_output_tokens: 5`. A live reproduction
using the previously configured acceptance OpenAI credential returned HTTP 400:
"Expected a value >= 16, but got 5 instead." The same request with 16 returned
HTTP 200/completed. This establishes a Jarvis request defect; it is not an audit
of the separate credential entered in the native window.

The Responses adapter now raises sub-minimum output budgets to 16, preserves
larger budgets and reports the upstream JSON error explanation while redacting
credential values/key fragments. Non-JSON failures retain their HTTP status and
retry classification. No provider settings or stored credentials were changed.

Two route regressions failed before the fix and passed afterward. All 43 focused
provider/connection-route tests pass. A real call through `testLLMProvider` with
`gpt-6.1-sol` returned `{ok: true, model: "gpt-6.1-sol"}` using the acceptance key.
The source API reference is https://developers.openai.com/api/reference/python/resources/responses/methods/create.


## Walkthrough pass 3: interview, Profile and first goal

- Work stays in the primary `fix/local-walkthrough` checkout. The written interview displays only the latest question. Send and Enter immediately clear the visible composer and show pending feedback; the original answer and request ID remain in per-tab storage until acknowledgement. Errors restore the text. Retry first reconciles server state, covering a lost request or lost acknowledgement without duplicating a turn.
- The interviewer asks for the most important outcome and a concrete success target/timeframe when missing. It does not invent metrics or deadlines. The completed interview remains canonical profile context, now visible in Profile under **From your interview**, without overwriting separately edited questionnaire fields. Memory suppression still hides forgotten/superseded source statements.
- A completed interview's latest stated goal becomes one canonical draft objective when the journey finishes or explores the dashboard. The goal and journey transition commit atomically. Receipts prevent duplicate creation on retries/replay or resurrection after deletion. Existing goals are preserved. Skipped/no-goal interviews do not fabricate a goal. Draft objectives have authority zero and do not start work. Today shows a draft when no active goal exists and **Review goal** opens its exact Goals selection.
- Regression evidence: the previous implementation failed nine relevant checks; the changes passed the full affected onboarding/Profile/host/goal-card scope (1,140 tests, zero failures). Additional Profile suppression and draft-review checks passed in a 35-test run; the final atomic-failure and initial-goal scope passed 12 tests. These counts overlap. TypeScript passed and the UI detector returned no findings. One earlier test assertion still expected the old goal-context-only prompt; it was updated to the new host contract while retaining legacy prompt semantics. A fixture-build attempt without Bun in PATH failed; rerunning with the configured PATH passed.
- Live acceptance used the actual daemon on 3147, GPT-6.1 Sol and synthetic Tide & Thread answers, in `/home/vierisid/.jarvis-interview-pass3-20261021`. Both Send and Enter visibly cleared the composer. A vague goal prompted a success/timeframe follow-up; five answers produced seven saved facts. The entire 12-step tutorial, Pebble opening, real model workflow build, Continue to dashboard, Review goal and Profile navigation completed. Profile survived reload. The first dashboard showed **Reach 50 online orders per month for Tide & Thread by December 2026.** as a draft.
- Durable receipt: journey `6a682a19-79ae-431e-8894-aaadf3f168ea`, goal `7d5b9e04-9852-4866-b4fa-690a3a118c02`, flow `lLDxyKnuCMabA6iCcTN0Z`, draft `cYI2nPVPtWDw5iHl06q4m`. SQLite confirmed one goal, one workflow and zero runs. This pass tested creation and handoff, not workflow execution or third-party connections. No Shopify/Google access or external messages were used.
- Screenshots: `C:/Users/vieri/.codex/visualizations/2026/10/20/01a15867-3427-7ba0-9c7e-383700e463b0/interview-pass-3-{question,dashboard,profile}.png`. Private machine-local receipt and full test logs are in `/home/vierisid/.cache/codex/jarvis-interview-pass3`.
