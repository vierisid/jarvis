//go:build windows

package update

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// payloadEntry is the only file the win32 package ships under bin/.
const payloadEntry = WindowsExeName

// ExecutableIn is the sidecar binary inside an install directory.
func ExecutableIn(installDir string) string {
	return filepath.Join(installDir, WindowsExeName)
}

// CheckPayloadLayout rejects a package missing the executable we install, so
// a malformed publish does not surface as a signature failure.
func CheckPayloadLayout(stagedBin, version string) error {
	if _, err := os.Stat(filepath.Join(stagedBin, WindowsExeName)); err != nil {
		return fmt.Errorf("sidecar %s should contain %s but does not — the published package looks malformed",
			version, WindowsExeName)
	}
	return nil
}

// installDirOf maps a running executable to its install directory: the
// directory jarvis.exe sits in.
func installDirOf(exe string) (string, error) {
	if !strings.EqualFold(filepath.Base(exe), WindowsExeName) {
		return "", fmt.Errorf("unexpected executable name %q", filepath.Base(exe))
	}
	return filepath.Dir(exe), nil
}
