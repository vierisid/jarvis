package main

// First-run window, hosted-first (usejarvis).
//
// When no token is configured the sidecar starts the handshake and loads the
// hosted connect page (Clerk login, plan/checkout for a first device) in the
// webview; a "Self-hosting?" link on the local shell switches to the classic
// paste-a-token form. The webview's Go binding surface is deliberately
// minimal - progress/close UX only (`onProgress`, `onComplete`) - the JWT is
// delivered over the nonce long-poll, never through page JavaScript.
//
// SECURITY: webview bindings are reachable by WHATEVER page the webview is
// showing, and the hosted flow navigates to remote content (connect page,
// Clerk, Stripe's checkout redirects). `submitToken` is therefore gated: it
// only accepts input while the LOCAL token form is the active document
// (selfHostFormActive), so no remote page can silently enroll this sidecar
// to an attacker-controlled brain by injecting a self-describing JWT.

import (
	"context"
	"fmt"
	"log"
	"os"
	"runtime"
	"strings"

	webview "github.com/webview/webview_go"
)

// hostedShellHTML is the local page shown while the handshake registers (and
// as the fallback surface for errors). Styled like the token form. The
// /*__BOOT__*/ placeholder lets hostedShellWithError bake an error into the
// document itself - an Eval racing a fresh SetHtml can silently lose the
// message, a baked-in script cannot.
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
  /*__BOOT__*/
</script>
</body>
</html>`

// hostedShellWithError renders the shell with the error already displayed by
// the document's own boot script (no post-load Eval race).
func hostedShellWithError(msg string) string {
	boot := "window.__setError('" + jsEscape(msg) + "');"
	return strings.Replace(hostedShellHTML, "/*__BOOT__*/", boot, 1)
}

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

	// True only while the LOCAL paste-a-token form is the active document.
	// All reads/writes happen on the webview main thread (bindings and
	// Dispatch closures both run there), so a plain bool is race-free.
	selfHostFormActive := false

	// Self-host path: swap to the classic token form (its submitToken binding
	// is installed below and only accepts input while this form is active).
	if err := w.Bind("chooseSelfHost", func() {
		cancel() // stop the handshake goroutine; its nonce simply expires
		selfHostFormActive = true
		w.Dispatch(func() { w.SetHtml(setupWindowHTML) })
	}); err != nil {
		return "", fmt.Errorf("bind chooseSelfHost: %w", err)
	}

	if err := w.Bind("submitToken", submitTokenHandler(
		func() bool { return selfHostFormActive },
		func(tok string) {
			token = tok
			w.Terminate()
		},
	)); err != nil {
		return "", fmt.Errorf("bind setup handler: %w", err)
	}

	// Minimal page bindings: progress/close UX ONLY, never token transport
	// (the connect page shows its own progress; these let it inform the shell
	// and close the window when its flow ends). Reachable from remote pages,
	// which is fine: they log, they cannot move credentials.
	if err := w.Bind("onProgress", func(step string) {
		log.Printf("[hosted] connect page progress: %s", step)
	}); err != nil {
		return "", fmt.Errorf("bind onProgress: %w", err)
	}
	if err := w.Bind("onComplete", func() {
		// The long-poll delivers the JWT and terminates the window; the page
		// signaling completion is only a UX hint.
		log.Printf("[hosted] connect page reports completion")
	}); err != nil {
		return "", fmt.Errorf("bind onComplete: %w", err)
	}

	startHandshake := func() {
		go func() {
			setStatus := func(text string) {
				w.Dispatch(func() {
					if ctx.Err() != nil {
						return
					}
					w.Eval("window.__setStatus && window.__setStatus('" + jsEscape(text) + "')")
				})
			}
			showShellError := func(text string) {
				w.Dispatch(func() {
					if ctx.Err() != nil {
						return // self-host chosen or window closing: leave the form alone
					}
					w.SetHtml(hostedShellWithError(text))
				})
			}

			nonce, err := generateHandshakeNonce()
			if err != nil {
				showShellError("Could not start setup: " + err.Error())
				return
			}
			hostname, _ := os.Hostname()

			if err := registerHandshake(ctx, base, nonce, hostname); err != nil {
				if ctx.Err() != nil {
					return
				}
				log.Printf("[hosted] handshake register failed: %v", err)
				showShellError("Could not reach usejarvis. Check your connection and try again.")
				return
			}

			// Hand the webview to the hosted connect page (nonce in the URL;
			// the page claims it after Clerk login). Re-check ctx INSIDE the
			// dispatched closure: if the user picked self-host in the gap, a
			// late Navigate must not yank the token form away.
			w.Dispatch(func() {
				if ctx.Err() != nil {
					return
				}
				w.Navigate(connectPageURL(base, nonce))
			})

			jwt, err := awaitHandshakeToken(ctx, base, nonce, func(step string) {
				setStatus(step) // only visible if the shell is still showing
			})
			if err != nil {
				if ctx.Err() != nil {
					return // window closed or self-host chosen
				}
				log.Printf("[hosted] handshake failed: %v", err)
				showShellError("Setup did not complete: " + err.Error())
				return
			}
			log.Printf("[hosted] enrollment token received via handshake")
			w.Dispatch(func() {
				// Assigned on the main thread so the read after w.Run()
				// needs no cross-goroutine ordering argument.
				token = jwt
				w.Terminate()
			})
		}()
	}

	if err := w.Bind("retryHosted", func() {
		if ctx.Err() != nil {
			return // self-host already chosen; nothing to retry
		}
		selfHostFormActive = false
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

// jsEscape makes a Go string safe inside a single-quoted JS string literal.
// Backslash first, then quotes and line terminators; `<` is escaped so the
// literal can also sit inside an inline <script> without closing it.
func jsEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `'`, `\'`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, "\r", `\r`)
	s = strings.ReplaceAll(s, "<", `\x3c`)
	return s
}
