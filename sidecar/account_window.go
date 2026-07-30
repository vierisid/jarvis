package main

// Account window — a webview onto the HOSTED account page (usejarvis), not a
// dashboard room: identity (Clerk avatar/profile/sign-out), the current plan,
// and device management are account-plane data the brain deliberately never
// holds, so the page is served by app.usejarvis.dev and authenticated by the
// Clerk session that the hosted onboarding flow established in this same
// webview runtime. If that session is gone (cleared cookies, platform without
// webview cookie persistence), the page falls back to Clerk sign-in and
// returns to /account.
//
// SECURITY: this window shows remote content end-to-end (account page, Clerk,
// Stripe portal redirects), so it registers no bindings beyond the harmless
// __jarvis_reveal show-window hook that runLocalWebview's reveal helper
// installs (webview_reveal.go) — same invariant as the hosted connect flow
// (hosted_window.go). The origin is pinned via resolveHostedBaseURL: release
// builds always talk to the real origin.

import (
	webview "github.com/webview/webview_go"
)

// accountShellHTML is the local first document, shown while the hosted page
// loads. The window is created hidden and revealed on document load — without
// a local shell an unreachable origin would keep the window invisible until
// the reveal timeout, then surface a raw platform error page with no context.
// Deliberately static (no retry, no bindings): if the remote navigation
// fails, the platform error page replaces this shell in an already-visible
// window the user can simply close and reopen.
const accountShellHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    margin: 0; padding: 40px 36px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    background: #f5f2eb; color: #1a1a1a;
  }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .sub { font-size: 13px; margin: 0 0 24px; opacity: 0.8; }
  .spinner {
    width: 22px; height: 22px; margin: 18px 0;
    border: 3px solid #cbc3b2; border-top-color: #c23a2a; border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <h1>Your account</h1>
  <p class="sub">Contacting usejarvis&hellip;</p>
  <div class="spinner"></div>
</body>
</html>`

// OpenAccount opens the hosted account page on its own OS-locked goroutine
// (webview owns its thread, like the settings window / log viewer).
func (c *SidecarClient) OpenAccount() {
	go c.runAccountWindow()
}

func (c *SidecarClient) runAccountWindow() {
	c.mu.Lock()
	base := resolveHostedBaseURL(c.config.HostedBaseURL)
	c.mu.Unlock()

	runLocalWebview("JARVIS — Account", 920, 720, webview.HintNone, func(w webview.WebView) {
		w.SetHtml(accountShellHTML)
		// Dispatch rather than a direct call: the dispatch queue runs after
		// SetHtml's string navigation has been issued, so the shell is the
		// document on screen while the remote page loads instead of the two
		// navigations racing in the engine. If the shell still loses the
		// race, the reveal's timeout fallback covers us as before.
		w.Dispatch(func() { w.Navigate(base + "/account") })
	})
}
