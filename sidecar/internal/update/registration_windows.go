//go:build windows

package update

import (
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// UninstallKeyPath is where Jarvis-Setup registers the app (Apps & features).
const UninstallKeyPath = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Jarvis`

// RefreshRegistration keeps the uninstall entry's DisplayVersion in step with
// a self-update. The installer reads DisplayVersion first when deciding what
// is installed, so a stale value would have it "update" a sidecar that is
// already current. Only an entry that points at installDir is touched: a
// sidecar copied elsewhere by hand must not rewrite the installer's record.
func RefreshRegistration(installDir, version string) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, UninstallKeyPath, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return nil // not installed by Jarvis-Setup: nothing to keep in step
	}
	defer k.Close()
	loc, _, err := k.GetStringValue("InstallLocation")
	if err != nil || !strings.EqualFold(filepath.Clean(loc), filepath.Clean(installDir)) {
		return nil
	}
	return k.SetStringValue("DisplayVersion", version)
}
