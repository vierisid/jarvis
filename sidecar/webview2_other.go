//go:build !windows

package main

// ensureWebView2Runtime is a no-op off Windows: WebView2 is the Windows webview
// backend; Linux uses WebKitGTK and macOS uses WKWebView (shipped with the OS),
// so the runtime is always considered present.
func ensureWebView2Runtime() bool { return true }
