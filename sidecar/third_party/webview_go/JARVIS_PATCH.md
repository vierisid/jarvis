# Vendored + patched `webview_go`

This is a local copy of `github.com/webview/webview_go`
(`v0.0.0-20240831120633-6173450d4dd6`), wired in via a `replace` directive in
`sidecar/go.mod`, with **one patch**.

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

Re-copy the module from the Go module cache, re-apply the one-line `SW_HIDE`
patch above (search for `PATCHED (jarvis)`), and re-run `go mod tidy`.
