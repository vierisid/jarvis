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
	schedule  func(d time.Duration, f func()) func()
	now       func() time.Time
	cooldown  time.Duration

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
		now:      time.Now,
		cooldown: failureCooldown,
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
	u.mu.Lock()
	u.latest, u.blocked = latest, blocked
	u.checkGen++
	gen := u.checkGen
	if u.firstGen == 0 {
		u.firstGen = gen
	}
	if u.cancelRetry != nil {
		u.cancelRetry()
		u.cancelRetry = nil
	}
	// A release build is never moved onto a prerelease: only a sidecar that
	// is itself running one follows the brain onto rc builds.
	candidate := u.updatable() && update.StrictlyNewer(latest, u.running) &&
		(!update.IsPrerelease(latest) || update.IsPrerelease(u.running))
	if !candidate {
		u.available = ""
		if !u.applying.Load() {
			u.state = UpdateState{}
		}
	}
	u.mu.Unlock()

	if !candidate {
		u.changed()
		// A blocked sidecar with nothing installable still gets its prompt:
		// it cannot work until updated, and the prompt says how.
		if blocked && u.updatable() {
			u.fireFirstOffer()
		}
		return
	}
	go u.check(gen, latest, false)
}

// check confirms the advertised version is really published before offering
// it; a version not there yet is retried on updateRetryInterval. Only the
// process's first check may open the startup prompt: an update that becomes
// known later (a brain upgraded mid-session, a retry that finally finds the
// version) is offered by the tray and the dashboard instead of a window
// popping up in the middle of work. A blocked sidecar is the exception: it
// cannot work at all until updated.
func (u *Updater) check(gen int, version string, retry bool) {
	_, err := u.resolve(u.registry, version)

	u.mu.Lock()
	if gen != u.checkGen {
		u.mu.Unlock()
		return
	}
	startup := gen == u.firstGen && !retry
	if err != nil && u.available == version {
		// Already confirmed on an earlier check (this is a reconnect): a
		// transient registry error must not take the offer away.
		u.mu.Unlock()
		log.Printf("[update] re-check of sidecar %s failed (%v); keeping the confirmed offer", version, err)
		return
	}
	if err != nil {
		u.available = ""
		if !u.applying.Load() {
			u.state = UpdateState{Phase: updatePhaseUnavailable, Version: version, Error: err.Error()}
		}
		u.cancelRetry = u.schedule(updateRetryInterval, func() { u.check(gen, version, true) })
		blocked := u.blocked
		u.mu.Unlock()
		if !errors.Is(err, update.ErrVersionNotFound) {
			log.Printf("[update] could not check sidecar %s on the registry: %v (retrying in %s)", version, err, updateRetryInterval)
		} else {
			log.Printf("[update] sidecar %s is not published yet (retrying in %s)", version, updateRetryInterval)
		}
		u.changed()
		if blocked {
			u.fireFirstOffer()
		}
		return
	}
	u.available = version
	keepFailure := u.state.Phase == updatePhaseFailed && u.state.Version == version
	if !u.applying.Load() && !keepFailure {
		u.state = UpdateState{Phase: updatePhaseAvailable, Version: version}
	}
	blocked := u.blocked
	u.mu.Unlock()
	log.Printf("[update] sidecar %s is available (running %s)", version, u.running)
	u.changed()
	if startup || blocked {
		u.fireFirstOffer()
	}
}

func (u *Updater) fireFirstOffer() {
	u.firstOffer.Do(func() {
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
	sinceFailure := u.now().Sub(u.failedAt)
	u.mu.Unlock()
	if target == "" {
		return fmt.Errorf("no sidecar update is available")
	}
	if version != "" && version != target {
		return fmt.Errorf("requested sidecar %s, but the available update is %s", version, target)
	}
	if sinceFailure < u.cooldown {
		return fmt.Errorf("the last attempt just failed; try again in a few seconds")
	}
	if !u.applying.CompareAndSwap(false, true) {
		return ErrUpdateBusy
	}
	go u.apply(target)
	return nil
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
	if err := u.handOff(update.ExecutableIn(dir)); err != nil {
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
func (u *Updater) cleanupPrevious() {
	u.mu.Lock()
	if u.cleaned {
		u.mu.Unlock()
		return
	}
	u.cleaned = true
	u.mu.Unlock()
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
