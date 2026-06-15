package main

// Local sidecar settings window — a small webview that shows connection status,
// lets the user change the enrollment token, and edit sidecar preferences.
// Entirely local: it is NOT a dashboard room and never talks to the brain
// (the old "Settings" entry opened the remote settings room). Mirrors the log
// viewer pattern; UI is plain HTML, to be branded later.

import (
	"fmt"
	"log"

	webview "github.com/webview/webview_go"
)

// OpenSettings opens the local sidecar settings window on its own OS-locked
// goroutine (webview owns its thread, like the log viewer / panels).
func (c *SidecarClient) OpenSettings() {
	go c.runSettingsWindow()
}

// settingsState is the snapshot the page renders. Returned by the getState
// binding (webview_go marshals it to JSON for the JS side).
type settingsState struct {
	Status string `json:"status"` // "connected" | "connecting" | "error"
	Prefs  struct {
		StartAtStartup      bool `json:"start_at_startup"`
		EtherealPebble      bool `json:"ethereal_pebble"`
		EtherealIdleSeconds int  `json:"ethereal_idle_seconds"`
		TelemetryEnabled    bool `json:"telemetry_enabled"`
	} `json:"prefs"`
}

func connStateString(s int32) string {
	switch s {
	case connConnected:
		return "connected"
	case connError:
		return "error"
	default:
		return "connecting"
	}
}

func (c *SidecarClient) runSettingsWindow() {
	runLocalWebview("JARVIS — Sidecar Settings", 520, 560, webview.HintNone, func(w webview.WebView) {

		// getState returns the live connection status + current preferences.
		_ = w.Bind("getState", func() settingsState {
			prefs := c.Preferences()
			var st settingsState
			st.Status = connStateString(c.ConnState())
			st.Prefs.StartAtStartup = prefs.StartAtStartup
			st.Prefs.EtherealPebble = prefs.EtherealPebble
			st.Prefs.EtherealIdleSeconds = prefs.EtherealIdleSeconds
			if st.Prefs.EtherealIdleSeconds <= 0 {
				st.Prefs.EtherealIdleSeconds = pebbleEtherealDefaultIdleSec
			}
			st.Prefs.TelemetryEnabled = c.TelemetryEnabled()
			return st
		})

		// saveToken validates + persists a new enrollment token. It applies on the
		// next reconnect attempt; a restart guarantees a clean reconnect.
		_ = w.Bind("saveToken", func(raw string) error {
			raw = trimToken(raw)
			if raw == "" {
				return fmt.Errorf("Paste a token to save.")
			}
			if _, err := DecodeJWTPayload(raw); err != nil {
				return fmt.Errorf("That doesn't look like a valid token. Copy the full token from the dashboard.")
			}
			if err := c.editConfig(func(cfg *SidecarConfig) { cfg.Token = raw }); err != nil {
				return fmt.Errorf("Could not save the token: %v", err)
			}
			log.Printf("[settings] enrollment token updated")
			return nil
		})

		// restartSidecar launches a fresh process and exits this one (so a new token
		// takes effect). The settings window offers it right after a token save.
		_ = w.Bind("restartSidecar", func() error {
			log.Printf("[settings] restart requested")
			return c.Restart()
		})

		// setPref persists a single preference toggle. For start_at_startup it also
		// registers/unregisters OS autostart; if that fails we don't save the toggle
		// so the checkbox reverts to the real state.
		_ = w.Bind("setPref", func(key string, enabled bool) error {
			switch key {
			case "start_at_startup":
				if err := platformSetAutoStart(enabled); err != nil {
					verb := "enable"
					if !enabled {
						verb = "disable"
					}
					return fmt.Errorf("Could not %s start-at-startup: %v", verb, err)
				}
				return c.editConfig(func(cfg *SidecarConfig) { cfg.Preferences.StartAtStartup = enabled })
			case "ethereal_pebble":
				if err := c.editConfig(func(cfg *SidecarConfig) { cfg.Preferences.EtherealPebble = enabled }); err != nil {
					return err
				}
				c.applyPebblePrefs()
				return nil
			case "telemetry_enabled":
				// Persist an explicit pointer so the choice is durable (and a future
				// config read can tell "off" from "unset/default-on"). The running
				// telemetry loop re-reads this each tick, so it takes effect live.
				b := enabled
				return c.editConfig(func(cfg *SidecarConfig) { cfg.Telemetry.Enabled = &b })
			default:
				return fmt.Errorf("unknown preference %q", key)
			}
		})

		// setEtherealIdle sets the idle timeout (seconds) before the pebble fades out.
		_ = w.Bind("setEtherealIdle", func(seconds int) error {
			if seconds < 1 {
				seconds = 1
			}
			if seconds > 3600 {
				seconds = 3600
			}
			if err := c.editConfig(func(cfg *SidecarConfig) { cfg.Preferences.EtherealIdleSeconds = seconds }); err != nil {
				return err
			}
			c.applyPebblePrefs()
			return nil
		})

		// The vendored webview creates the window hidden (no flash); reveal it once
		// the page has loaded.
		revealWebviewOnLoad(w)
		w.SetHtml(settingsWindowHTML)
	})
}

// trimToken strips surrounding whitespace from a pasted token.
func trimToken(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\n' || s[start] == '\r' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\n' || s[end-1] == '\r' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

const settingsWindowHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  /* Force the sidecar's own light theme regardless of the OS appearance:
     color-scheme: light keeps the engine from dark-rendering form controls /
     scrollbars, and there is no prefers-color-scheme override. */
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    background: #f5f2eb; color: #1a1a1a; padding: 22px; overflow-y: auto;
  }
  h1 { font-size: 18px; margin: 0 0 16px; }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em;
    opacity: 0.6; margin: 22px 0 8px;
  }
  .card {
    background: #fff; border: 1px solid #cbc3b2; border-radius: 10px;
    padding: 14px 16px; margin-bottom: 2px;
  }
  .status { display: flex; align-items: center; gap: 10px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #b9b3a6; flex: 0 0 auto; }
  .dot.connected { background: #2fae57; }
  .dot.connecting { background: #d2a23a; }
  .dot.error { background: #c23a2a; }
  .status-text { font-size: 14px; font-weight: 600; }
  label.field { font-size: 12px; font-weight: 600; display: block; margin-bottom: 6px; }
  textarea {
    width: 100%; height: 84px; resize: none; padding: 9px 11px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px;
    border: 1px solid #cbc3b2; border-radius: 8px; background: #fbf9f4; color: #1a1a1a; line-height: 1.4;
  }
  textarea:focus { outline: 2px solid #c23a2a; outline-offset: 1px; border-color: #c23a2a; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
  .msg { font-size: 12px; min-height: 16px; flex: 1; }
  .msg.ok { color: #2fae57; }
  .msg.err { color: #c23a2a; }
  button {
    appearance: none; border: 0; border-radius: 8px; padding: 9px 16px;
    background: #c23a2a; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #a83120; }
  button:disabled { opacity: 0.5; cursor: default; }
  .pref { display: flex; align-items: flex-start; gap: 10px; padding: 4px 0; }
  .pref + .pref { border-top: 1px solid rgba(128,128,128,0.18); margin-top: 6px; padding-top: 12px; }
  .pref input { margin-top: 2px; width: 16px; height: 16px; flex: 0 0 auto; }
  .pref .label { font-size: 14px; }
  .pref .hint { font-size: 12px; opacity: 0.7; margin-top: 2px; }
  #prefMsg { font-size: 12px; min-height: 16px; margin-top: 6px; }
  #prefMsg.err { color: #c23a2a; }
  .idlerow { display: flex; align-items: center; gap: 8px; padding: 12px 0 2px; margin-top: 8px; border-top: 1px solid rgba(128,128,128,0.18); font-size: 14px; }
  .idlerow .label { flex: 1; }
  .idlerow input { width: 60px; padding: 5px 8px; border: 1px solid #cbc3b2; border-radius: 6px; background: #fff; color: #1a1a1a; font-size: 13px; }
</style>
</head>
<body>
  <h1>Sidecar Settings</h1>

  <h2>Connection</h2>
  <div class="card">
    <div class="status">
      <span id="dot" class="dot"></span>
      <span id="statusText" class="status-text">Checking…</span>
    </div>
  </div>

  <h2>Enrollment token</h2>
  <div class="card">
    <label class="field" for="tok">Paste a new token to re-point this machine</label>
    <textarea id="tok" placeholder="eyJhbGciOiJFUzI1NiIs..." spellcheck="false"></textarea>
    <div class="row">
      <span id="tokMsg" class="msg"></span>
      <button id="saveTok" onclick="doSaveToken()">Save token</button>
    </div>
  </div>

  <h2>General</h2>
  <div class="card">
    <label class="pref">
      <input type="checkbox" id="start_at_startup" onchange="togglePref(this)">
      <span><span class="label">Start at system startup</span>
        <div class="hint">Launch the sidecar automatically when you log in.</div></span>
    </label>
  </div>

  <h2>Style</h2>
  <div class="card">
    <label class="pref">
      <input type="checkbox" id="ethereal_pebble" onchange="togglePref(this)">
      <span><span class="label">Ethereal pebble</span>
        <div class="hint">Fade the pebble out while it sits idle; it pops back in when Jarvis activates.</div></span>
    </label>
    <div class="idlerow" id="etherealIdleRow">
      <span class="label">Fade out after</span>
      <input type="number" id="ethereal_idle_seconds" min="1" max="3600" step="1" onchange="saveIdle(this)">
      <span>seconds idle</span>
    </div>
    <div id="prefMsg"></div>
  </div>

  <h2>Privacy</h2>
  <div class="card">
    <label class="pref">
      <input type="checkbox" id="telemetry_enabled" onchange="togglePref(this)">
      <span><span class="label">Send anonymous usage metrics</span>
        <div class="hint">A small anonymous ping (hashed machine id, version, OS, capabilities) at startup and hourly, so the project can measure usage. No personal data or screen content. On by default; turn off here anytime.</div></span>
    </label>
  </div>

<script>
  var dot = document.getElementById('dot');
  var statusText = document.getElementById('statusText');

  function paintStatus(s) {
    dot.className = 'dot ' + s;
    statusText.textContent = s === 'connected' ? 'Connected'
                           : s === 'error'     ? 'Connection error'
                                               : 'Connecting…';
  }

  async function pollStatus() {
    try { var st = await window.getState(); paintStatus(st.status); } catch (e) {}
  }

  function updateIdleRow() {
    var on = document.getElementById('ethereal_pebble').checked;
    var inp = document.getElementById('ethereal_idle_seconds');
    inp.disabled = !on;
    document.getElementById('etherealIdleRow').style.opacity = on ? '1' : '0.45';
  }

  async function saveIdle(el) {
    var msg = document.getElementById('prefMsg');
    msg.className = ''; msg.textContent = '';
    var v = parseInt(el.value, 10);
    if (isNaN(v) || v < 1) { v = 1; el.value = 1; }
    try { await window.setEtherealIdle(v); }
    catch (e) { msg.className = 'err'; msg.textContent = (e && e.message) ? e.message : String(e); }
  }

  async function init() {
    var st = await window.getState();
    paintStatus(st.status);
    document.getElementById('start_at_startup').checked = !!st.prefs.start_at_startup;
    document.getElementById('ethereal_pebble').checked = !!st.prefs.ethereal_pebble;
    document.getElementById('ethereal_idle_seconds').value = st.prefs.ethereal_idle_seconds || 5;
    document.getElementById('telemetry_enabled').checked = !!st.prefs.telemetry_enabled;
    updateIdleRow();
    // Typing a new token after a save reverts the button from Restart to Save.
    document.getElementById('tok').addEventListener('input', resetTokenButton);
    setInterval(pollStatus, 2000);
  }

  function resetTokenButton() {
    var btn = document.getElementById('saveTok');
    if (btn.textContent !== 'Save token') {
      btn.textContent = 'Save token';
      btn.onclick = doSaveToken;
    }
    btn.disabled = false;
  }

  async function doRestart() {
    var btn = document.getElementById('saveTok');
    var msg = document.getElementById('tokMsg');
    btn.disabled = true;
    msg.className = 'msg'; msg.textContent = '';
    try {
      await window.restartSidecar();
      msg.className = 'msg ok';
      msg.textContent = 'Restarting Jarvis…';
    } catch (e) {
      btn.disabled = false;
      msg.className = 'msg err';
      msg.textContent = (e && e.message) ? e.message : String(e);
    }
  }

  // Note: the JS handler must NOT be named the same as the Go binding
  // (window.saveToken) — a same-named top-level function shadows the binding.
  async function doSaveToken() {
    var btn = document.getElementById('saveTok');
    var msg = document.getElementById('tokMsg');
    var tok = document.getElementById('tok');
    msg.className = 'msg'; msg.textContent = '';
    btn.disabled = true;
    try {
      await window.saveToken(tok.value);
      msg.className = 'msg ok';
      msg.textContent = 'Saved — restart to reconnect with the new token.';
      tok.value = '';
      // Morph Save -> Restart for a one-click apply.
      btn.textContent = 'Restart Jarvis';
      btn.onclick = doRestart;
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = (e && e.message) ? e.message : String(e);
    }
    btn.disabled = false;
  }

  async function togglePref(el) {
    var msg = document.getElementById('prefMsg');
    msg.className = ''; msg.textContent = '';
    var desired = el.checked;
    try {
      await window.setPref(el.id, desired);
    } catch (e) {
      el.checked = !desired; // revert on failure
      msg.className = 'err';
      msg.textContent = (e && e.message) ? e.message : String(e);
    }
    updateIdleRow();
  }

  init();
</script>
</body>
</html>`
