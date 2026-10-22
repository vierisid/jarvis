# Local dashboard and onboarding integration

Approved scope: finish the merged dashboard/onboarding bindings and run local integration tests. Hosting PR F-24 and deployment are deferred by the owner on 20 October 2026.

## Architecture

Reuse canonical providers, SQLite stores and the existing authenticated API/WebSocket owners. Supply a stable UI composition root with all 19 room bodies, one conversation owner and shared capability/reconciliation state. Connect the optional onboarding host to the same services, preserving durable request, journey, job, flow and version identities. No fixture data may become a missing-provider fallback.

Keep ordinary production release gates default-off. A separate local integration entry may explicitly authorize its isolated process; it must report integration mode, preserve authentication and provider readiness, and never fabricate release receipts. External models and Google are replaced only at declared test boundaries. Missing hosting is reported as deferred, not passed.

## Implementation sequence

1. Complete onboarding provider assembly, lifecycle and durable build dispatch.
2. Bind daemon capabilities and the dashboard composition root, retaining legacy routes.
3. Finish workflow preview/draft destinations and all room adapters.
4. Connect onboarding view adapters, tutorial renderers and exact saved-draft handoff.
5. Provide an isolated authenticated launcher and exercise local write/read/restart, cancellation, uncertain responses, scope rejection and ordinary UI journeys.
6. Run focused regressions, type/build/guards, then the full local suite. Preserve exact-source evidence and remaining platform/provider limits.

## Acceptance

The local integrated app must use real routes and persistence. New and returning users can enter/resume/skip onboarding; accepted creation saves one disabled draft and no run. Navigation, conversation drafts and selected IDs survive reload/reconnect. Missing providers and revoked sessions fail truthfully. Production entry cannot inherit integration authorization.

Hosting compatibility, production activation, paid real-model evaluation and external OAuth remain outside this local acceptance.

## Run the real daemon with a fresh sidecar

Use `bun run dev` for the connected app with real providers and a native sidecar. It uses persistent local data and does not seed sample workflows or substitute models. From this checkout with Bun on PATH:

```sh
bun run dev --data-dir "$HOME/.jarvis-local-acceptance-20261020"
```

The default port is 3143. Wait for `JARVIS daemon running on port 3143`, then enroll from a second terminal in the same checkout:

```sh
bun run dev --data-dir "$HOME/.jarvis-local-acceptance-20261020" --enroll "local-acceptance"
```

Copy the printed enrollment token into a sidecar built from this checkout. On Windows, quit any existing Jarvis instance from its tray menu first. Prepare a bundle in a normal user folder, such as `C:\Users\<you>\JarvisLocalAcceptance`, with `bin/jarvis.exe` and a copy of `scripts/integration/start-sidecar.cmd` at its root. Then run:

```powershell
& 'C:\Users\<you>\JarvisLocalAcceptance\start-sidecar.cmd'
```

On the first launch, paste the enrollment token when prompted. Later launches reuse the saved enrollment without prompting. The helper gives only its child process a separate `profile/` directory and sets an explicit working directory. Add `--check` to verify the executable without starting onboarding. The batch helper works with the existing PowerShell execution policy and makes no policy changes.

Avoid preparing the bundle under AppData from a packaged desktop app: Windows can redirect that write into the app's private cache, leaving the ordinary terminal unable to find the executable. Verify the physical destination from WSL or another independent process.

The sidecar opens its authenticated onboarding window. Complete permissions, configure and test the model provider, finish onboarding, create a disabled workflow draft, then check dashboard navigation, chat and reconnect. Real provider calls use the credentials you enter. A separate profile does not reset Windows permission grants.

The launcher creates separate `home/`, `data/` and `tmp/` directories and does not inherit your normal configuration, credentials or `.env`. Reuse the directory to resume; choose a new name to start over. The default is `~/.jarvis-local-acceptance`; symlinked data roots are resolved before starting the engine. Use the same `--port` on both commands if changing it. The daemon binds to loopback, preserves authentication and uses the normal daemon lock. Ctrl-C stops it. Restart after source edits: this launcher deliberately uses a foreground process without Bun hot reload, which failed the engine handshake in local verification.

This mode builds its own UI into `ui/dist-local-integration/`, explicitly authorizes the optional dashboard/onboarding integration and continues to report `released: false`. `bun run dev` now starts this connected local app; `dev:local` is an alias. `dev:legacy` retains the previous hot-reload command for the released UI. Production builds retain their release gates. Its data and native profile are separate from the deterministic harness below.

Windows sidecar cross-build from WSL, using the repository's existing release build script and installed Go/mingw toolchain:

```sh
cd sidecar
mkdir -p dist/local-acceptance
make manifest
GOOS=windows GOARCH=amd64 SETUP=windows-cross OUT=dist/local-acceptance/jarvis.exe bash ../.github/scripts/build-sidecar.sh
```

The build is a local unsigned binary, not a published installer. `make manifest` regenerates the tracked Windows resource; do not include incidental resource changes in an unrelated source commit.

## Run the deterministic integration harness

From a checkout with its dependencies installed and Bun available:

```sh
run_dir="$(mktemp -d /tmp/jarvis-integration.XXXXXX)"
mkdir -p "$run_dir/home" "$run_dir/tmp"
env -i PATH="$PATH" HOME="$run_dir/home" TMPDIR="$run_dir/tmp" \
  LOCAL_INTEGRATION_DIR="$run_dir" bun run scripts/integration/serve.ts
```

Read `bootstrap-url.txt` in that directory and open its loopback URL. It establishes an HttpOnly, SameSite session cookie. Keep that URL private. Port 3198 is the default; set `LOCAL_INTEGRATION_PORT` in the clean environment to change it. Keep the same directory to verify durable data after a restart, then use its newly generated bootstrap URL to reconnect. Ctrl-C stops the worker, engine and server.

The launcher seeds only synthetic data, uses the real workflow engine and SQLite, and supplies deterministic model responses. It rejects external `fetch` requests; this is not an operating-system network sandbox. Google, devices and external channels are deliberately absent. The local HTML entry is separate from the production build. No URL parameter enables the production release gates.

Useful local checks, with a separate empty HOME/TMPDIR and no inherited service credentials:

```sh
bun x tsc --noEmit
bun run build:ui
bun test --preload ./src/test-preload.ts src/brief src/onboarding-next ui/src/brief ui/src/onboarding-next src/integration src/util/model-exec-env.test.ts
JARVIS_TEST_PREPARED_Q13=1 bun test --preload ./src/test-preload.ts src/brief/opportunity-activation.test.ts
JARVIS_TEST_ENGINE_BUILD=1 bun test --preload ./src/test-preload.ts src/workflows/runner/engine-runtime/build.test.ts src/workflows/runner/engine-runtime/outer-worker-delay.test.ts src/workflows/runner/engine-runtime/emergency-hold-engine.test.ts
```

The 20 October run passed 2,840 integration tests with one separately exercised Q13 opt-in skip, 29 Q13 activation tests, 36 engine opt-in tests, and 293 final focused checks. These scopes overlap. Type checking and the production UI build passed. The broad regression run recorded 13,087 passes, 87 skips and one environment-classification failure; the classification was corrected and its tests plus the final affected suites passed. The broad run was not repeated after the correction and final UI edits.

Browser checks covered onboarding through a saved disabled draft, all twelve tutorial steps, replay, conversation persistence, guarded Memory/Profile edits, canonical decisions, opportunity activation without a run, retained settings navigation through the shared socket, and one explicitly started local echo run that succeeded and survived restart. Exact logs, source hashes, patch and screenshot are retained in the AIOS Jarvis project under `progress/evidence/dashboard-integration/local-wiring-2026-10-20/`.

This establishes local integration only. Hosted billing and F-24 compatibility, real OAuth/model calls, native device permissions, the full 988-case visual matrix, physical optional-module removal builds, Q22 release-scope reconciliation and release-owner acceptance still require their own evidence.
