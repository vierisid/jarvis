//go:build !windows && !darwin

package update

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectModePackageManager(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("BUN_INSTALL", "")
	prev := npmGlobalModules
	npmGlobalModules = func() string { return "/usr/lib/node_modules" }
	t.Cleanup(func() { npmGlobalModules = prev })

	cases := map[string]Mode{
		home + "/.bun/install/global/node_modules/@usejarvis/sidecar-linux-x64/bin/jarvis": {Kind: ModePackageManager, PackageManager: "bun"},
		"/usr/lib/node_modules/@usejarvis/sidecar-linux-x64/bin/jarvis":                    {Kind: ModePackageManager, PackageManager: "npm"},
	}
	for exe, want := range cases {
		if m := DetectMode(exe); m.Kind != want.Kind || m.PackageManager != want.PackageManager {
			t.Errorf("DetectMode(%q) = %+v, want %+v", exe, m, want)
		}
	}
}

// Only bun's and npm's global trees can be updated with `bun add -g` /
// `npm install -g`; any other node_modules would get a second copy installed
// beside it while it stayed outdated, so it is left to the user.
func TestDetectModeOtherNodeModulesIsManual(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("BUN_INSTALL", "")
	prev := npmGlobalModules
	npmGlobalModules = func() string { return "/usr/lib/node_modules" }
	t.Cleanup(func() { npmGlobalModules = prev })

	for _, exe := range []string{
		"/home/u/.local/share/pnpm/global/5/node_modules/@usejarvis/sidecar-linux-x64/bin/jarvis",
		"/home/u/.npm/_npx/abc123/node_modules/@usejarvis/sidecar-linux-x64/bin/jarvis",
		"/home/u/project/node_modules/@usejarvis/sidecar-linux-x64/bin/jarvis",
	} {
		if m := DetectMode(exe); m.Kind != ModeManual {
			t.Errorf("DetectMode(%q) = %+v, want manual", exe, m)
		}
	}
}

// A custom BUN_INSTALL moves bun's global tree.
func TestDetectModeHonorsBunInstall(t *testing.T) {
	root := t.TempDir()
	t.Setenv("BUN_INSTALL", root)
	prev := npmGlobalModules
	npmGlobalModules = func() string { return "" }
	t.Cleanup(func() { npmGlobalModules = prev })

	exe := root + "/install/global/node_modules/@usejarvis/sidecar-linux-x64/bin/jarvis"
	if m := DetectMode(exe); m.Kind != ModePackageManager || m.PackageManager != "bun" {
		t.Errorf("DetectMode(%q) = %+v, want bun", exe, m)
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
	if got, err := PackageManagerArgs("bun", "0.10.0"); err != nil || len(got) != 4 || got[0] != "bun" || got[3] != "@usejarvis/sidecar@0.10.0" {
		t.Errorf("bun args = %v, %v", got, err)
	}
	if got, err := PackageManagerArgs("npm", "0.10.0"); err != nil || len(got) != 4 || got[0] != "npm" || got[3] != "@usejarvis/sidecar@0.10.0" {
		t.Errorf("npm args = %v, %v", got, err)
	}
}

// The version becomes a package spec: anything but a canonical version (a
// URL, a git spec, a tag) must never reach the package manager.
func TestPackageManagerArgsRefuseNonVersions(t *testing.T) {
	for _, v := range []string{"latest", "v0.10.0", "0.10.0 ", "git+https://evil/x.git", "file:../x", "0.10.0+build", ""} {
		if got, err := PackageManagerArgs("npm", v); err == nil {
			t.Errorf("PackageManagerArgs(npm, %q) = %v, want an error", v, got)
		}
	}
}
