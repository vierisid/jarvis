package main

// The update prompt: a small local window offering the sidecar update the
// brain advertised. The same window serves every entry point — the startup
// offer (onFirstUpdateOffer), the tray's Update item and the dashboard hint
// (the sidecar.update_prompt RPC) — and follows the install through its
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
	// updateWindowMu guards updateWindowWV and updateWindowTorndown, which the
	// window goroutine publishes and offer changes read.
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
}

func (c *SidecarClient) updateView() updateWindowView {
	o := c.updater.Offer()
	v := updateWindowView{
		Version: o.Version,
		Current: o.Current,
		Blocked: o.Blocked,
		Phase:   o.State.Phase,
		Error:   o.State.Error,
		Manual:  o.State.ManualCommand,
	}
	if v.Manual == "" && (v.Version == "" || v.Phase == updatePhaseUnavailable) {
		// Nothing installable (an old brain rejected us, or the version is
		// not published yet): the page still needs something to offer.
		v.Manual = c.updater.ManualCommand(o.Version)
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
		// Cocoa run loop (tray_darwin.go); the startup offer can race it.
		waitTrayReady(15 * time.Second)
		c.runUpdateWindow()
	}()
}

func focusUpdateWindow() {
	updateWindowMu.Lock()
	w, gone := updateWindowWV, updateWindowTorndown
	updateWindowMu.Unlock()
	if w == nil || gone {
		return
	}
	w.Dispatch(func() {
		if h := w.Window(); h != nil {
			_ = platformFocusWindow(h)
		}
	})
}

// pushUpdateWindow re-renders an open prompt after the offer changed (a
// phase of the install, a failure).
func (c *SidecarClient) pushUpdateWindow() {
	updateWindowMu.Lock()
	w, gone := updateWindowWV, updateWindowTorndown
	updateWindowMu.Unlock()
	if w == nil || gone {
		return
	}
	b, _ := json.Marshal(c.updateView())
	js := "window.__update && window.__update(" + string(b) + ")"
	w.Dispatch(func() {
		updateWindowMu.Lock()
		gone := updateWindowTorndown || updateWindowWV != w
		updateWindowMu.Unlock()
		if !gone {
			w.Eval(js)
		}
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
			// The window is revealed on load; bring it forward then, since an
			// unprompted window (startup, dashboard) otherwise opens behind
			// whatever the user is in.
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
  .manual label { font-size: 11px; font-weight: 600; color: var(--ink2); display: block; margin-bottom: 6px; }
  .cmd {
    display: flex; gap: 8px; align-items: stretch;
  }
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
  <div class="manual" id="manual">
    <label>Update it yourself</label>
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
    checking: 'Checking the update…',
    downloading: 'Downloading…',
    verifying: 'Verifying the download…',
    installing: 'Installing…',
    restarting: 'Restarting the sidecar…'
  };
  function busy(p) { return !!PHASES[p]; }

  function render(v) {
    view = v;
    var installable = !!v.version && v.phase !== 'unavailable';
    var working = busy(v.phase);
    var failed = v.phase === 'failed';

    $('eyebrow').textContent = v.blocked ? 'Update required' : 'Sidecar update';
    $('eyebrow').className = 'eyebrow' + (v.blocked ? ' warn' : '');
    if (v.blocked) {
      $('title').textContent = 'This sidecar needs an update';
      $('sub').innerHTML = 'Your brain no longer accepts sidecar <b></b>. Jarvis on this machine stays offline until it is updated.';
      $('sub').querySelector('b').textContent = v.current;
    } else {
      $('title').textContent = installable ? 'A new sidecar is available' : 'Sidecar update';
      $('sub').innerHTML = installable
        ? 'Version <b></b> is ready to install (this is <b></b>). The sidecar restarts for a few seconds; your brain keeps working.'
        : 'This is sidecar <b></b>.';
      var bs = $('sub').querySelectorAll('b');
      if (installable) { bs[0].textContent = v.version; bs[1].textContent = v.current; }
      else { bs[0].textContent = v.current; }
    }

    var status = '';
    if (working) status = PHASES[v.phase];
    else if (failed) status = 'The update did not complete: ' + (v.error || 'unknown error') + '. Nothing changed; you are still on ' + v.current + '.';
    else if (v.phase === 'unavailable') status = 'Version ' + v.version + ' is not published yet. Try again in a while, or update it yourself.';
    else if (!installable && v.blocked) status = 'This brain did not say which version to install.';
    $('status').textContent = status;
    $('status').className = 'status' + (failed ? ' err' : '');

    var showManual = !!v.manual && (failed || !installable);
    $('manual').className = 'manual' + (showManual ? ' on' : '');
    $('cmd').textContent = v.manual || '';

    $('go').hidden = !installable;
    $('go').disabled = working;
    $('go').textContent = failed ? 'Try again' : 'Update now';
    $('skip').hidden = v.blocked || !installable || working;
    $('later').hidden = v.blocked;
    $('later').disabled = working;
    $('later').textContent = installable ? 'Later' : 'Close';
    $('quit').hidden = !v.blocked;
    $('quit').disabled = working;
  }
  window.__update = render;

  $('go').onclick = async function () {
    $('go').disabled = true;
    try {
      await window.updateNow();
      render(Object.assign({}, view, { phase: 'checking', error: '' }));
    } catch (e) {
      render(Object.assign({}, view, { phase: 'failed', error: (e && e.message) ? e.message : String(e) }));
    }
  };
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
    if (e.key === 'Escape' && view && !view.blocked && !busy(view.phase)) window.updateClose();
  });

  window.updateState().then(function (v) { render(v); window.updateReady(); });
` + brandTitlebarJS + brandPageBodyJS + `
</script>
</body>
</html>`
