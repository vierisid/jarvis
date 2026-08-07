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

// The darwin npm package only started shipping Jarvis.app at
// minBundledSidecarVersion; earlier ones carry a bare binary that cannot
// notify or hold TCC grants. The installer must refuse those — and must say so
// in terms of the PACKAGE rather than blaming the signature. The first real
// macOS test run reported "code-signature verification failed" for exactly
// this case, which sends the reader after a signing bug that does not exist.
func TestBundledSidecarVersionFloor(t *testing.T) {
	for _, v := range []string{"0.8.0", "0.9.0"} {
		if !versionLess(v, minBundledSidecarVersion) {
			t.Errorf("%s predates the Jarvis.app bundle and must be refused", v)
		}
	}
	for _, v := range []string{minBundledSidecarVersion, "0.9.2", "1.0.0"} {
		if versionLess(v, minBundledSidecarVersion) {
			t.Errorf("%s ships the bundle and must be accepted", v)
		}
	}
}
