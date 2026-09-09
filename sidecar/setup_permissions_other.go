//go:build !darwin

package main

// Non-darwin stubs for the --setup onboarding wizard. Windows has no TCC
// equivalent — desktop apps only trip the global privacy toggles, so the
// wizard shows the autostart choice plus a mic-settings deep link. Linux has
// neither; the wizard is autostart-only.

import (
	"fmt"
	"os/exec"
	"runtime"
)

// setupPermissionStatuses: no per-app permission model here — every row is
// "not applicable" and the wizard hides them.
func setupPermissionStatuses() (notif, mic, screen, ax string) {
	return "na", "na", "na", "na"
}

func setupRequestPermission(string) {}

// setupOpenPane deep-links the Windows microphone privacy page; there is no
// pane to open elsewhere.
func setupOpenPane(name string) error {
	if runtime.GOOS == "windows" && name == "microphone" {
		return startPaneLauncher(exec.Command("rundll32", "url.dll,FileProtocolHandler", "ms-settings:privacy-microphone"))
	}
	return fmt.Errorf("no settings pane for %q on this platform", name)
}

// setupPermissionGrant: the Windows microphone page is the ONE thing there is
// to open here, and it is worth opening precisely because its status is
// unreadable. Windows governs desktop-app mic access with a single global
// switch, and with it off the capture just fails - no in-the-moment prompt
// arrives to rescue the user, which is why a link they can visit beforehand
// earns its place even though no row can ever go green.
func setupPermissionGrant(name string) string {
	if runtime.GOOS == "windows" && name == "microphone" {
		return grantPane
	}
	return grantNone
}

// setupProcessBundled: no bundle identity anywhere but macOS, so there is
// nothing here that could be missing. Always true.
func setupProcessBundled() bool { return true }

const setupPlatform = runtime.GOOS
