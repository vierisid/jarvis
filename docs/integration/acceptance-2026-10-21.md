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


## Walkthrough pass 4: interview-based activation suggestions

- The first-workflow page reads the canonical Profile API after a completed interview. It displays the latest stated goal and offers the actual saved routine(s), with a goal-planning starting point when no routine was recorded. Generic examples are clearly labelled and appear only without usable interview suggestions/goal. A failed profile read is explicit and does not display stale or unrelated suggestions. Skipped interviews do not read profile context.
- Selecting a suggestion puts the goal, routine, available work/tool context and approval preferences into the editable request sent unchanged through intent validation and workflow composition. It does not create a second goal, grant access or run work. No domain-specific templates, invented apps, schedules or metrics. The interviewer now records a routine consistently under rhythm. Canonical facts are sorted chronologically, matching first-goal selection, and existing memory suppression still applies.
- Existing drafts, deliberate empty edits and uncertain request IDs are preserved on reload/back/retry. Suggestions refresh from canonical facts; a selected request remains user-owned text. Prompts stay within 2,000 characters without splitting facts; if goal/routine/approval boundaries cannot fit, no suggestion is manufactured. The personal layout has tighter vertical spacing and full-width routine choices.
- Regression tests fail against the previous implementation. The affected onboarding/Profile suite passed 1,058 tests, zero failures. Final focused tests, TypeScript, UI detector and normal commit hooks are recorded in the machine-local pass-4 logs. The UI detector reported no findings.
- Live acceptance used GPT-6.1 Sol, synthetic Tide and Thread answers and the actual daemon on 3147 in `/home/vierisid/.jarvis-activation-pass4-20261021`. Four answers produced five canonical facts. The activation page displayed the 50-orders/month-by-December goal and Friday Shopify/Sheets sales routine. Selecting the routine carried the user's pasted-input-only boundary into the request. Reload, daemon restart, Back to tour and return preserved the request. Create produced **Friday sales summary draft**, and View your request confirmed all interview context. Continue to dashboard displayed the same draft goal.
- Receipt: goal `4bc72d94-268d-4b8a-ae4d-d2c67126b513`, flow `vp43pdhAXE7Bg8iLEWmJe`, version `2TWj8t51N2lg6bs81LHSd`. SQLite confirmed one goal, one workflow and zero runs. This pass skipped the tour content already tested in pass 3 and tested draft creation/handoff, not execution or third-party connections.
- Screenshot: `C:/Users/vieri/.codex/visualizations/2026/10/20/01a15867-3427-7ba0-9c7e-383700e463b0/activation-pass-4-personalized.png`. Private receipt and test logs: `/home/vierisid/.cache/codex/jarvis-activation-pass4`. The AIOS index generator remains blocked by the disconnected `workspace/Jarvis/team-shared` mount (OSError 19).


## Walkthrough pass 5: active interview OKR

- Completing or exploring onboarding after a completed interview prepares a full proposal through the existing NLGoalBuilder. The latest canonical goal remains the objective; the saved interview supplies context, targets, routines and approval boundaries. A complete plan requires 2-5 key results and milestones for each. Missing baselines become planning work rather than fabricated measurements. Skipped/no-goal interviews and existing goals retain their prior behavior.
- The canonical GoalApplicationService creates the objective, key results and milestones and activates every node at the dashboard handoff. Journey exit, goal tree, events and the durable receipt share one transaction. Authority stays zero and no progress is fabricated. Prepared proposals are tied to the interview digest; stale facts, revocation, invalid plans and partial writes fail closed. Retries reuse the prepared plan; receipts prevent duplicates and resurrection after deletion. Existing draft goals/old receipts are not migrated.
- Exit feedback says the goal plan is being prepared. Only the onboarding exit receives a 120-second budget across the host/session/HTTP/server layers. A confirmed failed workflow build now releases its retained request for editing; an uncertain build remains locked until reconciliation.
- Verification: the affected onboarding/UI/goals suite passed 1,418 tests; subsequent focused runtime/host checks passed 94 tests, rollback checks passed 9 tests, and transport/recovery checks passed 40 tests. Counts overlap. TypeScript passed and the UI detector returned no findings. New assembly regressions failed against the prior implementation and passed with the fix. Transport tests initially collided with running instances on 3143/3144; they passed with test-only port substitutions to 43143/43144 and Bun in PATH, then the test file was restored.
- Live acceptance used the real daemon, GPT-6.1 Sol and synthetic Tide and Thread interview answers on port 3147, in `/home/vierisid/.jarvis-okr-pass5-20261021`. Four answers recorded the 50-orders/month-by-December objective, missing baseline, Friday Shopify/Sheets routine and manual/review boundaries. The tour content was skipped (covered in pass 3). An unsupported workflow composition was rejected; after the recovery fix its request became editable, and a revised manual Agent/Notify checklist built successfully.
- Continue to dashboard generated one active objective, three active key results and six active milestones: establish the baseline, maintain the Friday review routine and reach the stated order target. Today and Goals displayed the complete plan. All ten nodes had authority zero, score zero and activation timestamps. One workflow remained a draft; zero workflow runs or external messages occurred. Browser reload and daemon restart preserved all ten goal rows unchanged.
- Receipt: objective `b7355f79-e584-4c65-8571-11483e851749`, journey `7d54a38d-de0e-45a4-afdf-3b9a47fc0eb5`. Evidence and logs are in `/home/vierisid/.cache/codex/jarvis-okr-pass5`. Screenshot: `C:/Users/vieri/.codex/visualizations/2026/10/20/01a15867-3427-7ba0-9c7e-383700e463b0/okr-pass-5-active.png`.


## Walkthrough pass 6: dashboard goal-card alignment

- Vieri accepted onboarding and goal creation. Subsequent walkthrough passes preserve the current brain/native data and completed journey, restarting directly at the dashboard. No fresh profile, enrollment or onboarding reset.
- Today now summarizes only the objective's direct key results. The complete milestone tree remains in Goals. The card retains the Figma 306px companion width, 18px padding, asymmetric corners, ten-segment main bar and footer action. Key results use compact two-line labels (full text available on hover/accessibility), continuous blue/green tracks and aligned values. The hidden reserved footer label shares the visible label's layout so its arrow does not add unwanted height.
- Existing measured counts remain counts. Otherwise the canonical normalized goal progress is shown as a percentage, including zero. A missing initial fraction displays zero only in this card; this does not write measurements, infer business counts from titles, or alter outcome evidence elsewhere. Nonzero-baseline/decreasing metrics use their canonical progress rather than an incorrect value/target ratio. Weekly changes appear only when provided by measured data.
- Focused GoalCard, Goals and host tests: 57 passed, zero failures. TypeScript passed; design detector returned no findings. Live checks used Vieri's saved Morloven objective on 3146: 0% overall, three key-result rows, no milestone dump or Not measured text. Light/dark themes, What’s next and Escape return were checked. This pass changes the dashboard card, not goal generation, execution or measurements.
- Machine-local preservation snapshot and verification files: `/home/vierisid/.cache/codex/jarvis-dashboard-pass6`. The saved instance has eleven goal-tree nodes and a completed journey; no data reset is part of this pass.


## Walkthrough pass 7: useful first-dashboard checklist

- A confirmed empty decision hero now offers ten workspace setup/discovery steps: goal and key results, default authority, governed actions, connections, profile, memory, workflow library, Needs you, opportunities and preferences. Three remaining steps show initially; all ten can be expanded. Each opens its actual room, with the existing goal selected when available. Real decisions retain priority; loading and error states are not disguised as empty.
- Completion is an explicit personal acknowledgement, never inferred from opening a page. Check/undo and hide/resume persist in one revisioned vault setting. Strict authenticated routes reject unknown fields, stale revisions and malformed state. Failed or uncertain writes require refresh before another change. No permission, goal, onboarding or execution changes are made by checking a step.
- Verification: 135 focused Profile/settings, Today and host tests passed; TypeScript passed. Design detector scanned the two new UI files with no regex findings (element-level checks do not run on source scans). Live checks on 3146 opened all ten destinations, corrected workflow navigation to the library containing the existing Morloven draft, and verified completion, reload, hide, daemon restart, resume and undo. Light/dark appearance and the conversation-open layout were visually checked. Test completion was undone to leave 0/10 for Vieri.
- Existing data/profile and completed onboarding are retained. Evidence: `/home/vierisid/.cache/codex/jarvis-dashboard-pass7`; screenshot `C:/Users/vieri/.codex/visualizations/2026/10/20/01a15867-3427-7ba0-9c7e-383700e463b0/dashboard-pass-7-checklist.png`. This pass tests navigation and checklist persistence, not execution or configuration of every destination.


## Walkthrough pass 8: sequential Today setup hero

- Replaced the list with one setup action at a time using the existing Today decision hero's outlined surface, angled paper stack, typography, motion and responsive layout. Hover/focus lifts the paper and reveals its page shortcut; Review setup action provides a keyboard/touch disclosure and Escape closes it. The original ten destinations and saved acknowledgements remain.
- A review strip on the real destination provides Done, back to Today and Back without completing. Completion waits for the server acknowledgement, counts one setup action and returns to the next hero card. The existing unsaved-edit navigation guard runs before acknowledgement. Opening a page, hovering or returning without completing does not count. No permissions, workflow activation, business outcomes or activity evidence are fabricated.
- Review context survives reload in owner-scoped local storage. Progress still uses the existing revisioned vault setting. Duplicate presses, stale/failed/lost acknowledgements and retired owners cannot advance the sequence incorrectly. Undo, hide/resume and the all-complete state remain available. Real decisions retain priority. A background refresh of a previously empty decision queue retains the setup hero rather than remounting its open paper; failed reads still show unavailable.
- Live acceptance on the saved 3146 instance visited all ten real destinations, completed each review and reached 10/10. Undo restored the initial 0/10 state. A destination reload retained the review controls; returning without completing retained the current task. Light/dark, resting/raised paper and conversation-open layout were visually checked. The source detector reported no regex findings; element-level checks do not run on source scans. The affected 139-test suite passed; final focused tests cover the same sequence plus errors, guarded navigation, scope retirement and background-refresh behavior.
- Evidence and preservation snapshot: `/home/vierisid/.cache/codex/jarvis-dashboard-pass8`. Screenshot: `C:/Users/vieri/.codex/visualizations/2026/10/20/01a15867-3427-7ba0-9c7e-383700e463b0/dashboard-pass-8-hero.png`. Existing goals, workflow, onboarding, configuration and native enrollment are retained. This verifies setup review/navigation, not changes to authority or execution of workflows.


## Walkthrough pass 9: ready Pebble chat, topic titles and working marker

- Opening the Pebble with no active chat now ensures a ready conversation through the authenticated lifecycle API. The server transaction reuses the existing active/open chat across windows and uncertain retries. Closing the last tab while the Pebble is open creates a new writable chat; closed messages are retained. Failed creation offers an explicit retry instead of looping. Hidden Pebbles do not create chats.
- Accepted first written messages supply a bounded local topic label, persisted with turn acceptance. Existing untitled history derives the same label from its earliest written user message on read, including after restart. Named chats and subsequent messages retain their title. No extra model request is used for naming. Live acceptance changed Vieri's previous New chat to A cool fact without altering its four messages.
- Inspected the already-open Chrome Figma editor and prototype, UI-20 working reference nodes 738:402158 and 738:379733, in light and dark. Plain replies now use the same 8px current-work pebble and restrained movement as the activity list. Offline and reduced-motion states remain still; approvals retain their own status, and completion shows the answer immediately. No illustrative Goal/Memory checks are invented.
- 128 focused lifecycle, HTTP, transport/client/provider, tabs, composer and message tests passed. TypeScript passed. The UI detector returned no source findings (element-level checks do not run on source scans). Live 3146 acceptance closed the last tab, received an automatically created writable chat, sent two actual-model questions, observed the moving marker and streamed answers, and verified the saved title. Original chat reopened and selected through the authenticated API; test chat history retained separately.
- Snapshot/evidence: /home/vierisid/.cache/codex/jarvis-dashboard-pass9. All eleven goal rows, completed onboarding, settings (including Vieri's now-complete 10/10 setup progress), and original messages compare unchanged. Native enrollment is checked separately across the final relaunch. No reset, onboarding replay, workflow execution or deployment.


## Walkthrough pass 10: unclipped wordmark

- The embedded wordmark extended beyond the original SVG viewBox: browser text bounds ended at x=1300.82 in a 1280px viewport. Expanded both light/dark viewBoxes from 515.7 to 532 units, retaining the embedded font, colors and original paths. Updated the lockup widths proportionally so the sidebar, standalone brand and cropped Pebble/composer marks keep their original scale.
- Rebuilt the local UI and inspected the real dashboard. Both corrected SVG variants end at x=1260.48 inside the same 1280px viewport, leaving visible room for the final s. Expanded and collapsed navigation and the Pebble crop were visually checked. Sidebar logo height remains 36.83 CSS pixels. No data or onboarding changes.
