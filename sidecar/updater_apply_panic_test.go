package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jarvis/sidecar/internal/update"
)

// #842. #760 contained panics in the goroutines the updater starts from an ack,
// but not the two Start runs an install on: apply and checkThenApply. A panic
// in either ended the process, and on Windows a package-manager update had
// already moved the running exe out of the package tree by then, so the panic
// skipped the restore and left no jarvis.exe where autostart looks for it.
//
// These call the goroutine bodies directly (with applying set, as Start does)
// and catch what escapes, so before the fix they FAIL with "panic escaped"
// instead of aborting the test binary the way the production goroutine aborts
// the sidecar.

// pmUpdaterWithAside is a package-manager updater whose "move the running exe
// aside" is recorded: restores counts the calls of the restore it hands back.
// The real move is a no-op off Windows, so this is what makes the restore
// observable on Linux.
func pmUpdaterWithAside(t *testing.T) (*fakeUpdater, *atomic.Int32) {
	t.Helper()
	f := newFakeUpdater(t, "0.9.7", update.Mode{Kind: update.ModePackageManager, PackageManager: "bun"})
	f.verBin = func(string) (string, error) { return "0.10.0", nil }
	var restores atomic.Int32
	f.moveAside = func(string) (func() error, error) {
		return func() error { restores.Add(1); return nil }, nil
	}
	return f, &restores
}

// assertFailedAndIdle is the state every contained apply panic must leave: the
// attempt reported as failed with a command to run by hand, the cooldown armed
// (so a looping caller cannot retry it back to back), applying cleared so the
// update can be tried again, and nothing handed off.
func assertFailedAndIdle(t *testing.T, f *fakeUpdater) {
	t.Helper()
	o := offerWithin(t, f.Updater)
	if o.State.Phase != updatePhaseFailed || o.State.Version != "0.10.0" ||
		o.State.Error != applyPanicError || o.State.ManualCommand == "" {
		t.Errorf("state after a contained apply panic = %+v, want failed for 0.10.0 with %q and a manual command",
			o.State, applyPanicError)
	}
	if f.applying.Load() {
		t.Error("applying is still set: no update can be started again in this process")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failedAt.IsZero() {
		t.Error("failedAt not set: the retry cooldown is not armed")
	}
	if len(f.handedOff) != 0 {
		t.Errorf("handed off to %v after a panic", f.handedOff)
	}
}

// A panic anywhere between moving the running exe aside and handing off puts
// it back exactly once.
func TestUpdaterPackageManagerApplyPanicRestoresTheRunningExe(t *testing.T) {
	cases := map[string]func(f *fakeUpdater){
		"package manager": func(f *fakeUpdater) {
			f.pmRun = func(context.Context, []string, string) error { panic("pmRun") }
		},
		"signature check": func(f *fakeUpdater) {
			f.verifyPM = func(string) error { panic("verifyPM") }
		},
		"version probe": func(f *fakeUpdater) {
			f.verBin = func(string) (string, error) { panic("verBin") }
		},
		"hand-off": func(f *fakeUpdater) {
			f.handOff = func(string) error { panic("handOff") }
		},
		// The restarting report runs after the payload checked out and before
		// the hand-off.
		"restarting report": func(f *fakeUpdater) {
			f.emit = func(s UpdateState) {
				if s.Phase == updatePhaseRestarting {
					panic("emit")
				}
			}
		},
	}
	for name, inject := range cases {
		t.Run(name, func(t *testing.T) {
			f, restores := pmUpdaterWithAside(t)
			inject(f)
			f.applying.Store(true)
			if r := escaped(func() { f.apply("0.10.0") }); r != nil {
				t.Fatalf("panic escaped apply: %v", r)
			}
			if n := restores.Load(); n != 1 {
				t.Errorf("the running exe was restored %d times, want 1", n)
			}
			assertFailedAndIdle(t, f)
		})
	}
}

// A panic AFTER the explicit restore of a failed attempt (here: reporting
// that failure) must not restore a second time. On Windows a second restore
// would move whatever is now at the exe path aside again.
func TestUpdaterPackageManagerApplyPanicAfterRestoreDoesNotRestoreAgain(t *testing.T) {
	f, restores := pmUpdaterWithAside(t)
	f.pmRun = func(context.Context, []string, string) error { return errors.New("EACCES") }
	var panicked atomic.Bool
	f.emit = func(s UpdateState) {
		if s.Phase == updatePhaseFailed && panicked.CompareAndSwap(false, true) {
			panic("emit")
		}
	}
	f.applying.Store(true)
	if r := escaped(func() { f.apply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped apply: %v", r)
	}
	if !panicked.Load() {
		t.Fatal("the failure report never ran: the test did not exercise the path it is about")
	}
	if n := restores.Load(); n != 1 {
		t.Errorf("the running exe was restored %d times, want 1", n)
	}
	if f.applying.Load() {
		t.Error("applying is still set after a contained panic")
	}
}

// A successful hand-off is final: nothing after it may restore, and applying
// stays set until the process exits (#760's TestUpdaterStaysBusyAfterHandOff
// covers the non-panic half).
func TestUpdaterPackageManagerApplyHandOffSucceedsWithoutRestore(t *testing.T) {
	f, restores := pmUpdaterWithAside(t)
	f.applying.Store(true)
	if r := escaped(func() { f.apply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped apply: %v", r)
	}
	if n := restores.Load(); n != 0 {
		t.Errorf("restored %d times after a successful hand-off", n)
	}
	if !f.applying.Load() {
		t.Error("applying cleared after a successful hand-off")
	}
}

// Native: a panic after the payload was swapped in but before the hand-off
// rolls the swap back, the same as a hand-off that fails, so the state that
// says "failed" is not sitting on top of a half-finished update.
func TestUpdaterNativeApplyPanicAfterSwapRollsBack(t *testing.T) {
	skipOnBundlePayload(t)
	mode := nativeMode(t)
	live := filepath.Join(mode.InstallDir, filepath.Base(update.ExecutableIn(mode.InstallDir)))
	if err := os.WriteFile(live, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	f := newFakeUpdater(t, "0.9.7", mode)
	f.published["0.10.0"] = true
	f.install = func(_ context.Context, _ *update.Release, dir string, _ func(string)) error {
		staged := t.TempDir()
		if err := os.WriteFile(filepath.Join(staged, filepath.Base(live)), []byte("new"), 0755); err != nil {
			return err
		}
		return update.Swap(staged, dir)
	}
	var cleared atomic.Int32
	f.clearPending = func() { cleared.Add(1) }
	f.markPending = func(string, string, string) error { panic("markPending") }
	f.applying.Store(true)
	if r := escaped(func() { f.apply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped apply: %v", r)
	}
	if b, _ := os.ReadFile(live); string(b) != "old" {
		t.Errorf("live copy after a contained panic = %q, want the previous version rolled back", b)
	}
	if cleared.Load() == 0 {
		t.Error("the pending-update marker was not cleared")
	}
	assertFailedAndIdle(t, f)
}

// Native: a panic BEFORE anything was swapped (in the download) has nothing to
// roll back, and must not try: Rollback with a leftover .old from an earlier
// update would put that older copy in place of the one running now.
func TestUpdaterNativeApplyPanicBeforeSwapLeavesTheInstallAlone(t *testing.T) {
	mode := nativeMode(t)
	live := filepath.Join(mode.InstallDir, filepath.Base(update.ExecutableIn(mode.InstallDir)))
	if err := os.WriteFile(live, []byte("current"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(live+".old", []byte("older"), 0755); err != nil {
		t.Fatal(err)
	}
	f := newFakeUpdater(t, "0.9.7", mode)
	f.published["0.10.0"] = true
	f.install = func(context.Context, *update.Release, string, func(string)) error { panic("download") }
	f.applying.Store(true)
	if r := escaped(func() { f.apply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped apply: %v", r)
	}
	if b, _ := os.ReadFile(live); string(b) != "current" {
		t.Errorf("live copy = %q, want it untouched", b)
	}
	assertFailedAndIdle(t, f)
}

// checkThenApply: the registry lookup runs before apply, outside anything
// apply defers, so a panic there left applying set for good even if the
// process had survived it.
func TestUpdaterCheckThenApplyPanicClearsApplying(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.resolve = func(string, string) (*update.Release, error) { panic("registry") }
	f.applying.Store(true)
	if r := escaped(func() { f.checkThenApply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped checkThenApply: %v", r)
	}
	assertFailedAndIdle(t, f)
}

// skipOnBundlePayload skips a test that stages a single-file payload: on macOS
// the payload is the Jarvis.app bundle directory, so Swap would refuse it.
func skipOnBundlePayload(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "darwin" {
		t.Skip("the darwin payload is a bundle directory")
	}
}

// The cooldown is armed BEFORE applying clears: a Start that slips in between
// would otherwise begin a new attempt with no cooldown at all. Observed from
// the failure report itself, which is the moment failedAt has just been set.
func TestUpdaterApplyPanicReportsTheFailureBeforeClearingApplying(t *testing.T) {
	f, _ := pmUpdaterWithAside(t)
	f.pmRun = func(context.Context, []string, string) error { panic("pmRun") }
	var applyingAtReport, reported atomic.Bool
	f.emit = func(s UpdateState) {
		if s.Phase == updatePhaseFailed {
			applyingAtReport.Store(f.applying.Load())
			reported.Store(true)
		}
	}
	f.applying.Store(true)
	if r := escaped(func() { f.apply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped apply: %v", r)
	}
	if !reported.Load() {
		t.Fatal("the failure was never reported")
	}
	if !applyingAtReport.Load() {
		t.Error("applying was cleared before the failure (and its cooldown) was recorded")
	}
	if f.applying.Load() {
		t.Error("applying is still set after the attempt ended")
	}
}

// A restore that does not work must not be reported as "still installed".
func TestUpdaterApplyPanicReportsAFailedRestore(t *testing.T) {
	cases := map[string]func() error{
		"restore errors": func() error { return errors.New("access denied") },
		"restore panics": func() error { panic("restore") },
	}
	for name, restore := range cases {
		t.Run(name, func(t *testing.T) {
			f, _ := pmUpdaterWithAside(t)
			f.moveAside = func(string) (func() error, error) { return restore, nil }
			f.pmRun = func(context.Context, []string, string) error { panic("pmRun") }
			f.applying.Store(true)
			if r := escaped(func() { f.apply("0.10.0") }); r != nil {
				t.Fatalf("panic escaped apply: %v", r)
			}
			s := offerWithin(t, f.Updater).State
			if s.Phase != updatePhaseFailed || !strings.HasPrefix(s.Error, applyPanicRestoreError) {
				t.Errorf("state = %+v, want failed with %q", s, applyPanicRestoreError)
			}
			if strings.Contains(s.Error, "still installed") {
				t.Errorf("error %q claims the current version is still installed", s.Error)
			}
			if f.applying.Load() {
				t.Error("applying is still set after a contained panic")
			}
		})
	}
}

// Native, the same for a rollback that cannot run: here the .old copy is gone
// by the time the panic is handled.
func TestUpdaterNativeApplyPanicReportsAFailedRollback(t *testing.T) {
	skipOnBundlePayload(t)
	mode := nativeMode(t)
	live := filepath.Join(mode.InstallDir, filepath.Base(update.ExecutableIn(mode.InstallDir)))
	if err := os.WriteFile(live, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	f := newFakeUpdater(t, "0.9.7", mode)
	f.published["0.10.0"] = true
	f.install = func(_ context.Context, _ *update.Release, dir string, _ func(string)) error {
		staged := t.TempDir()
		if err := os.WriteFile(filepath.Join(staged, filepath.Base(live)), []byte("new"), 0755); err != nil {
			return err
		}
		return update.Swap(staged, dir)
	}
	f.markPending = func(string, string, string) error {
		if err := os.Remove(live + ".old"); err != nil {
			t.Errorf("removing .old: %v", err)
		}
		panic("markPending")
	}
	f.applying.Store(true)
	if r := escaped(func() { f.apply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped apply: %v", r)
	}
	s := offerWithin(t, f.Updater).State
	if s.Phase != updatePhaseFailed || !strings.HasPrefix(s.Error, applyPanicRestoreError) {
		t.Errorf("state = %+v, want failed with %q", s, applyPanicRestoreError)
	}
}

// Native hand-off panic: rolled back like a hand-off that returned an error.
func TestUpdaterNativeHandOffPanicRollsBack(t *testing.T) {
	skipOnBundlePayload(t)
	mode := nativeMode(t)
	live := filepath.Join(mode.InstallDir, filepath.Base(update.ExecutableIn(mode.InstallDir)))
	if err := os.WriteFile(live, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	f := newFakeUpdater(t, "0.9.7", mode)
	f.published["0.10.0"] = true
	f.install = func(_ context.Context, _ *update.Release, dir string, _ func(string)) error {
		staged := t.TempDir()
		if err := os.WriteFile(filepath.Join(staged, filepath.Base(live)), []byte("new"), 0755); err != nil {
			return err
		}
		return update.Swap(staged, dir)
	}
	f.handOff = func(string) error { panic("handOff") }
	f.applying.Store(true)
	if r := escaped(func() { f.apply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped apply: %v", r)
	}
	if b, _ := os.ReadFile(live); string(b) != "old" {
		t.Errorf("live copy = %q, want the previous version rolled back", b)
	}
	if s := offerWithin(t, f.Updater).State; s.Error != applyPanicError {
		t.Errorf("error = %q, want %q", s.Error, applyPanicError)
	}
}

// A restore that panics while the ordinary error path runs it (the package
// manager failed, then putting the exe back blew up) must not be reported as
// "still installed" either.
func TestUpdaterRestorePanicOnTheErrorPathIsReportedAsAFailedRestore(t *testing.T) {
	f, _ := pmUpdaterWithAside(t)
	f.moveAside = func(string) (func() error, error) {
		return func() error { panic("restore") }, nil
	}
	f.pmRun = func(context.Context, []string, string) error { return errors.New("EACCES") }
	f.applying.Store(true)
	if r := escaped(func() { f.apply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped apply: %v", r)
	}
	s := offerWithin(t, f.Updater).State
	if s.Phase != updatePhaseFailed || !strings.HasPrefix(s.Error, applyPanicRestoreError) {
		t.Errorf("state = %+v, want failed with %q", s, applyPanicRestoreError)
	}
	if f.applying.Load() {
		t.Error("applying is still set after a contained panic")
	}
}

// Guards against the naive half-fix: clearing applying in the error branch AND in finishApply.
// checkThenApply's registry failure must clear applying exactly once, after
// its report: a Start that wins the flag while that report is being delivered
// owns it, and the first attempt's end must not clear it from under it (two
// attempts would then be able to run at once).
func TestUpdaterCheckThenApplyDoesNotClearTheNextAttemptsFlag(t *testing.T) {
	f := newFakeUpdater(t, "0.9.7", nativeMode(t))
	f.resolve = func(string, string) (*update.Release, error) { return nil, errors.New("registry unreachable") }
	var secondWon atomic.Bool
	f.emit = func(s UpdateState) {
		if s.Phase == updatePhaseUnavailable {
			// What Start does: take the flag if it is free.
			secondWon.Store(f.applying.CompareAndSwap(false, true))
		}
	}
	f.applying.Store(true)
	if r := escaped(func() { f.checkThenApply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped checkThenApply: %v", r)
	}
	if secondWon.Load() && !f.applying.Load() {
		t.Fatal("a second attempt took the flag during the report, and the first attempt's end cleared it")
	}
	if !secondWon.Load() && f.applying.Load() {
		t.Fatal("applying is still set after a failed registry check")
	}
}

// The restore failed on the ordinary error path (it returned an error), then
// reporting that failure panicked in a hook. The failure was already recorded
// with the restore error in it, and must not be replaced by a generic "still
// installed".
func TestUpdaterHookPanicAfterAFailedRestoreKeepsTheRestoreFailure(t *testing.T) {
	f, _ := pmUpdaterWithAside(t)
	f.moveAside = func(string) (func() error, error) {
		return func() error { return errors.New("access denied") }, nil
	}
	f.pmRun = func(context.Context, []string, string) error { return errors.New("EACCES") }
	var panicked atomic.Bool
	f.emit = func(s UpdateState) {
		if s.Phase == updatePhaseFailed && panicked.CompareAndSwap(false, true) {
			panic("emit")
		}
	}
	f.applying.Store(true)
	if r := escaped(func() { f.apply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped apply: %v", r)
	}
	if !panicked.Load() {
		t.Fatal("the failure report never ran: the test did not exercise the path it is about")
	}
	s := offerWithin(t, f.Updater).State
	if s.Phase != updatePhaseFailed || strings.Contains(s.Error, "still installed") ||
		!strings.Contains(s.Error, "restoring the previous version failed: access denied") {
		t.Errorf("state = %+v, want failed naming the failed restore, never \"still installed\"", s)
	}
	if f.applying.Load() {
		t.Error("applying is still set after a contained panic")
	}
}

// The restore failed on the ordinary error path, then the panic came BEFORE
// the failure was recorded (here: the clock fail reads). Nothing specific was
// recorded, so the contained panic reports the failed restore itself.
func TestUpdaterPanicBeforeReportingAFailedRestoreReportsTheRestoreFailure(t *testing.T) {
	f, _ := pmUpdaterWithAside(t)
	f.moveAside = func(string) (func() error, error) {
		return func() error { return errors.New("access denied") }, nil
	}
	f.pmRun = func(context.Context, []string, string) error { return errors.New("EACCES") }
	var panicked atomic.Bool
	base := f.now
	f.now = func() time.Time {
		if panicked.CompareAndSwap(false, true) {
			panic("clock")
		}
		return base()
	}
	f.applying.Store(true)
	if r := escaped(func() { f.apply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped apply: %v", r)
	}
	s := offerWithin(t, f.Updater).State
	if s.Phase != updatePhaseFailed || !strings.HasPrefix(s.Error, applyPanicRestoreError) ||
		!strings.Contains(s.Error, "access denied") {
		t.Errorf("state = %+v, want failed with %q naming the restore error", s, applyPanicRestoreError)
	}
	if f.applying.Load() {
		t.Error("applying is still set after a contained panic")
	}
}

// A hook panic after the specific failure was recorded keeps that failure:
// the generic panic text would hide the real cause (mirrors check's recorded).
func TestUpdaterHookPanicAfterTheFailureWasRecordedKeepsIt(t *testing.T) {
	f, restores := pmUpdaterWithAside(t)
	f.pmRun = func(context.Context, []string, string) error { return errors.New("EACCES") }
	f.emit = func(s UpdateState) {
		if s.Phase == updatePhaseFailed {
			panic("emit")
		}
	}
	f.applying.Store(true)
	if r := escaped(func() { f.apply("0.10.0") }); r != nil {
		t.Fatalf("panic escaped apply: %v", r)
	}
	s := offerWithin(t, f.Updater).State
	if s.Phase != updatePhaseFailed || !strings.Contains(s.Error, "EACCES") || s.ManualCommand == "" {
		t.Errorf("state = %+v, want the recorded EACCES failure kept", s)
	}
	if n := restores.Load(); n != 1 {
		t.Errorf("restored %d times, want 1", n)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failedAt.IsZero() {
		t.Error("failedAt not set")
	}
}
