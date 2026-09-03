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

`third_party/webview_go/webview.go` hardcodes the pkg-config name
`webkit2gtk-4.0`, which recent distros no longer ship — Arch removed it
outright, Debian 13 and Ubuntu 24.04 dropped it, and only older releases
(Ubuntu 22.04, Debian 12) still carry `libwebkit2gtk-4.0-dev`. Install **4.1**
and add a `.pc` name shim rather than chasing a 4.0 package. The two differ
only where libsoup types surface in the API (4.1 is libsoup3, 4.0 libsoup2) —
webview_go touches none of them, so the shim is a pure rename. On Arch in
particular, do **not** install a 4.0 package: it resolves to an AUR source
build that compiles WebKit from scratch and typically fails.

**Debian / Ubuntu**

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev build-essential pkg-config

sudo ln -sf /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.1.pc \
            /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.0.pc
sudo ln -sf /usr/lib/x86_64-linux-gnu/pkgconfig/javascriptcoregtk-4.1.pc \
            /usr/lib/x86_64-linux-gnu/pkgconfig/javascriptcoregtk-4.0.pc
```

**Arch**

Arch's pkgconfig dir is `/usr/lib/pkgconfig` (no multiarch triplet), so the
Debian paths above do not apply. Keep the shims out of the pacman-managed tree
by putting them in `~/.local` — Arch's default search path is only
`/usr/lib/pkgconfig:/usr/share/pkgconfig`, so `PKG_CONFIG_PATH` must name it:

```bash
sudo pacman -S --needed webkit2gtk-4.1 gtk3 base-devel pkgconf

mkdir -p ~/.local/lib/pkgconfig
ln -sf /usr/lib/pkgconfig/webkit2gtk-4.1.pc        ~/.local/lib/pkgconfig/webkit2gtk-4.0.pc
ln -sf /usr/lib/pkgconfig/javascriptcoregtk-4.1.pc ~/.local/lib/pkgconfig/javascriptcoregtk-4.0.pc

# add to ~/.bashrc or ~/.zshrc so `make build` works without a prefix
export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
```

Verify the shim before building — this should print `-lwebkit2gtk-4.1`:

```bash
pkg-config --libs gtk+-3.0 webkit2gtk-4.0
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
| `internal/` | packages shared with the installer: `brand` (CSS + the custom title bar), `webviewui` (window host), `winchrome` (Windows custom window chrome), `autostart` (login items), `webview2` (runtime bootstrap) |
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

### Custom window chrome (Windows)

The local webview windows — settings, logs, the first-run connect window and
its token form, the onboarding slideshow, and the installer's wizard — draw
their own title bar on Windows instead of wearing the system one. `internal/winchrome` removes
`WS_CAPTION` from the HWND and nothing else: the window keeps its overlapped
frame, so resize borders, Aero Snap, the maximized rect, minimize/restore and
the taskbar entry all stay native, and no window procedure is subclassed. The
strip itself is shared markup in `internal/brand/titlebar.go`, rendered only
when `winchrome.Install` has stamped `<html data-chrome="custom">` — so the
same page keeps its native title bar on macOS and Linux.

The page moves the window through a binding rather than CSS: the WebView2
child HWND covers the client area and swallows the mouse, so `app-region:
drag` does nothing and the drag is a `ReleaseCapture` +
`WM_NCLBUTTONDOWN`/`HTCAPTION` handshake instead. Two consequences worth
knowing: the Win11 Snap Layouts flyout does not appear on the page's maximize
button (it needs `HTMAXBUTTON` from a window procedure we do not own), and
custom chrome must never be given to a window showing REMOTE content — those
bindings move, minimize, maximize and close the window. That is why the
account window (`account_window.go`, end-to-end remote) and the dashboard
panels stay natively framed.

To eyeball the pages without a Windows machine:

```sh
JARVIS_PAGE_DUMP_DIR=/tmp/pages go test -run TestDumpBrandPages .
# then open /tmp/pages/chrome-*.html (and dark-chrome-*.html)
```

The installer is its own package and dumps separately — one file per wizard
STATE (the plan screen alone has four), with the bindings stubbed, since the
whole visible output of that window is a single status panel:

```sh
JARVIS_PAGE_DUMP_DIR=/tmp/wizard go test -run TestDumpWizardPage ./installer/
```

The same states are asserted rather than eyeballed by
`TestWizardPanelSaysWhatIsOnTheMachine`, which renders the wizard through
headless Chromium and reads the status row, subtitle and button back out of
the DOM — the panel is fed from a snapshot, so what it SAYS is not something
the Go tests can see:

```sh
JARVIS_BROWSER_TESTS=1 go test -run TestWizardPanel ./installer/
```

`TestTitlebarGesture` covers the half of the interaction layer that is just
DOM: it stubs the five bindings, drives real PointerEvents through headless
Chromium, and asserts what the page would have asked the window to do (a click
never drags, one drag per gesture, drag-then-regrab is not a double-click, a
lost mouseup starts nothing). It is opt-in, because a headless browser is not a
dependency this suite relies on:

```sh
JARVIS_BROWSER_TESTS=1 go test -run TestTitlebarGesture .
```

Run it after any change to `TitlebarJS`.

What that cannot reach is Win32 itself — the modal move loop, snap, maximize
geometry — so this much still needs a real Windows box at least once per change
to `winchrome` or the strip's script:

- [ ] Drag the strip: the window follows, and does not stay glued to the
      cursor after the drop.
- [ ] Drag to a screen edge (snap), and drag a maximized window (it restores
      into the drag).
- [ ] Double-click the strip maximizes, again restores. Then drag, drop, and
      immediately press again — that must NOT maximize.
- [ ] Maximize: the taskbar stays visible and nothing is clipped, on a
      secondary monitor with a different resolution and DPI too.
- [ ] The maximize glyph tracks the state after Win+Up/Down and a taskbar
      snap, not just after the button.
- [ ] Minimize and close; Alt+Space and Alt+F4; right-click the strip for the
      system menu.
- [ ] Resize from all four edges and corners.
- [ ] Scroll settings and onboarding: the scrollbar starts below the strip and
      its top arrow is clickable, and Space / PageDown / Home / End scroll the
      window with nothing focused (the page scrolls an inner container, so this
      is script, not the browser).
- [ ] Drag a URL or a file onto the window: nothing navigates. Drag selected
      text into the token form's textarea: it drops.

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
