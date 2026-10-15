# ON-B-11 verification — 15 October 2026

Baseline: `02727336b50bd2f89469d06b7fd6f3947d1b47d7` on main. The PR has no
sibling onboarding commits. See the receipt for pinned B02/B03/B04 candidate heads.

| Check | Evidence |
| --- | --- |
| Independent branch | 92 focused tests pass, three real B02 cases skip because its source is absent. TypeScript and UI build pass. |
| Actual partial assembly | Temporary detached candidate combines this work with B02/B03/B04. 220 tests pass. Real B01/B02 persistence, isolated keychain, service/auth doubles. TypeScript and UI build pass. |
| Remove B02 | Regenerate literal imports, run runtime tests and TypeScript. No unresolved setup import; commands remain blocked. |
| Remove every provider | Regenerate an empty catalog, run runtime tests, TypeScript and UI build. Legacy endpoint still works; new commands remain blocked. |
| Full synthetic matrix | Empty/single/partial/full manifests compile; deleting each required capability blocks dispatch. Optional diagnostics is not required. This is no claim of real future-provider assembly. |
| Transport | Loopback HTTP checks authenticated read-only status, no-session 401, legacy status, and default-off 503 commands. Version mismatch, forged scope, body size/abort and error redaction covered. |
| Compatibility regressions | 72 package, session-liveness and TCP/unix WebSocket tests pass. |
| Packaging | Package dry-run includes generator and ignored generated catalog. Source-free dependency-stage invocation skips safely. Docker runtime COPY retains the start/dev generator; no image build run. |
| Review | Direct implementer review, no independent approval. Corrections and their regression coverage are listed in the receipt. Normal commit hooks run. |

The real setup tests check both initially stopped and already-running host services.
An injected TTS rebind failure preserves durable setup but leaves journey setup
pending. Retrying applies LLM/TTS/Awareness, confirms startup, then acknowledges
B01. A subsequent retry preserves timestamp and revision. Revoking the session
during reload prevents subsequent service calls. Stored voice decline is retained;
new hosted setup persists Awareness off.

The partial candidate status reports B01 bound, B02 bound but unavailable without
service ports, B03/B04 `binding_missing`, future providers `module_absent`, and
overall supported/ready/enabled/released false. These are actual assembly results
using an isolated vault and an explicit fake enrolled-session resolver.

The full release is blocked. Google/OAuth, interviewer effects and retention,
future workflow providers, the UI adapter, native behavior, and candidate-bound
D/F/Q plus U11/B13 evidence are not supplied by fixtures. No real account, model,
production workflow, deployment or native permission change was performed.

To repeat a combined check, create a disposable detached worktree on the PR head,
merge only the pinned provider heads without committing, install frozen
dependencies, generate the registry, and run the receipt's test/build commands.
Move provider directories outside `src` before regenerating for removal checks.
Never perform those removal checks in an active developer or production checkout.
The temporary integration checkout is not a PR base and is discarded afterward.
