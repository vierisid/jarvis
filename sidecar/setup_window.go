package main

// First-run setup window.
//
// When the sidecar starts with no token configured, instead of printing an
// error and exiting we pop up a small native window asking for the enrollment
// JWT. It reuses the webview_go dependency the panels already pull in, so it is
// a single cross-platform implementation (Windows / Linux / macOS); the UI is
// local HTML in the shared Monochrome Lab brand (brand_css.go).
//
// Flow: main() calls runSetupWindow() when cfg.Token == ""; the window blocks
// until the user submits a valid-looking token (closing the window cancels).
// The token is validated only as a well-formed JWT here — the brain still does
// the real cryptographic verification on connect.

// setupWindowHTML is the self-host first-run form, Monochrome Lab
// (brand_css.go): a centered raised card with the signature corner.
// `window.submitToken(value)` is the Go binding installed below; it rejects with
// a message when the token is empty/malformed so the form can show it inline.
const setupWindowHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>` + brandTokensCSS + brandPebbleCSS + `
  body { min-height: 100vh; display: flex; flex-direction: column; padding: 26px 30px; }
  .bhead .word { font-size: 16px; }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; }
  .formbox {
    width: 100%; max-width: 440px; padding: 24px 24px 20px;
    background: var(--raise); border: 1px solid var(--rule);
    border-radius: var(--corner); box-shadow: var(--sh-md);
  }
  .eyebrow {
    font-family: var(--mono); font-size: 10px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--ink3); margin-bottom: 9px;
  }
  h1 { font-size: 19px; font-weight: 700; letter-spacing: -.025em; margin: 0 0 6px; }
  .sub { font-size: 12.5px; color: var(--ink3); margin: 0 0 18px; line-height: 1.55; }
  .sub b { color: var(--ink2); font-weight: 600; }
  label { font-size: 11px; font-weight: 600; color: var(--ink2); display: block; margin-bottom: 7px; }
  textarea {
    width: 100%; height: 110px; resize: none; padding: 10px 12px;
    font-family: var(--mono); font-size: 11.5px; line-height: 1.5;
    border: 1px solid var(--rule); border-radius: var(--corner-sm);
    background: var(--panel2); color: var(--ink); outline: none;
    transition: border-color .12s, box-shadow .12s, background .12s;
  }
  textarea::placeholder { color: var(--faint); }
  textarea:focus { border-color: var(--speak); background: var(--raise); box-shadow: 0 0 0 3px rgba(45,120,255,.14); }
  .hint { font-size: 11px; color: var(--faint); margin: 8px 0 0; line-height: 1.5; }
  .row { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; gap: 12px; }
  #err { color: var(--listen-tx); font-size: 12px; line-height: 1.5; min-height: 16px; flex: 1; text-align: left; }
  button {
    appearance: none; height: 40px; padding: 0 18px; border: 1px solid transparent;
    border-radius: var(--corner-sm); font-family: var(--sans); font-size: 13.5px;
    font-weight: 600; cursor: pointer; background: var(--ink); color: var(--bg);
    transition: filter 150ms var(--ease);
  }
  button:not(:disabled):hover { filter: brightness(1.08); }
  button:focus-visible { outline: 2px solid var(--ink2); outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
  <div class="bhead"><span class="word"><span class="u">use</span>jarvis</span></div>
  <div class="center">
    <div class="formbox">
      <div class="eyebrow">Self-hosted</div>
      <h1>Connect this machine to Jarvis</h1>
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
    </div>
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

// NOTE: the standalone runSetupWindow function was removed when the
// hosted-first connect window (hosted_window.go) took over the no-token
// first run; the HTML above is its self-host form, reached via the
// "Paste your enrollment token" link (gated submitToken binding).
