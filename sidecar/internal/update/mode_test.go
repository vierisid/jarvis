//go:build !windows && !darwin

package update

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectModePackageManager(t *testing.T) {
	cases := map[string]string{
		"/home/u/.bun/install/global/node_modules/@usejarvis/sidecar-linux-x64/bin/jarvis":          "bun",
		"/usr/lib/node_modules/@usejarvis/sidecar-linux-x64/bin/jarvis":                             "npm",
		"/home/u/.nvm/versions/node/v22/lib/node_modules/@usejarvis/sidecar-linux-arm64/bin/jarvis": "npm",
	}
	for exe, pm := range cases {
		m := DetectMode(exe)
		if m.Kind != ModePackageManager || m.PackageManager != pm {
			t.Errorf("DetectMode(%q) = %+v, want package manager %s", exe, m, pm)
		}
	}
}

func TestDetectModeNativeWritableDir(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "jarvis")
	if err := os.WriteFile(exe, []byte("x"), 0755); err != nil {
		t.Fatal(err)
	}
	m := DetectMode(exe)
	if m.Kind != ModeNative || m.InstallDir != dir {
		t.Fatalf("DetectMode = %+v, want native in %s", m, dir)
	}
}

func TestDetectModeManual(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can write anywhere")
	}
	dir := t.TempDir()
	ro := filepath.Join(dir, "ro")
	if err := os.MkdirAll(ro, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ro, "jarvis"), []byte("x"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(ro, 0555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(ro, 0755) })

	if m := DetectMode(filepath.Join(ro, "jarvis")); m.Kind != ModeManual || m.Reason == "" {
		t.Errorf("unwritable dir: DetectMode = %+v, want manual with a reason", m)
	}
	// `go run` / a renamed binary: not a layout we know how to swap.
	other := filepath.Join(dir, "sidecar-dev")
	if err := os.WriteFile(other, []byte("x"), 0755); err != nil {
		t.Fatal(err)
	}
	if m := DetectMode(other); m.Kind != ModeManual {
		t.Errorf("unexpected name: DetectMode = %+v, want manual", m)
	}
}

func TestPackageManagerArgsPinTheVersion(t *testing.T) {
	if got := PackageManagerArgs("bun", "0.10.0"); len(got) != 4 || got[0] != "bun" || got[3] != "@usejarvis/sidecar@0.10.0" {
		t.Errorf("bun args = %v", got)
	}
	if got := PackageManagerArgs("npm", "0.10.0"); len(got) != 4 || got[0] != "npm" || got[3] != "@usejarvis/sidecar@0.10.0" {
		t.Errorf("npm args = %v", got)
	}
}
