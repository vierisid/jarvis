//go:build !windows && !darwin

package main

// Linux (and anything else) is npm/bun territory — the installer product
// targets Windows and macOS. These stubs keep the package building everywhere
// (test.yml runs `go build ./...` on ubuntu) while the flow exits honestly.

import "fmt"

func installDirDefault() (string, error) {
	return "", fmt.Errorf("the installer supports Windows and macOS; install with: bun install -g @usejarvis/sidecar")
}

func detectInstalled() (installedSidecar, error) {
	var inst installedSidecar
	inst.ManagedByNpm = npmManagedSidecarPresent()
	if !inst.ManagedByNpm {
		return inst, fmt.Errorf("the installer supports Windows and macOS; install with: bun install -g @usejarvis/sidecar")
	}
	return inst, nil
}

func installedBinaryVersion(string) (string, error) {
	return "", fmt.Errorf("unsupported platform")
}

func stopRunningSidecar(installedSidecar, bool) error { return nil }

func checkPayloadLayout(string, string) error { return nil }

func verifyPayloadSignature(string) error {
	return fmt.Errorf("code-signature verification is not available on this platform")
}

func swapInstall(string, string) error {
	return fmt.Errorf("unsupported platform")
}

func launchInstalled(string, string, bool) error {
	return fmt.Errorf("unsupported platform")
}

func runUninstall(_ bool) int {
	logf("the installer supports Windows and macOS")
	return exitOther
}

func applyAutostart(string, bool) error { return nil }
