# Vendored + patched `webview_go`

This is a local copy of `github.com/webview/webview_go` (the pinned version is
in `UPSTREAM_VERSION`), wired in via a `replace` directive in `sidecar/go.mod`,
with **two patches** (`jarvis.patch`): a Win32 one (no open flash) and a Cocoa
one (create the window on the main thread).

## Why

Upstream's Win32 engine constructor shows the window (`ShowWindow(SW_SHOW)` +
`UpdateWindow`) and *then* initializes WebView2 — all before `webview.New()`
returns control to Go. So the empty window is composited during init, producing
a black flash before the page renders. There's no API to create the window
hidden, so we patch the constructor.

## The patch

In `libs/webview/include/webview.h`, the win32 `win32_edge_engine` constructor:

```cpp
    if (m_owns_window) {
      ShowWindow(m_window, SW_HIDE);   // was: SW_SHOW + UpdateWindow + SetFocus
    }
```

The host (sidecar) now creates the window hidden and reveals it itself once the
page has loaded — see `revealWebviewOnLoad` (`webview_reveal.go`) for the local
windows (settings, logs, account) and the hosted first-run window, and the
inline reveal in `panels_runtime.go` for panels.
Non-`delayShow` overlay panels are shown immediately.

## The Cocoa patch (macOS main-thread window creation)

On macOS the sidecar's tray owns the single process-wide `[NSApp run]` loop, and
panels are spawned on background goroutines. Cocoa requires every `NSWindow` to
be created on the main thread, so `webview.New()` off the main thread aborts with
*"NSWindow should only be instantiated on the main thread!"*. We patch
`cocoa_wkwebview_engine::set_up_window()` to marshal itself synchronously onto the
main queue when called off-main:

```cpp
  void set_up_window() {
    if (!objc::msg_send<bool>("NSThread"_cls, "isMainThread"_sel)) {
      dispatch_sync_f(dispatch_get_main_queue(), this, [](void *ctx) {
        static_cast<cocoa_wkwebview_engine *>(ctx)->set_up_window();
      });
      return;
    }
    ...
  }
```

The host side (`panels_runtime.go`) cooperates: it runs all panel setup through
`uiSync` (the webview's main-queue dispatch), and on macOS it does NOT call
`wv.Run()`/`Terminate()` (which would nest/stop the tray's shared loop) — it
attaches to the shared loop and tears down when the window closes. The tray sets
itself as the `NSApplicationDelegate` so the engine skips its own bootstrap loop.

The GTK path is unchanged.

## Upgrading

Upgrades are automated. `.github/workflows/update-webview.yml` runs monthly: it
checks the Go module proxy for a newer version, re-vendors via
`scripts/vendor-webview.sh`, re-applies `jarvis.patch`, and -- only if the patch
still applies and the sidecar still builds (linux-native cgo + windows-cross
mingw) -- opens a PR. A green run means the bump is safe to merge, but the PR is
always left for a human to review and merge (no auto-merge).

To bump manually (or pin a specific version):

```sh
scripts/vendor-webview.sh                # latest from the proxy
scripts/vendor-webview.sh v0.0.0-2025... # a specific version
```

If upstream moves the win32 constructor, `patch` (and the workflow) will fail.
Regenerate `jarvis.patch`: diff a pristine copy of the new
`libs/webview/include/webview.h` against the `SW_HIDE` edit above (search for
`PATCHED (jarvis)`), update the hunk, and re-run the script.
