package update

// bun / npm global installs of @usejarvis/sidecar. A package manager owns
// its tree, so neither the installer nor the self-updater swaps files inside
// it: the installer defers to it, the sidecar runs it.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// PackageName is the wrapper package a global install is made of.
const PackageName = "@usejarvis/sidecar"

// InstalledPackageManager positively identifies a global bun- or npm-managed
// @usejarvis/sidecar and names its owner ("bun" or "npm"; "" when neither has
// it). Which one matters: they keep separate global trees, so only the
// owner's commands reach it.
func InstalledPackageManager() string {
	if root := bunGlobalModules(); root != "" && hasSidecarPackage(root) {
		return "bun"
	}
	if root := npmGlobalModules(); root != "" && hasSidecarPackage(root) {
		return "npm"
	}
	return ""
}

// hasSidecarPackage reports whether a global node_modules tree holds the
// package. It wants the package's package.json, not just its directory: a
// folder left behind by an uninstall would otherwise refuse the native install
// for good, with nothing on the screen saying why.
func hasSidecarPackage(nodeModules string) bool {
	fi, err := os.Stat(filepath.Join(nodeModules, "@usejarvis", "sidecar", "package.json"))
	return err == nil && !fi.IsDir()
}

// PackageManagerArgs is the command that installs version globally with pm
// ("bun" or "npm"). It pins the exact version rather than updating to the
// registry's latest, for the same reason the native path does. The version
// becomes part of a package spec, so only a canonical one is accepted (a URL
// or git spec would install something else entirely).
func PackageManagerArgs(pm, version string) ([]string, error) {
	if !ValidVersion(version) {
		return nil, fmt.Errorf("not a sidecar version: %q", version)
	}
	spec := PackageName + "@" + version
	if pm == "bun" {
		return []string{"bun", "add", "-g", spec}, nil
	}
	return []string{"npm", "install", "-g", spec}, nil
}

// PackageManagerHint is PackageManagerArgs for display: the command a user
// can run themselves. A version that is not canonical is shown as "latest".
func PackageManagerHint(pm, version string) string {
	if !ValidVersion(version) {
		version = "latest"
	}
	spec := PackageName + "@" + version
	if pm == "bun" {
		return "bun add -g " + spec
	}
	return "npm install -g " + spec
}

// bunGlobalModules is bun's global node_modules: $BUN_INSTALL/install/global
// when BUN_INSTALL is set, else ~/.bun/install/global.
func bunGlobalModules() string {
	root := os.Getenv("BUN_INSTALL")
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		root = filepath.Join(home, ".bun")
	}
	return filepath.Join(root, "install", "global", "node_modules")
}

// npmGlobalModules asks npm for its global node_modules. A seam for tests.
var npmGlobalModules = func() string {
	cmd := exec.Command("npm", "root", "-g")
	hideSubprocessWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
