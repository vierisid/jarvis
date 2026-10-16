# ON-U-04: written interview

An optional, controlled presentation module. It is not imported by the shipped
onboarding entry. No session, model, storage, microphone, audio, OAuth, goal or
Authority effect occurs inside the view.

## Design and ownership

Roadmap: onboarding UI/UX v1, 14 October 2026, ON-U-04. Figma file
`eNfKeirIKLZLlZEasrurZa`, page `1097:16402`, checkpoint
`Onboarding · Tutorial focus contour · 2026-10-14`, version
`2410205462365531104`. Live prototype nodes inspected: `1097:16517`,
`1097:16538`, `1097:16607`. Dark materials reuse the approved Brief tokens.

This directory owns the view, scoped styles, tests and isolated preview only.
ON-U-10 owns discovery/registration and host mapping; ON-B-04 owns session
behavior; ON-B-05 owns confirmed facts/completion; ON-B-11 owns runtime exposure.
Enable only after those capabilities and the combined D/F/Q candidate are
verified. Missing providers keep the legacy entry available.

## Host contract

Import `InterviewView` and its local structural types from `index.tsx` after
capability discovery. Do not make sibling feature branches compile-time
dependencies. The manifest provides `interview-view.v1` and requires
`interview-session.v1` and `interview-profile.v1`.

- The model is a presentation projection, not a new transport schema. Map the
  canonical session ID, turn ID, request ID, ordered cursor and terminal state.
  `resumed` is an additional observation, not a replacement wire phase.
- Keep messages chronological with unique stable IDs; mark partial assistant
  messages `streaming`. The newest assistant question is the central heading.
  Prior questions and answers remain in the scrollable transcript below.
- Keep the existing adaptive interview themes and question generation in the
  provider. The view generates no questions and has no questionnaire engine.
- Own draft persistence outside this component. Allocate a unique request ID for
  each changed draft. Once submitted, the ID and body are immutable. Preserve a
  newer draft typed while awaiting a response; clear only the acknowledged text.
- `onSubmit` emits the exact draft, session, turn and client request ID once.
  The host must immediately move to thinking/pending, reconcile provider events,
  and reject stale identities. The local guard is not server idempotency.
- On an unconfirmed answer use `recovery: {kind: "answer", answer}` with the
  original immutable intent. Retry emits that intent, not the current draft.
  Advance `cursor` on another failed retry so another deliberate retry is
  possible. Session/turn mismatches are not offered for retry.
- Use `{kind: "session"}` for reconnection or provider-owned reconciliation.
  This view never decides whether an uncertain answer was committed.
- `confirmedFactIds` contains only acknowledged Memory identities. Null means
  unknown, not zero. The view deduplicates IDs and excludes blank IDs. Do not use
  predicted facts or interview messages as confirmations.
- A provider-confirmed `done` and a provider-confirmed `skipped` have different
  terminal surfaces. Optional farewell text must describe saved context, never
  claim active goals or Authority rules. A save failure remains an error.
- Skip/Continue emit intents without changing the terminal state optimistically.
  `navigation.revision` must advance on acknowledgement or failure, even when
  returning to ready. Pending navigation prevents further intents and edits.
  Return a safe user-facing error instead of raw transport details.
- Callback exceptions/promise failures belong to the host: catch them and publish
  the corresponding error/recovery model. Do not leave an intent unacknowledged.
- A changed session ID resets local interaction guards and reading position.
  Theme changes preserve the current draft, focused input and reading position.

The composer grows from 44 to 132px upward; Send stays at its bottom edge.
Enter sends; Shift+Enter inserts a newline. IME composition, keyCode 229 and held
Enter do not send. Streaming text is visible but not announced fragment by
fragment. A separate polite status announces the completed question. Scroll
anchors preserve the first visible transcript item during content and width
changes; Latest question is the explicit return to the top.

The host supplies `--on-setup-height` if the view occupies a container rather
than the viewport. Load the already merged global fonts/primitive styles. No
sibling theme provider is required.

## Local verification

From this worktree:

```sh
bun test ui/src/onboarding-next/views/interview ui/src/v2/onboarding
bunx tsc --noEmit
bun run build:ui
bun build ui/src/onboarding-next/views/interview/preview/index.html --outdir /tmp/on-u-04-preview-build --target browser
bun ui/src/onboarding-next/views/interview/preview/serve.ts
```

Open http://127.0.0.1:4413/. Set `ONBOARDING_PREVIEW_PORT` for another port.
The loopback fixture has no backend. All facts, questions, replies and timing are
illustrative; Return reply explicitly advances the fixture.

1. Check Fail next answer, type an answer and press Enter.
2. Type a newer draft, expand Answer awaiting confirmation, then Retry answer.
   The retry retains the original ID and answer; the newer draft survives.
3. Return reply, then compare resumed, connecting, streaming and saving-error.
4. Compare done, skipped and unknown. Only done with confirmed identities shows
   the positive saved-context completion; unknown never becomes zero.
5. Try long, scroll into history, Return reply, resize, then Latest question.
6. Compare Light/Dark, 390/768/1440px, No motion and 200% preview zoom.

DOM tests cover composition events, request guards, retry, navigation, focus,
fact counts, streaming and synthetic scroll anchoring. Manual browser checks cover
actual keyboard/scroll/layout behavior. Native IME, assistive technology,
WebView zoom and real provider durability are separate integration checks.

## Rollback

Before registration, revert this optional module. After registration, disable
the optional UI entry before removal. Keep the previous onboarding entry and
all journey/session/Memory records. There is no migration or data cleanup.
