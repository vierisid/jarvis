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
	// PackageManager names the owner when NpmManaged ("bun" or "npm"), so the
	// page prints commands that reach the install detection found.
	PackageManager string `json:"package_manager"`
	// AutostartDefault seeds the wizard's checkbox (--no-autostart clears it).
	AutostartDefault bool `json:"autostart_default"`
	// NoLaunch mirrors --no-launch. The buttons that would start Jarvis only
	// close the window then, so they must not say "Launch Jarvis".
	NoLaunch bool `json:"no_launch"`
}

// applyPlan folds what detection found into the page's state. Pure, and split
// out of the plan goroutine so the mapping from "what is on this machine" to
// "what the panel says" is testable without a registry or a window.
func applyPlan(s *wizardState, inst installedSidecar, latestVersion string) {
	s.Phase = "plan"
	s.Detected = true
	s.Installed = inst.Version != ""
	s.NpmManaged = inst.PackageManager != ""
	s.PackageManager = inst.PackageManager
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
	s.PackageManager = out.Inst.PackageManager
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

// wizardDeps is what a wizard run reaches outside itself for. runWizard wires
// the real registry, detection and install; tests wire fakes, because the
// decisions a run makes between those calls (whether Retry may plan again,
// what code a closed window exits with) never reach the page.
type wizardDeps struct {
	fetchLatest    func() (*pkgRelease, error)
	detect         func() (installedSidecar, error)
	install        func(progressFn) installOutcome
	applyAutostart func(installDir string, enabled bool) error
}

// wizardRun is the wizard's state machine, kept apart from the window that
// shows it: every binding the page calls is a method here. Bindings run on the
// UI thread and the work on goroutines, so all of it is guarded by mu.
type wizardRun struct {
	deps wizardDeps
	// initial is the state a run opens with, and what Retry resets the page to.
	initial wizardState

	mu       sync.Mutex
	st       wizardState
	out      installOutcome
	started  bool
	planned  bool
	planGen  int // invalidates results from superseded plan goroutines
	exitCode int // exitOther (closed early) unless a flow completes
	// installDone is closed when the install goroutine finishes. Closing
	// the window mid-install must not os.Exit through a half-finished
	// binary swap, so wait blocks on it.
	installDone chan struct{}
}

func newWizardRun(deps wizardDeps, initial wizardState) *wizardRun {
	return &wizardRun{deps: deps, initial: initial, st: initial, exitCode: exitOther}
}

func (r *wizardRun) set(fn func(*wizardState)) {
	r.mu.Lock()
	fn(&r.st)
	r.mu.Unlock()
}

// progress is the snapshot the page polls.
func (r *wizardRun) progress() wizardState {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.st
}

// startPlan resolves versions on a goroutine. Bindings run ON the UI
// thread, so doing the (up to 60s) registry fetch inline would block
// the event loop — including the reveal-on-load that makes the window
// visible in the first place. The page polls getProgress instead.
func (r *wizardRun) startPlan() {
	r.mu.Lock()
	if r.planned || r.started {
		r.mu.Unlock()
		return
	}
	r.planned = true
	r.planGen++
	gen := r.planGen
	r.mu.Unlock()

	go func() {
		// A superseded (or overtaken-by-install) goroutine must not
		// clobber the current phase — otherwise a double Retry can
		// bounce a running install back to the plan screen. Call it only
		// inside set, which holds mu.
		stale := func() bool { return gen != r.planGen || r.started }

		rel, err := r.deps.fetchLatest()
		if err != nil {
			r.set(func(s *wizardState) {
				if stale() {
					return
				}
				s.Phase = "failed"
				s.Error = fmt.Sprintf("could not reach the npm registry: %v", err)
			})
			return
		}

		inst, ierr := r.deps.detect()
		if ierr != nil {
			// Fail rather than plan. A plan we could not verify has
			// nothing honest to put in the panel — the page would
			// have to either claim "not installed" or admit it is
			// still checking, next to a live Install button — and
			// performInstall would refuse this machine anyway
			// (flow.go returns exitOther on the same error).
			r.set(func(s *wizardState) {
				if stale() {
					return
				}
				s.Phase = "failed"
				s.Error = fmt.Sprintf("could not inspect the existing installation: %v", ierr)
			})
			return
		}
		r.set(func(s *wizardState) {
			if stale() {
				return
			}
			applyPlan(s, inst, rel.Version)
			// Already current: no install goroutine will run to set
			// `out`, but the up-to-date screen offers a Launch button (a
			// menu-bar-only app the user re-ran the installer to find).
			// Seed the launch target so launchAndClose can start the
			// installed sidecar. This runs inside set()'s mu-held section,
			// past the stale() guard, so it can neither clobber nor be
			// clobbered by a real install, and there is no window in which
			// the Launch button is live before `out` is seeded.
			if s.UpToDate {
				r.out = installOutcome{Rel: rel, Inst: inst, InstallDir: inst.InstallDir, UpToDate: true}
			}
			// Nothing to install is a benign terminal state however the
			// window is closed: already current, or owned by bun/npm (the
			// console flow exits 0 on both). Neither screen has an Install
			// button, so its window controls must agree with its Close.
			if s.UpToDate || s.NpmManaged {
				r.exitCode = exitOK
			}
		})
	}()
}

// retryPlan re-runs resolution after a failure. (The page can't just
// reload: it was loaded via SetHtml, so a reload lands on about:blank.)
func (r *wizardRun) retryPlan() {
	r.mu.Lock()
	if r.started {
		r.mu.Unlock()
		return
	}
	r.planned = false
	r.st = r.initial
	// A fresh plan starts a fresh run: the code of an install that failed
	// before this Retry says nothing about how the new one ends.
	r.exitCode = exitOther
	r.mu.Unlock()
	r.startPlan()
}

// startInstall runs the install on a goroutine; the page follows it through
// getProgress.
func (r *wizardRun) startInstall(autostartOn bool) {
	r.mu.Lock()
	if r.started {
		r.mu.Unlock()
		return
	}
	r.started = true
	r.st.Phase = "running"
	r.installDone = make(chan struct{})
	done := r.installDone
	r.mu.Unlock()

	go func() {
		defer close(done)
		res := r.deps.install(func(stage, detail string) {
			r.set(func(s *wizardState) { s.Stage, s.Detail = stage, detail })
		})
		if res.Err != nil {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.out = res
			// Carry the real code out (2 network / 3 verification /
			// 4 stop / 5 filesystem) so a scripted GUI run is as
			// diagnosable as a --silent one.
			r.exitCode = res.Code
			// The install is over, so the failed screen's Retry has to be
			// able to plan again. Left set, started turned retryPlan into
			// a no-op and the page into a dead end.
			r.started = false
			r.st.Phase = "failed"
			r.st.Error = res.Err.Error()
			return
		}
		if shouldApplyAutostart(res) {
			if err := r.deps.applyAutostart(res.InstallDir, autostartOn); err != nil {
				logf("warning: autostart registration failed: %v", err)
			}
		}
		// Exit code and phase in one step: the UI must never advertise
		// success ahead of the value the process will exit with.
		r.mu.Lock()
		defer r.mu.Unlock()
		r.out = res
		r.exitCode = exitOK
		applyOutcome(&r.st, res)
	}()
}

// launchTarget is what the Launch button starts: the install that just
// finished, or the already-current one the plan found.
func (r *wizardRun) launchTarget() installOutcome {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.out
}

// closeInstaller records how a run the user is done with ends. success=true
// for benign terminal states (already current, npm-managed), which exit 0;
// Cancel passes false and keeps the non-zero "did not install" code, except
// where the plan already seeded exitOK because there was nothing to install.
func (r *wizardRun) closeInstaller(success bool) {
	if !success {
		return
	}
	r.mu.Lock()
	r.exitCode = exitOK
	r.mu.Unlock()
}

// wait returns the code to exit with, once no install is mid-flight.
func (r *wizardRun) wait() int {
	r.mu.Lock()
	done := r.installDone
	r.mu.Unlock()
	if done != nil {
		<-done
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.exitCode
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

	r := newWizardRun(wizardDeps{
		fetchLatest: func() (*pkgRelease, error) { return fetchLatestRelease(registryURL) },
		detect:      detectInstalled,
		install: func(progress progressFn) installOutcome {
			return performInstall(registryURL, false, progress)
		},
		applyAutostart: applyAutostart,
	}, wizardState{Phase: "resolving", Platform: runtime.GOOS, AutostartDefault: autostartDefault, NoLaunch: noLaunch})

	// The same title bar the sidecar's own local windows draw (internal/brand +
	// internal/winchrome, Windows-only; native everywhere else). This window is
	// the first thing a user ever sees from the project, so it is the last one
	// that should look like it belongs to a different product than the app it
	// installs. Safe here for the same reason it is safe there: the page is
	// local HTML compiled into this binary, and the window controls it binds
	// are never reachable by a remote document.
	opened := webviewui.RunWindow("Install Jarvis", 480, 560, webview.HintNone, winchrome.CustomTitleBar, func(w webview.WebView) {
		_ = w.Bind("startPlan", r.startPlan)
		_ = w.Bind("retryPlan", r.retryPlan)
		_ = w.Bind("getProgress", r.progress)
		_ = w.Bind("startInstall", r.startInstall)

		// launchAndClose starts the installed sidecar (macOS first installs
		// hand off to Jarvis.app --setup for the permission wizard) and closes.
		_ = w.Bind("launchAndClose", func() {
			res := r.launchTarget()
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

		_ = w.Bind("closeInstaller", func(success bool) {
			r.closeInstaller(success)
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
	return r.wait()
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
    <button class="sbtn pri hidden" id="btnMain" disabled>Install</button>
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
    if (st.npm_managed) { return 'Managed by ' + (st.package_manager || 'npm'); }
    // Not "Installing…"/"Updating…": the subtitle above already says that, and
    // the stage line below says which part. What must NOT appear here
    // mid-install is the plan's "Not installed" — true until the swap lands,
    // and indistinguishable from the label having got stuck.
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
    var cancel = el('btnCancel');
    // Where Jarvis lives after it starts. It has no Dock/taskbar presence and
    // no persistent window — only a menu-bar (macOS) / system-tray (Windows)
    // icon — so a done screen that doesn't say this reads as "nothing happened".
    var homeSpot = st.platform === 'darwin' ? 'the menu bar, at the top-right of your screen'
      : st.platform === 'windows' ? 'the system tray, near the clock'
      : 'the menu bar';
    // Where to start it by hand, for a run told not to launch it (--no-launch).
    var startSpot = st.platform === 'darwin' ? 'your Applications folder'
      : st.platform === 'windows' ? 'the Start menu'
      : 'your applications';
    // bun and npm keep separate global trees, so the commands name the one
    // that owns this machine's install.
    var pm = st.package_manager || 'npm';
    var npmLine = 'This machine\'s sidecar is managed by ' + pm + '. Update it with ' +
      pm + ' update -g @usejarvis/sidecar, or remove it with ' +
      pm + ' remove -g @usejarvis/sidecar to use this installer instead.';
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

    // Nothing to press until the plan is in: a disabled "Install" (or, after
    // a failure, "Retry") would name a choice the page has not offered yet.
    main.classList.toggle('hidden', st.phase === 'resolving');
    // The secondary button only ever closes the window. It goes where the
    // main button already does that alone, and says Close rather than Cancel
    // where there is nothing left to cancel.
    var nothingToInstall = st.phase === 'plan' && (st.npm_managed || st.up_to_date);
    var mainCloses = st.npm_managed || (st.no_launch && (st.phase === 'done' || nothingToInstall));
    cancel.classList.toggle('hidden', st.phase === 'done' || mainCloses);
    cancel.textContent = nothingToInstall ? 'Close' : 'Cancel';

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
      cancel.disabled = false;
      main.onclick = function () { window.retryPlan(); };
      return;
    }
    if (st.phase === 'running') {
      // Updating, not Installing, when the button that started it said Update.
      el('subtitle').textContent = st.installed ? 'Updating…' : 'Installing…';
      pebble.className = 'bdrop s-think';
      main.disabled = true;
      cancel.disabled = true;
      return;
    }
    if (st.phase === 'done') {
      pebble.className = 'bdrop s-done';
      main.disabled = false;
      if (st.npm_managed) {
        el('subtitle').textContent = npmLine;
        main.textContent = 'Close';
        main.onclick = function () { window.closeInstaller(true); };
      } else if (st.no_launch) {
        el('subtitle').textContent =
          (st.up_to_date ? 'Already up to date.' : st.first_install ? 'Installed.' : 'Updated.') +
          ' Start Jarvis from ' + startSpot + ' when you want it.';
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
      el('subtitle').textContent = npmLine;
      main.textContent = 'Close';
      main.onclick = function () { window.closeInstaller(true); };
    } else if (st.up_to_date && st.no_launch) {
      el('subtitle').textContent = 'You already have the latest sidecar. Start Jarvis from ' + startSpot + ' when you want it.';
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
