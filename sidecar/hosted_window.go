package main

// First-run window, hosted-first (usejarvis).
//
// When no token is configured the sidecar starts the handshake and opens the
// hosted connect page (Clerk login, plan/checkout for a first device) in the
// SYSTEM browser — not in this webview: the embedded engine drops
// window.open, so Clerk's Google SSO popup silently no-oped, and Google
// rejects OAuth from embedded webviews regardless. The webview only ever
// shows the local shell, which tracks progress while the nonce long-poll
// waits for the enrollment JWT; a "Self-hosting?" link switches to the
// classic paste-a-token form. The JWT is delivered over the long-poll, never
// through page JavaScript.
//
// SECURITY: webview bindings are reachable by WHATEVER page the webview is
// showing. This window now only ever shows local documents, but `submitToken`
// stays gated to the LOCAL token form (selfHostFormActive) as defense in
// depth against a compromised shell document, and `openConnectPage` takes no
// arguments — it can only launch the Go-held pinned connect URL.

import (
	"context"
	"fmt"
	"log"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"

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
  #reopen { display: none; margin-top: 6px; font-size: 13px; }
  #reopen a { color: #c23a2a; cursor: pointer; text-decoration: underline; }
  #url {
    display: none; margin-top: 10px; padding: 8px 10px;
    font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px;
    background: #ece8dd; border-radius: 6px; word-break: break-all; user-select: all;
  }
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
  <div id="reopen"><a onclick="window.openConnectPage()">Open the sign-in page again</a></div>
  <div id="url"></div>
  <div id="retry"><button onclick="window.retryHosted()">Try again</button></div>
  <p class="footer">Self-hosting your own brain? <a onclick="window.chooseSelfHost()">Paste your enrollment token</a></p>
<script>
  window.__setStatus = function (text) { document.getElementById('status').textContent = text; };
  window.__setError = function (text) {
    document.getElementById('status').textContent = '';
    document.getElementById('err').textContent = text;
    document.getElementById('spin').style.display = text ? 'none' : '';
    document.getElementById('retry').style.display = text ? 'block' : 'none';
    document.getElementById('reopen').style.display = 'none';
    document.getElementById('url').style.display = 'none';
  };
  window.__browserOpened = function (ok, url) {
    document.getElementById('status').textContent = ok
      ? 'We opened usejarvis in your browser — finish signing in there. This window will continue on its own.'
      : 'Could not open your browser automatically. Open this link yourself:';
    document.getElementById('reopen').style.display = 'block';
    var u = document.getElementById('url');
    u.textContent = url;
    u.style.display = 'block';
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
	// LIFO sandwich with the deferred Destroy above: on return, cancel() makes
	// the handshake goroutine's HTTP calls abort promptly, Wait() joins the
	// goroutine, and only then does Destroy free the engine. The goroutine's
	// w.Dispatch calls check ctx only INSIDE their closures — without the join,
	// one concluding at the instant the window closes could Dispatch into a
	// freed engine (the same hazard class stopReveal closes for the timer).
	var handshakeWG sync.WaitGroup
	defer handshakeWG.Wait()
	defer cancel()

	// Unlike the main-thread-only locals below, this is written by the handshake
	// goroutine and read after Run() returns, so it needs real synchronisation.
	// It deliberately does NOT live behind a Dispatch closure: see the capture
	// site in startHandshake.
	var tokenMu sync.Mutex
	var token string

	// The user explicitly clicked "paste your own token". Distinct from ctx,
	// which the deferred teardown ALSO cancels — so `ctx.Err() != nil` cannot
	// tell "the user opted out of hosted" from "this function is returning",
	// and only the former may discard a delivered hosted JWT.
	var selfHostChosen atomic.Bool

	// True only while the LOCAL paste-a-token form is the active document.
	// All reads/writes happen on the webview main thread (bindings and
	// Dispatch closures both run there), so a plain bool is race-free.
	selfHostFormActive := false

	// Connect page URL for the CURRENT handshake nonce, and a guard against
	// overlapping handshakes (double-clicked "Try again"). Main-thread only,
	// like selfHostFormActive/token: bindings and Dispatch closures both run
	// on the webview main thread, and the pre-Run startHandshake call happens
	// before the loop starts.
	connectURL := ""
	handshakeInFlight := false
	reopenInFlight := false

	// Set once Run() returns: a SetHtml closure posted by chooseSelfHost or
	// retryHosted just before the window closed can outlive this loop (GTK
	// idle sources and the Cocoa main queue both survive loop exit) and drain
	// in the process's NEXT webview loop, after Destroy has freed this
	// engine. The ctx guard the other closures use cannot cover
	// chooseSelfHost — it cancels ctx itself — so those two closures re-check
	// this flag instead (same pattern as webview_reveal's stopped flag).
	// Atomic because the later loop may run on a different OS thread.
	var torndown atomic.Bool

	// Self-host path: swap to the classic token form (its submitToken binding
	// is installed below and only accepts input while this form is active).
	if err := w.Bind("chooseSelfHost", func() {
		selfHostChosen.Store(true) // before cancel(): the ONLY reason to drop a hosted token
		cancel()                   // stop the handshake goroutine; its nonce simply expires
		selfHostFormActive = true
		connectURL = "" // openConnectPage goes dormant with the shell
		w.Dispatch(func() {
			if torndown.Load() {
				return
			}
			w.SetHtml(setupWindowHTML)
		})
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

	// Fallback for the shell's "open the sign-in page again" link: the
	// automatic browser launch failed, or the user closed the tab. Takes no
	// arguments — it can only relaunch the pinned URL Go already holds. The
	// launch runs off-thread (it waits up to 3s for the launcher's verdict,
	// which must not stall the UI loop), joined via handshakeWG so it cannot
	// Dispatch into a freed engine, ctx-guarded like the handshake's closures,
	// and debounced so a double-click launches one browser, not two.
	if err := w.Bind("openConnectPage", func() {
		if connectURL == "" || reopenInFlight {
			return
		}
		reopenInFlight = true
		url := connectURL
		handshakeWG.Add(1)
		go func() {
			defer handshakeWG.Done()
			err := openInDefaultBrowser(ctx, url)
			w.Dispatch(func() { reopenInFlight = false })
			if err != nil && ctx.Err() == nil {
				log.Printf("[hosted] reopen browser failed: %v", err)
				w.Dispatch(func() {
					// url != connectURL: the document moved on while the
					// launch was failing (terminal error shell, or a fresh
					// retry) — don't repaint a dead nonce's URL over it.
					if ctx.Err() != nil || url != connectURL {
						return
					}
					w.Eval("window.__browserOpened && window.__browserOpened(false, '" + jsEscape(url) + "')")
				})
			}
		}()
	}); err != nil {
		return "", fmt.Errorf("bind openConnectPage: %w", err)
	}

	startHandshake := func() {
		handshakeInFlight = true
		handshakeWG.Add(1)
		go func() {
			defer handshakeWG.Done()
			// Posted after any final showShellError SetHtml (FIFO), so by the
			// time "Try again" is clickable the guard is already down.
			defer w.Dispatch(func() { handshakeInFlight = false })
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
					connectURL = "" // the nonce died with the handshake
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

			// Sign-in happens in the SYSTEM browser (nonce in the URL; the
			// connect page claims it after Clerk login) — see the header
			// comment for why not this webview. The shell stays up as the
			// progress surface. Re-check ctx INSIDE the dispatched closures:
			// if the user picked self-host in the gap, a late Eval must not
			// scribble on the token form.
			connect := connectPageURL(base, nonce)
			w.Dispatch(func() {
				if ctx.Err() != nil {
					return
				}
				connectURL = connect
			})
			if ctx.Err() != nil {
				// Self-host chosen or window closed mid-register. Best
				// effort: a cancel racing the launch below can still open
				// one stale tab, whose nonce simply expires.
				return
			}
			launched := true
			if err := openInDefaultBrowser(ctx, connect); err != nil {
				if ctx.Err() != nil {
					return
				}
				launched = false
				log.Printf("[hosted] could not open the system browser: %v", err)
			}
			w.Dispatch(func() {
				if ctx.Err() != nil {
					return
				}
				w.Eval(fmt.Sprintf("window.__browserOpened && window.__browserOpened(%t, '%s')", launched, jsEscape(connect)))
			})

			jwt, err := awaitHandshakeToken(ctx, base, nonce, func(step string) {
				setStatus(step) // server-side provisioning hints
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
			// Captured HERE, not inside the Dispatch closure. By the time
			// awaitHandshakeToken returns, the server has already marked the
			// handshake delivered — this JWT is SPENT, and the nonce can never
			// be re-polled. Losing it strands the user with a paid, enrolled
			// instance and no way to reach it. Seen live on macOS: the token
			// arrived, the closure never drained, and the window sat open
			// forever while runFirstRunWindow stayed blocked in Run().
			//
			// So the two concerns are separated: keeping the credential is
			// correctness and happens unconditionally below; closing the window
			// is UI and stays best-effort in the dispatch.
			//
			// Gated on the explicit opt-out rather than ctx — the deferred
			// teardown cancels ctx too, so a ctx check here would silently
			// discard a valid token on an ordinary close.
			if !selfHostChosen.Load() {
				tokenMu.Lock()
				token = jwt
				tokenMu.Unlock()
			}
			w.Dispatch(func() { w.Terminate() })
		}()
	}

	if err := w.Bind("retryHosted", func() {
		if ctx.Err() != nil || handshakeInFlight {
			return // self-host already chosen, or a double-click: one handshake at a time
		}
		selfHostFormActive = false
		connectURL = "" // stale nonce; the fresh handshake sets the new URL
		w.Dispatch(func() {
			if torndown.Load() {
				return
			}
			w.SetHtml(hostedShellHTML)
		})
		startHandshake()
	}); err != nil {
		return "", fmt.Errorf("bind retryHosted: %w", err)
	}

	stopReveal := revealWebviewOnLoad(w)
	// LIFO with the deferred Destroy at the top: joining the reveal-timeout
	// goroutine before the engine is freed prevents its pending Dispatch from
	// landing on a dangling pointer if the window closes within the timeout.
	defer stopReveal()
	w.SetHtml(hostedShellHTML)
	startHandshake()
	w.Run() // blocks until Terminate() or the window is closed
	torndown.Store(true)
	// Join the handshake goroutine BEFORE reading the token, rather than
	// leaving it to the deferred Wait: defers run after the return value is
	// evaluated, so a token that lands in the instant the window closes would
	// otherwise be dropped on the floor. Both calls are idempotent, so the
	// deferred cancel/Wait stay as backstops for the early-return paths.
	cancel()
	handshakeWG.Wait()
	tokenMu.Lock()
	defer tokenMu.Unlock()
	return token, nil
}

// jsEscape makes a Go string safe inside a single-quoted JS string literal.
// Backslash first, then quotes and line terminators (including U+2028/U+2029,
// which pre-ES2019 parsers treat as terminators); `<` is escaped so the
// literal can also sit inside an inline <script> without closing it.
func jsEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `'`, `\'`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, "\r", `\r`)
	s = strings.ReplaceAll(s, "\u2028", `\u2028`)
	s = strings.ReplaceAll(s, "\u2029", `\u2029`)
	s = strings.ReplaceAll(s, "<", `\x3c`)
	return s
}
