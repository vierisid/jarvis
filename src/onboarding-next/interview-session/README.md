# ON-B-04: recover written interview sessions

Optional, unregistered, default-off `interview-session.v1`. Construction starts
no work. The provider, headless client and socket adapter compile on main without
any other onboarding PR. The static manifest requires `interview-profile.v1`.
Missing either injected port or `enabled: true` returns unavailable, with no
storage or model call. ON-B-11 alone owns runtime/API registration; ON-U-10 owns
the UI mapping. This card changes neither legacy onboarding nor UI views.

## Server binding

`createInterviewSessionProvider` takes an authenticated context resolver, the
existing vault database selected for that scope, and two structural ports:

- `interviewer.create/prepare`: the existing interviewer, with its current
  prompt, themes and turn limit, adapted to **stage** fact/wrap effects. Prepare
  receives a cloned checkpoint and must have no profile writes or completion
  effects. Do not pass legacy `runInterviewTurn` directly: it writes inline.
- `profile.commit`: ON-B-05's durable, idempotent fact/wrap adapter. It must
  reconcile by the supplied stable `attemptId`, check `signal` and `isCurrent`
  before each effect, and resolve only after all required writes are confirmed.
  Retrying the same identity must not write the same fact twice. Only its
  `confirmedFactIds` are displayed as saved. ON-B-04 does not implement that
  profile store, fact identity policy, prompt or model loop.

The effect-staging binding and production profile acknowledgement implementation
are activation prerequisites. Tests use explicit provider doubles. One text-only
fixture executes the real existing interviewer with a scripted model and no
legacy tools. This is not real model or fact-writer certification.

`createSettingsInterviewStore` uses a versioned, hashed actor/project key in the
existing vault `settings` table and an immediate SQLite transaction. It does not
open a vault or create a table. Every request derives scope from authenticated
server context, including reads. Client IDs never select a vault or authorize
access. Recheck authorization after awaited work. Host binding changes require
new contexts and clients; never let a captured context retain revoked authority.

One session per actor/project is retained. Start resumes it, including terminal
states. No reset/re-enrol operation exists. The host must respect existing legacy
completion/journey eligibility before offering this provider. B01 remains the
journey owner; B11 maps confirmed session terminals to its acknowledgement port.

## Durability and recovery

Each prompt has a server turn ID. An accepted answer reserves that turn and
persists its exact text, immutable client request ID and write-attempt identity
before model work. Two tabs cannot answer the same prompt differently. Resends
return/reconcile the same turn; changed text under an old ID is rejected.

Prepared output is persisted before profile commit. Model failure retries the
same logical turn; fact acknowledgement failure retries only the commit using
the same identity. A crashed worker's expired lease can be reclaimed on explicit
start/retry/answer. An old worker cannot replace a newer lease's result. Pure model
generation can repeat after a crash before its checkpoint is stored; one logical
turn and one fact-write attempt identity are accepted. This does not claim
exactly-once remote model inference or exactly-once effects without ON-B-05.

Server work is bounded to 30 seconds by default (configurable up to 120 seconds).
Skip records a terminal state and aborts local waiting immediately; lease fencing
also rejects late replies from another process. Already committed facts are not
undone. A skipped record preserves its accepted answer and any uncertain commit
identity for profile reconciliation, without publishing a late bubble or marking
the interview done. Done is exposed only after the profile receipt resolves.

Transcript/checkpoint records are bounded to 32 turns, 16 KiB input/reply strings
and 2 MB serialized state. The checkpoint omits the duplicate system prompt and
does not use Pebble history. Future/corrupt records fail closed and stay intact.
No transcript, provider exception, credentials or profile facts are logged as
telemetry. Local records contain user text and follow the vault's privacy/access
controls. B11 must wire Forget/retention policy before activation.

## Written transport and client

`createInterviewTransportHandler` accepts only versioned written request
envelopes with `speakReply: false`; it returns a correlated snapshot envelope.
It registers no socket or route. `createInterviewSocketTransport` uses an injected
socket, correlates concurrent requests, ignores binary/unrelated voice events,
and removes listeners on response, close, abort or timeout. It never creates
audio or requests microphone access. Disconnect does not cancel accepted work.

`createInterviewClient` persists an unsubmitted draft and the original submitted
intent before transmission. Inject storage keyed by authenticated account,
project and stable tab ID; dispose/recreate on identity changes. A local storage
failure blocks send rather than silently losing the answer. Reconnect calls
start; refresh reads a snapshot without retrying work; retry preserves the
original answer/ID. Acknowledgement clears only that exact draft, preserving a
newer draft. Another tab's advanced prompt releases a rejected intent but keeps
its text for deliberate editing. Cursor and terminal guards reject late replies
and errors. U10 must map `busy` to pending UI immediately, wire errors/recovery,
map the snapshot into U04's controlled view, and own navigation acknowledgement.

## Verification and rollback

Run `bun test --preload ./src/test-preload.ts src/onboarding-next/interview-session`.
The socket integration test uses a real loopback WebSocket and temporary SQLite
file: cut after acceptance, reconnect/retry, preserve original answer and newer
draft, then assert one reply and no repeated opening. No paid model, real profile
write, production daemon, external connection or workflow action is involved.

Disable/omit the optional provider and keep the legacy path. Retain additive
session records, original drafts, confirmed facts and uncertain attempt receipts.
No destructive migration or data deletion is needed. Actual B05/B11/U10 and D/F/Q
activation evidence remains separate from this card's independent merge checks.
