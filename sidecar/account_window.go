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

	"github.com/jarvis/sidecar/internal/winchrome"
)

// accountShellHTML is the local first document, shown while the hosted page
// loads — a Monochrome Lab loading moment (brand_css.go): centered Pebble in
// the think state under a mono eyebrow. The window is created hidden and
// revealed on document load — without a local shell an unreachable origin
// would keep the window invisible until the reveal timeout, then surface a
// raw platform error page with no context. Deliberately static (no retry, no
// bindings): if the remote navigation fails, the platform error page replaces
// this shell in an already-visible window the user can simply close and
// reopen.
const accountShellHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>` + brandTokensCSS + brandPebbleCSS + `
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .statusbox { text-align: center; position: relative; }
  .dropwrap { display: flex; justify-content: center; margin-bottom: 20px; position: relative; }
  .dropwrap .bbloom { width: 150px; height: 150px; left: 50%; top: 50%; transform: translate(-50%,-52%); }
  .statephase {
    font-family: var(--mono); font-size: 10px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--ink3); margin-bottom: 9px;
  }
  h1 { font-size: 19px; font-weight: 700; letter-spacing: -.025em; margin: 0; }
  .sub { font-size: 12.5px; color: var(--ink3); margin-top: 6px; }
</style>
</head>
<body>
  <div class="statusbox">
    <div class="dropwrap">
      <span class="bbloom"></span>
      <span class="bdrop s-think" style="width:64px;height:64px"><span class="in"></span><span class="ring"></span></span>
    </div>
    <div class="statephase">Account</div>
    <h1>Your account</h1>
    <p class="sub">Contacting usejarvis&hellip;</p>
  </div>
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

	runLocalWebview("JARVIS — Account", 920, 720, webview.HintNone, winchrome.NativeTitleBar, func(w webview.WebView) func() {
		w.SetHtml(accountShellHTML)
		// Dispatch rather than a direct call: the dispatch queue runs after
		// SetHtml's string navigation has been issued, so the shell is the
		// document on screen while the remote page loads instead of the two
		// navigations racing in the engine. If the shell still loses the
		// race, the reveal's timeout fallback covers us as before.
		w.Dispatch(func() { w.Navigate(base + "/account") })
		return nil
	})
}
