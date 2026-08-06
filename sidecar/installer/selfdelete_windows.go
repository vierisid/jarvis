//go:build windows

package main

// Self-delete: uninstall.exe lives inside the directory it must remove, and
// Windows won't delete a running image. Standard trick — a detached cmd.exe
// waits ~2s (ping) for this process to exit and release its lock, then
// removes the tree.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// scheduleSelfDelete detaches a cmd.exe that removes dir after we exit.
//
// SysProcAttr.CmdLine is mandatory here: Go's default argv escaping wraps the
// argument in quotes and escapes inner quotes as \" — syntax cmd.exe does not
// understand, so the rmdir would silently fail and leave the install behind.
// os/exec documents this cmd.exe exception.
func scheduleSelfDelete(dir string) error {
	if err := validateRemovableInstallDir(dir); err != nil {
		return err
	}
	cmd := exec.Command("cmd")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       `/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q "` + dir + `"`,
		CreationFlags: createNoWindow,
	}
	return cmd.Start()
}

// validateRemovableInstallDir refuses to recursively delete anything that
// isn't recognisably our install directory. InstallLocation comes from HKCU
// (same-user writable, so not a privilege boundary) but a corrupted or
// tampered value would otherwise turn uninstall into `rmdir /s /q <anything>`.
// Rejecting cmd metacharacters also keeps the path from breaking out of the
// quoted CmdLine above.
func validateRemovableInstallDir(dir string) error {
	if dir == "" {
		return fmt.Errorf("empty install directory")
	}
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("install directory %q is not absolute", dir)
	}
	if filepath.Dir(dir) == dir {
		return fmt.Errorf("refusing to remove a volume root (%q)", dir)
	}
	if strings.ContainsAny(dir, `"&|<>^%`) {
		return fmt.Errorf("install directory %q contains unsafe characters", dir)
	}
	// Must actually look like our install: one of the binaries we put there.
	for _, marker := range []string{sidecarExeName, uninstallExeName} {
		if _, err := os.Stat(filepath.Join(dir, marker)); err == nil {
			return nil
		}
	}
	return fmt.Errorf("%q does not look like a Jarvis install (no %s or %s)", dir, sidecarExeName, uninstallExeName)
}
