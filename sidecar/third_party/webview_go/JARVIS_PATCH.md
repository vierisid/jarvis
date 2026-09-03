# Vendored + patched `webview_go`

This is a local copy of `github.com/webview/webview_go` (the pinned version is
in `UPSTREAM_VERSION`), wired in via a `replace` directive in `sidecar/go.mod`,
with **five patches**, all carried by `jarvis.patch`: a Win32 one for the open
flash, a Cocoa one to create the window on the main thread, a `webview_create`
check that rejects a half-built engine, a NULL-handle guard in `webview.go`,
and a browser-controller accessor in a file of our own, `jarvis_native.go`.

`jarvis.patch` must carry EVERY vendored edit. `vendor-webview.sh` deletes the
vendor directory and copies pristine upstream over it, keeping only
`JARVIS_PATCH.md`, `jarvis.patch` and `.gitattributes` — so an edit made
directly to a vendored file, `webview.go` included, is reverted on the next
re-vendor with the build still green. Regenerate the patch by diffing pristine
upstream against the patched tree for every file we touch, and give each
behavior its own sanity grep in the script.

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
mingw) -- opens a PR. The script also asserts one marker per patched behavior
after re-applying, so a patch that silently stopped carrying one of them fails
the run instead of shipping a green PR that reverts it. The PR is always left
for a human to review and merge (no auto-merge).

To bump manually (or pin a specific version):

```sh
scripts/vendor-webview.sh                # latest from the proxy
scripts/vendor-webview.sh v0.0.0-2025... # a specific version
```

If upstream moves the win32 constructor, `patch` (and the workflow) will fail.
Regenerate `jarvis.patch`: diff a pristine copy of the new
`libs/webview/include/webview.h` against the `SW_HIDE` edit above (search for
`PATCHED (jarvis)`), update the hunk, and re-run the script.

## The NULL-handle patch (`webview.go`)

`webview_create` returns `nullptr` when the window could not be created — it
deletes the instance and returns null (`webview.h`, `webview_create`). Upstream's
Go binding wrapped that null in a non-nil `*webview` and returned it anyway:

```go
w := &webview{}
w.w = C.webview_create(boolToInt(debug), window)
return w        // never nil, even when w.w is NULL
```

So the `if wv == nil` guard at every call site (`local_webview_other.go`,
`local_webview_darwin.go`, `panels_runtime.go`, `hosted_window.go`,
`internal/webviewui/run.go`) was dead code, and the next call through the interface dereferenced NULL inside C++.
That is an access violation, not a Go panic: the process dies instantly with
nothing in the log — the failure mode looks like "the sidecar just vanishes when
a window opens".

The check cannot live at the call site, because none of the C entry points are
NULL-safe — `webview_get_window` included (`static_cast<webview *>(w)->window()`),
so even `wv.Window() == nil` faults. `NewWindow` now returns a nil interface
instead, which makes the guard every caller already has do what it says.

## The half-built-engine patch (`webview_create`)

`embed()` pumps the message loop while WebView2 initializes, and bails if it
sees a WM_QUIT:

```cpp
while (flag.test_and_set() && GetMessageW(&msg, nullptr, 0, 0) >= 0) {
  if (msg.message == WM_QUIT) { got_quit_msg = true; break; }
  ...
}
if (got_quit_msg) { return false; }
```

The window was created before that point, so a thread with a stray WM_QUIT
already queued produces an engine with a valid `m_window` and a NULL
`m_webview`/`m_controller`. Upstream's `webview_create` only checked
`w->window()`, so it returned that engine and the first `bind()`/`navigate()`
faulted on NULL — a 0xC0000005 that no Go `recover` can catch.

It now requires `browser_controller()` as well, so a failed init is a failed
create. Combined with the NULL-handle patch above, callers get a nil `WebView`
and their existing `wv == nil` guard logs and degrades.

The stray WM_QUIT that made this reachable came from the sidecar calling
`Terminate()` (`PostQuitMessage(0)`, which targets the *calling* thread) from
a foreign goroutine; `panels_runtime.go` now dispatches it onto the engine's
own thread. This patch is the backstop for any other source.

## The browser-controller accessor (`jarvis_native.go`)

Upstream's C library has implemented `webview_get_native_handle` since 0.11,
but its Go binding never bound it: `Window()` hands out the HWND and nothing
else. That leaves the engine's own object graph — and with it every WebView2
setting the library does not already set inside `embed()` — unreachable from
Go.

`internal/winchrome` needs exactly one of those settings.
`AreBrowserAcceleratorKeysEnabled` is what stops F5 and Ctrl+R from reloading a
document loaded with `SetHtml`; such a reload lands on `about:blank`, and on a
window that draws its own title bar that means no page AND no caption. Reaching
`ICoreWebView2Settings3` to turn it off starts from the controller pointer this
accessor returns.

Two shape decisions worth keeping:

- **A new file, not a hunk in `webview.go` or `webview.h`.** It touches no
  upstream source, so it has nothing to conflict with when the monthly bot
  re-vendors — unlike `webview.h`, which already carries five hunks and whose
  win32 constructor context this file explicitly warns about above. `patch`
  creates it from a `--- /dev/null` hunk, and it must NOT go in `KEEP_FILES`:
  the whole point is that the patch carries it.
- **A free function, not a method on the `WebView` interface.** Nothing in this
  repo implements that interface today, but upstream may well add its own
  `NativeHandle` with a different signature, and a package-level function has
  a far smaller collision surface.

Unlike the other four, this patch cannot be silently reverted: `internal/winchrome`
*calls* `webview.BrowserController`, so losing it is a **build failure** on the
Windows cross-build in `test.yml` and `update-webview.yml`, not a green PR that
quietly dropped a behavior. The sanity grep in `vendor-webview.sh` is kept
anyway, both for consistency and because it names the intent.
