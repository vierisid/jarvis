package update

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ModeKind says how a running sidecar can be updated.
type ModeKind string

const (
	// ModeNative: installed by Jarvis-Setup (or copied by hand) into a
	// directory this user can write — the payload is swapped in place.
	ModeNative ModeKind = "native"
	// ModePackageManager: a bun/npm global install owns the binary, so the
	// update runs that package manager.
	ModePackageManager ModeKind = "package_manager"
	// ModeManual: neither applies (unwritable location, unexpected layout);
	// the user is told what to run.
	ModeManual ModeKind = "manual"
)

// Mode is the result of DetectMode.
type Mode struct {
	Kind ModeKind
	// InstallDir is the directory Swap operates on (ModeNative only).
	InstallDir string
	// PackageManager is "bun" or "npm" (ModePackageManager only).
	PackageManager string
	// Reason explains ModeManual.
	Reason string
}

// DetectMode classifies the running executable (os.Executable()). A package
// manager install is recognised by its path — the npm wrapper launches the
// platform package's binary straight out of node_modules — before anything
// else, because swapping files inside a package manager's tree would leave it
// believing a version is installed that is not.
func DetectMode(exe string) Mode {
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	slashed := filepath.ToSlash(exe)
	if strings.Contains(slashed, "/node_modules/@usejarvis/sidecar-") {
		pm := "npm"
		if strings.Contains(slashed, "/.bun/install/global/") {
			pm = "bun"
		}
		return Mode{Kind: ModePackageManager, PackageManager: pm}
	}
	dir, err := installDirOf(exe)
	if err != nil {
		return Mode{Kind: ModeManual, Reason: err.Error()}
	}
	if !canWriteDir(dir) {
		return Mode{Kind: ModeManual, Reason: fmt.Sprintf("%s is not writable by this user", dir)}
	}
	return Mode{Kind: ModeNative, InstallDir: dir}
}

// canWriteDir probes by creating a file: permission bits alone miss ACLs,
// read-only mounts and macOS app-translocation.
func canWriteDir(dir string) bool {
	probe := filepath.Join(dir, ".jarvis-update-probe")
	f, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0600)
	if err != nil {
		return false
	}
	f.Close()
	os.Remove(probe)
	return true
}
