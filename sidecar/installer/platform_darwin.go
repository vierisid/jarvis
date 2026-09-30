//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jarvis/sidecar/internal/autostart"
	"github.com/jarvis/sidecar/internal/update"
)

const appBundleName = update.AppBundleName

// installDirDefault prefers /Applications, falling back to ~/Applications for
// non-admin users.
func installDirDefault() (string, error) {
	if canWriteDir("/Applications") {
		return "/Applications", nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "Applications")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return dir, nil
}

func canWriteDir(dir string) bool {
	probe := filepath.Join(dir, ".jarvis-installer-probe")
	f, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0600)
	if err != nil {
		return false
	}
	f.Close()
	os.Remove(probe)
	return true
}

var plistVersionRe = regexp.MustCompile(`<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>`)

// detectInstalled looks for Jarvis.app in /Applications then ~/Applications,
// reading the version straight from Info.plist. A global bun/npm install of
// the package marks the machine as npm-managed (we defer to it rather than
// fight it).
func detectInstalled() (installedSidecar, error) {
	var inst installedSidecar
	candidates := []string{"/Applications"}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, "Applications"))
	}
	for _, dir := range candidates {
		plist := filepath.Join(dir, appBundleName, "Contents", "Info.plist")
		raw, err := os.ReadFile(plist)
		if err != nil {
			continue
		}
		if m := plistVersionRe.FindSubmatch(raw); m != nil {
			inst.Version = strings.TrimSpace(string(m[1]))
			inst.InstallDir = dir
			return inst, nil
		}
	}
	// No bundle install — a global bun/npm @usejarvis/sidecar owns this
	// machine instead? (Positive identification only: a bare `jarvis` on PATH
	// could be the brain CLI.)
	inst.PackageManager = sidecarPackageManager()
	return inst, nil
}

// stopRunningSidecar SIGTERMs any jarvis process running from the installed
// bundle (main.go handles SIGTERM cleanly), waits up to 15s, then SIGKILLs.
func stopRunningSidecar(inst installedSidecar, _ bool) error {
	if inst.InstallDir == "" {
		return nil
	}
	binPath := filepath.Join(inst.InstallDir, appBundleName, "Contents", "MacOS", "jarvis")
	pids, err := pidsForExecutable(binPath)
	if err != nil || len(pids) == 0 {
		return nil // not running (or unknowable — the swap will surface it)
	}
	logf("stopping running sidecar (pid %v)...", pids)
	for _, pid := range pids {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if left, _ := pidsForExecutable(binPath); len(left) == 0 {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	for _, pid := range pids {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	time.Sleep(500 * time.Millisecond)
	if left, _ := pidsForExecutable(binPath); len(left) != 0 {
		return fmt.Errorf("sidecar still running (pid %v)", left)
	}
	return nil
}

// pidsForExecutable matches running processes by full command path.
func pidsForExecutable(binPath string) ([]int, error) {
	out, err := exec.Command("pgrep", "-f", binPath).Output()
	if err != nil {
		// pgrep exits 1 on no matches.
		return nil, nil
	}
	var pids []int
	for _, line := range strings.Fields(string(out)) {
		if pid, err := strconv.Atoi(line); err == nil && pid != os.Getpid() {
			pids = append(pids, pid)
		}
	}
	return pids, nil
}

// launchInstalled opens the installed app; on first install it hands off to
// the --setup onboarding wizard (permissions must be requested by Jarvis.app
// itself — TCC grants bind to the requesting bundle).
func launchInstalled(installDir, version string, firstInstall bool) error {
	app := filepath.Join(installDir, appBundleName)
	if firstInstall && setupHandoffAllowed(version) {
		return exec.Command("open", "-a", app, "--args", "--setup").Start()
	}
	return exec.Command("open", "-a", app).Start()
}

// runUninstall removes Jarvis.app, the LaunchAgent, and the retained
// uninstaller; ~/.jarvis is prompted (default keep). TCC entries are inert
// residue — pointed out for power users rather than reset behind their back.
func runUninstall(silent bool) int {
	inst, err := detectInstalled()
	if err != nil || inst.InstallDir == "" {
		logf("no installed Jarvis.app found")
		if !silent {
			notify("Uninstall Jarvis", "Jarvis does not appear to be installed.", false)
		}
		return exitOK
	}
	// Double-clicked from Finder there is no console — confirm with a dialog.
	if !silent && !confirm("Uninstall Jarvis",
		"Remove Jarvis from this Mac?\n\n"+filepath.Join(inst.InstallDir, appBundleName)) {
		return exitOK
	}
	if err := stopRunningSidecar(inst, silent); err != nil {
		logf("could not stop the running sidecar: %v", err)
		if !silent {
			notify("Uninstall Jarvis", "Could not stop the running Jarvis sidecar:\n\n"+err.Error(), true)
		}
		return exitStopFailed
	}

	if plist, err := autostart.PlistPath(); err == nil {
		removeIgnoreMissing(plist)
	}
	app := filepath.Join(inst.InstallDir, appBundleName)
	logf("removing %s", app)
	if err := os.RemoveAll(app); err != nil {
		logf("could not remove %s: %v", app, err)
		if !silent {
			notify("Uninstall Jarvis", "Could not remove:\n\n"+app+"\n\n"+err.Error(), true)
		}
		return exitFilesystem
	}

	maybeRemoveConfig(silent)
	logf("Jarvis has been uninstalled. (Permission entries can be cleared with: tccutil reset All com.jarvis.sidecar)")
	if !silent {
		notify("Uninstall Jarvis",
			"Jarvis has been uninstalled.\n\nmacOS keeps its (now inert) privacy entries; "+
				"clear them any time with:\ntccutil reset All com.jarvis.sidecar", false)
	}

	// The retained uninstaller is usually the bundle we're running from, so it
	// can only go once this process exits. Pass the path as $0 rather than
	// splicing it into the script — no quoting/expansion hazard.
	if retained, err := retainedUninstallerPath(); err == nil {
		if os.RemoveAll(retained) != nil {
			_ = exec.Command("/bin/sh", "-c", `sleep 2; rm -rf "$0"`, retained).Start()
		}
	}
	return exitOK
}

// applyAutostart is a no-op on macOS: the sidecar's --setup wizard owns the
// login-item choice (launched on first install), keeping one decision point.
func applyAutostart(string, bool) error { return nil }
