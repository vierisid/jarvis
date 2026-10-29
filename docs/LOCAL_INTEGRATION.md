# Local integration

Two contributor launchers run the connected Brief dashboard and onboarding on a
local machine:

- `bun run dev:local` runs the real daemon with real providers, for use with a
  native sidecar.
- `scripts/integration/serve.ts` is a deterministic harness with synthetic data and
  model replies.

Neither one is a release check, and neither enables anything in production builds.
`bun run dev` is still the hot-reload daemon for the ordinary UI.

## Real daemon with a sidecar

`dev:local` runs `scripts/integration/dev.ts`. It uses persistent local data, does
not seed sample workflows and does not substitute models. From the checkout:

```sh
bun run dev:local --data-dir "$HOME/.jarvis-local-acceptance"
```

Options: `--data-dir PATH` (default `~/.jarvis-local-acceptance`), `--port N`
(default 3143, range 1024 to 65535) and `--enroll DEVICE_NAME`. `--help` prints
them.

Wait for `JARVIS daemon running on port 3143`, then enroll a sidecar from a second
terminal in the same checkout, with the same `--data-dir` (and `--port`, if you
changed it):

```sh
bun run dev:local --data-dir "$HOME/.jarvis-local-acceptance" --enroll "local-acceptance"
```

This runs `jarvis enroll` against the same isolated vault and prints the token the
sidecar needs.

What the launcher does:

- It creates `home/`, `data/` and `tmp/` under the data directory and starts the
  daemon with only those plus `PATH`, `LANG` and a few platform variables. Your
  normal configuration, credentials and `.env` are not inherited. A symlinked data
  directory is resolved to its real path first.
- It turns on every `JARVIS_BRIEF_*` feature and sets `JARVIS_LOCAL_INTEGRATION=1`.
  The daemon accepts that flag only with this home/data layout on an
  authenticated loopback address, and then builds a separate UI into
  `ui/dist-local-integration/`.
- It binds to loopback, keeps authentication and uses the normal daemon lock.
  Ctrl-C stops it.
- It runs in the foreground without hot reload. Restart it after source edits.

Reuse the data directory to resume. Use a new one to start onboarding over.

### Windows sidecar bundle

Build `jarvis.exe` from this checkout. The Windows cross-build from Linux or WSL is
described in [sidecar/README.md](../sidecar/README.md#cross-compilation). The result
is a local unsigned binary.

On Windows, quit any running Jarvis from its tray menu first. Prepare a bundle in a
normal user folder, for example `C:\Users\<you>\JarvisLocalAcceptance`:

```
JarvisLocalAcceptance\
  start-sidecar.cmd     copy of scripts/integration/start-sidecar.cmd
  bin\jarvis.exe
```

Then run:

```powershell
& 'C:\Users\<you>\JarvisLocalAcceptance\start-sidecar.cmd'
```

- On the first launch the helper asks for the enrollment token and starts
  `jarvis.exe --token <token>`. Later launches find the saved
  `profile\.jarvis\sidecar.yaml` and start without asking.
- It sets `USERPROFILE` to the bundle's `profile\` folder for its child only, and
  starts the sidecar with `bin\` as its working directory. A separate profile does
  not reset Windows permission grants.
- `start-sidecar.cmd --check` only runs `jarvis.exe --version`.
- It is a batch file, so the PowerShell execution policy does not matter, and it
  changes no policy.

Do not prepare the bundle under `AppData` from a packaged desktop app. Windows can
redirect that write into the app's private storage, and an ordinary terminal then
cannot find the executable. Check the real destination from WSL or another
independent process.

The sidecar opens its onboarding window. Real provider calls use the credentials
you enter there.

## Deterministic harness

The harness uses the real routes, SQLite stores and workflow engine with synthetic
data and deterministic model replies. It refuses `fetch` requests to anything but
loopback (this is not an operating-system network sandbox). Google, devices and
external channels are absent. It refuses to start unless `HOME` is
`$LOCAL_INTEGRATION_DIR/home`.

```sh
run_dir="$(mktemp -d /tmp/jarvis-integration.XXXXXX)"
mkdir -p "$run_dir/home" "$run_dir/tmp"
env -i PATH="$PATH" HOME="$run_dir/home" TMPDIR="$run_dir/tmp" \
  LOCAL_INTEGRATION_DIR="$run_dir" bun run scripts/integration/serve.ts
```

- Open the loopback URL in `$run_dir/bootstrap-url.txt`. It sets an HttpOnly,
  SameSite session cookie, so keep it private. Each start writes a new one.
- `LOCAL_INTEGRATION_PORT` changes the port (default 3198).
- `LOCAL_INTEGRATION_UI=hosted` serves the prebuilt production UI from `ui/dist`
  (run `bun run build:ui` first) with a synthetic hosted identity. Without it the
  harness serves `ui/local-integration.html`. See
  [hosted-dashboard.md](hosted-dashboard.md#verification).
- Reuse the same directory to check that data survives a restart. Ctrl-C stops the
  worker, engine and server.

## Opt-in tests

Two groups of tests are skipped unless a flag is set:

```sh
# Real prepared-opportunity qualification
JARVIS_TEST_PREPARED_Q13=1 bun test --preload ./src/test-preload.ts \
  src/brief/opportunity-activation.test.ts src/awareness/prepared-opportunities.test.ts

# Build the workflow engine bundle instead of needing a cached one
JARVIS_TEST_ENGINE_BUILD=1 bun test --preload ./src/test-preload.ts \
  src/workflows/runner/engine-runtime/build.test.ts
```

`JARVIS_TEST_ENGINE_BUILD=1` also runs the engine-runtime end-to-end tests under
`src/workflows/runner/engine-runtime/` when no cached bundle exists.
