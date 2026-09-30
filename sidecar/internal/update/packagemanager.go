package update

// bun / npm global installs of @usejarvis/sidecar. A package manager owns
// its tree, so neither the installer nor the self-updater swaps files inside
// it: the installer defers to it, the sidecar runs it.

import (
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
	if home, err := os.UserHomeDir(); err == nil &&
		hasSidecarPackage(filepath.Join(home, ".bun", "install", "global", "node_modules")) {
		return "bun"
	}
	cmd := exec.Command("npm", "root", "-g")
	hideSubprocessWindow(cmd)
	if out, err := cmd.Output(); err == nil {
		if root := strings.TrimSpace(string(out)); root != "" && hasSidecarPackage(root) {
			return "npm"
		}
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
// registry's latest, for the same reason the native path does.
func PackageManagerArgs(pm, version string) []string {
	spec := PackageName + "@" + version
	if pm == "bun" {
		return []string{"bun", "add", "-g", spec}
	}
	return []string{"npm", "install", "-g", spec}
}
