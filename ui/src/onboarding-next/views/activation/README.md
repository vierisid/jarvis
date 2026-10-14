# ON-U-07: First-workflow prompt

Optional, unregistered presentation module. Target `main` independently; no
imports of sibling onboarding or unmerged D/F/Q code. Existing onboarding and
its Talk path are unchanged until ON-U-10 explicitly replaces that entry.

## Design

Native Figma file `eNfKeirIKLZLlZEasrurZa`, page `1097:16402`, checkpoint
**Onboarding · Tutorial focus contour · 2026-10-14**, version
`2410205462365531104`. Live inspected nodes: empty `1097:48090`, meeting
`1097:48110`, investor update `1097:48130`, competitor brief `1097:48150`.
Heading, example text, review note and action labels follow those screens.
Dark values follow the established onboarding/Brief palette. The static mark
uses the unchanged official path from D-16's `styles/assets/usejarvis-light.svg`
at `20e4d1a30fea4b24a753320dd313fdc680f2f697`; no logo redraw or D UI fork.

## Controlled host contract

`ActivationView` receives a serializable model and callbacks. Mount it in the
setup viewport (`--on-activation-height` defaults to `100dvh`, or set `100%` in
a sized host). The host owns draft persistence, journey revision and navigation.
Keep `journeyId` stable; change it for a genuinely different journey. Appearance
and local typing must not advance the authoritative revision.

`onDraftChange` synchronously feeds the next controlled draft. Keep raw prompt,
explicit context references and clarification answers intact across exit/return.
Suggestions change text only and focus the input; they neither submit nor grant
access. Length/blank checks are UI guards, not replacements for B-07 validation.
The 2,000-character limit preserves the existing activation limit without
silently truncating overlong restored/pasted text.

`onIntent` receives one of create/back/explore/resolve_connection. This is a
local presentation intent, **not a newly defined HTTP API**. Create contains the
versioned build-request projection plus separately keyed clarification answers.
The host passes those answers through B-07 and retains the original prompt. It
must not reinterpret the text as permission to publish, enable, run or send.
References come from the host, never guessed from text or manufactured by UI.

The host must reserve and persist the request/answers before job submission and
map them to B-07/B-08, deriving authorization from server context. Persist the
same pending request for reload reconciliation. Identical retries reuse its
request ID, prompt, references and answers; changed body/new validation requires
a new identity. The UI creates the first UUID only on explicit submission.

A resolved callback means delivered, not accepted. Controls stay locked until
authoritative model feedback advances `revision`. `checking`, `submitting` and
`accepted` remain locked. On acknowledged invalid/needs_input feedback, increment
revision and supply safe message/issues; editing and correction stay in the form.
Host code must correlate feedback to the original request and discard stale
replies. Clear resolved issues when appropriate; do not invent connected status.

If create throws/rejects, acceptance is unknown. Only retry of the exact request
is offered; editing and Explore are withheld until the host reconciles it. After
reload, provide `pendingRequest` with its unchanged answers and matching draft.
Use phase `ready` only if safe same-key reconciliation can be requested; while
the actual job is working use `submitting` or hand off to ON-U-08. Never unlock a
possibly accepted job by incrementing revision for unrelated UI state.

`resolve_connection` is an optional host navigation intent retaining the draft,
not OAuth or a connection mutation. Enable its button only when the host can
handle it. Back targets the tour; Explore is an explicit exit without workflow
success. The host maps it through the durable journey so it cannot race a job.
Failures of those navigation callbacks are locally retryable without losing text.

Enter adds a line; Ctrl/Cmd+Enter explicitly submits. IME/held-key guards and the
same-turn lock prevent accidental repeated submission. Input stays mounted and
readable during feedback. On ample-height desktops growth is upward with a
fixed bottom action position; compact/long forms scroll normally to retain all
content and keyboard-reachable actions. No animated height or fake build progress.

## Preview and verification

```sh
bun ui/src/onboarding-next/views/activation/preview/serve.ts
# http://127.0.0.1:4416/
bun test ui/src/onboarding-next/views/activation ui/src/v2/onboarding
bunx tsc --noEmit
bun run build:ui
bun build ui/src/onboarding-next/views/activation/preview/index.html --outdir /tmp/on-u-07-preview-build
```

Choose an example, edit it, click Create and inspect the receipt. Response
fixtures cover missing details, connections, invalid requests, pending and
transport failure. Return to request is a **fixture reset**, not a production
reconciliation operation. Explore/Back show a fixture handoff with a return that
retains the draft. No provider, live connection, chat send or real workflow exists
in this preview. The enlarged toggle exercises CSS scaling, not native browser
zoom or a WebView accessibility certification.

Enable only after ON-U-10, ON-B-07, ON-B-08, ON-B-11 registration and verified
D/F/Q assembly. Rollback: disable this optional view, then revert its own files;
retain journey/request/draft data and the previous onboarding entry.
Exact evidence and limitations: `docs/onboarding-delivery/ON-U-07.json`.
