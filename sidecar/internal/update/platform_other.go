//go:build !windows && !darwin

package update

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// payloadEntry is the bare binary the linux packages ship under bin/.
const payloadEntry = "jarvis"

// ExecutableIn is the sidecar binary inside an install directory.
func ExecutableIn(installDir string) string {
	return filepath.Join(installDir, payloadEntry)
}

// CheckPayloadLayout rejects a package missing the binary.
func CheckPayloadLayout(stagedBin, version string) error {
	if _, err := os.Stat(filepath.Join(stagedBin, payloadEntry)); err != nil {
		return fmt.Errorf("sidecar %s should contain %s but does not — the published package looks malformed",
			version, payloadEntry)
	}
	return nil
}

// VerifyPayloadSignature has nothing to check on Linux: the packages are not
// code-signed, so the registry's sha512 (already enforced by Download) is the
// trust anchor — the same one `npm install` relies on. Other platforms have
// no published package at all.
func VerifyPayloadSignature(string) error {
	if runtime.GOOS == "linux" {
		return nil
	}
	return fmt.Errorf("code-signature verification is not available on %s", runtime.GOOS)
}

// installDirOf maps a running executable to its install directory: the
// directory the bare jarvis binary sits in.
func installDirOf(exe string) (string, error) {
	if filepath.Base(exe) != payloadEntry {
		return "", fmt.Errorf("unexpected executable name %q", filepath.Base(exe))
	}
	return filepath.Dir(exe), nil
}
