package main

// Route the panel webview's new-window attempts to the system browser.
//
// Panels show the dashboard — remote content — and its OAuth "connect" buttons
// (Google/calendar in the hosting dashboard's Integrations page) open the
// provider's consent screen with window.open / a target=_blank link. Google
// (and Clerk's Google SSO) refuse to run OAuth inside an embedded webview, so
// left to itself the embedded engine either opens a nested Edge/WebKit window
// or no-ops — the "connect calendar opened the webkit browser" bug. The
// dashboard is written expecting the host to intercept this: see its own note
// in Integrations.tsx about "a webview host that intercepts target=_blank [and]
// sends it to the system browser." This is that host behaviour.
//
// installPanelExternalNav is implemented per platform (WebView2
// NewWindowRequested, WKWebView createWebViewWithConfiguration, WebKitGTK
// "create"); a no-op where unsupported. It is called on the webview's UI thread
// after the engine is created and before the first Navigate.

import (
	"context"
	"log"
	"strings"
)

// isExternallyOpenable reports whether a URL from remote panel content may be
// handed to the OS launcher: http(s) only, so a new-window handler fed by remote
// content can never be tricked into launching a file:// path, a javascript:
// URL, or a custom scheme.
func isExternallyOpenable(rawURL string) bool {
	return strings.HasPrefix(rawURL, "https://") || strings.HasPrefix(rawURL, "http://")
}

// panelOpenExternal is the single sink every platform handler funnels a URL to.
func panelOpenExternal(rawURL string) {
	if !isExternallyOpenable(rawURL) {
		if rawURL != "" {
			log.Printf("[panels] not opening a non-http external URL")
		}
		return
	}
	// openInDefaultBrowser blocks briefly on the launcher; keep it off the UI
	// thread the handler runs on.
	go func() {
		if err := openInDefaultBrowser(context.Background(), rawURL); err != nil {
			log.Printf("[panels] open external failed: %v", err)
		}
	}()
}
