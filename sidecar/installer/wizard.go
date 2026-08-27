package main

// The GUI wizard (default mode on Windows/macOS): plan → progress → done,
// in the shared Monochrome Lab brand. All real work happens in
// performInstall on a goroutine; the page polls getProgress.

import (
	"fmt"
	"runtime"
	"sync"

	webview "github.com/webview/webview_go"

	"github.com/jarvis/sidecar/internal/brand"
	"github.com/jarvis/sidecar/internal/webview2"
	"github.com/jarvis/sidecar/internal/webviewui"
	"github.com/jarvis/sidecar/internal/winchrome"
)

func guiSupported() bool {
	return runtime.GOOS == "windows" || runtime.GOOS == "darwin"
}

// wizardState is the page's poll snapshot.
type wizardState struct {
	Phase        string `json:"phase"` // "resolving" | "plan" | "running" | "done" | "failed"
	Stage        string `json:"stage"`
	Detail       string `json:"detail"`
	Error        string `json:"error"`
	Installed    string `json:"installed_version"`
	Latest       string `json:"latest_version"`
	NpmManaged   bool   `json:"npm_managed"`
	UpToDate     bool   `json:"up_to_date"`
	FirstInstall bool   `json:"first_install"`
	Platform     string `json:"platform"`
	// AutostartDefault seeds the wizard's checkbox (--no-autostart clears it).
	AutostartDefault bool `json:"autostart_default"`
}

func runWizard(registryURL string, noLaunch, autostartDefault bool) int {
	// The wizard itself is WebView2-backed on Windows; internal/webview2
	// prompts + waits when the runtime is missing (no-op elsewhere). The
	// fallback must honour the same flags the wizard would have — passing a
	// hardcoded `true` here once meant --no-autostart did the opposite of
	// what it says.
	if !webview2.Ensure() {
		logf("WebView2 runtime unavailable — falling back to console install")
		return runInstall(registryURL, false, noLaunch, autostartDefault)
	}

	var (
		mu       sync.Mutex
		st       = wizardState{Phase: "resolving", Platform: runtime.GOOS, AutostartDefault: autostartDefault}
		out      installOutcome
		started  bool
		planned  bool
		planGen  int         // invalidates results from superseded plan goroutines
		exitCode = exitOther // closed early unless a flow completes
		// installDone is closed when the install goroutine finishes. Closing
		// the window mid-install must not os.Exit through a half-finished
		// binary swap, so runWizard waits on it before returning.
		installDone chan struct{}
	)

	set := func(fn func(*wizardState)) {
		mu.Lock()
		fn(&st)
		mu.Unlock()
	}
	snapshot := func() wizardState {
		mu.Lock()
		defer mu.Unlock()
		return st
	}

	// NativeTitleBar on purpose: this is the first window a user ever sees from
	// this project, run before anything is installed, so it wears the system's
	// chrome rather than asking for trust with a title bar of our own.
	opened := webviewui.RunWindow("Install Jarvis", 480, 560, webview.HintNone, winchrome.NativeTitleBar, func(w webview.WebView) {

		// startPlan resolves versions on a goroutine. Bindings run ON the UI
		// thread, so doing the (up to 60s) registry fetch inline would block
		// the event loop — including the reveal-on-load that makes the window
		// visible in the first place. The page polls getProgress instead.
		startPlan := func() {
			mu.Lock()
			if planned || started {
				mu.Unlock()
				return
			}
			planned = true
			planGen++
			gen := planGen
			mu.Unlock()

			go func() {
				rel, err := fetchLatestRelease(registryURL)
				if err != nil {
					set(func(s *wizardState) {
						if gen != planGen {
							return
						}
						s.Phase = "failed"
						s.Error = fmt.Sprintf("could not reach the npm registry: %v", err)
					})
					return
				}
				inst, ierr := detectInstalled()
				set(func(s *wizardState) {
					// A superseded (or overtaken-by-install) goroutine must
					// not clobber the current phase — otherwise a double
					// Retry can bounce a running install back to the plan
					// screen.
					if gen != planGen || started {
						return
					}
					s.Phase = "plan"
					s.Latest = rel.Version
					if ierr == nil {
						s.Installed = inst.Version
						s.NpmManaged = inst.ManagedByNpm
						s.UpToDate = inst.Version != "" && !versionLess(inst.Version, rel.Version)
						// Updates must not re-apply autostart: the user's own
						// choice is authoritative once installed.
						s.FirstInstall = inst.Version == ""
					}
				})
			}()
		}
		_ = w.Bind("startPlan", startPlan)

		// retryPlan re-runs resolution after a failure. (The page can't just
		// reload: it was loaded via SetHtml, so a reload lands on about:blank.)
		_ = w.Bind("retryPlan", func() {
			mu.Lock()
			if started {
				mu.Unlock()
				return
			}
			planned = false
			st = wizardState{Phase: "resolving", Platform: runtime.GOOS, AutostartDefault: autostartDefault}
			mu.Unlock()
			startPlan()
		})

		_ = w.Bind("getProgress", func() wizardState { return snapshot() })

		_ = w.Bind("startInstall", func(autostartOn bool) {
			mu.Lock()
			if started {
				mu.Unlock()
				return
			}
			started = true
			st.Phase = "running"
			installDone = make(chan struct{})
			done := installDone
			mu.Unlock()

			go func() {
				defer close(done)
				res := performInstall(registryURL, false, func(stage, detail string) {
					set(func(s *wizardState) { s.Stage, s.Detail = stage, detail })
				})
				mu.Lock()
				out = res
				mu.Unlock()
				if res.Err != nil {
					// Carry the real code out (2 network / 3 verification /
					// 4 stop / 5 filesystem) so a scripted GUI run is as
					// diagnosable as a --silent one.
					mu.Lock()
					exitCode = res.Code
					mu.Unlock()
					set(func(s *wizardState) {
						s.Phase = "failed"
						s.Error = res.Err.Error()
					})
					return
				}
				if shouldApplyAutostart(res) {
					if err := applyAutostart(res.InstallDir, autostartOn); err != nil {
						logf("warning: autostart registration failed: %v", err)
					}
				}
				// Exit code before phase: the UI must never advertise
				// success ahead of the value the process will exit with.
				mu.Lock()
				exitCode = exitOK
				mu.Unlock()
				set(func(s *wizardState) {
					s.Phase = "done"
					s.NpmManaged = res.NpmManaged
					s.UpToDate = res.UpToDate
					if res.Rel != nil {
						s.Latest = res.Rel.Version
					}
				})
			}()
		})

		// launchAndClose starts the installed sidecar (macOS first installs
		// hand off to Jarvis.app --setup for the permission wizard) and closes.
		_ = w.Bind("launchAndClose", func() {
			mu.Lock()
			res := out
			mu.Unlock()
			if !noLaunch && res.InstallDir != "" && res.Rel != nil {
				firstInstall := res.Inst.Version == ""
				if err := launchInstalled(res.InstallDir, res.Rel.Version, firstInstall); err != nil {
					logf("warning: could not launch the sidecar: %v", err)
				}
			}
			w.Dispatch(w.Terminate)
		})

		// closeInstaller ends a run the user is done with. success=true for
		// benign terminal states (already current, npm-managed) which exit 0;
		// Cancel passes false and keeps the non-zero "did not install" code.
		_ = w.Bind("closeInstaller", func(success bool) {
			if success {
				mu.Lock()
				exitCode = exitOK
				mu.Unlock()
			}
			w.Dispatch(w.Terminate)
		})

		w.SetHtml(wizardHTML)
	})

	// No window at all (a broken WebView2, a headless session): silently exiting
	// would look like the installer doing nothing when double-clicked, so fall
	// back to the console flow, which at least reports what happened.
	if !opened {
		logf("no window could be opened — falling back to a console install")
		return runInstall(registryURL, false, noLaunch, autostartDefault)
	}

	// The window can be closed with its native close button at any time,
	// including mid-install (the JS only disables our own Cancel button).
	// Returning here would os.Exit the process — potentially between the two
	// renames of the binary swap, leaving the machine with a .old and no
	// installed binary — so let the install finish first.
	mu.Lock()
	done := installDone
	mu.Unlock()
	if done != nil {
		<-done
	}

	mu.Lock()
	defer mu.Unlock()
	return exitCode
}

const wizardHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>` + brand.TokensCSS + brand.PebbleCSS + `
  html, body { height: 100%; }
  body { padding: 30px 26px 24px; font-size: 13px; display: flex; flex-direction: column; }
  .hero { display: flex; align-items: center; gap: 14px; }
  .hero .bdrop { width: 38px; height: 38px; flex: 0 0 auto; }
  h1 { font-size: 19px; font-weight: 650; letter-spacing: -.01em; margin: 0; }
  .sub { font-size: 12px; color: var(--ink3); margin: 8px 0 16px; line-height: 1.55; }
  .panel { background: var(--raise); border: 1px solid var(--rule); border-radius: var(--corner); box-shadow: var(--sh-sm); padding: 14px 16px; }
  .kv { display: flex; justify-content: space-between; padding: 6px 0; font-size: 12.5px; }
  .kv .k { color: var(--ink3); }
  .kv .v { font-family: var(--mono); font-weight: 600; }
  .stage { font-size: 12.5px; color: var(--ink2); min-height: 18px; margin-top: 12px; }
  .err { color: var(--listen-tx); font-size: 12px; line-height: 1.5; margin-top: 10px; word-break: break-word; }
  .sw { position: relative; display: inline-block; width: 38px; height: 22px; flex: 0 0 auto; cursor: pointer; }
  .sw input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .sw .track { position: absolute; inset: 0; background: var(--panel); border: 1px solid var(--rule); border-radius: 999px; transition: background .16s var(--ease); }
  .sw .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--raise); box-shadow: var(--sh-sm); transition: transform .16s var(--ease); }
  .sw input:checked + .track { background: var(--ink); border-color: var(--ink); }
  .sw input:checked + .track::after { transform: translateX(16px); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
  .row .lbl { font-size: 12.5px; font-weight: 600; }
  .row .note { font-size: 11px; color: var(--ink3); margin-top: 2px; }
  .foot { margin-top: auto; display: flex; justify-content: flex-end; gap: 10px; padding-top: 18px; }
  .sbtn { appearance: none; font-family: var(--sans); font-size: 12.5px; font-weight: 600; padding: 8px 16px; border-radius: var(--corner-sm); border: 1px solid var(--rule); color: var(--ink); background: var(--raise); cursor: pointer; }
  .sbtn:hover { background: var(--panel); border-color: var(--rule-hi); }
  .sbtn.pri { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  .sbtn.pri:hover { filter: brightness(1.08); }
  .sbtn:disabled { opacity: .5; cursor: default; }
  .hidden { display: none !important; }
</style>
</head>
<body>
  <div class="hero">
    <span class="bdrop" id="pebble"><span class="in"></span><span class="ring"></span></span>
    <h1><span class="word"><span class="u">use</span>jarvis</span> sidecar</h1>
  </div>
  <p class="sub" id="subtitle">Checking versions…</p>

  <div class="panel">
    <div class="kv"><span class="k">Installed</span><span class="v" id="vInstalled">…</span></div>
    <div class="kv"><span class="k">Latest</span><span class="v" id="vLatest">…</span></div>
    <div class="stage" id="stage"></div>
    <div class="err hidden" id="error"></div>
  </div>

  <div class="row" id="autostartRow">
    <div><div class="lbl">Start at login</div><div class="note">Jarvis only helps while the sidecar is running.</div></div>
    <label class="sw"><input type="checkbox" id="autostart" checked><span class="track"></span></label>
  </div>

  <div class="foot">
    <button class="sbtn" id="btnCancel" onclick="window.closeInstaller(false)">Cancel</button>
    <button class="sbtn pri" id="btnMain" disabled>Install</button>
  </div>

<script>
  var el = function (id) { return document.getElementById(id); };
  var autostartSeeded = false;

  function render(st) {
    el('vInstalled').textContent = st.installed_version || 'not installed';
    el('vLatest').textContent = st.latest_version || '…';
    el('stage').textContent = st.detail || '';
    el('error').classList.toggle('hidden', !st.error);
    el('error').textContent = st.error || '';
    var pebble = el('pebble');
    var main = el('btnMain');
    // Autostart applies on first install only; on updates the user's own
    // choice (Jarvis settings / setup wizard) stands.
    var showAutostart = st.phase === 'plan' && st.platform === 'windows' &&
                        st.first_install && !st.npm_managed && !st.up_to_date;
    el('autostartRow').classList.toggle('hidden', !showAutostart);
    // Seed the checkbox from the flag (--no-autostart clears it), once.
    if (!autostartSeeded && st.phase !== 'resolving') {
      el('autostart').checked = !!st.autostart_default;
      autostartSeeded = true;
    }

    if (st.phase === 'resolving') {
      el('subtitle').textContent = 'Checking for the latest sidecar…';
      pebble.className = 'bdrop s-think';
      main.disabled = true;
      return;
    }
    if (st.phase === 'failed') {
      el('subtitle').textContent = 'Something went wrong.';
      pebble.className = 'bdrop s-err';
      main.textContent = 'Retry';
      main.disabled = false;
      el('btnCancel').disabled = false;
      main.onclick = function () { window.retryPlan(); };
      return;
    }
    if (st.phase === 'running') {
      el('subtitle').textContent = 'Installing…';
      pebble.className = 'bdrop s-think';
      main.disabled = true;
      el('btnCancel').disabled = true;
      return;
    }
    if (st.phase === 'done') {
      pebble.className = 'bdrop s-done';
      el('btnCancel').classList.add('hidden');
      main.disabled = false;
      if (st.npm_managed) {
        el('subtitle').textContent = 'This machine uses the npm-managed sidecar — update it with bun update -g @usejarvis/sidecar.';
        main.textContent = 'Close';
        main.onclick = function () { window.closeInstaller(true); };
      } else {
        el('subtitle').textContent = st.up_to_date ? 'Already up to date.'
          : (st.platform === 'darwin' && st.first_install)
            ? 'Installed. Jarvis will now ask for its permissions.'
            : 'Installed.';
        main.textContent = 'Launch Jarvis';
        main.onclick = function () { window.launchAndClose(); };
      }
      return;
    }
    // plan
    pebble.className = 'bdrop';
    main.disabled = false;
    if (st.npm_managed) {
      el('subtitle').textContent = 'This machine uses the npm-managed sidecar — nothing to do here.';
      main.textContent = 'Close';
      main.onclick = function () { window.closeInstaller(true); };
    } else if (st.up_to_date) {
      el('subtitle').textContent = 'You already have the latest sidecar.';
      main.textContent = 'Close';
      main.onclick = function () { window.closeInstaller(true); };
    } else {
      el('subtitle').textContent = st.installed_version
        ? 'An update is available.'
        : 'This installs the Jarvis sidecar on this machine.';
      main.textContent = st.installed_version ? 'Update' : 'Install';
      main.onclick = function () { window.startInstall(el('autostart').checked); };
    }
  }

  async function poll() {
    try { render(await window.getProgress()); } catch (e) {}
    setTimeout(poll, 500);
  }

  window.startPlan();
  poll();
</script>
</body>
</html>`
