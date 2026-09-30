package main

// The update prompt: a small local window offering the sidecar update the
// brain advertised. The same window serves every entry point: the startup
// offer (onFirstUpdateOffer), the tray's Update item and the dashboard hint
// (the sidecar.update_prompt RPC). It follows the install through its
// phases, so a failure is explained where the user clicked. Windows and macOS
// only: Linux has no local-window runner under the shared GTK loop, and its
// dashboard installs the update directly instead.

import (
	"encoding/json"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	webview "github.com/webview/webview_go"

	"github.com/jarvis/sidecar/internal/winchrome"
)

var (
	// updateWindowOpen guards against a second prompt: a later open focuses
	// the existing window instead.
	updateWindowOpen atomic.Bool
	// updateWindowMu guards updateWindowWV and updateWindowTorndown, and is
	// held across every Dispatch to the window: the window's cleanup takes it
	// too, so it is the join point runLocalWebview requires (on Windows the
	// engine is destroyed right after cleanup, and a Dispatch that had already
	// read the pointer would land on freed memory).
	updateWindowMu       sync.Mutex
	updateWindowWV       webview.WebView
	updateWindowTorndown bool
)

// updatePromptSupported reports whether this platform shows the prompt.
func updatePromptSupported() bool {
	return runtime.GOOS == "windows" || runtime.GOOS == "darwin"
}

// updateWindowView is the JSON the page renders from.
type updateWindowView struct {
	Version string `json:"version"`
	Current string `json:"current"`
	Blocked bool   `json:"blocked"`
	Phase   string `json:"phase"`
	Error   string `json:"error"`
	Manual  string `json:"manual"`
	// CanApply is false when this install cannot update itself (manual
	// mode): the page then shows the command instead of "Update now".
	CanApply bool `json:"canApply"`
}

func (c *SidecarClient) updateView() updateWindowView {
	return updateViewOf(c.updater.Offer(), c.updater.canApply(), c.updater.ManualCommand)
}

// updateViewOf builds the page's view from an offer (pure, for the tests).
func updateViewOf(o UpdateOffer, canApply bool, manual func(version string) string) updateWindowView {
	v := updateWindowView{
		Version:  o.Version,
		Current:  o.Current,
		Blocked:  o.Blocked,
		Phase:    o.State.Phase,
		Error:    o.State.Error,
		Manual:   o.State.ManualCommand,
		CanApply: canApply,
	}
	if v.Version == "" && v.Phase == updatePhaseUnavailable {
		// Not published yet: the version is only known from the state.
		v.Version = o.State.Version
	}
	if v.Manual == "" && (!canApply || o.Version == "" || v.Phase == updatePhaseUnavailable) {
		// Nothing this sidecar can install right now: the page still needs
		// something to offer.
		v.Manual = manual(v.Version)
	}
	return v
}

// openUpdatePrompt shows the prompt, or focuses it when it is already open.
func (c *SidecarClient) openUpdatePrompt() {
	if !updateWindowOpen.CompareAndSwap(false, true) {
		focusUpdateWindow()
		return
	}
	go func() {
		defer updateWindowOpen.Store(false)
		// On macOS the window must not be created before the tray owns the
		// Cocoa run loop (tray_darwin.go); the startup offer can race it. If
		// the tray never comes up, skip the window rather than risk it: the
		// tray item and the dashboard still offer the update.
		if !waitTrayReady(15 * time.Second) {
			log.Printf("[update] the tray is not ready; not opening the update prompt")
			return
		}
		c.runUpdateWindow()
	}()
}

// focusUpdateWindow brings an open prompt forward. A request that arrives
// before the window has published itself (it is still being created) is
// dropped: the window is about to appear anyway.
func focusUpdateWindow() {
	updateWindowMu.Lock()
	defer updateWindowMu.Unlock()
	w := updateWindowWV
	if w == nil || updateWindowTorndown {
		return
	}
	w.Dispatch(func() {
		if h := w.Window(); h != nil {
			_ = platformFocusWindow(h)
		}
	})
}

// pushUpdateWindow re-renders an open prompt after the offer changed (a
// phase of the install, a failure). The view is read when the dispatched
// closure runs, not when it is queued, so pushes from different goroutines
// can never render an older state last.
func (c *SidecarClient) pushUpdateWindow() {
	updateWindowMu.Lock()
	defer updateWindowMu.Unlock()
	w := updateWindowWV
	if w == nil || updateWindowTorndown {
		return
	}
	w.Dispatch(func() {
		b, _ := json.Marshal(c.updateView())
		w.Eval("window.__update && window.__update(" + string(b) + ")")
	})
}

func (c *SidecarClient) runUpdateWindow() {
	runLocalWebview("JARVIS — Update", 460, 330, webview.HintFixed, winchrome.CustomTitleBar, func(w webview.WebView) func() {
		updateWindowMu.Lock()
		updateWindowWV, updateWindowTorndown = w, false
		updateWindowMu.Unlock()

		// Bindings run on the window's UI thread: nothing here may block.
		_ = w.Bind("updateState", func() updateWindowView { return c.updateView() })
		_ = w.Bind("updateReady", func() {
			// Called by the page just after the reveal-on-load (it waits for
			// the same load event, and longer): an unprompted window
			// (startup, dashboard) otherwise opens behind whatever the user
			// is in. Earlier would show the window before its first paint.
			if h := w.Window(); h != nil {
				_ = platformFocusWindow(h)
			}
		})
		_ = w.Bind("updateNow", func() error {
			return c.updater.Start("")
		})
		_ = w.Bind("updateSkip", func(version string) {
			go c.skipUpdateVersion(version)
			closeLocalWindow(w)
		})
		_ = w.Bind("updateClose", func() { closeLocalWindow(w) })
		_ = w.Bind("updateQuit", func() {
			log.Printf("[update] quit requested from the update prompt")
			closeLocalWindow(w)
			if c.shutdown != nil {
				go c.shutdown()
			}
		})

		w.SetHtml(updateWindowHTML)
		// The join: once this returns, no push or focus can reach w. (On
		// macOS it runs after the close, and a Dispatch queued before it is
		// harmless: the engine is leaked there and its window already nil.)
		return func() {
			updateWindowMu.Lock()
			updateWindowTorndown = true
			if updateWindowWV == w {
				updateWindowWV = nil
			}
			updateWindowMu.Unlock()
		}
	})
}

// updateWindowHTML is the prompt, Monochrome Lab like the other local pages.
// window.__update(view) re-renders it; the Go bindings are updateState,
// updateReady, updateNow, updateSkip(version), updateClose and updateQuit.
const updateWindowHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>JARVIS — Update</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>` + brandTokensCSS + `
  html, body { height: 100%; }
  body { padding: 0; overflow: hidden; }
  .pagebody {
    height: 100%; overflow-y: auto;
    display: flex; flex-direction: column; padding: 22px 24px 20px;
  }
  .eyebrow {
    font-family: var(--mono); font-size: 10px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--ink3); margin-bottom: 9px;
  }
  .eyebrow.warn { color: var(--listen-tx); }
  h1 { font-size: 18px; font-weight: 700; letter-spacing: -.02em; margin: 0 0 6px; }
  .sub { font-size: 12.5px; color: var(--ink3); margin: 0; line-height: 1.55; }
  .sub b { color: var(--ink2); font-weight: 600; font-family: var(--mono); font-size: 12px; }
  .status { margin-top: 14px; font-size: 12.5px; color: var(--ink2); min-height: 18px; line-height: 1.5; }
  .status.err { color: var(--listen-tx); }
  .manual { display: none; margin-top: 12px; }
  .manual.on { display: block; }
  .manual h2 { font-size: 11px; font-weight: 600; color: var(--ink2); margin: 0 0 6px; }
  .cmd { display: flex; gap: 8px; align-items: stretch; }
  .cmd code {
    flex: 1; min-width: 0; padding: 8px 10px; border-radius: var(--corner-sm);
    border: 1px solid var(--rule); background: var(--panel2); color: var(--ink);
    font-family: var(--mono); font-size: 11.5px; line-height: 1.45;
    overflow-wrap: anywhere; user-select: all; -webkit-user-select: all;
  }
  .spacer { flex: 1; }
  .row { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  button {
    appearance: none; height: 36px; padding: 0 15px; border: 1px solid var(--rule);
    border-radius: var(--corner-sm); font-family: var(--sans); font-size: 13px;
    font-weight: 600; cursor: pointer; background: var(--raise); color: var(--ink2);
    transition: background .12s, border-color .12s, color .12s, filter .15s var(--ease);
  }
  button:not(:disabled):hover { background: var(--panel); color: var(--ink); border-color: var(--rule-hi); }
  button.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  button.primary:not(:disabled):hover { background: var(--ink); color: var(--bg); filter: brightness(1.08); }
  button.link { border-color: transparent; background: transparent; color: var(--ink3); padding: 0 8px; }
  button.link:not(:disabled):hover { background: transparent; border-color: transparent; color: var(--ink); }
  button:focus-visible { outline: 2px solid var(--ink2); outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: default; }
  button[hidden] { display: none; }
  .copy { height: auto; padding: 0 12px; font-size: 12px; }
` + brandTitlebarCSS + `
</style>
</head>
<body>
<div class="pagebody" tabindex="-1">
  <div class="eyebrow" id="eyebrow">Sidecar update</div>
  <h1 id="title">A new sidecar is available</h1>
  <p class="sub" id="sub"></p>
  <div class="status" id="status" role="status" aria-live="polite"></div>
  <div class="status err" id="error" role="alert" hidden></div>
  <div class="manual" id="manual" role="group" aria-labelledby="manual-h">
    <h2 id="manual-h">Update it yourself</h2>
    <div class="cmd"><code id="cmd"></code><button class="copy" id="copy" type="button">Copy</button></div>
  </div>
  <div class="spacer"></div>
  <div class="row">
    <button class="link" id="skip" type="button">Skip this version</button>
    <button id="later" type="button">Later</button>
    <button id="quit" type="button" hidden>Quit</button>
    <button class="primary" id="go" type="button">Update now</button>
  </div>
</div>` + brandTitlebarHTML + `
<script>
  var $ = function (id) { return document.getElementById(id); };
  var view = null;
  var PHASES = {
    downloading: 'Downloading…',
    verifying: 'Verifying the download…',
    installing: 'Installing…',
    restarting: 'Restarting the sidecar…'
  };
  function busy(p) { return !!PHASES[p]; }

  // Keep keyboard focus on something useful: the first visible, enabled
  // action when the focused button just vanished or was disabled.
  function settleFocus() {
    var a = document.activeElement;
    if (a && a.tagName === 'BUTTON' && !a.hidden && !a.disabled) return;
    var order = ['go', 'later', 'quit', 'copy'];
    for (var i = 0; i < order.length; i++) {
      var b = $(order[i]);
      if (!b.hidden && !b.disabled && b.offsetParent !== null) { b.focus(); return; }
    }
  }

  function render(v) {
    view = v;
    var installable = !!v.version && v.phase !== 'unavailable' && v.canApply;
    var working = busy(v.phase);
    var failed = v.phase === 'failed';

    $('eyebrow').textContent = v.blocked ? 'Update required' : 'Sidecar update';
    $('eyebrow').className = 'eyebrow' + (v.blocked ? ' warn' : '');
    var sub = $('sub');
    sub.textContent = '';
    var add = function (text, bold) {
      var n = bold ? document.createElement('b') : document.createTextNode(text);
      if (bold) n.textContent = text;
      sub.appendChild(n);
    };
    if (v.blocked) {
      $('title').textContent = 'This sidecar needs an update';
      add('Your brain no longer accepts sidecar '); add(v.current, true);
      add('. Jarvis on this machine stays offline until it is updated.');
    } else if (v.version) {
      $('title').textContent = 'A new sidecar is available';
      add('Version '); add(v.version, true); add(' is available (this is '); add(v.current, true);
      add(installable ? '). The sidecar restarts for a few seconds; your brain keeps working.' : ').');
    } else {
      $('title').textContent = 'Sidecar update';
      add('This is sidecar '); add(v.current, true); add('.');
    }

    var status = '';
    if (working) status = PHASES[v.phase];
    else if (v.phase === 'unavailable' && v.error) status = 'Could not check version ' + v.version + ' on the registry (' + v.error + '). Jarvis tries again in a while.';
    else if (v.phase === 'unavailable') status = 'Version ' + v.version + ' is not published yet. Jarvis checks again in a while, or you can update it yourself.';
    else if (!v.version && v.blocked) status = 'Your brain did not say which version to install.';
    else if (v.version && !v.canApply) status = 'This sidecar cannot update itself where it is installed.';
    $('status').textContent = status;
    $('error').hidden = !failed;
    $('error').textContent = failed ? 'The update did not complete: ' + (v.error || 'unknown error') : '';

    var showManual = !!v.manual && (failed || !installable);
    $('manual').className = 'manual' + (showManual ? ' on' : '');
    $('cmd').textContent = v.manual || '';

    $('go').hidden = !installable;
    $('go').disabled = working;
    $('go').textContent = failed ? 'Try again' : 'Update now';
    $('skip').hidden = v.blocked || !installable || working;
    $('later').hidden = v.blocked;
    $('later').textContent = installable ? 'Later' : 'Close';
    $('quit').hidden = !v.blocked;
    $('quit').disabled = working;
    settleFocus();
  }
  window.__update = render;

  function refresh() { return window.updateState().then(render); }

  $('go').onclick = async function () {
    $('go').disabled = true;
    try {
      await window.updateNow();
    } catch (e) {
      // Refused (nothing to install, a cooldown, already running): show the
      // reason, then the real state, which the updater owns.
      $('error').hidden = false;
      $('error').textContent = (e && e.message) ? e.message : String(e);
    }
    // Progress arrives through __update; this only covers a refusal and a
    // push that raced the call. Never render a phase the updater did not set.
    var msg = $('error').hidden ? '' : $('error').textContent;
    await refresh();
    if (msg && view && view.phase !== 'failed' && !busy(view.phase)) {
      $('error').hidden = false;
      $('error').textContent = msg;
    }
  };
  // Closing is always allowed, also mid-install: the install carries on, and
  // the tray and dashboard follow it.
  $('later').onclick = function () { window.updateClose(); };
  $('skip').onclick = function () { window.updateSkip(view ? view.version : ''); };
  $('quit').onclick = function () { window.updateQuit(); };
  $('copy').onclick = function () {
    var text = $('cmd').textContent;
    var done = function () { $('copy').textContent = 'Copied'; setTimeout(function () { $('copy').textContent = 'Copy'; }, 1500); };
    var select = function () {
      var r = document.createRange(); r.selectNodeContents($('cmd'));
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      try { if (document.execCommand('copy')) { done(); } } catch (e) {}
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, select);
    } else {
      select();
    }
  };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && view && !view.blocked) window.updateClose();
  });

  refresh();
  // After the reveal-on-load (load + a short settle): focus the window then,
  // not before its first paint.
  window.addEventListener('load', function () { setTimeout(function () { window.updateReady(); }, 150); });
` + brandTitlebarJS + brandPageBodyJS + `
</script>
</body>
</html>`
