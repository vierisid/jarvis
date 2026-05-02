# Sidecar

A Go client that connects to the JARVIS brain over WebSocket and exposes local machine capabilities (terminal, filesystem, clipboard, screenshots, etc.) as RPC handlers.

## Building

```bash
go build -o jarvis-sidecar .
```

Cross-compile for other platforms:

```bash
GOOS=darwin  go build -o jarvis-sidecar-macos .
GOOS=windows go build -o jarvis-sidecar.exe .
```

### Panel service prerequisites (Phase 2 ambient UX)

The sidecar can spawn native panel windows (frameless, always-on-top, transparent, click-through) via `github.com/webview/webview_go`. This requires a system webview runtime per platform:

| Platform | Runtime | Install |
|---|---|---|
| Windows 11 | WebView2 (Edge Chromium) | Pre-installed on Win11; on Win10 see [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) |
| macOS | WKWebView | Pre-installed (system) |
| Linux | WebKitGTK 4.1 | see "Linux setup" below |

#### Linux setup (Ubuntu 22.04/24.04 + WSL)

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev build-essential pkg-config

# webview_go's cgo line hardcodes pkg-config name webkit2gtk-4.0, but Noble
# only ships 4.1. Symlink the .pc files so build-time pkg-config resolves
# (the webview.h runtime loader already prefers libwebkit2gtk-4.1.so).
sudo ln -sf /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.1.pc \
            /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.0.pc
sudo ln -sf /usr/lib/x86_64-linux-gnu/pkgconfig/javascriptcoregtk-4.1.pc \
            /usr/lib/x86_64-linux-gnu/pkgconfig/javascriptcoregtk-4.0.pc
```

WSL note: WebKitGTK runs but the panel window appears on the WSL X server, not Windows directly. For real-world dev/test, build for Windows and run natively on Win11.

Cross-compilation with cgo: the panel service uses cgo, so cross-compiling needs the target's webview headers available. For Windows builds from Linux, the simplest path is to build natively on Windows; for macOS, build on a Mac.

## Usage

```bash
# First run — enroll with a token from the brain
./jarvis-sidecar --token <jwt>

# Subsequent runs — uses saved token
./jarvis-sidecar
```

## File Structure

### Core

| File | Purpose |
|---|---|
| `main.go` | Entry point, flag parsing, signal handling |
| `config.go` | YAML config loading/saving (`~/.jarvis/sidecar.yaml`) |
| `types.go` | Shared types: capabilities, RPC messages, config structs |
| `client.go` | WebSocket client, reconnect loop, preflight integration |
| `handlers.go` | RPC handler registry (terminal, filesystem, clipboard, screenshot, config, system info) |
| `observers.go` | Background observers (clipboard polling, screen capture, window tracking) |

### Platform-specific (build tags)

Go build constraints (`//go:build linux`, etc.) ensure only the correct OS file is compiled. All three files export the same function signatures:

| Function | Linux | macOS | Windows |
|---|---|---|---|
| `platformClipboardRead()` | xclip | pbpaste | powershell Get-Clipboard |
| `platformClipboardWrite()` | xclip | pbcopy | powershell Set-Clipboard |
| `platformCaptureScreen()` | scrot / import / gnome-screenshot | screencapture | powershell System.Windows.Forms |
| `platformDefaultShell()` | `"sh"` | `"sh"` | `"cmd.exe"` |
| `platformGetActiveWindow()` | xdotool + ps | osascript (System Events) | powershell Get-Process |

Files: `platform_linux.go`, `platform_darwin.go`, `platform_windows.go`

### Preflight checks (build tags)

Before registering handlers, the client validates that required system tools are present. Each capability maps to a check function that returns `""` (available) or a reason string (unavailable).

| File | Checks |
|---|---|
| `preflight.go` | `CheckCapabilities()` orchestrator (platform-independent) |
| `preflight_linux.go` | xclip/xsel, scrot/import/gnome-screenshot, xdotool, Chrome, DISPLAY/WAYLAND_DISPLAY |
| `preflight_darwin.go` | pbpaste, screencapture, osascript, Chrome |
| `preflight_windows.go` | powershell, cmd.exe, Chrome |

Unavailable capabilities are reported to the brain in the `register` and `capabilities_update` messages so the dashboard can show warnings and the routing layer can return clear errors.

## Tests

```bash
go test ./...
```
