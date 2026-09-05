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
//
// No version numbers cross into the page, by design. This installer only ever
// fetches the `latest` dist-tag, so the version is not something the user
// chooses or can act on — two hex-ish numbers to compare are a decision they
// were never given. What they need to know is the state: whether a sidecar is
// on this machine, and whether an update is waiting.
type wizardState struct {
	Phase  string `json:"phase"` // "resolving" | "plan" | "running" | "done" | "failed"
	Stage  string `json:"stage"`
	Detail string `json:"detail"`
	Error  string `json:"error"`
	// Detected says a plan actually inspected this machine. Without it the
	// page cannot tell "no sidecar here" from "we never got to look" — and a
	// registry failure would have it report "Not installed" to someone whose
	// sidecar is sitting right there.
	Detected  bool `json:"detected"`
	Installed bool `json:"installed"`
	// NpmManaged/UpToDate/FirstInstall describe the machine, not a release.
	// FirstInstall keeps its plan-time meaning after the install completes —
	// "this run was the first one" — which is what the macOS done screen and
	// the autostart row are asking about.
	NpmManaged   bool   `json:"npm_managed"`
	UpToDate     bool   `json:"up_to_date"`
	FirstInstall bool   `json:"first_install"`
	Platform     string `json:"platform"`
	// AutostartDefault seeds the wizard's checkbox (--no-autostart clears it).
	AutostartDefault bool `json:"autostart_default"`
}

// applyPlan folds what detection found into the page's state. Pure, and split
// out of the plan goroutine so the mapping from "what is on this machine" to
// "what the panel says" is testable without a registry or a window.
func applyPlan(s *wizardState, inst installedSidecar, latestVersion string) {
	s.Phase = "plan"
	s.Detected = true
	s.Installed = inst.Version != ""
	s.NpmManaged = inst.ManagedByNpm
	s.UpToDate = inst.Version != "" && !versionLess(inst.Version, latestVersion)
	// Updates must not re-apply autostart: the user's own choice is
	// authoritative once installed.
	s.FirstInstall = inst.Version == ""
}

// applyOutcome folds a finished install into the page's state.
//
// Installed = true is the point of it: the panel is fed from the PLAN
// snapshot, so a first install that succeeded went on reporting "not
// installed" on its own done screen until the state said otherwise.
func applyOutcome(s *wizardState, out installOutcome) {
	s.Phase = "done"
	s.Detected = true
	// The stage line is progress, and there is none left. Kept on the failed
	// path (it says which step died, which is worth having beside the error);
	// here it would leave "Installing to C:\…—" sitting under "Installed".
	s.Stage, s.Detail = "", ""
	// True on every path that gets here: we installed it, npm already had, or
	// it was current to begin with.
	s.Installed = true
	s.NpmManaged = out.NpmManaged
	s.UpToDate = out.UpToDate
}

// launchHomeSpot names, for the current OS, where the sidecar lives once
// running, plus how to open it by hand — used in the launch-failure alert so a
// user of this Dock/taskbar-less app isn't left with a vanished window and no
// Jarvis. Mirrors the JS `homeSpot` phrasing in the done screen.
func launchHomeSpot() string {
	switch runtime.GOOS {
	case "darwin":
		return "the menu bar at the top-right of your screen (open Jarvis from your Applications folder)"
	case "windows":
		return "the system tray near the clock (open Jarvis from the Start menu)"
	default:
		return "the menu bar"
	}
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

	// The same title bar the sidecar's own local windows draw (internal/brand +
	// internal/winchrome, Windows-only; native everywhere else). This window is
	// the first thing a user ever sees from the project, so it is the last one
	// that should look like it belongs to a different product than the app it
	// installs. Safe here for the same reason it is safe there: the page is
	// local HTML compiled into this binary, and the window controls it binds
	// are never reachable by a remote document.
	opened := webviewui.RunWindow("Install Jarvis", 480, 560, webview.HintNone, winchrome.CustomTitleBar, func(w webview.WebView) {

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
						if gen != planGen || started {
							return
						}
						s.Phase = "failed"
						s.Error = fmt.Sprintf("could not reach the npm registry: %v", err)
					})
					return
				}
				// A superseded (or overtaken-by-install) goroutine must not
				// clobber the current phase — otherwise a double Retry can
				// bounce a running install back to the plan screen.
				stale := func(s *wizardState) bool { return gen != planGen || started }

				inst, ierr := detectInstalled()
				if ierr != nil {
					// Fail rather than plan. A plan we could not verify has
					// nothing honest to put in the panel — the page would
					// have to either claim "not installed" or admit it is
					// still checking, next to a live Install button — and
					// performInstall would refuse this machine anyway
					// (flow.go returns exitOther on the same error).
					set(func(s *wizardState) {
						if stale(s) {
							return
						}
						s.Phase = "failed"
						s.Error = fmt.Sprintf("could not inspect the existing installation: %v", ierr)
					})
					return
				}
				set(func(s *wizardState) {
					if stale(s) {
						return
					}
					applyPlan(s, inst, rel.Version)
					// Already current: no install goroutine will run to set
					// `out`/exitCode, but the up-to-date screen offers a Launch
					// button (a menu-bar-only app the user re-ran the installer
					// to find). Seed the launch target so launchAndClose can
					// start the installed sidecar, and mark exit 0 — "already
					// current" is a benign terminal state however the window is
					// closed (matches the console flow and closeInstaller's
					// contract). This runs inside set()'s mu-held section, past
					// the stale() guard, so it can neither clobber nor be
					// clobbered by a real install, and there is no window in
					// which the Launch button is live before `out` is seeded.
					if s.UpToDate {
						out = installOutcome{Rel: rel, Inst: inst, InstallDir: inst.InstallDir, UpToDate: true}
						exitCode = exitOK
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
				set(func(s *wizardState) { applyOutcome(s, res) })
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
					// A GUI user never sees the log: without this the window
					// just closes and Jarvis never appears — the same
					// "nothing happened" the rest of this work fixes. Say so,
					// and point them at where to start it by hand. Leave the
					// window open (no Terminate) so the Launch button retries.
					notify("Jarvis could not start",
						"Jarvis is installed but could not be started automatically. Open it yourself — it runs in "+launchHomeSpot()+".",
						true)
					return
				}
			}
			w.Dispatch(w.Terminate)
		})

		// closeInstaller ends a run the user is done with. success=true for
		// benign terminal states (already current, npm-managed) which exit 0;
		// Cancel passes false and keeps the non-zero "did not install" code —
		// except on the up-to-date screen, where the plan already seeded exitOK
		// (the machine is in the desired state however this window is closed).
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

	// The window can be closed at any time — the native X on macOS, the strip's
	// own close button on Windows — including mid-install, since the JS
	// disables Cancel but never the window controls.
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
<title>Install Jarvis</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>` + brand.TokensCSS + brand.PebbleCSS + `
  html, body { height: 100%; }
  /* No padding on body: under custom chrome the strip's offset REPLACES it,
     which would leave the hero flush against the bar. The padding and the
     column live on .pagebody, which is also the scroll container so its
     scrollbar starts below the strip (PageBodyJS keeps it keyboard-scrollable
     — a div takes no focus of its own). */
  body { padding: 0; overflow: hidden; font-size: 13px; }
  .pagebody {
    height: 100%; overflow-y: auto;
    padding: 30px 26px 24px; display: flex; flex-direction: column;
  }
  /* The strip already puts 34px of chrome above the hero; the full 30px on
     top of that reads as a gap rather than as breathing room. */
  html[data-chrome="custom"] .pagebody { padding-top: 20px; }
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
` + brand.TitlebarCSS + `
</style>
</head>
<body>
<div class="pagebody" tabindex="-1">
  <div class="hero">
    <span class="bdrop" id="pebble"><span class="in"></span><span class="ring"></span></span>
    <h1><span class="word"><span class="u">use</span>jarvis</span> sidecar</h1>
  </div>
  <p class="sub" id="subtitle">Checking for the latest sidecar…</p>

  <div class="panel">
    <div class="kv"><span class="k">Sidecar</span><span class="v" id="vStatus">…</span></div>
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
</div>` + brand.TitlebarHTML + `

<script>
  var el = function (id) { return document.getElementById(id); };
  var autostartSeeded = false;

  // The panel's one factual line. It says what this machine's sidecar IS, not
  // which release it is pinned to: the installer always fetches the latest, so
  // the version was never the user's decision to make.
  //
  // Every branch reads the CURRENT snapshot, which is why the done screen
  // corrects itself — the plan said "Not installed", and the state that
  // arrives with the finished install says otherwise.
  function statusText(st) {
    // Nothing was inspected yet (or the registry never answered): "Not
    // installed" would be a claim we cannot make.
    if (!st.detected) { return st.phase === 'failed' ? '—' : 'Checking…'; }
    if (st.npm_managed) { return 'Managed by npm'; }
    // Not "Installing…": the subtitle above already says that, and the stage
    // line below says which part. What must NOT appear here mid-install is the
    // plan's "Not installed" — true until the swap lands, and indistinguishable
    // from the label having got stuck.
    if (st.phase === 'running') { return 'In progress'; }
    // "Updated", not "Installed", when the run replaced something: the button
    // that started it said Update.
    if (st.phase === 'done') {
      if (st.up_to_date) { return 'Up to date'; }
      return st.first_install ? 'Installed' : 'Updated';
    }
    if (!st.installed) { return 'Not installed'; }
    return st.up_to_date ? 'Up to date' : 'Update available';
  }

  function render(st) {
    el('vStatus').textContent = statusText(st);
    el('stage').textContent = st.detail || '';
    el('error').classList.toggle('hidden', !st.error);
    el('error').textContent = st.error || '';
    var pebble = el('pebble');
    var main = el('btnMain');
    // Where Jarvis lives after it starts. It has no Dock/taskbar presence and
    // no persistent window — only a menu-bar (macOS) / system-tray (Windows)
    // icon — so a done screen that doesn't say this reads as "nothing happened".
    var homeSpot = st.platform === 'darwin' ? 'the menu bar, at the top-right of your screen'
      : st.platform === 'windows' ? 'the system tray, near the clock'
      : 'the menu bar';
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
        el('subtitle').textContent = st.up_to_date ? 'Already up to date. Jarvis lives in ' + homeSpot + '.'
          : (st.platform === 'darwin' && st.first_install)
            ? 'Installed. Jarvis will ask for its permissions, then live in ' + homeSpot + '.'
            : st.first_install ? 'Installed. Jarvis lives in ' + homeSpot + '.'
              : 'Updated. Jarvis lives in ' + homeSpot + '.';
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
      // Menu-bar-only app: a user who re-ran the installer to "get Jarvis
      // back" needs a way to start it, not just a dead-end Close. Launch it.
      el('subtitle').textContent = 'You already have the latest sidecar — it runs in ' + homeSpot + '.';
      main.textContent = 'Launch Jarvis';
      main.onclick = function () { window.launchAndClose(); };
    } else {
      // The panel row is where "there is an update" is announced; saying it
      // again here would leave the two lines of the screen agreeing with each
      // other instead of telling the user two things.
      el('subtitle').textContent = st.installed
        ? 'This updates the Jarvis sidecar on this machine.'
        : 'This installs the Jarvis sidecar on this machine.';
      main.textContent = st.installed ? 'Update' : 'Install';
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

<!-- The chrome gets its own <script> on purpose. Everything above opens by
     calling bindings, and a throw there would abort the rest of ITS block —
     which, under custom chrome, is a window left with no title bar at all and
     no native one to fall back on. A separate block still runs. -->
<script>` + brand.TitlebarJS + brand.PageBodyJS + `</script>
</body>
</html>`
