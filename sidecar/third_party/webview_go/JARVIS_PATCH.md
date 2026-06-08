# Vendored + patched `webview_go`

This is a local copy of `github.com/webview/webview_go` (the pinned version is
in `UPSTREAM_VERSION`), wired in via a `replace` directive in `sidecar/go.mod`,
with **one patch** (`jarvis.patch`).

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
page has loaded — see `revealWebviewOnLoad` (`webview_reveal.go`) for the setup
window + log viewer, and the inline reveal in `panels_runtime.go` for panels.
Non-`delayShow` overlay panels are shown immediately.

Only the **Windows** path is patched; the GTK/Cocoa paths are unchanged (they
keep showing on create, and the host's reveal/hide logic is a harmless no-op /
brief flash there).

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
