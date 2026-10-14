# ON-U-03: Google connection view

Controlled, optional Google-only onboarding screen. Not registered or activated.
Targets `main` at `5024ea7455a5613be0514475be32c0dee6de0edd` and builds without
another onboarding PR. Owns only this directory and its delivery receipt/evidence.

## Design

Approved Figma file `eNfKeirIKLZLlZEasrurZa`, onboarding page `1097:16402`;
idle `1097:16449`, connected illustration `1097:16490`.
Checkpoint: `Onboarding · Tutorial focus contour · 2026-10-14`, version
`2410205462365531104`. Retains the single Google row, asymmetric corners,
progress line, title, Back/Skip/Continue and Brief theme materials.

The pre-connection copy describes the purpose, not an existing permission.
Connected access is the provider's actual `grantedAccessSummary`, never a
hard-coded send right. Empty account/scope summaries are explicitly unknown.
The preview's read-only grant and account are illustrative.

## Host contract

- `GoogleView` accepts serializable `GoogleModel` and intent callbacks. It has no
  OAuth calls, polling, timers, external windows, storage or navigation effects.
- `connection.state` uses the frozen Google vocabulary. `pending` means waiting,
  not connected; only provider-confirmed `connected` shows the check and grant.
- `onConnect()` asks the host to start/retry. `onCancel(attemptId)` asks it to stop
  waiting for that attempt. Neither changes this controlled view by itself.
- ON-B-03 owns authorized status reads, attempt correlation, stale/late callbacks,
  scope verification, external-window handling, cancellation and listener cleanup.
  Reconcile late grants without advancing another journey. Never treat a window
  opening or cancellation request as a confirmed terminal result.
- `onBack()` and `onSkip()` remain available during connection waiting. The host
  stops waiting/cleans listeners when leaving. Skip does not revoke an existing
  grant or mark a new connection as successful. `onContinue()` is unavailable
  while waiting; in other states it requests the next step without claiming a
  connection. Google remains optional, as in the approved screen.
- `navigation` is separate from connection waiting. Host-owned navigation pending
  suppresses every callback while retaining DOM identity and focus. The host must
  guard duplicate requests and transfer focus when the actual next screen mounts.
- Error/unavailable messages must be safe, redacted user-facing prose, not raw
  OAuth responses, tokens or consent URLs. Rendering escapes text; it does not
  replace server-side redaction or authorization.
- `progress` belongs to the journey. Omit when unknown. The preview supplies the
  approved 3-of-6 illustration; the view does not infer hosted/self setup order.
- `manifest.json` requires `google-state.v1`. ON-U-10 owns optional UI discovery;
  ON-B-11 owns runtime registration. Missing providers stay unsupported. No absent
  sibling imports or fake production providers are introduced.

## Verify

```sh
bun test ui/src/onboarding-next/views/google ui/src/v2/onboarding
bunx tsc --noEmit
bun run build:ui
bun build ui/src/onboarding-next/views/google/preview/index.html --outdir /tmp/on-u-03-preview-build
bun ui/src/onboarding-next/views/google/preview/serve.ts
```

Open `http://127.0.0.1:4412/`. Connect -> Cancel sign-in -> Try again stays local.
Only selecting the fixture's `connected` scenario confirms the illustrative grant.
Try denied consent, window failure, expired/unavailable, both themes, long account
and navigation pending/error. Preview zoom is CSS enlargement, not a native
browser/WebView zoom test. No real sign-in or account mutation is performed.

Rollback before registration: revert this PR; there is no data migration. After
registration, disable the optional host entry before removing this module. Keep
journey/connection records and the legacy entry. Do not remove Telegram elsewhere.
