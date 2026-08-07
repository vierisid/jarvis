# Sidecar

A Go program that runs on the user's machine, connects to the JARVIS brain over
WebSocket, and exposes local capabilities (terminal, filesystem, clipboard,
screenshots, browser control, OCR, …) as RPC handlers.

It is also a **desktop application**, which is the part that surprises people
reading the handler code: a menu-bar/tray item, a floating "pebble" overlay with
wake-word audio, frameless always-on-top panels, global hotkeys and native
notifications. That is why it is cgo-heavy and why the build has real platform
prerequisites.

## Building

```bash
make build          # -> ./jarvis   (injects the version from VERSION)
make test           # vet + unit tests + cross-compiled tester binaries
make dist           # all five target platforms into dist/
```

Prefer `make` over a bare `go build`: the Makefile injects `-X
main.sidecarVersion` from [`VERSION`](VERSION), and on macOS sets the 11.0
deployment target that keeps APIs newer SDKs mark obsoleted compilable.

### Cross-compilation

**Plain `GOOS=… go build` does not work.** The sidecar needs cgo (webview_go,
GTK/Cocoa overlays, malgo audio), so every target needs its own toolchain and
headers. Two paths actually work:

```bash
# Windows, from Linux — mingw-w64 plus the bundled EventToken.h shim.
# This is what CI does; no Windows machine required.
CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++ \
  GOOS=windows GOARCH=amd64 CGO_ENABLED=1 \
  CGO_CFLAGS="-I$(pwd)/include" CGO_CXXFLAGS="-I$(pwd)/include" \
  go build -ldflags "-H windowsgui" -o jarvis.exe .

# macOS — must be built on a Mac; both arches via clang -target.
CC="clang -target arm64-apple-macos11" GOOS=darwin GOARCH=arm64 go build -o jarvis .
```

### Linux prerequisites

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev build-essential pkg-config

# webview_go's cgo line hardcodes the pkg-config name webkit2gtk-4.0, but
# current distros only ship 4.1. Symlink the .pc files so build-time
# pkg-config resolves (the runtime loader already prefers 4.1).
sudo ln -sf /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.1.pc \
            /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.0.pc
sudo ln -sf /usr/lib/x86_64-linux-gnu/pkgconfig/javascriptcoregtk-4.1.pc \
            /usr/lib/x86_64-linux-gnu/pkgconfig/javascriptcoregtk-4.0.pc
```

Windows needs the **WebView2 runtime** (pre-installed on Win11; the sidecar
offers to install it on Win10). macOS uses the system WKWebView.

WSL note: WebKitGTK runs, but panels appear on the WSL X server rather than the
Windows desktop. For realistic testing, cross-build for Windows and run natively.

## Running

```bash
./jarvis                  # start using the saved token
./jarvis --token <jwt>    # enroll: verified against the brain, then saved
./jarvis --setup          # first-launch onboarding (permissions, autostart)
./jarvis --version
./jarvis --help
./jarvis --test <cmd>     # built-in platform tests; needs -tags sidecartest
```

Config lives at `~/.jarvis/sidecar.yaml` (shared with the brain — the sidecar
owns only its own keys). A token can also arrive from the dashboard as a
`jarvis://` deep link, and unconfigured launches open a connect window.

`--token` is verified against the brain it names *before* being saved; a
wrong-URL token used to be persisted blind and then fail invisibly in the
reconnect loop.

## Layout

The package is flat Go at the top level — ~150 files in `package main` — so
this is a map of **subsystems by filename prefix**, not a file list.

| Prefix / file | Subsystem |
|---|---|
| `main.go`, `client.go`, `handlers.go` | entry point, WebSocket client + reconnect, RPC handler registry |
| `config.go`, `types.go` | `~/.jarvis/sidecar.yaml`, shared message/config types |
| `observers.go` | background clipboard / screen / window observers |
| `tray_*` | menu-bar / system-tray item and its menu |
| `pebble_*` | floating overlay, audio capture, wake word |
| `panels_*` | frameless always-on-top webview panels |
| `hotkeys_*` | global hotkeys |
| `notify_*` | native notifications and their click-through actions |
| `region_select_*` | interactive screen-region picker |
| `browser_*` | Chrome control over CDP |
| `ocr_*` | text extraction (macOS delegates to `helpers/ocr-helper.swift`) |
| `setup_*` | `--setup` onboarding and its permission checks |

| Directory | Contents |
|---|---|
| `internal/` | packages shared with the installer: `brand` (CSS), `webviewui` (window host), `autostart` (login items), `webview2` (runtime bootstrap) |
| `installer/` | the standalone desktop installer — see its own package docs |
| `npm/` | per-platform npm packages plus the `@usejarvis/sidecar` wrapper |
| `packaging/` | macOS `.app` bundle assets; Windows manifest/icon resources |
| `helpers/` | `ocr-helper.swift`, built as a universal binary on macOS |
| `scripts/` | release-time shell tooling and its tests |
| `tester/` | standalone binaries for manual platform validation |
| `include/` | `EventToken.h` — the one WebView2 SDK header mingw lacks |
| `third_party/` | vendored `webview_go` fork (patched to create windows hidden) |

### Platform-specific files (build tags)

Build constraints (`//go:build linux`, etc.) ensure only the correct OS file
compiles. Each set exports identical signatures, so callers are OS-agnostic:

| Function | Linux | macOS | Windows |
|---|---|---|---|
| `platformClipboardRead()` | xclip | pbpaste | PowerShell Get-Clipboard |
| `platformClipboardWrite()` | xclip | pbcopy | PowerShell Set-Clipboard |
| `platformCaptureScreen()` | scrot / import / gnome-screenshot | screencapture | PowerShell System.Windows.Forms |
| `platformDefaultShell()` | `"sh"` | `"sh"` | `"cmd.exe"` |
| `platformGetActiveWindow()` | xdotool + ps | osascript (System Events) | PowerShell Get-Process |

Anything compiled only for one OS is invisible to the others' builds — which is
why CI compiles all three targets rather than trusting a Linux build.

### Preflight checks

Before registering handlers, the client checks which capabilities the machine
can actually serve. Each check returns `""` (available) or a reason string.
`preflight.go` orchestrates; `preflight_{linux,darwin,windows}.go` implement
terminal, clipboard, screenshot, awareness, processes, notifications, browser
and desktop checks per platform.

Unavailable capabilities are reported to the brain in the `register` and
`capabilities_update` messages, so the dashboard can warn and the routing layer
can return a clear error instead of timing out.

## Distribution

Published as platform npm packages (`@usejarvis/sidecar-*`) behind the
`@usejarvis/sidecar` wrapper, and installed for non-developers by the desktop
installer in `installer/`.

On macOS the sidecar ships as **`Jarvis.app`**, not a bare binary:
`UNUserNotificationCenter` is unavailable outside a bundle, and TCC grants
(microphone, screen recording, accessibility) bind to a bundle identifier — so
a loose binary cannot notify and loses its permissions.

## Tests

```bash
go test ./...                    # unit tests (also run in CI on Linux)
make test                        # the above, plus cross-built tester binaries
scripts/sign-windows.test.sh     # release tooling, no credentials needed
```

UI and platform behaviour that cannot run headless is covered by the `tester/`
binaries and by `--test` on a `-tags sidecartest` build.
