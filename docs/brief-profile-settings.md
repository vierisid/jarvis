# Brief Profile and Settings (F-23)

Optional `profileSettings` provider, enabled only by `JARVIS_BRIEF_PROFILE_SETTINGS=1`
and explicit registration/activation in F-01. Default off. F-23 supplies a contract
and headless editor; D-29 owns the visible Profile/Settings rooms. F-24 remains
the separate hosting compatibility card. No provider calls, billing changes,
credential enrollment or automatic onboarding activation occur on read/save.

## Field mapping

Native Figma file `eNfKeirIKLZLlZEasrurZa`, page `81:2` (Pebble workspace v6.1),
node `392:3946` (15 · Profile), inspected on 2026-10-12. Also checked the matching
UI-33 stable-form component labels under the UI-35 checkpoint. Design examples
are illustrative and are never defaults or account data.

| Native field | Canonical value | Ownership and behavior |
| --- | --- | --- |
| Full name | Unavailable: `account_name_not_exposed` | Account identity. The current hosted `/api/billing` bridge exposes email, not full name. Never infer it from preferred name, memory, Google or email. No instance identity writer. |
| What should Jarvis call you? | `answers.preferred_name` | Assistant context; existing preferred-name question and memory projection. |
| Company | `answers.company` | Verified missing additive question in the existing profile record. No parsing/splitting of the free-form work/role answer. |
| Role | `answers.work_role` | Existing free-form Work / Role answer, retained verbatim. |
| What are you building? | `answers.current_projects` | Existing Current Projects question; never replaces Goals. |
| How you like to work | `answers.communication_preferences` | Existing communication preferences; never replaces routines, constraints or pet peeves. |

All answers live in **the same** `user.profile.v1` settings row. The 13 existing
questions remain editable by canonical ID alongside the additive Company question:

| Existing question | Canonical ID |
| --- | --- |
| Preferred Name | `preferred_name` |
| Pronouns | `pronouns` |
| Location / Timezone | `location_timezone` |
| Work / Role | `work_role` |
| Interests | `interests` |
| Current Projects | `current_projects` |
| Goals | `goals_next_90_days` |
| Communication Preferences | `communication_preferences` |
| Pet Peeves | `pet_peeves` |
| Routines & Constraints | `routines_constraints` |
| Tools & Stack | `tools_stack` |
| Important People | `important_people` |
| Anything Else | `anything_else` |

The contract provides the complete question list. Consumers must retain fields
outside the compact design instead of flattening or dropping them. Interview
facts remain in the canonical record and are preserved without being treated as
individual form answers. Memory corrections update this same record and invalidate
the edit revision; unchanged saves cannot resurrect forgotten projections.

## Read and save

Authenticated daemon routes, all responses `Cache-Control: no-store`:

* `GET /api/brief/profile-settings` → `{status:'ready', data}` (contractVersion 1).
* `PATCH /api/brief/profile-settings/profile` → `{revision, answers}` request;
  `{saved:true, profile:{revision,answers}}` response.
* `PATCH /api/brief/profile-settings/voice` → `{revision, voice}` request;
  `{saved:true, application, voice}` response.

No query parameters or caller-selected scope. Bodies allow only the documented
keys, cap at 64,000 bytes, and reject malformed UTF-8/JSON. Profile patch keys must
be known question IDs, at most 4,000 characters each. Null or a blank answer clears
that answer; omitted answers remain untouched. Invalid input writes nothing.
Existing profile records above 256,000 characters fail closed for this editor.

Profile revision hashes the canonical row and memory field revisions, not a
second store or wall-clock timestamp. Compare and write run in one immediate
transaction; `409 revision_conflict` never overwrites a concurrent writer. No
automatic mutation retries. The headless `ProfileEditor` retains drafts through
polling, out-of-order reads, conflicts, and typing during a pending save. Explicit
discard/reload is the consumer's choice after showing any unsaved-edit warning.

The existing `/api/user-profile` GET adds `revision`. Its current Settings form
captures that revision with the edit draft and POSTs it back. Revision-bearing
legacy saves patch only named answers. When F-23 is enabled, missing revisions
receive HTTP 428 and require a reload; disabled F-23 retains the old unversioned
POST behavior. Explicit Clear and onboarding replay retain their existing
destructive semantics. Company is additive, but an older binary does not expose
it and can drop it when rewriting the canonical record: back up before rollback.

## Preferences and ownership

Check-in frequency is explicitly unavailable (`check_in_not_supported`, no choices).
The old heartbeat interval/active-hours settings are unused by the current daemon;
writing them would falsely promise a schedule. No new scheduler is introduced.

Voice edits affect **standard TTS only**, use the shared existing Edge and Usejarvis
voice catalogs, and validate on the server. Realtime voices and dynamic ElevenLabs
or Sarvam selection remain in the existing Settings form. Those providers return
`use_existing_voice_settings`; arbitrary design voices are never accepted. A
stored custom voice may be displayed as its exact canonical value but is not
advertised as a supported choice. Provider unavailability and damaged settings
have explicit reasons. Choice availability describes configuration support, not
a successful live-provider check or entitlement assertion.

Voice revisions cover the stored TTS row and effective provider/deployment state.
Saves call `persistUserPatch('tts', {voice})`, preserve credentials and nested
settings, and never stamp a provider default, enable speech, rewrite `config.yaml`,
or touch SYSTEM-owned blocks. Hosted silent users keep their included provider
default across save/restart. The existing reload coordinator applies the voice.
`application:failed` means **saved but not applied**; `restart_required` means no
apply adapter was supplied. Neither means the save should be retried. Errors are
fixed codes, never provider exception text or secrets.

Account identity stays external on hosted installs (`readPath:'/api/billing'`) and
unavailable on self-hosted installs. The existing authenticated bridge owns account
reads, browser links and their unavailable/error states. This adapter does not
copy identity into assistant context or make account/billing mutations.

`openVoiceSettings()` selects the existing Channels Settings form, which already
handles deployment-aware provider setup. `replayProfileSettings('profile'|'tutorial',
true)` calls the shared `resetOnboarding` client and existing `/api/onboarding/reset`
route, including cache invalidation/broadcast/reload. Profile replay clears saved
context; the consumer must show confirmation first. No `setup`/`all` replay is
offered by this adapter, and no action runs on mount, refresh or browser return.

## Verification and rollback

Fixture-only tests use temporary SQLite databases, a temporary keychain directory,
fake reload appliers, and a real authenticated HTTP server over a temporary Unix
socket. No production daemon, real voice call, email, OAuth, payment or deployment
is used. See `docs/brief-delivery/F-23.json` for commands and results.

Quick verification: in an isolated fixture enable the flag, read capabilities and
the snapshot, patch Company with its revision, and restart/read it. Reuse the old
revision and verify 409 without data loss. Verify a hosted voice-only save stores
only `voice`, retains secrets, and keeps provider silence. Remove the flag and
verify the capability and new routes are unavailable.

Rollback: disable the flag first; the new routes stop accepting reads/writes.
There is no migration to reverse. Preserve the vault/keychain backup and keep
the current canonical rows. Revert this card's commits only, preserving the staged
F stack. Visible D-29 binding, human review, merges and deployment remain separate
release gates; passing fixtures do not claim production activation.
