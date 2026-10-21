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
