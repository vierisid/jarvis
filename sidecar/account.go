package main

// The "Account" tray entry opens the hosted account page (identity, current
// plan, device management on usejarvis) in the user's DEFAULT BROWSER — not an
// embedded webview.
//
// WHY the system browser: the account page is gated by the Clerk session that
// hosted onboarding establishes, and that sign-in happens in the system
// browser — hosted_window.go opens the connect/sign-in page there on purpose,
// because the embedded engine drops window.open (Clerk's Google SSO popup
// silently no-ops) and Google rejects OAuth from embedded webviews anyway. The
// Clerk cookie therefore lives in the system browser's cookie jar, never the
// webview runtime's. Navigating an embedded webview to /account lands on a
// signed-out page that then tries to sign in inside the very webview Clerk and
// Google refuse — the "Account opened the Edge webview and I couldn't sign in"
// bug. The system browser already holds the session, so the page loads through.

import (
	"context"
	"log"
)

// OpenAccount hands the hosted account page to the OS default browser.
func (c *SidecarClient) OpenAccount() {
	c.mu.Lock()
	base := resolveHostedBaseURL(c.config.HostedBaseURL)
	c.mu.Unlock()
	// openInDefaultBrowser blocks briefly waiting on the launcher, and the
	// account page is hosted (independent of the brain connection), so fire it
	// off the tray/main goroutine with a standalone context.
	go func() {
		if err := openInDefaultBrowser(context.Background(), base+"/account"); err != nil {
			log.Printf("[tray] open account failed: %v", err)
		}
	}()
}
