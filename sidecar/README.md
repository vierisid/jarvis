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

## Usage

```bash
# First run — enroll with a token from the brain
./jarvis-sidecar --token <jwt>

# Subsequent runs — uses saved token
./jarvis-sidecar
```

The sidecar persists its token and local settings in:

```text
~/.jarvis-sidecar/config.yaml
```

For remote enrollments, make sure the brain generated the token with a routable `daemon.brain_domain` / `JARVIS_BRAIN_DOMAIN`. If the token points at `localhost`, only a sidecar on the same machine can connect.

You can also override the brain URL per sidecar after enrollment by editing the saved config:

```yaml
token: "<jwt>"
brain: "wss://brain.example.com/sidecar/connect"
capabilities:
  - terminal
  - filesystem
  - browser
  - awareness
```

## File Structure

### Core

| File | Purpose |
|---|---|
| `main.go` | Entry point, flag parsing, signal handling |
| `config.go` | YAML config loading/saving (`~/.jarvis-sidecar/config.yaml`) |
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
