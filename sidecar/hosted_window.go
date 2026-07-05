package main

// First-run window, hosted-first (usejarvis).
//
// When no token is configured the sidecar starts the handshake and loads the
// hosted connect page (Clerk login, plan/checkout for a first device) in the
// webview; a "Self-hosting?" link on the local shell switches to the classic
// paste-a-token form. The webview's Go binding surface is deliberately
// minimal - progress/close UX only (`onProgress`, `onComplete`) - the JWT is
// delivered over the nonce long-poll, never through page JavaScript.

import (
	"context"
	"fmt"
	"html"
	"log"
	"os"
	"runtime"
	"strings"

	webview "github.com/webview/webview_go"
)

// hostedShellHTML is the local page shown while the handshake registers (and
// as the fallback surface for errors). Styled like setupWindowHTML.
const hostedShellHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 36px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    background: #f5f2eb; color: #1a1a1a;
    display: flex; flex-direction: column; min-height: 92vh;
  }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .sub { font-size: 13px; margin: 0 0 24px; opacity: 0.8; line-height: 1.5; }
  #status { font-size: 13px; color: #6a675f; min-height: 18px; }
  #err { color: #c23a2a; font-size: 13px; min-height: 18px; margin-top: 6px; }
  .spinner {
    width: 22px; height: 22px; margin: 18px 0;
    border: 3px solid #cbc3b2; border-top-color: #c23a2a; border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .footer { margin-top: auto; font-size: 12px; color: #6a675f; }
  .footer a { color: #c23a2a; cursor: pointer; text-decoration: underline; }
  #retry { display: none; margin-top: 12px; }
  button {
    appearance: none; border: 0; border-radius: 8px; padding: 9px 16px;
    background: #c23a2a; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
  }
</style>
</head>
<body>
  <h1>Connect this device</h1>
  <p class="sub">Sign in to your usejarvis account to link this machine to your Jarvis.</p>
  <div class="spinner" id="spin"></div>
  <div id="status">Contacting usejarvis&hellip;</div>
  <div id="err"></div>
  <div id="retry"><button onclick="window.retryHosted()">Try again</button></div>
  <p class="footer">Self-hosting your own brain? <a onclick="window.chooseSelfHost()">Paste your enrollment token</a></p>
<script>
  window.__setStatus = function (text) { document.getElementById('status').textContent = text; };
  window.__setError = function (text) {
    document.getElementById('err').textContent = text;
    document.getElementById('spin').style.display = text ? 'none' : '';
    document.getElementById('retry').style.display = text ? 'block' : 'none';
  };
</script>
</body>
</html>`

// runFirstRunWindow drives the no-token first run: hosted connect by default,
// self-host token form one click away. Returns the enrollment JWT ("" if the
// user closed the window). Blocks; must run on the main OS thread.
func runFirstRunWindow(cfg *SidecarConfig) (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	w := webview.New(false)
	if w == nil {
		return "", fmt.Errorf("could not open the setup window (no display, or the system webview runtime is missing)")
	}
	defer w.Destroy()

	w.SetTitle("JARVIS - Connect")
	w.SetSize(920, 720, webview.HintNone)

	base := resolveHostedBaseURL(cfg.HostedBaseURL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var token string

	// Self-host path: swap to the classic token form (its submitToken binding
	// is installed below and shared by both forms).
	if err := w.Bind("chooseSelfHost", func() {
		cancel() // stop the handshake goroutine; its nonce simply expires
		w.Dispatch(func() { w.SetHtml(setupWindowHTML) })
	}); err != nil {
		return "", fmt.Errorf("bind chooseSelfHost: %w", err)
	}

	if err := w.Bind("submitToken", func(raw string) error {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return fmt.Errorf("Paste your enrollment token to continue.")
		}
		if _, err := DecodeJWTPayload(raw); err != nil {
			return fmt.Errorf("That doesn't look like a valid token. Copy the full token from the dashboard.")
		}
		token = raw
		w.Terminate()
		return nil
	}); err != nil {
		return "", fmt.Errorf("bind setup handler: %w", err)
	}

	// Minimal page bindings: progress/close UX ONLY, never token transport
	// (the connect page shows its own progress; these let it inform the shell
	// and close the window when its flow ends).
	if err := w.Bind("onProgress", func(step string) {
		log.Printf("[hosted] connect page progress: %s", step)
	}); err != nil {
		return "", fmt.Errorf("bind onProgress: %w", err)
	}
	if err := w.Bind("onComplete", func() {
		// The long-poll should already have delivered the JWT; the page
		// signaling completion without it means the user finished in-page UX
		// early. The poll goroutine terminates the window when the token
		// lands, so this is just a hint.
		log.Printf("[hosted] connect page reports completion")
	}); err != nil {
		return "", fmt.Errorf("bind onComplete: %w", err)
	}

	startHandshake := func() {
		go func() {
			setStatus := func(text string) {
				w.Dispatch(func() { w.Eval("window.__setStatus && window.__setStatus('" + jsEscape(text) + "')") })
			}
			setError := func(text string) {
				w.Dispatch(func() { w.Eval("window.__setError && window.__setError('" + jsEscape(text) + "')") })
			}

			nonce, err := generateHandshakeNonce()
			if err != nil {
				setError("Could not start setup: " + err.Error())
				return
			}
			hostname, _ := os.Hostname()

			if err := registerHandshake(ctx, base, nonce, hostname); err != nil {
				log.Printf("[hosted] handshake register failed: %v", err)
				setError("Could not reach usejarvis. Check your connection and try again.")
				return
			}

			// Hand the webview to the hosted connect page (nonce in the URL;
			// the page claims it after Clerk login).
			w.Dispatch(func() { w.Navigate(connectPageURL(base, nonce)) })

			jwt, err := awaitHandshakeToken(ctx, base, nonce, func(step string) {
				setStatus(step) // only visible if the shell is still showing
			})
			if err != nil {
				if ctx.Err() != nil {
					return // window closed or self-host chosen
				}
				log.Printf("[hosted] handshake failed: %v", err)
				// Bring the user back to the local shell with the reason.
				w.Dispatch(func() { w.SetHtml(hostedShellHTML) })
				setError("Setup did not complete: " + err.Error())
				return
			}
			token = jwt
			log.Printf("[hosted] enrollment token received via handshake")
			w.Dispatch(func() { w.Terminate() })
		}()
	}

	if err := w.Bind("retryHosted", func() {
		w.Dispatch(func() { w.SetHtml(hostedShellHTML) })
		startHandshake()
	}); err != nil {
		return "", fmt.Errorf("bind retryHosted: %w", err)
	}

	revealWebviewOnLoad(w)
	w.SetHtml(hostedShellHTML)
	startHandshake()
	w.Run() // blocks until Terminate() or the window is closed
	return token, nil
}

// jsEscape makes a Go string safe inside a single-quoted JS literal.
func jsEscape(s string) string {
	s = html.EscapeString(s)
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `'`, `\'`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}
