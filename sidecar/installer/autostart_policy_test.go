package main

import "testing"

// Autostart must be applied on FIRST INSTALL ONLY. The sidecar never clears
// its Run value when the preference is off, so re-applying on update would
// silently resurrect a login item the user had disabled — a regression that
// already shipped once. Both call sites (runInstall and the wizard's
// startInstall) go through shouldApplyAutostart, which is what this pins.
func TestShouldApplyAutostart(t *testing.T) {
	cases := []struct {
		name string
		out  installOutcome
		want bool
	}{
		{"fresh install", installOutcome{Inst: installedSidecar{Version: ""}}, true},
		{"update", installOutcome{Inst: installedSidecar{Version: "0.9.0"}}, false},
		{"reinstall of same version", installOutcome{Inst: installedSidecar{Version: "0.9.1"}}, false},
		{"already current", installOutcome{UpToDate: true, Inst: installedSidecar{Version: "0.9.1"}}, false},
		// npm/bun owns this machine's sidecar — we installed nothing, so the
		// login item is not ours to register.
		{"npm managed", installOutcome{NpmManaged: true, Inst: installedSidecar{Version: ""}}, false},
	}
	for _, c := range cases {
		if got := shouldApplyAutostart(c.out); got != c.want {
			t.Errorf("%s: shouldApplyAutostart = %v, want %v", c.name, got, c.want)
		}
	}
}
