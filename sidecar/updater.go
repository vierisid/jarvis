package main

// Self-update. The brain advertises the sidecar version it ships with
// (register_ack / register_rejected `latest`); this file decides whether that
// version is an update for this process, confirms it is actually published,
// and installs it on request (swapping the payload in place for a native
// install, or running bun/npm for a package-manager one), then hands off to
// the new binary.
//
// The brain only ever SUGGESTS a version. Everything that makes installing it
// safe is enforced here and in internal/update: the version must be canonical
// and strictly newer than this build (and a release build is never moved onto
// a prerelease), it is fetched only from the npm registry (updateRegistryURL),
// and on Windows/macOS the payload must carry our pinned code signature before
// it is ever executed. The native path checks the tarball's sha512 itself; the
// package-manager path pins bun/npm to the same registry and version and
// leaves the integrity check to them, as a manual install would.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jarvis/sidecar/internal/update"
)

// Update phases reported to the brain (update_progress) and shown by the
// prompt. "available" is local only: it is what the tray/prompt offer.
const (
	updatePhaseAvailable   = "available"
	updatePhaseDownloading = "downloading"
	updatePhaseVerifying   = "verifying"
	updatePhaseInstalling  = "installing"
	updatePhaseRestarting  = "restarting"
	updatePhaseFailed      = "failed"
	updatePhaseUnavailable = "unavailable"
)

// Feature flags advertised in `register` so the dashboard knows what it can
// ask of this sidecar. Older sidecars advertise none.
const (
	featureUpdatePrompt = "update_prompt" // can show the native update prompt
	featureUpdateApply  = "update_apply"  // can install an update on request
)

const (
	// updateRetryInterval re-checks a version the registry did not carry yet
	// (a brain released moments before its paired sidecar finished publishing).
	updateRetryInterval = time.Hour
	// packageManagerTimeout bounds `bun add -g` / `npm install -g`.
	packageManagerTimeout = 5 * time.Minute
	// failureCooldown spaces out retries after a failed attempt, so a looping
	// caller cannot turn into back-to-back downloads.
	failureCooldown = 15 * time.Second
	// installerDownloadURL is where a native install that cannot update
	// itself gets the current installer.
	installerDownloadURL = "https://github.com/vierisid/jarvis/releases/tag/installer-latest"
)

// UpdateState is the updater's latest progress, as reported to the brain.
type UpdateState struct {
	Phase         string `json:"phase"`
	Version       string `json:"version,omitempty"`
	Error         string `json:"error,omitempty"`
	ManualCommand string `json:"manual_command,omitempty"`
}

// UpdateOffer is what the prompt / tray show.
type UpdateOffer struct {
	Version string // "" when no installable update is known
	Blocked bool   // the brain refused this version: updating is required
	Current string
	State   UpdateState
}

// Updater owns the self-update state for one process. The zero value is not
// usable; build it with newUpdater.
type Updater struct {
	running  string      // this build's version (sidecarVersion)
	registry string      // npm registry base (updateRegistryURL)
	exe      string      // this process's executable, symlinks resolved
	mode     update.Mode // how this install can be updated

	// Seams, replaced by tests.
	resolve   func(registry, version string) (*update.Release, error)
	install   func(ctx context.Context, rel *update.Release, installDir string, progress func(string)) error
	pmResolve func(pm, version string) (args []string, pathEnv string, err error)
	pmRun     func(ctx context.Context, args []string, pathEnv string) error
	verifyPM  func(exe string) error // signature of what the package manager installed
	verBin    func(exe string) (string, error)
	handOff   func(exe string) error // relaunch exe and exit this process once it is up
	// markPending / clearPending keep the startup-rollback marker
	// (update_pending.go) for a native update.
	markPending  func(installDir, from, to string) error
	clearPending func()
	schedule     func(d time.Duration, f func()) func()
	now          func() time.Time
	cooldown     time.Duration

	// Hooks, set by the client / platform UI. All optional.
	onChange     func(UpdateOffer) // tray item, open prompt
	onFirstOffer func(UpdateOffer) // the once-per-process startup prompt
	emit         func(UpdateState) // update_progress to the brain

	mu          sync.Mutex
	latest      string // version the brain advertised ("" = none / old brain)
	blocked     bool
	available   string // latest, confirmed published and newer than running
	state       UpdateState
	checkGen    int    // bumps on every advertise; stale checks drop their result
	firstGen    int    // the process's first advertise: only it may prompt at startup
	cancelRetry func() // pending unavailable-retry timer
	cleaned     bool   // .old from a previous update already handled
	failedAt    time.Time

	// applying is set while an update installs, and STAYS set once the
	// process has handed off to the new binary: a second apply in the few
	// hundred ms before this process exits would swap again and delete the
	// rollback copy.
	applying   atomic.Bool
	firstOffer sync.Once
	// blockedOffer is separate: a sidecar the brain starts refusing
	// mid-session (a brain upgrade raised its floor) gets the prompt even if
	// the startup offer was already shown and put off.
	blockedOffer sync.Once
}

func newUpdater(running string) *Updater {
	exe, err := os.Executable()
	if err == nil {
		if resolved, rerr := filepath.EvalSymlinks(exe); rerr == nil {
			exe = resolved
		}
	}
	u := &Updater{
		running:  running,
		registry: updateRegistryURL(),
		exe:      exe,
		resolve:  update.ResolveRelease,
		install:  installNative,
		pmRun:    runPackageManager,
		verifyPM: verifyInstalledPayload,
		verBin:   binaryVersion,
		schedule: func(d time.Duration, f func()) func() {
			t := time.AfterFunc(d, f)
			return func() { t.Stop() }
		},
		now:          time.Now,
		cooldown:     failureCooldown,
		markPending:  writePendingUpdate,
		clearPending: clearPendingUpdate,
	}
	u.pmResolve = func(pm, version string) ([]string, string, error) {
		_, args, pathEnv, err := update.PackageManagerInvocation(pm, version, u.registry, u.exe)
		return args, pathEnv, err
	}
	if exe != "" {
		u.mode = update.DetectMode(exe)
	} else {
		u.mode = update.Mode{Kind: update.ModeManual, Reason: fmt.Sprintf("cannot locate the running executable: %v", err)}
	}
	return u
}

// updatable reports whether this build can take part in self-update at all:
// an unstamped dev build never does.
func (u *Updater) updatable() bool {
	return update.ValidVersion(u.running)
}

// Features is the register `features` list.
func (u *Updater) Features() []string {
	if !u.updatable() {
		return nil
	}
	var f []string
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		f = append(f, featureUpdatePrompt)
	}
	if u.canApply() {
		f = append(f, featureUpdateApply)
	}
	return f
}

// canApply reports whether Start can install anything at all here. A
// package-manager install whose tool cannot be found is not offered as a
// one-click update (the dashboard shows the command instead).
func (u *Updater) canApply() bool {
	switch u.mode.Kind {
	case update.ModeNative:
		return true
	case update.ModePackageManager:
		_, _, err := u.pmResolve(u.mode.PackageManager, "0.0.0")
		return err == nil
	}
	return false
}

// OnAck handles a register_ack. Called on the read loop: never blocks.
func (u *Updater) OnAck(latest string) {
	u.advertise(latest, false)
	go u.cleanupPrevious()
}

// OnRejected handles a register_rejected. Called on the read loop: never
// blocks.
func (u *Updater) OnRejected(latest string) {
	u.advertise(latest, true)
}

func (u *Updater) advertise(latest string, blocked bool) {
	// The locked region is a closure with a deferred unlock, not a Lock and a
	// later Unlock, because this runs on the read loop under the recover in
	// runRegisterAck / runRegisterRejected (#670). A panic between a bare
	// Lock and Unlock would be contained with u.mu still held, and then the
	// tray's next Offer() and the next ack's advertise -- on the read loop --
	// would block forever: a registered sidecar that never answers, which is
	// worse than the crash the recover replaced.
	candidate, gen := func() (bool, int) {
		u.mu.Lock()
		defer u.mu.Unlock()
		u.latest, u.blocked = latest, blocked
		u.checkGen++
		gen := u.checkGen
		if u.firstGen == 0 {
			u.firstGen = gen
		}
		if u.cancelRetry != nil {
			cancel := u.cancelRetry
			u.cancelRetry = nil
			cancel()
		}
		// A release build is never moved onto a prerelease: only a sidecar
		// that is itself running one follows the brain onto rc builds.
		candidate := u.updatable() && update.StrictlyNewer(latest, u.running) &&
			(!update.IsPrerelease(latest) || update.IsPrerelease(u.running))
		if !candidate {
			u.available = ""
			if !u.applying.Load() {
				u.state = UpdateState{}
			}
		}
		return candidate, gen
	}()

	if !candidate {
		u.changed()
		// A blocked sidecar with nothing installable still gets its prompt:
		// it cannot work until updated, and the prompt says how.
		if blocked && u.updatable() {
			u.fireBlockedOffer()
		}
		return
	}
	go u.check(gen, latest, false)
}

// registryStateFor is the state a registry check leaves behind for version:
// "unavailable" (with the error only when it was not simply "not published
// yet", so the prompt can tell a network problem from a pending release).
func registryStateFor(version string, err error) UpdateState {
	s := UpdateState{Phase: updatePhaseUnavailable, Version: version}
	if !errors.Is(err, update.ErrVersionNotFound) {
		s.Error = err.Error()
	}
	return s
}

// check confirms the advertised version is really published before offering
// it; a version not there yet is retried on updateRetryInterval. Only the
// process's first check may open the startup prompt: an update that becomes
// known later (a brain upgraded mid-session, a retry that finally finds the
// version) is offered by the tray and the dashboard instead of a window
// popping up in the middle of work. A blocked sidecar is the exception: it
// cannot work at all until updated.
//
// It runs on its own goroutine (from advertise, and again from the retry
// timer), so nothing above it recovers a panic: before #760 one ended the
// process. See recoverCheck for the state a contained panic leaves.
func (u *Updater) check(gen int, version string, retry bool) {
	// Set once this check's result is in the updater's state. A panic before
	// that leaves the check undecided and recoverCheck decides it; a panic
	// after it (in a hook: emit, the tray, the prompt) leaves an accurate
	// state that is only logged.
	recorded := false
	defer u.recoverCheck(gen, version, &recorded)

	_, err := u.resolve(u.registry, version)

	startup := false
	// The locked region is a closure with a deferred unlock, for the reason
	// advertise gives (#670): a panic between a bare Lock and Unlock would be
	// contained with u.mu still held, and every later Offer() -- the tray --
	// and the next ack's advertise on the read loop would block forever.
	stale, kept, report, blocked := func() (stale, kept bool, report *UpdateState, blocked bool) {
		u.mu.Lock()
		defer u.mu.Unlock()
		if gen != u.checkGen {
			recorded = true
			return true, false, nil, false
		}
		startup = gen == u.firstGen && !retry
		if err != nil && u.available == version {
			// Already confirmed on an earlier check (this is a reconnect): a
			// transient registry error must not take the offer away.
			recorded = true
			return false, true, nil, false
		}
		// The brain (and so the dashboard) learns the outcome too: without
		// it, it would offer an update the sidecar cannot install yet.
		if err != nil {
			u.available = ""
			if !u.applying.Load() {
				s := registryStateFor(version, err)
				u.state = s
				report = &s
			}
			u.cancelRetry = u.schedule(updateRetryInterval, func() { u.check(gen, version, true) })
			recorded = true
			return false, false, report, u.blocked
		}
		u.available = version
		keepFailure := u.state.Phase == updatePhaseFailed && u.state.Version == version
		if !u.applying.Load() && !keepFailure {
			s := UpdateState{Phase: updatePhaseAvailable, Version: version}
			u.state = s
			report = &s
		}
		recorded = true
		return false, false, report, u.blocked
	}()
	if stale {
		return
	}
	if kept {
		log.Printf("[update] re-check of sidecar %s failed (%v); keeping the confirmed offer", version, err)
		return
	}
	if err != nil {
		if !errors.Is(err, update.ErrVersionNotFound) {
			log.Printf("[update] could not check sidecar %s on the registry: %v (retrying in %s)", version, err, updateRetryInterval)
		} else {
			log.Printf("[update] sidecar %s is not published yet (retrying in %s)", version, updateRetryInterval)
		}
		u.announce(report, blocked, false)
		return
	}
	log.Printf("[update] sidecar %s is available (running %s)", version, u.running)
	u.announce(report, blocked, startup)
}

// announce tells the brain, the tray and (when it applies) the prompt about a
// check's recorded result. Each hook is contained on its own (#760), so a
// panicking emit cannot cost a blocked sidecar its prompt, which it needs to
// work at all.
func (u *Updater) announce(report *UpdateState, blocked, startup bool) {
	containUpdaterPanic("reporting the check to the brain", func() { u.report(report) })
	containUpdaterPanic("updating the tray", u.changed)
	switch {
	case blocked:
		containUpdaterPanic("showing the blocked prompt", u.fireBlockedOffer)
	case startup:
		containUpdaterPanic("showing the startup prompt", u.fireFirstOffer)
	}
}

// checkPanicError is the state a check that panicked before deciding leaves
// behind. Not a registry answer, so the prompt shows it as an error rather
// than as "not published yet".
const checkPanicError = "the update check failed unexpectedly; it will be retried"

// recoverCheck contains a panic in check (#760) and picks the state it leaves.
// It is a terminal decision because nothing above check can make one: check is
// fire-and-forget, with no connection to fail closed into (the asymmetry #670
// drew for the read loop's register_rejected) and no caller to report to.
//
// Undecided (the panic came before the result was recorded): the check is
// treated as one that could not reach the registry, which is what it is from
// the outside. The version is unavailable with checkPanicError, the brain and
// the tray are told (and a blocked sidecar still gets its prompt), and the
// retry timer is armed, so the version is checked
// again on updateRetryInterval as well as on the next ack and on Start --
// rather than nothing at all until a reconnect. Two exceptions, the same as
// the registry-error path: an offer an earlier check already confirmed is
// kept, and the state of an update that is installing is not overwritten.
// A superseded check (another advertise since) changes nothing.
//
// Decided (the panic came after the result was recorded): the state is
// already accurate and is left alone. The hooks that run then are each
// contained in announce, so this is only for a panic outside them; a hook that
// panicked lost only its own delivery (a prompt under its sync.Once is lost
// for this process, a missed emit or tray refresh waits for the next change).
func (u *Updater) recoverCheck(gen int, version string, recorded *bool) {
	r := recover()
	if r == nil {
		return
	}
	if *recorded {
		log.Printf("[update] after checking sidecar %s, telling the brain or the UI panicked; the offer state "+
			"stands: %v\n%s", version, r, debug.Stack())
		return
	}
	log.Printf("[update] checking sidecar %s panicked; treating it as a failed check and retrying in %s: %v\n%s",
		version, updateRetryInterval, r, debug.Stack())
	report, blocked, apply := func() (*UpdateState, bool, bool) {
		u.mu.Lock()
		defer u.mu.Unlock()
		if gen != u.checkGen || u.available == version {
			return nil, false, false
		}
		u.available = ""
		var report *UpdateState
		if !u.applying.Load() {
			s := UpdateState{Phase: updatePhaseUnavailable, Version: version, Error: checkPanicError}
			u.state = s
			report = &s
		}
		// Defensive: check records its result straight after arming a retry,
		// so an undecided check never armed one of its own. What can be here
		// is the timer that fired this very retry; stopping it is harmless,
		// and it keeps "at most one armed" true by construction.
		if u.cancelRetry != nil {
			cancel := u.cancelRetry
			u.cancelRetry = nil
			containUpdaterPanic("cancelling the previous retry", cancel)
		}
		containUpdaterPanic("arming the retry", func() {
			u.cancelRetry = u.schedule(updateRetryInterval, func() { u.check(gen, version, true) })
		})
		return report, u.blocked, true
	}()
	if !apply {
		return
	}
	// As on the registry-error path: a sidecar the brain refused cannot work
	// until updated, so it gets its prompt whatever the check found.
	u.announce(report, blocked, false)
}

// containUpdaterPanic runs f and logs a panic in it instead of letting it out.
// For the follow-up work a recover does itself, which runs in a deferred
// function where a second panic would no longer be contained by anything.
func containUpdaterPanic(what string, f func()) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[update] %s panicked: %v\n%s", what, r, debug.Stack())
		}
	}()
	f()
}

func (u *Updater) report(s *UpdateState) {
	if s != nil && u.emit != nil {
		u.emit(*s)
	}
}

func (u *Updater) fireFirstOffer() {
	u.firstOffer.Do(func() {
		if u.onFirstOffer != nil {
			u.onFirstOffer(u.Offer())
		}
	})
}

func (u *Updater) fireBlockedOffer() {
	u.blockedOffer.Do(func() {
		if u.onFirstOffer != nil {
			u.onFirstOffer(u.Offer())
		}
	})
}

func (u *Updater) changed() {
	if u.onChange != nil {
		u.onChange(u.Offer())
	}
}

// Offer snapshots what the prompt / tray should show.
func (u *Updater) Offer() UpdateOffer {
	u.mu.Lock()
	defer u.mu.Unlock()
	return UpdateOffer{Version: u.available, Blocked: u.blocked, Current: u.running, State: u.state}
}

func (u *Updater) setState(s UpdateState) {
	u.mu.Lock()
	u.state = s
	u.mu.Unlock()
	if u.emit != nil {
		u.emit(s)
	}
	u.changed()
}

// ManualCommand is what the user can run themselves when an automatic
// update is impossible or failed.
func (u *Updater) ManualCommand(version string) string {
	if version == "" {
		version = "latest"
	}
	switch {
	case u.mode.Kind == update.ModePackageManager && runtime.GOOS == "windows":
		// Windows keeps the running exe locked inside the package tree.
		return "Quit Jarvis first, then run: " + update.PackageManagerHint(u.mode.PackageManager, version)
	case u.mode.Kind == update.ModePackageManager:
		return update.PackageManagerHint(u.mode.PackageManager, version)
	case runtime.GOOS == "windows" || runtime.GOOS == "darwin":
		return "Download and run the installer: " + installerDownloadURL
	case u.mode.Kind == update.ModeNative && update.ValidVersion(version):
		// A binary copied into place by hand: `bun add -g` would install a
		// second copy and leave this one (the one autostart runs) outdated.
		if pkg, err := update.PlatformPackage(); err == nil {
			return fmt.Sprintf("Replace %s with bin/jarvis from %s-%s@%s (npm pack %s-%s@%s)",
				update.ExecutableIn(u.mode.InstallDir), update.PackageName, pkg, version, update.PackageName, pkg, version)
		}
		return update.PackageManagerHint("bun", version)
	default:
		return update.PackageManagerHint("bun", version)
	}
}

// ErrUpdateBusy is returned when an update is already being installed.
var ErrUpdateBusy = errors.New("an update is already in progress")

// Start installs the available update in the background. version, when not
// empty, must match what this sidecar itself confirmed: the caller (the
// brain, via update_apply) cannot pick a different one.
func (u *Updater) Start(version string) error {
	u.mu.Lock()
	target := u.available
	latest := u.latest
	sinceFailure := u.now().Sub(u.failedAt)
	u.mu.Unlock()
	// Not confirmed yet (the registry check is still running, or found
	// nothing an hour ago and has not retried): check again right now rather
	// than make the user wait for the retry.
	recheck := target == "" && u.updatable() && update.StrictlyNewer(latest, u.running) &&
		(!update.IsPrerelease(latest) || update.IsPrerelease(u.running))
	if recheck {
		target = latest
	}
	if target == "" {
		return fmt.Errorf("no sidecar update is available")
	}
	if version != "" && version != target {
		return fmt.Errorf("requested sidecar %s, but the available update is %s", version, target)
	}
	if sinceFailure < u.cooldown {
		return ErrUpdateCooldown
	}
	if !u.applying.CompareAndSwap(false, true) {
		return ErrUpdateBusy
	}
	if recheck {
		go u.checkThenApply(target)
	} else {
		go u.apply(target)
	}
	return nil
}

// ErrUpdateCooldown refuses a retry right after a failed attempt.
var ErrUpdateCooldown = errors.New("the last attempt just failed; try again in a few seconds")

// checkThenApply confirms version on the registry, then installs it. Called
// with applying already set.
func (u *Updater) checkThenApply(version string) {
	if _, err := u.resolve(u.registry, version); err != nil {
		u.applying.Store(false)
		u.setState(registryStateFor(version, err))
		return
	}
	u.mu.Lock()
	if u.latest == version {
		u.available = version
	}
	u.mu.Unlock()
	u.apply(version)
}

// apply runs one update attempt. On success the process hands off to the new
// binary and exits (applying stays set until then); on failure it keeps
// running the current version and reports the failure with a manual command.
func (u *Updater) apply(version string) {
	handedOff := false
	defer func() {
		if !handedOff {
			u.applying.Store(false)
		}
	}()
	if !update.StrictlyNewer(version, u.running) {
		u.fail(version, fmt.Errorf("sidecar %s is not newer than the running %s", version, u.running))
		return
	}
	ctx := context.Background()
	switch u.mode.Kind {
	case update.ModeNative:
		handedOff = u.applyNative(ctx, version)
	case update.ModePackageManager:
		handedOff = u.applyPackageManager(ctx, version)
	default:
		u.fail(version, fmt.Errorf("this sidecar cannot update itself: %s", u.mode.Reason))
	}
}

func (u *Updater) applyNative(ctx context.Context, version string) bool {
	u.setState(UpdateState{Phase: updatePhaseDownloading, Version: version})
	rel, err := u.resolve(u.registry, version)
	if err != nil {
		u.fail(version, err)
		return false
	}
	dir := u.mode.InstallDir
	if err := u.install(ctx, rel, dir, func(phase string) {
		u.setState(UpdateState{Phase: phase, Version: version})
	}); err != nil {
		u.fail(version, err)
		return false
	}
	if err := update.RefreshRegistration(dir, version); err != nil {
		log.Printf("[update] could not refresh the uninstall entry: %v", err)
	}
	u.setState(UpdateState{Phase: updatePhaseRestarting, Version: version})
	if err := u.markPending(dir, u.running, version); err != nil {
		log.Printf("[update] could not record the pending update (no startup rollback): %v", err)
	}
	if err := u.handOff(update.ExecutableIn(dir)); err != nil {
		u.clearPending()
		rbErr := update.Rollback(dir)
		if rbErr != nil {
			err = fmt.Errorf("%w (and restoring the previous version failed: %v)", err, rbErr)
		}
		_ = update.RefreshRegistration(dir, u.running)
		u.fail(version, fmt.Errorf("the new sidecar did not start: %w", err))
		return false
	}
	return true
}

func (u *Updater) applyPackageManager(ctx context.Context, version string) bool {
	u.setState(UpdateState{Phase: updatePhaseInstalling, Version: version})
	args, pathEnv, err := u.pmResolve(u.mode.PackageManager, version)
	if err != nil {
		u.fail(version, err)
		return false
	}
	// Windows will not let a package manager overwrite the executable this
	// process is running from, but it does allow moving it aside.
	restore, err := moveRunningExeAside(u.exe)
	if err != nil {
		u.fail(version, err)
		return false
	}
	runCtx, cancel := context.WithTimeout(ctx, packageManagerTimeout)
	err = u.pmRun(runCtx, args, pathEnv)
	cancel()
	if err != nil {
		err = fmt.Errorf("%s failed: %w", filepath.Base(args[0]), err)
	} else if err = u.verifyPM(u.exe); err != nil {
		// Before the new binary is executed at all, not even for --version.
		err = fmt.Errorf("code-signature verification of the installed sidecar failed: %w", err)
	} else {
		var got string
		got, err = u.verBin(u.exe)
		if err == nil && got != version {
			err = fmt.Errorf("%s reports %q after the update, want %s", filepath.Base(u.exe), got, version)
		}
	}
	if err != nil {
		restore()
		u.fail(version, err)
		return false
	}
	u.setState(UpdateState{Phase: updatePhaseRestarting, Version: version})
	if err := u.handOff(u.exe); err != nil {
		restore()
		u.fail(version, fmt.Errorf("the new sidecar did not start: %w", err))
		return false
	}
	return true
}

func (u *Updater) fail(version string, err error) {
	log.Printf("[update] updating to sidecar %s failed: %v", version, err)
	u.mu.Lock()
	u.failedAt = u.now()
	u.mu.Unlock()
	u.setState(UpdateState{
		Phase:         updatePhaseFailed,
		Version:       version,
		Error:         err.Error(),
		ManualCommand: u.ManualCommand(version),
	})
}

// cleanupPrevious drops the copy a previous self-update kept for rollback,
// once this process has proven itself by registering with the brain.
//
// It runs on its own goroutine from OnAck, so nothing above it recovers a
// panic: before #760 one ended the process. A contained panic sets `cleaned`
// back to false, so the next accepted registration in this process tries
// again, and that is the state to fall back to because of what this proves:
// clearing the pending-update marker is how a fresh self-update is marked
// healthy (update_pending.go), and a marker left behind by a panic that was
// recorded as done would get a good update rolled back after three starts.
// Both steps are idempotent (removing a file, a directory), so a retry is
// safe; one that panics every time costs a logged stack per reconnect, not
// the process.
func (u *Updater) cleanupPrevious() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[update] cleaning up after the previous update panicked; retrying on the next registration: %v\n%s",
				r, debug.Stack())
			u.mu.Lock()
			u.cleaned = false
			u.mu.Unlock()
		}
	}()
	// A closure with a deferred unlock: the panic above must never be
	// recovered with u.mu still held (see advertise).
	if done := func() bool {
		u.mu.Lock()
		defer u.mu.Unlock()
		if u.cleaned {
			return true
		}
		u.cleaned = true
		return false
	}(); done {
		return
	}
	// This process reached the brain: an update that installed it is proven.
	u.clearPending()
	if u.mode.Kind == update.ModePackageManager {
		// Windows moved the running exe aside for the package manager.
		cleanupMovedExe(u.exe)
		return
	}
	if u.mode.Kind != update.ModeNative {
		return
	}
	dir := u.mode.InstallDir
	if !update.HasOld(dir) {
		return
	}
	if err := update.CleanupOld(dir); err != nil {
		log.Printf("[update] could not remove the previous version: %v", err)
		return
	}
	log.Printf("[update] removed the previous version kept for rollback")
}

// installNative downloads, verifies and swaps in rel.
func installNative(_ context.Context, rel *update.Release, installDir string, progress func(string)) error {
	work, err := os.MkdirTemp("", "jarvis-update-*")
	if err != nil {
		return fmt.Errorf("could not create a work directory: %w", err)
	}
	defer os.RemoveAll(work)
	tgz, err := update.Download(rel, work)
	if err != nil {
		return err
	}
	progress(updatePhaseVerifying)
	staged := filepath.Join(work, "staged")
	if err := update.Extract(tgz, staged); err != nil {
		return fmt.Errorf("payload rejected: %w", err)
	}
	stagedBin := filepath.Join(staged, "bin")
	if err := update.CheckPayloadLayout(stagedBin, rel.Version); err != nil {
		return err
	}
	if err := update.VerifyPayloadSignature(stagedBin); err != nil {
		return fmt.Errorf("code-signature verification failed (refusing to install an unverified sidecar): %w", err)
	}
	progress(updatePhaseInstalling)
	if err := update.Swap(stagedBin, installDir); err != nil {
		return fmt.Errorf("install failed: %w", err)
	}
	return nil
}

// runPackageManager runs args (args[0] already resolved) with pathEnv as
// PATH, folding the tail of its output into the error.
func runPackageManager(ctx context.Context, args []string, pathEnv string) error {
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	hideSubprocessWindow(cmd)
	if pathEnv != "" {
		cmd.Env = append(os.Environ(), "PATH="+pathEnv)
	}
	// npm on Windows is npm.cmd: the timeout kills cmd.exe, but node keeps
	// the output pipe open. WaitDelay stops waiting on it.
	cmd.WaitDelay = 10 * time.Second
	out, err := cmd.CombinedOutput()
	if err != nil {
		tail := strings.TrimSpace(string(out))
		if len(tail) > 600 {
			tail = "..." + tail[len(tail)-600:]
		}
		if tail != "" {
			return fmt.Errorf("%v: %s", err, tail)
		}
		return err
	}
	return nil
}

// verifyInstalledPayload checks the code signature of what a package manager
// just installed, exactly as the native path checks a downloaded payload
// (no-op on Linux, whose packages are unsigned).
func verifyInstalledPayload(exe string) error {
	dir, err := update.PayloadDirOf(exe)
	if err != nil {
		return err
	}
	return update.VerifyPayloadSignature(dir)
}

func binaryVersion(exe string) (string, error) {
	cmd := exec.Command(exe, "--version")
	hideSubprocessWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
