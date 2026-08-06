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
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", "ms-settings:privacy-microphone").Start()
	}
	return fmt.Errorf("no settings pane for %q on this platform", name)
}

const setupPlatform = runtime.GOOS
