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
	"errors"
	"fmt"
	"log"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"

	webview "github.com/webview/webview_go"

	"github.com/jarvis/sidecar/internal/winchrome"
)

// hostedShellHTML is the local page shown while the handshake registers (and
// as the fallback surface for errors). Monochrome Lab (brand_css.go): a
// centered status screen whose Pebble mirrors the machine's state — breathing
// red while contacting usejarvis, white think-ring while sign-in runs in the
// browser, fast red on error. The /*__BOOT__*/ placeholder lets
// hostedShellWithError bake an error into the document itself - an Eval
// racing a fresh SetHtml can silently lose the message, a baked-in script
// cannot.
const hostedShellHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>JARVIS - Connect</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>` + brandTokensCSS + brandPebbleCSS + `
  html, body { height: 100%; }
  /* No padding on body: the strip's offset would replace it, not add to it.
     .pagebody carries the padding and the centred column, and is the scroll
     container so its scrollbar starts below the strip — PageBodyJS is what
     keeps it scrollable by keyboard. */
  body { padding: 0; overflow: hidden; }
  .pagebody {
    height: 100%; overflow-y: auto;
    display: flex; flex-direction: column; padding: 26px 30px;
  }
  .bhead .word { font-size: 16px; }
  /* Under custom chrome the strip already carries the mark and the window
     name; a wordmark directly beneath it reads as a doubled header. */
  html[data-chrome="custom"] .bhead { display: none; }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; }
  .statusbox { width: 100%; max-width: 380px; text-align: center; position: relative; }
  .dropwrap { display: flex; justify-content: center; margin-bottom: 20px; position: relative; }
  .dropwrap .bbloom { width: 150px; height: 150px; left: 50%; top: 50%; transform: translate(-50%,-52%); }
  .statephase {
    font-family: var(--mono); font-size: 10px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--ink3); margin-bottom: 9px;
  }
  h2 { font-size: 19px; font-weight: 700; letter-spacing: -.025em; margin: 0; }
  #status { font-size: 12.5px; color: var(--ink3); line-height: 1.55; margin-top: 6px; min-height: 18px; }
  #err { font-size: 12px; color: var(--listen-tx); line-height: 1.5; margin-top: 8px; min-height: 18px; }
  #reopen { display: none; margin-top: 8px; font-size: 12.5px; }
  #reopen a { color: var(--listen-tx); cursor: pointer; text-decoration: underline; }
  #url {
    display: none; margin-top: 12px; padding: 9px 11px; text-align: left;
    font-family: var(--mono); font-size: 11px; line-height: 1.5;
    background: var(--panel2); border: 1px solid var(--rule);
    border-radius: var(--corner-sm); color: var(--ink2);
    word-break: break-all; user-select: all;
  }
  #retry { display: none; margin-top: 16px; }
  .btn {
    appearance: none; height: 40px; padding: 0 18px; border: 1px solid transparent;
    border-radius: var(--corner-sm); font-family: var(--sans); font-size: 13.5px;
    font-weight: 600; cursor: pointer; background: var(--ink); color: var(--bg);
    transition: filter 150ms var(--ease);
  }
  .btn:hover { filter: brightness(1.08); }
  .btn:focus-visible { outline: 2px solid var(--ink2); outline-offset: 2px; }
  .footer { margin: 0; font-size: 11.5px; color: var(--faint); text-align: center; }
  .footer a { color: var(--listen-tx); cursor: pointer; text-decoration: underline; }
` + brandTitlebarCSS + `
</style>
</head>
<body>
<div class="pagebody" tabindex="-1">
  <div class="bhead"><span class="word"><span class="u">use</span>jarvis</span></div>
  <div class="center">
    <div class="statusbox">
      <div class="dropwrap">
        <span class="bbloom" id="bloom"></span>
        <span class="bdrop" id="drop" style="width:64px;height:64px"><span class="in"></span><span class="ring"></span></span>
      </div>
      <div class="statephase" id="phase">Connecting</div>
      <h2>Connect this device</h2>
      <div id="status">Contacting usejarvis&hellip;</div>
      <div id="err"></div>
      <div id="reopen"><a onclick="window.openConnectPage()">Open the sign-in page again</a></div>
      <div id="url"></div>
      <div id="retry"><button class="btn" onclick="window.retryHosted()">Try again</button></div>
    </div>
  </div>
  <p class="footer">Self-hosting your own brain? <a onclick="window.chooseSelfHost()">Paste your enrollment token</a></p>
</div>` + brandTitlebarHTML + `
<script>
  window.__setStatus = function (text) { document.getElementById('status').textContent = text; };
  window.__setError = function (text) {
    document.getElementById('drop').className = text ? 'bdrop s-err' : 'bdrop';
    document.getElementById('phase').textContent = text ? 'Setup failed' : 'Connecting';
    document.getElementById('status').textContent = '';
    document.getElementById('err').textContent = text;
    document.getElementById('retry').style.display = text ? 'block' : 'none';
    document.getElementById('reopen').style.display = 'none';
    document.getElementById('url').style.display = 'none';
  };
  window.__setSelfHostHint = function () {
    document.getElementById('drop').className = 'bdrop';
    document.getElementById('phase').textContent = 'Manual setup';
    document.getElementById('status').textContent =
      'usejarvis is not reachable from this machine. Use the "Paste your enrollment token" link below to connect this device.';
    document.getElementById('err').textContent = '';
    document.getElementById('retry').style.display = 'none';
    document.getElementById('reopen').style.display = 'none';
    document.getElementById('url').style.display = 'none';
  };
  window.__browserOpened = function (ok, url) {
    document.getElementById('drop').className = ok ? 'bdrop s-think' : 'bdrop';
    document.getElementById('phase').textContent = ok ? 'Waiting for sign-in' : 'Open the link below';
    document.getElementById('status').textContent = ok
      ? 'We opened usejarvis in your browser — finish signing in there. This window will continue on its own.'
      : 'Could not open your browser automatically. Open this link yourself:';
    document.getElementById('reopen').style.display = 'block';
    var u = document.getElementById('url');
    u.textContent = url;
    u.style.display = 'block';
  };
  /*__BOOT__*/
` + brandTitlebarJS + brandPageBodyJS + `
</script>
</body>
</html>`

// hostedShellWithError renders the shell with the error already displayed by
// the document's own boot script (no post-load Eval race).
func hostedShellWithError(msg string) string {
	boot := "window.__setError('" + jsEscape(msg) + "');"
	return strings.Replace(hostedShellHTML, "/*__BOOT__*/", boot, 1)
}

// hostedShellWithSelfHostHint renders the shell pointing the user at the
// footer's paste-a-token link instead of an error: shown when the hosted
// origin doesn't resolve at all (likely a self-hosted / offline machine).
func hostedShellWithSelfHostHint() string {
	return strings.Replace(hostedShellHTML, "/*__BOOT__*/", "window.__setSelfHostHint();", 1)
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

	// Brain-check of a pasted token, on its own context: chooseSelfHost cancels
	// ctx to stop the hosted handshake, but a verification started afterwards
	// must keep running. Cancelled before the WaitGroup join (LIFO with the
	// defers above) so closing the window never blocks on a slow probe.
	verifyCtx, verifyCancel := context.WithCancel(context.Background())
	defer verifyCancel()

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

	// True while a pasted token is being verified against its brain; gates
	// submitToken so a second paste can't race the in-flight check. Main-thread
	// only, like selfHostFormActive.
	verifyInFlight := false

	// The ACTIVE handshake's nonce (set once registered server-side), read by
	// the deep-link handler off-thread — a jarvis://enroll link only counts
	// when it names this exact nonce. Any page can fire deep links; only the
	// real connect page knows the 256-bit nonce.
	var nonceMu sync.Mutex
	currentNonce := ""
	setNonce := func(n string) { nonceMu.Lock(); currentNonce = n; nonceMu.Unlock() }
	getNonce := func() string { nonceMu.Lock(); defer nonceMu.Unlock(); return currentNonce }

	// Serializes deep-link verifications (the browser row can be re-clicked
	// while a probe is in flight; verify_token.go bounds each at ~12s).
	var deepLinkBusy atomic.Bool

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
		func() bool { return selfHostFormActive && !verifyInFlight },
		func(tok string) {
			// Structurally valid — now prove it works against the brain it
			// names before it is persisted. A wrong-URL token used to be saved
			// blind: the window closed and the only trace of the failure was
			// the reconnect loop in the log. The form shows "checking" while
			// this runs; the verdict lands via window.__tokenVerdict, and
			// success closes the window as before.
			verifyInFlight = true
			handshakeWG.Add(1)
			go func() {
				defer handshakeWG.Done()
				verr := verifyBrainToken(verifyCtx, tok, cfg.Brain)
				w.Dispatch(func() {
					if torndown.Load() || verifyCtx.Err() != nil {
						return
					}
					verifyInFlight = false
					if verr != nil {
						w.Eval("window.__tokenVerdict && window.__tokenVerdict('" + jsEscape(verr.Error()) + "')")
						return
					}
					tokenMu.Lock()
					token = tok
					tokenMu.Unlock()
					w.Terminate()
				})
			}()
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
			showSelfHostHint := func() {
				w.Dispatch(func() {
					if ctx.Err() != nil {
						return
					}
					connectURL = "" // the nonce died with the handshake
					w.SetHtml(hostedShellWithSelfHostHint())
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
				if isNoSuchHostErr(err) {
					// The hosted origin doesn't resolve at all — almost
					// certainly a self-hosted/offline machine, not a blip.
					// Point at the paste-a-token link instead of erroring.
					showSelfHostHint()
					return
				}
				showShellError("Could not reach usejarvis. Check your connection and try again.")
				return
			}

			// Registered: from here the connect page can hand a self-host
			// token straight back to us by deep link, keyed by this nonce.
			// Never cleared on later errors — the page for this nonce may
			// still be open in the browser, and a deep link doesn't need the
			// long-poll to be alive; a fresh handshake overwrites it.
			setNonce(nonce)

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
				if errors.Is(err, errHandshakeResolvedLocally) {
					// The deep-link goroutine owns the outcome (it verified,
					// stored the token, and is closing the window) — painting
					// an error over its success would be a lie.
					return
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

	// Enrollment deep links (jarvis://enroll — the connect page's free door):
	// the OS-launched forwarder dials our socket with the URI; nonce-match,
	// verify against the brain, report ONLY the verdict, and on success take
	// the token exactly like the hosted path. Listener failure is not fatal —
	// the page's copy-token fallback and the local paste form both still work.
	// dl.Close() joins in-flight callbacks; each callback joins its own work
	// into handshakeWG, so the explicit post-Run teardown below stays ordered:
	// close listener -> Wait -> read token -> (deferred) Destroy.
	dl, dlErr := listenEnrollDeepLinks(func(uri string) {
		nonce, tok, perr := parseEnrollDeepLink(uri)
		if perr != nil {
			log.Printf("[hosted] enroll deep link dropped: %v", perr)
			return
		}
		want := getNonce()
		if want == "" || nonce != want {
			log.Printf("[hosted] enroll deep link dropped: nonce mismatch")
			return
		}
		if !deepLinkBusy.CompareAndSwap(false, true) {
			log.Printf("[hosted] enroll deep link dropped: a verification is already running")
			return
		}
		handshakeWG.Add(1)
		go func() {
			defer handshakeWG.Done()
			defer deepLinkBusy.Store(false)
			if _, derr := DecodeJWTPayload(tok); derr != nil {
				reportSelfHostResult(verifyCtx, base, nonce, fmt.Errorf("That doesn't look like a valid token. Copy the full token printed by 'jarvis enroll'."))
				return
			}
			verr := verifyBrainToken(verifyCtx, tok, cfg.Brain)
			// The page is the feedback surface either way: it shows the reason
			// on failure and flips to "connected" on success.
			reportSelfHostResult(verifyCtx, base, nonce, verr)
			if verr != nil {
				log.Printf("[hosted] deep-linked token rejected: %v", verr)
				return
			}
			log.Printf("[hosted] enrollment token received via deep link and verified")
			tokenMu.Lock()
			token = tok
			tokenMu.Unlock()
			w.Dispatch(func() {
				if torndown.Load() {
					return
				}
				w.Terminate()
			})
		}()
	})
	if dlErr != nil {
		log.Printf("[hosted] enroll deep-link listener unavailable: %v", dlErr)
	}
	defer dl.Close() // idempotent backstop for early returns (nil-safe)

	// Custom chrome before the reveal hook: the window is still hidden, so the
	// native title bar is never composited. Safe here because every document
	// this window shows is LOCAL (the hosted connect page opens in the user's
	// browser, not in here) — see winchrome.Install on why that matters.
	winchrome.Install(w)
	stopReveal := revealWebviewOnLoad(w)
	// LIFO with the deferred Destroy at the top: joining the reveal-timeout
	// goroutine before the engine is freed prevents its pending Dispatch from
	// landing on a dangling pointer if the window closes within the timeout.
	defer stopReveal()
	w.SetHtml(hostedShellHTML)
	startHandshake()
	w.Run() // blocks until Terminate() or the window is closed
	torndown.Store(true)
	// No further deep links, and no callback mid-flight past this line (Close
	// joins them) — so the Add-into-handshakeWG below cannot race the Wait.
	dl.Close()
	// Join the handshake goroutine BEFORE reading the token, rather than
	// leaving it to the deferred Wait: defers run after the return value is
	// evaluated, so a token that lands in the instant the window closes would
	// otherwise be dropped on the floor. Both calls are idempotent, so the
	// deferred cancel/Wait stay as backstops for the early-return paths.
	cancel()
	verifyCancel()
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
