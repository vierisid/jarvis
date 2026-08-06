//go:build windows

package main

// Full uninstall: stop the sidecar, then remove — in dependency order — the
// Start Menu shortcut, the autostart Run value, the notification identity
// (AppUserModelId + jarvis:// protocol class, registered by the sidecar at
// every startup), the uninstall key, and finally the install directory via a
// detached self-delete. ~/.jarvis is prompted separately (default keep) and
// even on consent only the sidecar-owned files go — the directory is shared
// with the brain.

import (
	"golang.org/x/sys/windows/registry"

	"github.com/jarvis/sidecar/internal/autostart"
)

// notifyAUMID mirrors the sidecar's notify_windows.go registration.
const notifyAUMID = "Jarvis.Sidecar"

func runUninstall(silent bool) int {
	inst, err := detectInstalled()
	if err != nil || inst.InstallDir == "" {
		logf("no installed sidecar found")
		if !silent {
			notify("Uninstall Jarvis", "Jarvis does not appear to be installed for this user.", false)
		}
		return exitOK
	}

	// Launched from Settings → Apps there is no console, so confirm (and
	// report, below) with dialogs.
	if !silent && !confirm("Uninstall Jarvis",
		"Remove Jarvis from this computer?\n\n"+inst.InstallDir) {
		return exitOK
	}

	if err := stopRunningSidecar(inst, silent); err != nil {
		logf("could not stop the running sidecar: %v", err)
		if !silent {
			notify("Uninstall Jarvis", "Could not stop the running Jarvis sidecar:\n\n"+err.Error(), true)
		}
		return exitStopFailed
	}

	// Start Menu shortcut.
	if lnk, err := startMenuLnkPath(); err == nil {
		removeIgnoreMissing(lnk)
	}
	// Autostart Run value (shared logic with the sidecar's own registration).
	if err := autostart.Set("", false); err != nil {
		logf("warning: could not remove the autostart entry: %v", err)
	}
	// Notification identity the sidecar re-registers each startup.
	deleteKeyTree(registry.CURRENT_USER, `Software\Classes\AppUserModelId\`+notifyAUMID)
	deleteKeyTree(registry.CURRENT_USER, `Software\Classes\jarvis\shell\open\command`)
	deleteKeyTree(registry.CURRENT_USER, `Software\Classes\jarvis\shell\open`)
	deleteKeyTree(registry.CURRENT_USER, `Software\Classes\jarvis\shell`)
	deleteKeyTree(registry.CURRENT_USER, `Software\Classes\jarvis`)
	// The uninstall entry itself.
	deleteKeyTree(registry.CURRENT_USER, uninstallKeyPath)

	maybeRemoveConfig(silent)

	// Validate before announcing anything, so a refusal reports honestly.
	if err := validateRemovableInstallDir(inst.InstallDir); err != nil {
		logf("refusing to remove %s: %v", inst.InstallDir, err)
		if !silent {
			notify("Uninstall Jarvis",
				"Jarvis was unregistered, but its files could not be removed:\n\n"+
					inst.InstallDir+"\n\n"+err.Error(), true)
		}
		return exitFilesystem
	}

	// The completion dialog MUST come before scheduling the self-delete:
	// notify() is modal and blocks until the user clicks OK, while the
	// scheduled rmdir runs on a ~2s fuse sized to outlive this process — not a
	// dialog someone reads. Scheduling first would delete the tree while
	// uninstall.exe is still the running image, leaving the directory behind
	// after telling the user it was removed.
	logf("Jarvis has been uninstalled.")
	if !silent {
		notify("Uninstall Jarvis", "Jarvis has been uninstalled.", false)
	}

	logf("removing %s", inst.InstallDir)
	if err := scheduleSelfDelete(inst.InstallDir); err != nil {
		logf("could not schedule directory removal: %v — delete %s manually", err, inst.InstallDir)
		return exitFilesystem
	}
	return exitOK
}

// deleteKeyTree removes a key and (one level of) subkeys — the trees we own
// are shallow and enumerated deepest-first by the caller.
func deleteKeyTree(root registry.Key, path string) {
	if err := registry.DeleteKey(root, path); err != nil && err != registry.ErrNotExist {
		// Non-empty or absent — callers pass children first, so this is
		// best-effort cleanup, not an error worth failing the uninstall over.
		logf("note: could not remove registry key %s: %v", path, err)
	}
}
