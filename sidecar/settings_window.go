package main

// Local sidecar settings window — a small webview that shows connection status,
// lets the user change the enrollment token, and edit sidecar preferences.
// Entirely local: it is NOT a dashboard room and never talks to the brain
// (the old "Settings" entry opened the remote settings room). Mirrors the log
// viewer pattern; UI is local HTML in the shared Monochrome Lab brand
// (brand_css.go).

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"

	webview "github.com/webview/webview_go"

	"github.com/jarvis/sidecar/internal/winchrome"
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
		StartAtStartup         bool `json:"start_at_startup"`
		OpenDashboardAtStartup bool `json:"open_dashboard_at_startup"`
		EtherealPebble         bool `json:"ethereal_pebble"`
		EtherealIdleSeconds    int  `json:"ethereal_idle_seconds"`
		TelemetryEnabled       bool `json:"telemetry_enabled"`
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
	runLocalWebview("JARVIS — Sidecar Settings", 520, 560, webview.HintNone, winchrome.CustomTitleBar, func(w webview.WebView) func() {
		// Lifecycle plumbing for the async token check (bindings run on the
		// webview main thread, so the network probe must not run inline —
		// it would freeze the window for up to the probe timeout).
		// verifyCtx aborts an in-flight probe when the window closes; the
		// returned cleanup joins the goroutine before the engine is freed;
		// torndown stops its Dispatch closure from touching a dead document.
		verifyCtx, verifyCancel := context.WithCancel(context.Background())
		var verifyWG sync.WaitGroup
		var torndown atomic.Bool
		var checkInFlight atomic.Bool

		// getState returns the live connection status + current preferences.
		_ = w.Bind("getState", func() settingsState {
			prefs := c.Preferences()
			var st settingsState
			st.Status = connStateString(c.ConnState())
			st.Prefs.StartAtStartup = prefs.StartAtStartup
			st.Prefs.OpenDashboardAtStartup = prefs.OpenDashboardAtStartup
			st.Prefs.EtherealPebble = prefs.EtherealPebble
			st.Prefs.EtherealIdleSeconds = prefs.EtherealIdleSeconds
			if st.Prefs.EtherealIdleSeconds <= 0 {
				st.Prefs.EtherealIdleSeconds = pebbleEtherealDefaultIdleSec
			}
			st.Prefs.TelemetryEnabled = c.TelemetryEnabled()
			return st
		})

		// saveToken checks + persists a new enrollment token. A malformed paste
		// rejects the promise immediately; a well-formed one resolves it with
		// the brain check STARTED (the page shows "checking") and the verdict —
		// saved, or why not — lands async via window.__tokenVerdict. Only a
		// token the brain accepted is written to the config; it applies on the
		// next reconnect attempt, and a restart guarantees a clean reconnect.
		_ = w.Bind("saveToken", func(raw string) error {
			raw = trimToken(raw)
			if raw == "" {
				return fmt.Errorf("Paste a token to save.")
			}
			if _, err := DecodeJWTPayload(raw); err != nil {
				return fmt.Errorf("That doesn't look like a valid token. Copy the full token printed by 'jarvis enroll'.")
			}
			if !checkInFlight.CompareAndSwap(false, true) {
				return fmt.Errorf("A token check is already running.")
			}
			verifyWG.Add(1)
			go func() {
				defer verifyWG.Done()
				defer checkInFlight.Store(false)
				verr := verifyBrainToken(verifyCtx, raw, c.BrainOverride())
				if verr == nil {
					if err := c.editConfig(func(cfg *SidecarConfig) { cfg.Token = raw }); err != nil {
						verr = fmt.Errorf("Could not save the token: %v", err)
					} else {
						log.Printf("[settings] enrollment token verified with the brain and updated")
					}
				}
				if errors.Is(verr, context.Canceled) {
					return // window closed mid-check; no document to report to
				}
				msg := ""
				if verr != nil {
					msg = verr.Error()
				}
				w.Dispatch(func() {
					if torndown.Load() {
						return
					}
					w.Eval("window.__tokenVerdict && window.__tokenVerdict('" + jsEscape(msg) + "')")
				})
			}()
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
			case "open_dashboard_at_startup":
				// Read once per launch (shouldOpenDashboardAtStartup), so there
				// is no live state to apply here — just persist the choice.
				return c.editConfig(func(cfg *SidecarConfig) { cfg.Preferences.OpenDashboardAtStartup = enabled })
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

		w.SetHtml(settingsWindowHTML)
		return func() {
			torndown.Store(true)
			verifyCancel()
			verifyWG.Wait()
		}
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
<title>JARVIS — Sidecar Settings</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>` + brandTokensCSS + `
  /* Monochrome Lab (Brand Book III) — sidecar settings, shared tokens from
     brand_css.go (dark follows the OS); row grammar from the room-13 settings
     design: label + consequence left, control right, inside raised panels
     with the asymmetric corner. */
  html, body { height: 100%; }
  /* No padding on body: the strip's offset would replace it, not add to it,
     leaving the first element flush against the bar. The padding lives on
     .pagebody, which is also the scroll container so its scrollbar starts
     below the strip — and which PageBodyJS keeps scrollable by keyboard. */
  body { padding: 0; overflow: hidden; font-size: 13px; }
  .pagebody { height: 100%; overflow-y: auto; padding: 24px 22px 28px; }
  h1 { font-size: 19px; font-weight: 650; letter-spacing: -.01em; margin: 0 0 3px; }
  .sub { font-size: 12px; color: var(--ink3); margin: 0 0 18px; }
  .sec { font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink3); margin: 20px 4px 8px; }
  .panel { background: var(--raise); border: 1px solid var(--rule); border-radius: var(--corner); box-shadow: var(--sh-sm); overflow: hidden; }
  .panel.pad { padding: 14px 16px; }
  /* row grammar */
  .srow { display: flex; align-items: center; gap: 14px; padding: 13px 16px; border-bottom: 1px solid var(--rule2); }
  .srow:last-child { border-bottom: none; }
  .sl7 { flex: 1; min-width: 0; }
  .sl7 .a { font-size: 13px; font-weight: 600; color: var(--ink); }
  .sl7 .b { font-size: 11px; color: var(--ink3); margin-top: 3px; line-height: 1.5; }
  .sv7 { flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
  /* status dot with state-hue halo */
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); flex: 0 0 auto; box-shadow: 0 0 0 3px color-mix(in srgb, var(--faint) 16%, transparent); }
  .dot.connected { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 20%, transparent); }
  .dot.connecting { background: var(--hold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--hold) 20%, transparent); }
  .dot.error { background: var(--listen); box-shadow: 0 0 0 3px color-mix(in srgb, var(--listen) 20%, transparent); }
  .status-text { font-size: 13.5px; font-weight: 600; }
  /* toggle switch */
  .sw { position: relative; display: inline-block; width: 38px; height: 22px; flex: 0 0 auto; cursor: pointer; }
  .sw input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .sw .track { position: absolute; inset: 0; background: var(--panel); border: 1px solid var(--rule); border-radius: 999px; transition: background .16s var(--ease), border-color .16s; }
  .sw .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--raise); box-shadow: var(--sh-sm); transition: transform .16s var(--ease); }
  .sw input:checked + .track { background: var(--ink); border-color: var(--ink); }
  .sw input:checked + .track::after { transform: translateX(16px); }
  /* token field */
  .field { font-size: 11px; font-weight: 600; color: var(--ink2); display: block; margin-bottom: 7px; }
  textarea { width: 100%; height: 80px; resize: none; padding: 10px 12px; font-family: var(--mono); font-size: 11.5px; line-height: 1.5; border: 1px solid var(--rule); border-radius: var(--corner-sm); background: var(--panel2); color: var(--ink); outline: none; transition: border-color .12s, box-shadow .12s, background .12s; }
  textarea::placeholder { color: var(--faint); }
  textarea:focus { border-color: var(--speak); background: var(--raise); box-shadow: 0 0 0 3px rgba(45,120,255,.14); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 11px; }
  .msg { font-size: 11.5px; min-height: 16px; flex: 1; color: var(--ink3); }
  .msg.ok { color: var(--ok-tx); }
  .msg.err { color: var(--listen-tx); }
  /* buttons */
  .sbtn { appearance: none; font-family: var(--sans); font-size: 12px; font-weight: 600; padding: 7px 14px; border-radius: var(--corner-sm); border: 1px solid var(--rule); color: var(--ink); background: var(--raise); cursor: pointer; transition: background .12s, border-color .12s; }
  .sbtn:hover { background: var(--panel); border-color: var(--rule-hi); }
  .sbtn.pri { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  .sbtn.pri:hover { filter: brightness(1.08); }
  .sbtn:disabled { opacity: .5; cursor: default; }
  /* number input */
  .num { width: 62px; padding: 6px 9px; border: 1px solid var(--rule); border-radius: var(--corner-sm); background: var(--panel2); color: var(--ink); font-family: var(--mono); font-size: 12px; outline: none; text-align: center; }
  .num:focus { border-color: var(--speak); background: var(--raise); box-shadow: 0 0 0 3px rgba(45,120,255,.14); }
  .unit { font-size: 12px; color: var(--ink3); }
  #prefMsg { font-size: 11.5px; min-height: 16px; padding: 2px 16px 12px; color: var(--ink3); }
  #prefMsg.err { color: var(--listen-tx); }
` + brandTitlebarCSS + `
</style>
</head>
<body>
<div class="pagebody" tabindex="-1">
  <h1>Sidecar Settings</h1>
  <p class="sub">Connection, enrollment, and how the pebble behaves on this machine.</p>

  <div class="sec">Connection</div>
  <div class="panel">
    <div class="srow">
      <div class="sl7"><div class="a">Brain connection</div><div class="b">Live status of this machine's link to Jarvis.</div></div>
      <div class="sv7"><span id="dot" class="dot"></span><span id="statusText" class="status-text">Checking…</span></div>
    </div>
  </div>

  <div class="sec">Enrollment token</div>
  <div class="panel pad">
    <label class="field" for="tok">Paste a new token to re-point this machine</label>
    <textarea id="tok" placeholder="eyJhbGciOiJFUzI1NiIs…" spellcheck="false"></textarea>
    <div class="row">
      <span id="tokMsg" class="msg"></span>
      <button id="saveTok" class="sbtn pri" onclick="doSaveToken()">Save token</button>
    </div>
  </div>

  <div class="sec">General</div>
  <div class="panel">
    <div class="srow">
      <div class="sl7"><div class="a">Start at system startup</div><div class="b">Launch the sidecar automatically when you log in.</div></div>
      <div class="sv7"><label class="sw"><input type="checkbox" id="start_at_startup" onchange="togglePref(this)"><span class="track"></span></label></div>
    </div>
    <div class="srow">
      <div class="sl7"><div class="a">Open dashboard at startup</div><div class="b">Show the full Jarvis window every time the sidecar starts, not just the pebble.</div></div>
      <div class="sv7"><label class="sw"><input type="checkbox" id="open_dashboard_at_startup" onchange="togglePref(this)"><span class="track"></span></label></div>
    </div>
  </div>

  <div class="sec">Style</div>
  <div class="panel">
    <div class="srow">
      <div class="sl7"><div class="a">Ethereal pebble</div><div class="b">Fade the pebble out while it sits idle; it pops back in when Jarvis activates.</div></div>
      <div class="sv7"><label class="sw"><input type="checkbox" id="ethereal_pebble" onchange="togglePref(this)"><span class="track"></span></label></div>
    </div>
    <div class="srow" id="etherealIdleRow">
      <div class="sl7"><div class="a">Fade out after</div></div>
      <div class="sv7"><input class="num" type="number" id="ethereal_idle_seconds" min="1" max="3600" step="1" onchange="saveIdle(this)"><span class="unit">seconds idle</span></div>
    </div>
    <div id="prefMsg"></div>
  </div>

  <div class="sec">Privacy</div>
  <div class="panel">
    <div class="srow">
      <div class="sl7"><div class="a">Send anonymous usage metrics</div><div class="b">A small anonymous ping (hashed machine id, version, OS, capabilities) at startup and hourly, so the project can measure usage. No personal data or screen content. On by default; turn off here anytime.</div></div>
      <div class="sv7"><label class="sw"><input type="checkbox" id="telemetry_enabled" onchange="togglePref(this)"><span class="track"></span></label></div>
    </div>
  </div>

</div>` + brandTitlebarHTML + `
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
    document.getElementById('open_dashboard_at_startup').checked = !!st.prefs.open_dashboard_at_startup;
    document.getElementById('ethereal_pebble').checked = !!st.prefs.ethereal_pebble;
    document.getElementById('ethereal_idle_seconds').value = st.prefs.ethereal_idle_seconds || 5;
    document.getElementById('telemetry_enabled').checked = !!st.prefs.telemetry_enabled;
    updateIdleRow();
    // Typing a new token after a save reverts the button from Restart to Save.
    document.getElementById('tok').addEventListener('input', resetTokenButton);
    setInterval(pollStatus, 2000);
  }

  // True from Save-click until the async verdict lands; suppresses the
  // input-driven button reset so typing during a check can't re-enable Save,
  // and remembers what was submitted so the verdict never wipes newer input.
  var tokenChecking = false;
  var submittedTok = '';

  function resetTokenButton() {
    if (tokenChecking) return;
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
  // The promise resolving means the brain check STARTED; the verdict (saved,
  // or why not) arrives async via __tokenVerdict below.
  async function doSaveToken() {
    var btn = document.getElementById('saveTok');
    var msg = document.getElementById('tokMsg');
    var tok = document.getElementById('tok');
    msg.className = 'msg'; msg.textContent = '';
    btn.disabled = true;
    tokenChecking = true;
    submittedTok = tok.value;
    try {
      await window.saveToken(tok.value);
      msg.textContent = 'Checking the token with your brain…';
    } catch (e) {
      tokenChecking = false;
      msg.className = 'msg err';
      msg.textContent = (e && e.message) ? e.message : String(e);
      btn.disabled = false;
    }
  }

  window.__tokenVerdict = function (errMsg) {
    var btn = document.getElementById('saveTok');
    var msg = document.getElementById('tokMsg');
    var tok = document.getElementById('tok');
    tokenChecking = false;
    btn.disabled = false;
    if (errMsg) {
      msg.className = 'msg err';
      msg.textContent = errMsg;
      return;
    }
    msg.className = 'msg ok';
    msg.textContent = 'Saved — restart to reconnect with the new token.';
    // Only clear what was actually saved — never a newer token typed while
    // the check was running.
    if (tok.value === submittedTok) tok.value = '';
    // Morph Save -> Restart for a one-click apply.
    btn.textContent = 'Restart Jarvis';
    btn.onclick = doRestart;
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
` + brandTitlebarJS + brandPageBodyJS + `
</script>
</body>
</html>`
