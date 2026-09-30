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
// manager install is recognised by its path (the npm wrapper launches the
// platform package's binary straight out of node_modules) before anything
// else, because swapping files inside a package manager's tree would leave it
// believing a version is installed that is not. Only bun's and npm's GLOBAL
// trees count: a pnpm/yarn global, an npx cache or a project's node_modules
// would not be updated by `bun add -g` / `npm install -g`, which would then
// install a second copy and leave this one outdated forever.
func DetectMode(exe string) Mode {
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	if strings.Contains(filepath.ToSlash(exe), "/node_modules/") {
		if underDir(exe, bunGlobalModules()) {
			return Mode{Kind: ModePackageManager, PackageManager: "bun"}
		}
		if underDir(exe, npmGlobalModules()) {
			return Mode{Kind: ModePackageManager, PackageManager: "npm"}
		}
		return Mode{Kind: ModeManual, Reason: "installed in a node_modules tree that neither bun's nor npm's global install manages"}
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
// read-only mounts and macOS app-translocation. The name is unique, so a
// probe left behind by a crash cannot make the next check fail.
func canWriteDir(dir string) bool {
	f, err := os.CreateTemp(dir, ".jarvis-update-probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}

// underDir reports whether path lies inside dir (both symlink-resolved when
// possible; case-insensitive on Windows).
func underDir(path, dir string) bool {
	if dir == "" {
		return false
	}
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = resolved
	}
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	return rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

// bundleInstallDir is the macOS layout: <dir>/Jarvis.app/Contents/MacOS/jarvis
// installs into <dir>. Pure path logic, kept platform-neutral for the tests.
func bundleInstallDir(exe string) (string, error) {
	macOS := filepath.Dir(exe)
	contents := filepath.Dir(macOS)
	bundle := filepath.Dir(contents)
	if filepath.Base(exe) != "jarvis" || filepath.Base(macOS) != "MacOS" ||
		filepath.Base(contents) != "Contents" || filepath.Base(bundle) != AppBundleName {
		return "", fmt.Errorf("not running from %s (%s)", AppBundleName, exe)
	}
	return filepath.Dir(bundle), nil
}

// exeInstallDir is the single-binary layout (Windows, Linux): the directory
// the binary sits in, when it has the expected name (case-insensitively on
// Windows).
func exeInstallDir(exe, name string, foldCase bool) (string, error) {
	base := filepath.Base(exe)
	if base != name && !(foldCase && strings.EqualFold(base, name)) {
		return "", fmt.Errorf("unexpected executable name %q", base)
	}
	return filepath.Dir(exe), nil
}
