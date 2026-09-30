package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jarvis/sidecar/internal/update"
)

// fakeUpdater is an Updater with every side effect replaced: the registry
// answers from `published`, installs and hand-offs are recorded, and retries
// are captured instead of scheduled.
type fakeUpdater struct {
	*Updater
	mu        sync.Mutex
	published map[string]bool
	installed []string
	handedOff []string
	pmArgs    [][]string
	emitted   []UpdateState
	offers    []UpdateOffer
	retries   []func()
	settled   chan struct{}
}

func newFakeUpdater(t *testing.T, running string, mode update.Mode) *fakeUpdater {
	t.Helper()
	f := &fakeUpdater{published: map[string]bool{}, settled: make(chan struct{}, 16)}
	u := &Updater{running: running, registry: "https://registry.invalid", exe: "/opt/jarvis/jarvis", mode: mode}
	u.resolve = func(_, v string) (*update.Release, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if !f.published[v] {
			return nil, fmt.Errorf("x@%s: %w", v, update.ErrVersionNotFound)
		}
		return &update.Release{Version: v}, nil
	}
	u.install = func(_ context.Context, rel *update.Release, dir string, progress func(string)) error {
		progress(updatePhaseVerifying)
		progress(updatePhaseInstalling)
		f.mu.Lock()
		f.installed = append(f.installed, rel.Version)
		f.mu.Unlock()
		return nil
	}
	u.pmRun = func(_ context.Context, args []string) error {
		f.mu.Lock()
		f.pmArgs = append(f.pmArgs, args)
		f.mu.Unlock()
		return nil
	}
	u.verBin = func(string) (string, error) { return "", errors.New("unset") }
	u.handOff = func(exe string) error {
		f.mu.Lock()
		f.handedOff = append(f.handedOff, exe)
		f.mu.Unlock()
		return nil
	}
	u.schedule = func(_ time.Duration, fn func()) func() {
		f.mu.Lock()
		f.retries = append(f.retries, fn)
		f.mu.Unlock()
		return func() {}
	}
	u.emit = func(s UpdateState) {
		f.mu.Lock()
		f.emitted = append(f.emitted, s)
		f.mu.Unlock()
		if s.Phase == updatePhaseFailed || s.Phase == updatePhaseRestarting {
			f.settled <- struct{}{}
		}
	}
	u.onChange = func(UpdateOffer) {}
	u.onFirstOffer = func(o UpdateOffer) {
		f.mu.Lock()
		f.offers = append(f.offers, o)
		f.mu.Unlock()
		f.settled <- struct{}{}
	}
	f.Updater = u
	return f
}

func (f *fakeUpdater) waitSettled(t *testing.T) {
	t.Helper()
	select {
	case <-f.settled:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the updater")
	}
}

// waitUntil polls cond: OnAck's registry check runs on its own goroutine.
func waitUntil(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func nativeMode(t *testing.T) update.Mode {
	return update.Mode{Kind: update.ModeNative, InstallDir: t.TempDir()}
}

func TestUpdaterOffersPublishedNewerVersionOnce(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.published["0.10.0"] = true

	f.OnAck("0.10.0")
	f.waitSettled(t)
	if o := f.Offer(); o.Version != "0.10.0" || o.Blocked {
		t.Fatalf("offer = %+v, want 0.10.0 not blocked", o)
	}
	// A reconnect re-advertises the same version: the startup prompt must not
	// fire a second time in one process.
	f.OnAck("0.10.0")
	waitUntil(t, func() bool { return f.Offer().Version == "0.10.0" })
	time.Sleep(20 * time.Millisecond)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.offers) != 1 {
		t.Errorf("startup offer fired %d times, want 1", len(f.offers))
	}
}

// The brain only suggests: an older or equal version, a garbage one, or any
// version offered to a dev build is never an update.
func TestUpdaterIgnoresNonUpdates(t *testing.T) {
	cases := []struct{ running, latest string }{
		{"0.9.7", "0.9.7"},
		{"0.9.7", "0.9.6"},
		{"0.9.7", ""},
		{"0.9.7", "not-a-version"},
		{"dev", "0.10.0"},
	}
	for _, c := range cases {
		f := newFakeUpdater(t, c.running, nativeMode(t))
		f.published[c.latest] = true
		f.OnAck(c.latest)
		time.Sleep(20 * time.Millisecond)
		if o := f.Offer(); o.Version != "" {
			t.Errorf("running %s, latest %q: offered %q", c.running, c.latest, o.Version)
		}
		if err := f.Start(c.latest); err == nil {
			t.Errorf("running %s, latest %q: Start accepted", c.running, c.latest)
		}
	}
}

// A brain released before its paired sidecar finished publishing advertises
// a version npm does not have yet: nothing is offered until a retry finds it.
func TestUpdaterRetriesUnpublishedVersion(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.OnAck("0.10.0")
	waitUntil(t, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.retries) == 1
	})
	if o := f.Offer(); o.Version != "" || o.State.Phase != updatePhaseUnavailable {
		t.Fatalf("offer before publish = %+v, want unavailable", o)
	}

	f.mu.Lock()
	f.published["0.10.0"] = true
	retry := f.retries[0]
	f.mu.Unlock()
	retry()
	if o := f.Offer(); o.Version != "0.10.0" {
		t.Fatalf("offer after retry = %+v, want 0.10.0", o)
	}
}

func TestUpdaterBlockedAlwaysOffers(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.published["0.10.0"] = true
	f.OnRejected("0.10.0")
	f.waitSettled(t)
	if o := f.Offer(); o.Version != "0.10.0" || !o.Blocked {
		t.Fatalf("offer = %+v, want blocked 0.10.0", o)
	}

	// A brain that predates self-update rejects without a version: the prompt
	// still has to appear, with nothing to install but a manual command.
	g := newFakeUpdater(t, "0.9.7", nativeMode(t))
	g.OnRejected("")
	g.waitSettled(t)
	if o := g.Offer(); o.Version != "" || !o.Blocked {
		t.Fatalf("offer = %+v, want blocked without a version", o)
	}
}

func TestUpdaterNativeApplyHandsOffToInstalledBinary(t *testing.T) {
	mode := nativeMode(t)
	f := newFakeUpdater(t, "0.9.7", mode)
	f.published["0.10.0"] = true
	f.OnAck("0.10.0")
	f.waitSettled(t)

	// The brain cannot pick another version than the one the sidecar confirmed.
	if err := f.Start("0.11.0"); err == nil {
		t.Fatal("Start accepted a version other than the available one")
	}
	if err := f.Start("0.10.0"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	f.waitSettled(t)

	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.installed) != 1 || f.installed[0] != "0.10.0" {
		t.Errorf("installed = %v", f.installed)
	}
	if want := update.ExecutableIn(mode.InstallDir); len(f.handedOff) != 1 || f.handedOff[0] != want {
		t.Errorf("handed off to %v, want %s", f.handedOff, want)
	}
	var phases []string
	for _, s := range f.emitted {
		phases = append(phases, s.Phase)
	}
	if got := strings.Join(phases, ","); got != "downloading,verifying,installing,restarting" {
		t.Errorf("phases = %s", got)
	}
}

func TestUpdaterRejectsConcurrentApply(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.published["0.10.0"] = true
	f.OnAck("0.10.0")
	f.waitSettled(t)

	release := make(chan struct{})
	f.install = func(context.Context, *update.Release, string, func(string)) error {
		<-release
		return nil
	}
	if err := f.Start(""); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	if err := f.Start(""); !errors.Is(err, ErrUpdateBusy) {
		t.Errorf("second Start = %v, want ErrUpdateBusy", err)
	}
	close(release)
	f.waitSettled(t)
}

// If the new binary does not come up, the previous one is put back and the
// failure carries a command the user can run instead.
func TestUpdaterRollsBackWhenHandOffFails(t *testing.T) {
	mode := nativeMode(t)
	live := filepath.Join(mode.InstallDir, filepath.Base(update.ExecutableIn(mode.InstallDir)))
	f := newFakeUpdater(t, "0.9.7", mode)
	f.published["0.10.0"] = true
	f.OnAck("0.10.0")
	f.waitSettled(t)

	// A real Swap, so there is an .old to roll back to.
	f.install = func(_ context.Context, _ *update.Release, dir string, _ func(string)) error {
		staged := t.TempDir()
		if err := os.WriteFile(filepath.Join(staged, filepath.Base(live)), []byte("new"), 0755); err != nil {
			return err
		}
		return update.Swap(staged, dir)
	}
	if err := os.WriteFile(live, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	f.handOff = func(string) error { return errors.New("exited immediately") }

	if err := f.Start(""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	// "restarting" is reported before the hand-off fails, then "failed".
	waitUntil(t, func() bool { return f.Offer().State.Phase == updatePhaseFailed })
	o := f.Offer()
	if o.State.Phase != updatePhaseFailed || o.State.ManualCommand == "" {
		t.Fatalf("state = %+v, want failed with a manual command", o.State)
	}
	if b, _ := os.ReadFile(live); string(b) != "old" {
		t.Errorf("live copy after rollback = %q, want old", b)
	}
	// The update stays on offer for another try.
	if o.Version != "0.10.0" {
		t.Errorf("offer after failure = %q, want 0.10.0", o.Version)
	}
}

func TestUpdaterPackageManagerApply(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", update.Mode{Kind: update.ModePackageManager, PackageManager: "bun"})
	f.published["0.10.0"] = true
	f.verBin = func(string) (string, error) { return "0.10.0", nil }
	f.OnAck("0.10.0")
	f.waitSettled(t)

	if err := f.Start("0.10.0"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	f.waitSettled(t)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.pmArgs) != 1 || strings.Join(f.pmArgs[0], " ") != "bun add -g @usejarvis/sidecar@0.10.0" {
		t.Errorf("package manager ran %v", f.pmArgs)
	}
	if len(f.handedOff) != 1 || f.handedOff[0] != f.exe {
		t.Errorf("handed off to %v, want %s", f.handedOff, f.exe)
	}
}

// A failing package manager is reported with the exact command to run by hand.
func TestUpdaterPackageManagerFailureGivesCommand(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", update.Mode{Kind: update.ModePackageManager, PackageManager: "npm"})
	f.published["0.10.0"] = true
	f.pmRun = func(context.Context, []string) error { return errors.New("EACCES: permission denied") }
	f.OnAck("0.10.0")
	f.waitSettled(t)

	if err := f.Start(""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	f.waitSettled(t)
	s := f.Offer().State
	if s.Phase != updatePhaseFailed || !strings.Contains(s.Error, "EACCES") {
		t.Fatalf("state = %+v, want failed with the npm error", s)
	}
	if s.ManualCommand != "npm install -g @usejarvis/sidecar@0.10.0" {
		t.Errorf("manual command = %q", s.ManualCommand)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.handedOff) != 0 {
		t.Error("handed off after a failed package-manager update")
	}
}

// A package manager that exits 0 but leaves the old binary in place (another
// global tree, a pinned version) must not restart into the same version.
func TestUpdaterPackageManagerVersionMismatchFails(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", update.Mode{Kind: update.ModePackageManager, PackageManager: "bun"})
	f.published["0.10.0"] = true
	f.verBin = func(string) (string, error) { return "0.9.7", nil }
	f.OnAck("0.10.0")
	f.waitSettled(t)
	if err := f.Start(""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	f.waitSettled(t)
	if s := f.Offer().State; s.Phase != updatePhaseFailed {
		t.Fatalf("state = %+v, want failed", s)
	}
}

func TestUpdaterFeatures(t *testing.T) {
	dev := newFakeUpdater(t, "dev", nativeMode(t))
	if f := dev.Features(); len(f) != 0 {
		t.Errorf("dev build features = %v, want none", f)
	}
	manual := newFakeUpdater(t, "0.9.7", update.Mode{Kind: update.ModeManual, Reason: "ro"})
	for _, f := range manual.Features() {
		if f == featureUpdateApply {
			t.Error("manual install advertises update_apply")
		}
	}
	native := newFakeUpdater(t, "0.9.7", nativeMode(t))
	found := false
	for _, f := range native.Features() {
		found = found || f == featureUpdateApply
	}
	if !found {
		t.Error("native install does not advertise update_apply")
	}
}
