//go:build darwin

package update

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// payloadEntry is what the darwin package ships under bin/ and what an
// install directory holds: the whole Jarvis.app bundle.
const payloadEntry = AppBundleName

// expectedTeamID pins codesign verification to our Developer ID team; stamped
// at release with
// -X github.com/jarvis/sidecar/internal/update.expectedTeamID=<TEAMID>.
// Empty (dev builds) verifies the signature chain only, with a loud warning.
var expectedTeamID = ""

// ExecutableIn is the sidecar binary inside an install directory.
func ExecutableIn(installDir string) string {
	return filepath.Join(installDir, AppBundleName, "Contents", "MacOS", "jarvis")
}

// CheckPayloadLayout rejects a package that predates the Jarvis.app bundle.
func CheckPayloadLayout(stagedBin, version string) error {
	if _, err := os.Stat(filepath.Join(stagedBin, AppBundleName)); err == nil {
		return nil
	}
	if VersionLess(version, MinBundledSidecarVersion) {
		return fmt.Errorf(
			"sidecar %s ships a bare binary, not the %s bundle this installer requires "+
				"(macOS notifications and permission grants both need the bundle). "+
				"The npm 'latest' tag has to reach %s or newer before this installer can be used",
			version, AppBundleName, MinBundledSidecarVersion)
	}
	return fmt.Errorf("sidecar %s should contain %s but does not — the published package looks malformed",
		version, AppBundleName)
}

// VerifyPayloadSignature runs Gatekeeper's own checks on the staged bundle.
// With expectedTeamID set (release builds) the codesign requirement pins the
// Developer ID team, so a valid-but-foreign signature is refused.
func VerifyPayloadSignature(stagedBin string) error {
	app := filepath.Join(stagedBin, AppBundleName)
	args := []string{"--verify", "--deep", "--strict", app}
	if expectedTeamID != "" {
		req := fmt.Sprintf(`anchor apple generic and certificate leaf[subject.OU] = "%s"`, expectedTeamID)
		args = []string{"--verify", "--deep", "--strict", "-R=" + req, app}
	} else {
		Logf("warning: no pinned team id in this build — verifying signature chain only")
	}
	if out, err := exec.Command("codesign", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("codesign: %v — %s", err, strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command("spctl", "--assess", "--type", "execute", app).CombinedOutput(); err != nil {
		return fmt.Errorf("spctl assessment refused the app: %v — %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// installDirOf maps a running executable to its install directory: the
// directory holding Jarvis.app, when exe is <dir>/Jarvis.app/Contents/MacOS/jarvis.
func installDirOf(exe string) (string, error) { return bundleInstallDir(exe) }
