package main

// First-run setup window.
//
// When the sidecar starts with no token configured, instead of printing an
// error and exiting we pop up a small native window asking for the enrollment
// JWT. It reuses the webview_go dependency the panels already pull in, so it is
// a single cross-platform implementation (Windows / Linux / macOS) and the UI is
// plain HTML that can be branded later.
//
// Flow: main() calls runSetupWindow() when cfg.Token == ""; the window blocks
// until the user submits a valid-looking token (closing the window cancels).
// The token is validated only as a well-formed JWT here — the brain still does
// the real cryptographic verification on connect.

import (
	"fmt"
	"runtime"
	"strings"

	webview "github.com/webview/webview_go"
)

// setupWindowHTML is the (intentionally minimal, unbranded) first-run form.
// `window.submitToken(value)` is the Go binding installed below; it rejects with
// a message when the token is empty/malformed so the form can show it inline.
const setupWindowHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  /* Force the sidecar's own light theme regardless of the OS appearance. */
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    background: #f5f2eb; color: #1a1a1a;
  }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .sub { font-size: 13px; margin: 0 0 18px; opacity: 0.8; line-height: 1.45; }
  .hint { font-size: 12px; color: #6a675f; margin: 6px 0 16px; }
  label { font-size: 12px; font-weight: 600; display: block; margin-bottom: 6px; }
  textarea {
    width: 100%; height: 110px; resize: none; padding: 10px 12px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px;
    border: 1px solid #cbc3b2; border-radius: 8px; background: #fff; color: #1a1a1a;
    line-height: 1.4;
  }
  textarea:focus { outline: 2px solid #c23a2a; outline-offset: 1px; border-color: #c23a2a; }
  .row { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; gap: 12px; }
  #err { color: #c23a2a; font-size: 12px; min-height: 16px; flex: 1; }
  button {
    appearance: none; border: 0; border-radius: 8px; padding: 10px 18px;
    background: #c23a2a; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #a83120; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
  <h1>Connect this machine to JARVIS</h1>
  <p class="sub">Paste the enrollment token from the dashboard
    (<b>Settings &rarr; Sidecar &rarr; Enroll</b>). It connects this sidecar to
    your brain and authenticates it.</p>
  <label for="tok">Enrollment token</label>
  <textarea id="tok" placeholder="eyJhbGciOiJFUzI1NiIs..." spellcheck="false" autofocus></textarea>
  <p class="hint">The token is stored locally at ~/.jarvis/sidecar.yaml. Press Cmd/Ctrl+Enter to connect.</p>
  <div class="row">
    <span id="err"></span>
    <button id="go" onclick="submit()">Connect</button>
  </div>
<script>
  var tok = document.getElementById('tok');
  var err = document.getElementById('err');
  var btn = document.getElementById('go');
  async function submit() {
    err.textContent = '';
    btn.disabled = true;
    try {
      await window.submitToken(tok.value);
      // On success the window closes; nothing more to do.
    } catch (e) {
      err.textContent = (e && e.message) ? e.message : String(e);
      btn.disabled = false;
      tok.focus();
    }
  }
  tok.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  tok.focus();
</script>
</body>
</html>`

// runSetupWindow shows the first-run token prompt and returns the entered token
// (validated as a well-formed JWT). Returns "" if the user closed the window
// without submitting. Blocks until the window closes and must run on the main OS
// thread (webview/Cocoa requirement), so call it from main() before spawning
// other goroutines.
func runSetupWindow() (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	w := webview.New(false)
	if w == nil {
		return "", fmt.Errorf("could not open the setup window (no display, or the system webview runtime is missing)")
	}
	defer w.Destroy()

	w.SetTitle("JARVIS Sidecar - Setup")
	w.SetSize(560, 380, webview.HintFixed)

	var token string
	// window.submitToken(raw) -> resolves on success (and closes the window),
	// rejects with a message the form displays inline.
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

	// The vendored webview creates the window hidden (no flash); reveal it once
	// the form has loaded.
	revealWebviewOnLoad(w)
	w.SetHtml(setupWindowHTML)
	w.Run() // blocks until Terminate() (submit) or the window is closed
	return token, nil
}
