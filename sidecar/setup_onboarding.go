package main

// First-launch onboarding wizard (`jarvis --setup`), launched by the installer
// right after it places the app. Walks the user through the OS permissions the
// sidecar needs and the start-at-login choice, then hands back to the normal
// startup path (main.go re-execs via restartAfterSetup).
//
// Runs pre-tray on the process's own UI loop via webviewui.RunWindow — the
// same constraint as the hosted first-run window. The permission checks and
// requests live in setup_permissions_{darwin,other}.go; on macOS the grants
// bind to THIS bundle's identity, which is exactly why the installer defers
// to us instead of prompting itself.

import (
	"log"
	"os"
	"sync"
	"time"

	webview "github.com/webview/webview_go"

	"github.com/jarvis/sidecar/internal/autostart"
	"github.com/jarvis/sidecar/internal/webviewui"
)

// setupPermState is the wizard's poll snapshot (JSON via webview binding).
// Row values: "granted" | "denied" | "undetermined" | "na" (row hidden).
type setupPermState struct {
	Platform      string `json:"platform"`
	Notifications string `json:"notifications"`
	Microphone    string `json:"microphone"`
	Screen        string `json:"screen"`
	Accessibility string `json:"accessibility"`
	Autostart     bool   `json:"autostart"`
}

// runOnboarding blocks until the wizard window closes. Autostart is applied
// once, on Finish, so half-completed wizards leave no registration behind.
func runOnboarding(cfg *SidecarConfig) {
	log.Println("[setup] running first-launch onboarding...")

	// Permission statuses are sampled on a background goroutine into this
	// snapshot. Webview bindings run ON the UI thread, and reading TCC state
	// can block (the notification-settings read waits on a callback), so
	// polling it inline would freeze the very window it feeds.
	var (
		permMu   sync.Mutex
		permSnap setupPermState
	)
	permSnap.Platform = setupPlatform
	permSnap.Autostart = cfg.Preferences.StartAtStartup
	samplePermissions := func() {
		n, m, s, a := setupPermissionStatuses()
		permMu.Lock()
		permSnap.Notifications, permSnap.Microphone, permSnap.Screen, permSnap.Accessibility = n, m, s, a
		permMu.Unlock()
	}
	samplePermissions()

	stopSampling := make(chan struct{})
	defer close(stopSampling)
	go func() {
		t := time.NewTicker(1200 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-stopSampling:
				return
			case <-t.C:
				samplePermissions()
			}
		}
	}()

	if !webviewui.RunWindow("Welcome to JARVIS", 520, 620, webview.HintNone, func(w webview.WebView) {

		_ = w.Bind("getPermissions", func() setupPermState {
			permMu.Lock()
			defer permMu.Unlock()
			return permSnap
		})

		// requestPermission triggers the OS prompt (async); the page's poll
		// flips the row green when the user grants. Off-thread for the same
		// reason as the sampler above.
		_ = w.Bind("requestPermission", func(name string) {
			go func() {
				setupRequestPermission(name)
				samplePermissions()
			}()
		})

		_ = w.Bind("openPane", func(name string) error {
			return setupOpenPane(name)
		})

		// finishSetup applies the autostart choice and closes the wizard.
		// Registration failure keeps the window open so the user sees why.
		_ = w.Bind("finishSetup", func(autostartOn bool) error {
			if autostartOn {
				exe, err := os.Executable()
				if err != nil {
					return err
				}
				if err := autostart.Set(exe, true); err != nil {
					return err
				}
			} else {
				if err := autostart.Set("", false); err != nil {
					return err
				}
			}
			if err := saveConfigMutation(cfg, func(c *SidecarConfig) { c.Preferences.StartAtStartup = autostartOn }); err != nil {
				return err
			}
			permMu.Lock()
			permSnap.Autostart = autostartOn
			permMu.Unlock()
			log.Printf("[setup] onboarding finished (autostart=%v)", autostartOn)
			w.Dispatch(w.Terminate)
			return nil
		})

		w.SetHtml(onboardingWindowHTML)
	}) {
		// Onboarding is a convenience, not a gate: if no window can be shown the
		// sidecar must still start. Permissions are then requested lazily on
		// first use, as they were before --setup existed.
		log.Println("[setup] no window available — skipping onboarding and starting normally")
	}
}

// saveConfigMutation applies fn to cfg and persists it. The wizard runs before
// a SidecarClient exists, so it can't use client.editConfig.
func saveConfigMutation(cfg *SidecarConfig, fn func(*SidecarConfig)) error {
	fn(cfg)
	return SaveConfig(cfg)
}

const onboardingWindowHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>` + brandTokensCSS + brandPebbleCSS + `
  html, body { height: 100%; }
  body { padding: 26px 22px 24px; overflow-y: auto; font-size: 13px; }
  .hero { display: flex; align-items: center; gap: 14px; margin-bottom: 4px; }
  .hero .bdrop { width: 34px; height: 34px; flex: 0 0 auto; }
  h1 { font-size: 19px; font-weight: 650; letter-spacing: -.01em; margin: 0; }
  .sub { font-size: 12px; color: var(--ink3); margin: 6px 0 18px; line-height: 1.5; }
  .sec { font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink3); margin: 18px 4px 8px; }
  .panel { background: var(--raise); border: 1px solid var(--rule); border-radius: var(--corner); box-shadow: var(--sh-sm); overflow: hidden; }
  .srow { display: flex; align-items: center; gap: 14px; padding: 13px 16px; border-bottom: 1px solid var(--rule2); }
  .srow:last-child { border-bottom: none; }
  .srow.hidden { display: none; }
  .sl7 { flex: 1; min-width: 0; }
  .sl7 .a { font-size: 13px; font-weight: 600; color: var(--ink); }
  .sl7 .b { font-size: 11px; color: var(--ink3); margin-top: 3px; line-height: 1.5; }
  .sv7 { flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); flex: 0 0 auto; box-shadow: 0 0 0 3px color-mix(in srgb, var(--faint) 16%, transparent); }
  .dot.granted { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 20%, transparent); }
  .dot.denied { background: var(--listen); box-shadow: 0 0 0 3px color-mix(in srgb, var(--listen) 20%, transparent); }
  .dot.undetermined { background: var(--hold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--hold) 20%, transparent); }
  .sbtn { appearance: none; font-family: var(--sans); font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: var(--corner-sm); border: 1px solid var(--rule); color: var(--ink); background: var(--raise); cursor: pointer; transition: background .12s, border-color .12s; }
  .sbtn:hover { background: var(--panel); border-color: var(--rule-hi); }
  .sbtn.pri { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  .sbtn.pri:hover { filter: brightness(1.08); }
  .sw { position: relative; display: inline-block; width: 38px; height: 22px; flex: 0 0 auto; cursor: pointer; }
  .sw input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .sw .track { position: absolute; inset: 0; background: var(--panel); border: 1px solid var(--rule); border-radius: 999px; transition: background .16s var(--ease), border-color .16s; }
  .sw .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--raise); box-shadow: var(--sh-sm); transition: transform .16s var(--ease); }
  .sw input:checked + .track { background: var(--ink); border-color: var(--ink); }
  .sw input:checked + .track::after { transform: translateX(16px); }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 20px; }
  .msg { font-size: 11.5px; min-height: 16px; flex: 1; color: var(--ink3); }
  .msg.err { color: var(--listen-tx); }
</style>
</head>
<body>
  <div class="hero">
    <span class="bdrop" id="pebble"><span class="in"></span><span class="ring"></span></span>
    <h1>Welcome to <span class="word"><span class="u">use</span>jarvis</span></h1>
  </div>
  <p class="sub" id="intro">Jarvis needs a few permissions to see, hear, and notify on this machine. Grant each one below — rows turn green as you go. You can change any of this later in System Settings.</p>

  <div class="sec" id="permSec">Permissions</div>
  <div class="panel" id="permPanel">
    <div class="srow" id="row-notifications">
      <div class="sl7"><div class="a">Notifications</div><div class="b">Alerts from Jarvis when something needs you.</div></div>
      <div class="sv7"><span class="dot" data-dot="notifications"></span><button class="sbtn" onclick="grant('notifications')">Allow</button></div>
    </div>
    <div class="srow" id="row-microphone">
      <div class="sl7"><div class="a">Microphone</div><div class="b">Voice commands and the wake word.</div></div>
      <div class="sv7"><span class="dot" data-dot="microphone"></span><button class="sbtn" onclick="grant('microphone')">Allow</button></div>
    </div>
    <div class="srow" id="row-screen">
      <div class="sl7"><div class="a">Screen Recording</div><div class="b">Ambient screen awareness. macOS opens a toggle in System Settings — flip it on for Jarvis.</div></div>
      <div class="sv7"><span class="dot" data-dot="screen"></span><button class="sbtn" onclick="grantViaPane('screen')">Open Settings</button></div>
    </div>
    <div class="srow" id="row-accessibility">
      <div class="sl7"><div class="a">Accessibility</div><div class="b">Global hotkeys (Ctrl+Space). Grant Jarvis in the Accessibility list.</div></div>
      <div class="sv7"><span class="dot" data-dot="accessibility"></span><button class="sbtn" onclick="grantViaPane('accessibility')">Open Settings</button></div>
    </div>
  </div>

  <div class="sec">Startup</div>
  <div class="panel">
    <div class="srow">
      <div class="sl7"><div class="a">Start at login</div><div class="b">Launch the sidecar automatically when you log in — Jarvis only helps while it's running.</div></div>
      <div class="sv7"><label class="sw"><input type="checkbox" id="autostart" checked><span class="track"></span></label></div>
    </div>
  </div>

  <div class="foot">
    <span id="msg" class="msg"></span>
    <button class="sbtn pri" id="finishBtn" onclick="finish()">Finish setup</button>
  </div>

<script>
  var rows = ['notifications', 'microphone', 'screen', 'accessibility'];

  function paint(st) {
    var anyVisible = false;
    rows.forEach(function (name) {
      var row = document.getElementById('row-' + name);
      var v = st[name];
      if (v === 'na') { row.classList.add('hidden'); return; }
      anyVisible = true;
      row.classList.remove('hidden');
      var dot = row.querySelector('[data-dot]');
      dot.className = 'dot ' + v;
      var btn = row.querySelector('button');
      btn.style.visibility = (v === 'granted') ? 'hidden' : 'visible';
    });
    if (!anyVisible) {
      document.getElementById('permSec').style.display = 'none';
      document.getElementById('permPanel').style.display = 'none';
      document.getElementById('intro').textContent =
        'One choice and you are done — Windows and Linux ask for permissions the first time Jarvis needs them.';
    }
    document.getElementById('pebble').className =
      'bdrop' + (rows.every(function (n) { return st[n] === 'granted' || st[n] === 'na'; }) ? ' s-done' : '');
  }

  async function poll() {
    try { paint(await window.getPermissions()); } catch (e) {}
  }

  async function grant(name) {
    try { await window.requestPermission(name); } catch (e) {}
    setTimeout(poll, 400);
  }

  // Screen Recording / Accessibility have no grant dialog: register with the
  // OS (so Jarvis appears in the pane's list), then open that pane.
  async function grantViaPane(name) {
    try { await window.requestPermission(name); } catch (e) {}
    try { await window.openPane(name); } catch (e) {}
  }

  async function init() {
    var st = await window.getPermissions();
    document.getElementById('autostart').checked = true; // default on; wizard applies on Finish
    paint(st);
    setInterval(poll, 1500);
  }

  async function finish() {
    var btn = document.getElementById('finishBtn');
    var msg = document.getElementById('msg');
    msg.className = 'msg'; msg.textContent = '';
    btn.disabled = true;
    try {
      await window.finishSetup(document.getElementById('autostart').checked);
    } catch (e) {
      btn.disabled = false;
      msg.className = 'msg err';
      msg.textContent = (e && e.message) ? e.message : String(e);
    }
  }

  init();
</script>
</body>
</html>`
