package main

// The install/update flow shared by console/silent mode and the GUI wizard.
// Every failure maps to one of the frozen exit codes in main.go.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// minBundledSidecarVersion is the first sidecar release whose darwin npm
// package ships the Jarvis.app bundle rather than a bare binary. Earlier
// packages cannot be installed: macOS notifications are unavailable to a bare
// binary, and TCC grants bind to a bundle identity, so installing one would
// produce a sidecar that silently cannot notify or hold permissions.
const minBundledSidecarVersion = "0.9.1"

// minSetupSidecarVersion is the first sidecar release whose flag.Parse knows
// --setup. Older sidecars hard-exit on unknown flags with a dead stderr under
// -H windowsgui, so the handoff is version-gated.
const minSetupSidecarVersion = "0.9.1"

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

// installedSidecar is what detection found on this machine.
type installedSidecar struct {
	Version      string // "" when absent
	InstallDir   string // "" when absent
	ManagedByNpm bool   // a global npm/bun install owns the sidecar here
}

// progressFn receives coarse stage updates ("download", "verify", "install")
// with a human-readable detail line. Never called concurrently.
type progressFn func(stage, detail string)

// installOutcome is performInstall's result: Code is a main.go exit code,
// Err the terminal failure (nil on success), and the flags say which of the
// no-op success paths was taken.
type installOutcome struct {
	Code       int
	Err        error
	Rel        *pkgRelease
	Inst       installedSidecar
	InstallDir string
	UpToDate   bool
	NpmManaged bool
}

// performInstall runs resolve → detect → download → verify → stop → swap →
// register. It never launches the sidecar — callers own that (console mode
// respects --no-launch; the wizard launches from its Done page).
func performInstall(registryURL string, silent bool, progress progressFn) installOutcome {
	fail := func(code int, err error) installOutcome {
		return installOutcome{Code: code, Err: err}
	}

	progress("resolve", "Checking the latest sidecar version…")
	rel, err := fetchLatestRelease(registryURL)
	if err != nil {
		return fail(exitNetwork, fmt.Errorf("could not resolve the latest sidecar: %w", err))
	}

	inst, err := detectInstalled()
	if err != nil {
		return fail(exitOther, fmt.Errorf("could not inspect the existing installation: %w", err))
	}
	out := installOutcome{Code: exitOK, Rel: rel, Inst: inst}
	switch {
	case inst.ManagedByNpm:
		out.NpmManaged = true
		return out
	case inst.Version != "" && !versionLess(inst.Version, rel.Version):
		out.UpToDate = true
		out.InstallDir = inst.InstallDir
		return out
	}

	workDir, err := os.MkdirTemp("", "jarvis-installer-*")
	if err != nil {
		return fail(exitFilesystem, fmt.Errorf("could not create a work directory: %w", err))
	}
	defer os.RemoveAll(workDir)

	progress("download", fmt.Sprintf("Downloading sidecar %s…", rel.Version))
	tgz, err := downloadTarball(rel, workDir)
	if err != nil {
		return fail(exitNetwork, err)
	}

	progress("verify", "Verifying the payload (sha512 + code signature)…")
	staged := filepath.Join(workDir, "staged")
	if err := extractPayload(tgz, staged); err != nil {
		// Guard violations mean the payload is untrustworthy (3); local I/O
		// failures (disk full, permissions) are filesystem errors (5). The
		// exit codes are a frozen contract, so don't conflate them.
		var rej errPayloadRejected
		if errors.As(err, &rej) {
			return fail(exitVerification, fmt.Errorf("payload rejected: %w", err))
		}
		return fail(exitFilesystem, fmt.Errorf("could not unpack the payload: %w", err))
	}
	stagedBin := filepath.Join(staged, "bin")
	// Layout before signature: a package that predates the current layout would
	// otherwise surface as "code-signature verification failed", sending the
	// reader after a signing problem that does not exist.
	if err := checkPayloadLayout(stagedBin, rel.Version); err != nil {
		return fail(exitVerification, err)
	}
	if err := verifyPayloadSignature(stagedBin); err != nil {
		return fail(exitVerification, fmt.Errorf("code-signature verification failed (refusing to install an unverified sidecar): %w", err))
	}

	progress("install", "Stopping the running sidecar…")
	if err := stopRunningSidecar(inst, silent); err != nil {
		return fail(exitStopFailed, fmt.Errorf("could not stop the running sidecar: %w", err))
	}

	installDir := inst.InstallDir
	if installDir == "" {
		if installDir, err = installDirDefault(); err != nil {
			return fail(exitFilesystem, fmt.Errorf("no writable install location: %w", err))
		}
	}
	progress("install", fmt.Sprintf("Installing to %s…", installDir))
	if err := swapInstall(stagedBin, installDir); err != nil {
		return fail(exitFilesystem, fmt.Errorf("install failed: %w", err))
	}
	out.InstallDir = installDir

	if got, err := installedBinaryVersion(installDir); err != nil {
		logf("warning: post-install version check failed: %v", err)
	} else if got != rel.Version {
		logf("warning: installed binary reports %q, expected %q", got, rel.Version)
	}

	// System registration (uninstall entry, Start Menu, uninstaller copy) —
	// real on Windows, no-op elsewhere.
	if err := registerInstall(installDir, rel.Version); err != nil {
		logf("warning: system registration incomplete: %v", err)
	}
	return out
}

// runInstall is the console/silent entrypoint.
func runInstall(registryURL string, silent, noLaunch, autostartOn bool) int {
	out := performInstall(registryURL, silent, func(_, detail string) { logf("%s", detail) })
	switch {
	case out.Err != nil:
		logf("%v", out.Err)
		if out.Code == exitNetwork {
			logf("(the npm registry is the only payload source — check the network and retry)")
		}
		return out.Code
	case out.NpmManaged:
		logf("this machine's sidecar is managed by npm/bun — update it with: bun update -g @usejarvis/sidecar")
		return exitOK
	case out.UpToDate:
		logf("installed sidecar %s is already current", out.Inst.Version)
		return exitOK
	}
	logf("installed sidecar %s to %s", out.Rel.Version, out.InstallDir)
	if shouldApplyAutostart(out) {
		if err := applyAutostart(out.InstallDir, autostartOn); err != nil {
			logf("warning: autostart registration failed: %v", err)
		}
	}
	if !noLaunch {
		firstInstall := out.Inst.Version == ""
		if err := launchInstalled(out.InstallDir, out.Rel.Version, firstInstall); err != nil {
			logf("warning: could not launch the sidecar: %v", err)
		}
	}
	return exitOK
}

// execCommandOutput runs a command and returns its trimmed stdout. Console
// windows are suppressed: the installer is built -H windowsgui, so an
// unhidden child would flash a black console at the user.
func execCommandOutput(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	hideSubprocessWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// shouldApplyAutostart reports whether this run may touch the login-item
// registration. FIRST INSTALL ONLY: the sidecar never clears its Run value
// when the preference is off, so re-applying on an update would silently
// resurrect a login item the user had disabled. No-op outcomes (npm-managed,
// already current) installed nothing and must not touch it either.
func shouldApplyAutostart(out installOutcome) bool {
	return !out.NpmManaged && !out.UpToDate && out.Inst.Version == ""
}

// setupHandoffAllowed gates passing --setup to the installed sidecar: older
// releases die on unknown flags.
func setupHandoffAllowed(version string) bool {
	return !versionLess(version, minSetupSidecarVersion)
}

// npmManagedSidecarPresent positively identifies a global bun/npm-managed
// @usejarvis/sidecar (package dir present in a known global tree). We defer
// to the package manager instead of installing alongside it.
func npmManagedSidecarPresent() bool {
	var candidates []string
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".bun", "install", "global", "node_modules", "@usejarvis", "sidecar"))
	}
	if out, err := execCommandOutput("npm", "root", "-g"); err == nil && out != "" {
		candidates = append(candidates, filepath.Join(out, "@usejarvis", "sidecar"))
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && fi.IsDir() {
			return true
		}
	}
	return false
}
