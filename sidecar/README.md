# Jarvis Sidecar

The Sidecar is the desktop client that gives a Jarvis brain access to a
machine's browser, terminal, filesystem, clipboard, screenshots, windows, and
ambient-awareness signals. It runs on the machine being controlled and keeps
one authenticated WebSocket connection to the brain.

The brain and Sidecar may run on the same machine, but the common setup is an
always-on brain with one or more Sidecars on laptops and desktops.

## Supported platforms

| Platform | Distributed build | Desktop runtime |
|---|---|---|
| macOS 11+ | Apple silicon and Intel | WKWebView, provided by macOS |
| Windows 10/11 | x64 | WebView2; the Sidecar offers to install it when absent |
| Linux | x64 and arm64 | WebKitGTK 4.1 plus the desktop tools listed below |

The npm wrapper selects the correct platform package automatically.

## Install

The recommended install is:

```bash
bun install -g @usejarvis/sidecar
jarvis --version
```

Release archives are also attached to Jarvis GitHub releases when that release
contains a new Sidecar build. Archive names include the independent Sidecar
version and target platform, for example
`jarvis-v0.9.1-darwin-arm64.tar.gz`.

On macOS, native notifications, URL-based enrollment, the menu-bar identity,
and permission prompts depend on running inside a `Jarvis.app` bundle. See
[macOS packaging](packaging/macos/README.md) when assembling a local build; a
raw binary can still be enrolled from the terminal with `--token`.

## Connect a device

### Hosted Jarvis

Run the Sidecar with no arguments:

```bash
jarvis
```

On first launch, the local Connect window opens the usejarvis sign-in page in
the system browser. Finish signing in there; the Connect window receives the
enrollment token from the hosted handshake and stores it automatically.

### Self-hosted brain

First ensure the brain advertises an origin this device can reach. For a remote
brain, set `daemon.brain_domain` or `JARVIS_BRAIN_DOMAIN` before enrolling.
See [Self-hosting](../docs/SELF_HOSTING.md) for LAN, TLS, reverse-proxy, and
WebSocket examples.

Create a device from either:

- Dashboard: **Settings -> Sidecar -> Enroll**
- Brain CLI: `jarvis enroll "work-laptop"`

Enrollment tokens are shown once. Treat them like passwords.

Start the Sidecar, choose **Self-hosting? Paste your enrollment token** in the
Connect window, and paste the raw JWT. For a headless machine, pass it directly:

```bash
jarvis --token <enrollment-jwt>
```

Before saving a token, the Sidecar contacts the brain named by the token and
requests an access token. Invalid tokens, wrong brain URLs, unreachable brains,
and non-Jarvis servers are rejected without changing the saved configuration.
After enrollment, later launches only need:

```bash
jarvis
```

For the token format, verification flow, rotation, and revocation model, see
[Sidecar authentication](../docs/sidecar/SIDECAR_AUTHENTICATION.md).

## Normal operation

- Windows and macOS run a tray/menu-bar application. Its menu opens Chat, local
  Sidecar Settings, logs, and other Jarvis surfaces.
- Linux currently runs in the foreground without a tray. Keep it under the
  desktop session's service manager if it should stay running.
- The Sidecar reconnects automatically when the brain is temporarily
  unavailable.
- The brain reports the device as online under **Settings -> Sidecar** and
  shows unavailable capabilities discovered during startup preflight.
- Capability changes made from the dashboard are hot-applied and reported back
  to the brain.

Stop a foreground Sidecar with `Ctrl+C`. On Windows or macOS, use **Close**
from the tray/menu-bar menu.

## Local settings and files

| Item | Location |
|---|---|
| Configuration | `~/.jarvis/sidecar.yaml` |
| Logs | `~/.jarvis/sidecar.log` |
| Captures (default) | `~/.jarvis/captures/` |

On Windows, `~` means `%USERPROFILE%`. The configuration directory is
created with owner-only permissions where the platform supports them, and the
token-bearing configuration file is written with mode `0600` on Unix.

The local Settings window on Windows and macOS controls:

- enrollment token replacement
- launch at login
- ethereal Pebble behavior and idle delay
- anonymous Sidecar telemetry

The dashboard's Sidecar editor controls capabilities and operational limits
such as blocked commands, blocked paths, file-size limits, browser settings,
and awareness intervals.

Telemetry is independent from brain telemetry. Disable it in the local
Settings window, set `telemetry.enabled: false` in `sidecar.yaml`, or launch
with `JARVIS_SIDECAR_TELEMETRY=0`. See [Telemetry](../docs/TELEMETRY.md).

## Platform requirements

### Windows

- WebView2 is required for the Connect window, Pebble, and native Jarvis
  panels. Windows 11 normally includes it; the Sidecar prompts to install the
  runtime when it is missing.
- PowerShell is used for clipboard and screenshot fallbacks.
- A Chromium-based browser is required for browser automation. Jarvis detects
  the default browser first, then known Chrome, Edge, Brave, and Chromium
  installs.

### macOS

Grant permissions in **System Settings -> Privacy & Security** when requested:

- Microphone for voice and wake word
- Screen Recording for screen awareness
- Accessibility for global hotkeys and desktop automation
- Notifications for Sidecar notifications

Run the bundled application rather than moving only its inner binary. A locally
built unsigned app can be tested, but distributed builds should be signed and
notarized.

### Linux

Install the webview and desktop helpers. On Ubuntu 22.04/24.04:

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev build-essential pkg-config \
  xclip xsel scrot xdotool dbus
```

The Sidecar accepts any one of `scrot`, ImageMagick `import`, or
`gnome-screenshot` for screenshots. Clipboard support needs `xclip` or
`xsel`. Window awareness and desktop automation need `xdotool`.
`DISPLAY` or `WAYLAND_DISPLAY` must be present.

On Ubuntu releases whose webview package only ships a
`webkit2gtk-4.1.pc` pkg-config file, local builds may need 4.0 compatibility
links:

```bash
sudo ln -sf /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.1.pc \
  /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.0.pc
sudo ln -sf /usr/lib/x86_64-linux-gnu/pkgconfig/javascriptcoregtk-4.1.pc \
  /usr/lib/x86_64-linux-gnu/pkgconfig/javascriptcoregtk-4.0.pc
```

Adjust the architecture-specific pkg-config directory when building on arm64.
Under WSL, Linux GUI windows use the WSL display server; for normal Windows
desktop automation, run the Windows Sidecar natively.

## Troubleshooting

### The setup window does not open

- Check `~/.jarvis/sidecar.log`.
- On Windows, install or repair WebView2.
- On Linux, install WebKitGTK and confirm a desktop display variable is set.
- A headless device can enroll with `jarvis --token <jwt>`.

### The token is rejected or the brain is unreachable

1. Inspect `daemon.brain_domain` or `JARVIS_BRAIN_DOMAIN` on the brain.
2. From the Sidecar machine, verify that origin resolves and that its
   `/api/sidecars/.well-known/jwks.json` endpoint is reachable.
3. Confirm the reverse proxy allows WebSocket upgrades on
   `/sidecar/connect`.
4. Re-enroll after correcting the origin. Existing tokens retain the URLs they
   were issued with.

### A capability is unavailable

The Sidecar runs platform preflight checks before registering. The dashboard
shows the resulting reason, and the log contains the same startup details.
Install the named helper or grant the requested operating-system permission,
then restart the Sidecar.

### The brain says an update is required

The brain enforces minimum and recommended Sidecar versions:

- **OK**: compatible
- **Update available**: compatible, but a newer Sidecar is recommended
- **Update required**: connection refused until the Sidecar is updated

Update npm installs with:

```bash
bun update -g @usejarvis/sidecar
```

The Sidecar version comes from `sidecar/VERSION` and is independent of the
brain version. It is published through npm without a separate
`sidecar-v*` Git tag.

## Development

The Sidecar uses cgo for native webviews and overlays. Build it on the target
operating system so the compiler can use that platform's UI SDK:

```bash
cd sidecar
go test ./...
go vet ./...
make build
```

Additional targets:

```bash
make build-ocr-helper  # macOS Vision OCR helper; requires swiftc
make app-macos         # assemble dist/macos/Jarvis.app
make build-test        # sidecartest build with platform diagnostics
```

`GOOS=... go build` alone is not sufficient for release cross-compilation
because the native UI code requires cgo, headers, libraries, and a compatible
toolchain. The release workflow uses native or target-capable runners for each
platform.

The main implementation areas are:

| Area | Files |
|---|---|
| Startup, configuration, reconnect | `main.go`, `config.go`, `client.go` |
| Enrollment and token verification | `hosted*.go`, `deeplink*.go`, `verify_token.go` |
| RPC capabilities | `handlers.go`, `browser*.go`, `desktop_*.go`, `ocr_*.go` |
| Ambient UI | `pebble*.go`, `sub_pebble*.go`, `panels*.go` |
| Native shell | `tray_*.go`, `settings_window.go`, `log_viewer.go` |
| Platform checks | `preflight*.go`, `platform_*.go` |

Protocol details live in [Sidecar protocol](../docs/sidecar/SIDECAR_PROTOCOL.md).
