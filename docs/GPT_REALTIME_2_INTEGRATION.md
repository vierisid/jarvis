# GPT-Realtime-2 Integration

Premium opt-in speech-to-speech voice via OpenAI's GA Realtime API
(`gpt-realtime-2`). When enabled with a key, JARVIS streams mic audio to OpenAI
and plays the model's audio back, with the daemon acting as both the audio relay
and the tool executor. When disabled (the default) JARVIS uses the standard
STT -> text LLM -> TTS pipeline, which is unaffected by anything here.

This document is the rationale companion to the code; source files reference it
by section. It is intentionally decision-focused rather than a full API spec.

## 1. Entitlement & key resolution

Entitlement is simply "the user supplies a working OpenAI key" - there is no
separate licensing. Resolution (`resolveRealtimeVoice`, `src/config/realtime.ts`)
never throws: when realtime is unavailable it returns `{ ok: false, reason }`
and the caller logs a warning and falls back to the standard pipeline.

Key resolution: the realtime session reuses the key of the OpenAI provider
configured under Settings > LLM (stored in the DB + encrypted keychain). There
is no separate realtime credential and no `config.yaml` or env-var fallback -
if no OpenAI provider is configured, realtime voice reports unavailable.

The user is billed by OpenAI directly (BYO key). The Settings > Voice GET
endpoint redacts the key and reports `has_api_key` / `available` only.

## 2. Protocol notes (GA, post-2026-05)

These were confirmed via the live smoke test (`scripts/realtime-smoke.ts`) and
are load-bearing - they differ from the older beta:

- Connect to `wss://api.openai.com/v1/realtime?model=...` with a Bearer key and
  **no** `OpenAI-Beta` header.
- Session config is nested under `session.audio.{input,output}` with
  `session.type: 'realtime'`.
- Reasoning effort is `session.reasoning.effort` (GPT-5 convention), not a
  top-level field.
- Output audio events use the `response.output_audio*` names
  (`response.output_audio.delta`, `response.output_audio_transcript.*`).
- `format.rate` is **required** on both input and output audio formats. OpenAI
  rejects an input rate below 24 kHz (`MIN_REALTIME_INPUT_RATE`); transports
  capturing lower (e.g. a 16 kHz mic) must upsample before streaming.
- Turn detection uses plain `semantic_vad` - the low-latency, preamble-friendly
  default. `server_vad` and eagerness tuning both measured worse. The first-turn
  "doesn't start" symptom was dropped opening audio (fixed by transport
  buffering), not the VAD - leave it alone.

### Latency decisions

- A lean ~100-token voice prompt is used instead of the full ~5.6k-token agent
  prompt; the big context dominated per-turn latency for simple questions. Tools
  are still attached so capability is unchanged.
- The opening words of a turn are buffered during the connect window
  (`MAX_PENDING_MIC_FRAMES`, a sliding ~3s window of the most recent audio) so
  the first utterance isn't lost. The window keeps the most recent audio for VAD
  continuity rather than the absolute earliest frames.

## 3. Audio transport (§3a)

`AudioTransport` (`src/comms/audio-transport.ts`) decouples `RealtimeSession`
from where audio comes from / goes to. Contract: PCM signed-16 little-endian,
mono; the transport declares its sample rate so the session announces a matching
`audio.input.format.rate`.

`BrowserAudioTransport` is the only implementation today: mic frames arrive as
binary WS frames (`pushMicChunk`) and output audio is relayed to the browser via
the `sendAudio` hook. Playback timing/queueing lives in the browser
(`RealtimeVoiceController`, `ui/src/lib/`). A `PebbleAudioTransport` can be added
later against the same interface with no session changes.

### Barge-in

On `input_audio_buffer.speech_started` the session both cancels the in-flight
response server-side (`response.cancel`) and stops local playback. Cancelling
matters: without it OpenAI keeps generating tokens/audio the user will never
hear, and trailing deltas can replay over the interruption. Deltas that arrive
after a cancel (before the next `response.created`) are suppressed.

## 4. Daemon wiring

### Phase 2 - session wiring

`RealtimeVoiceSession` (`src/daemon/realtime-voice.ts`) glues a
`RealtimeSession` to an `AudioTransport` and to the tool executor. It is kept
separate from `ws-service` so it is unit-testable with an injected session
factory. ws-service opens (or reuses) one session per socket; a session spans
the whole conversation (semantic VAD detects turns), and is closed on
disconnect, on `max_session_minutes`, or when the monthly budget is reached.

When the server closes a session it sends `realtime_status: { state: 'closed' }`;
the browser must stop streaming on this, or it keeps a hot mic streaming into a
session that no longer exists.

### Phase 3 - auto-approve tool bridge

`orchestrator.executeRealtimeToolCall` mirrors the text-path authority gate but
**auto-approves**: a `requiresApproval` decision is executed so the audio loop is
never blocked on a dashboard click. Still enforced:

- emergency state,
- explicit hard denies,
- the `blocked_categories` backstop.

Every realtime tool call is written to the audit trail tagged `channel: 'voice'`;
an auto-approved call is logged as `approval_required` + `executed: true` so the
trail shows no human confirmed it.

**Safe defaults.** Because the mic is open and tools auto-approve, the backstop
must be safe by default. When `blocked_categories` is unset it defaults to every
`destructive`-impact action category (`DEFAULT_BLOCKED_CATEGORIES`): payments,
deletes, shell exec, software installs, settings changes, agent termination.
These stay blocked unless the user explicitly opts them back in by setting
`blocked_categories` to an explicit array (including `[]` to disable the backstop
entirely). This prevents an open mic - or TTS echo / background speech - from
triggering an irreversible action unattended.

### Cost guards

- `max_session_minutes` - hard cap on a single session; the daemon closes it on
  timeout.
- `monthly_budget_usd` - soft monthly ceiling. Spend is **estimated** from
  session wall-clock at the ~$/min figure shown in Settings > Voice (OpenAI
  bills per token, but no live invoice is available mid-session), persisted per
  month under the data dir (`realtime-budget.ts`), and checked at session start.
  Once the estimate reaches the budget, new sessions are refused with a
  `realtime_status: { state: 'closed', reason: 'budget', message }` (the client
  surfaces the message as a system line and stops the mic), and the standard
  pipeline is unaffected. This is an approximate guard, not accounting:
  - Spend is only recorded at session close, and `canStart` reads fresh at
    start, so concurrent sessions (e.g. multiple browser tabs) opened before any
    close all observe the same pre-spend total and can overshoot the cap. This
    is accepted for the single-user daemon; close it with an in-memory in-flight
    reservation if multi-session overshoot ever matters.

`GET /api/config/voice` reports the **effective** `blocked_categories` (the
applied default when unset) plus `blocked_categories_default: true|false`, so a
client can't misread the safe default as "nothing blocked" and a read-modify-
write round-trip can't silently persist `[]` and disable the backstop.

## 5. Input validation

`POST /api/config/voice` validates the patch (`validateVoicePatch`,
`src/daemon/config-merge.ts`) before merge/persist: known top-level keys only,
`wake_engine` and `reasoning_effort` against their enums, `max_session_minutes`
bounded numeric, `monthly_budget_usd` non-negative-or-null, `blocked_categories`
an array of strings. The merge preserves the stored `api_key` when the patch
omits it (the GET endpoint redacts it, so a UI round-trip never sees the value).
