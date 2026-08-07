// The Jarvis sidecar installer/updater/uninstaller.
//
// One binary, three modes: a GUI wizard (the default on Windows and macOS),
// --silent for headless install/update with frozen exit codes, and
// --uninstall. The payload is never embedded: the installer resolves the
// latest sidecar from the npm registry (the project's canonical channel),
// downloads the platform package tarball, verifies its sha512 AND its code
// signature, and only then installs.
//
// Boundaries (see code-signing/ in the usejarvis-docs repo):
//   - Enrollment is strictly the sidecar's concern: this program has no
//     --token flag and never reads or writes ~/.jarvis.
//   - It never requests OS permissions (macOS TCC grants bind to the
//     requesting bundle); it launches the installed Jarvis.app --setup.
package main

import (
	"flag"
	"fmt"
	"os"
)

// installerVersion is stamped by the build: -X main.installerVersion=$(VERSION).
var installerVersion = "dev"

// Exit codes for --silent (frozen contract from v1; the sidecar's future
// self-update path scripts against these):
//
//	0 installed / updated / already current
//	2 network or registry failure
//	3 payload verification failed (hash or code signature)
//	4 could not stop the running sidecar
//	5 filesystem failure (permissions, disk, swap)
//	1 anything else
const (
	exitOK           = 0
	exitOther        = 1
	exitNetwork      = 2
	exitVerification = 3
	exitStopFailed   = 4
	exitFilesystem   = 5
)

func main() {
	silent := flag.Bool("silent", false, "Install/update headlessly (exit codes: 0 ok, 2 network, 3 verify, 4 stop, 5 fs, 1 other)")
	uninstall := flag.Bool("uninstall", false, "Remove the installed sidecar")
	noLaunch := flag.Bool("no-launch", false, "Do not launch the sidecar after install/update")
	noAutostart := flag.Bool("no-autostart", false, "Do not register the sidecar to start at login (Windows; macOS decides in Jarvis's own setup)")
	showVersion := flag.Bool("version", false, "Print the installer version and exit")
	registryURL := flag.String("registry-url", defaultRegistryURL, "npm registry base URL (tests only)")
	flag.Parse()

	if *showVersion {
		fmt.Println(installerVersion)
		os.Exit(exitOK)
	}

	switch {
	// uninstallModeByDefault: the retained uninstaller copy (Windows
	// uninstall.exe / macOS "Uninstall Jarvis.app") gets no arguments when
	// double-clicked, and must never fall through to the install wizard.
	case *uninstall || uninstallModeByDefault():
		os.Exit(runUninstall(*silent))
	case *silent || !guiSupported():
		os.Exit(runInstall(*registryURL, *silent, *noLaunch, !*noAutostart))
	default:
		os.Exit(runWizard(*registryURL, *noLaunch, !*noAutostart))
	}
}
