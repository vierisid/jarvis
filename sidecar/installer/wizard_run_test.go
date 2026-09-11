package main

// The wizard's state machine, driven through the same calls the page makes,
// with the registry, detection and install faked. Neither decision pinned here
// is visible on the page: whether Retry can plan again after a failed install,
// and what code the process exits with however the window is closed.

import (
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeWizard struct {
	fetchErr error
	inst     installedSidecar
	// installs is the outcome of each install, in call order.
	installs []installOutcome

	mu    sync.Mutex
	calls int
}

func (f *fakeWizard) run() *wizardRun {
	return newWizardRun(wizardDeps{
		fetchLatest: func() (*pkgRelease, error) {
			if f.fetchErr != nil {
				return nil, f.fetchErr
			}
			return &pkgRelease{Version: "0.9.2"}, nil
		},
		detect: func() (installedSidecar, error) { return f.inst, nil },
		install: func(progressFn) installOutcome {
			f.mu.Lock()
			defer f.mu.Unlock()
			out := f.installs[f.calls]
			f.calls++
			return out
		},
		applyAutostart: func(string, bool) error { return nil },
	}, wizardState{Phase: "resolving", Platform: "windows"})
}

// waitPhase polls the way the page does until the run reaches phase.
func waitPhase(t *testing.T, r *wizardRun, phase string) wizardState {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		st := r.progress()
		if st.Phase == phase {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatalf("phase = %q after 5s, want %q (error %q)", st.Phase, phase, st.Error)
		}
		time.Sleep(time.Millisecond)
	}
}

// The failed screen's only way forward is Retry, and after a failed INSTALL it
// used to do nothing: the flag that stops a second install was never cleared,
// and retryPlan refused to run while it was set.
func TestWizardRetryAfterAFailedInstall(t *testing.T) {
	f := &fakeWizard{
		inst: installedSidecar{Version: "0.9.1", InstallDir: "/apps"},
		installs: []installOutcome{
			{Code: exitNetwork, Err: errors.New("download failed")},
			{Code: exitOK, Inst: installedSidecar{Version: "0.9.1"}, InstallDir: "/apps"},
		},
	}
	r := f.run()
	r.startPlan()
	waitPhase(t, r, "plan")

	r.startInstall(true)
	if st := waitPhase(t, r, "failed"); st.Error != "download failed" {
		t.Fatalf("failed screen says %q, want the install's error", st.Error)
	}

	r.retryPlan()
	if st := waitPhase(t, r, "plan"); st.Error != "" {
		t.Errorf("the retried plan still shows the failed install's error %q", st.Error)
	}
	r.startInstall(true)
	waitPhase(t, r, "done")

	if code := r.wait(); code != exitOK {
		t.Errorf("exit code = %d after the retried install succeeded, want %d", code, exitOK)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.calls != 2 {
		t.Errorf("install ran %d times, want 2", f.calls)
	}
}

func TestWizardExitCode(t *testing.T) {
	cases := []struct {
		name     string
		fetchErr error
		inst     installedSidecar
		install  *installOutcome // run an install that ends like this
		cancel   bool            // then press the secondary button
		want     int
	}{
		// Nothing to install: benign however the window is closed, as in the
		// console flow.
		{name: "window closed on the bun/npm screen", inst: installedSidecar{PackageManager: "bun"}, want: exitOK},
		{name: "window closed when already current", inst: installedSidecar{Version: "0.9.2", InstallDir: "/apps"}, want: exitOK},
		{name: "Close on the already-current screen", inst: installedSidecar{Version: "0.9.2", InstallDir: "/apps"}, cancel: true, want: exitOK},
		// Something to install that was not installed.
		{name: "Cancel before updating", inst: installedSidecar{Version: "0.9.1", InstallDir: "/apps"}, cancel: true, want: exitOther},
		{name: "window closed before installing", want: exitOther},
		{name: "registry unreachable", fetchErr: errors.New("offline"), want: exitOther},
		// A finished install reports how it ended.
		{name: "install failed", install: &installOutcome{Code: exitVerification, Err: errors.New("bad signature")}, want: exitVerification},
		{name: "install succeeded", install: &installOutcome{Code: exitOK, InstallDir: "/apps"}, want: exitOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &fakeWizard{fetchErr: c.fetchErr, inst: c.inst}
			if c.install != nil {
				f.installs = []installOutcome{*c.install}
			}
			r := f.run()
			r.startPlan()
			if c.fetchErr != nil {
				waitPhase(t, r, "failed")
			} else {
				waitPhase(t, r, "plan")
			}
			if c.install != nil {
				r.startInstall(false)
				if c.install.Err != nil {
					waitPhase(t, r, "failed")
				} else {
					waitPhase(t, r, "done")
				}
			}
			if c.cancel {
				r.closeInstaller(false)
			}
			if got := r.wait(); got != c.want {
				t.Errorf("exit code = %d, want %d", got, c.want)
			}
		})
	}
}
