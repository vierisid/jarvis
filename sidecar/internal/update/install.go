package update

// Install-directory operations shared by the installer (stop → swap → launch)
// and the self-updating sidecar (swap while running → relaunch → clean up once
// the new process is healthy). The live payload entry is renamed aside rather
// than overwritten, which every platform allows even while it is executing,
// and the previous copy is kept as <entry>.old until the caller is sure it no
// longer needs to roll back.

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	// AppBundleName is the macOS payload: the whole app bundle.
	AppBundleName = "Jarvis.app"
	// WindowsExeName is the Windows payload: a single executable.
	WindowsExeName = "jarvis.exe"
	// MinBundledSidecarVersion is the first sidecar release whose darwin npm
	// package ships the Jarvis.app bundle rather than a bare binary. Earlier
	// packages cannot be installed: macOS notifications are unavailable to a
	// bare binary, and TCC grants bind to a bundle identity, so installing one
	// would produce a sidecar that silently cannot notify or hold permissions.
	MinBundledSidecarVersion = "0.9.1"
)

func livePath(installDir string) string    { return filepath.Join(installDir, payloadEntry) }
func oldPath(installDir string) string     { return livePath(installDir) + ".old" }
func stagingPath(installDir string) string { return livePath(installDir) + ".staging" }

// Swap replaces the install directory's payload entry with the staged one.
// The copy lands next to the destination first (same volume, so the final
// rename is atomic), the live entry is renamed to .old, and the staged one is
// renamed into place; a failure at the last step renames .old back. On
// success .old is KEPT: the installer drops it right away with CleanupOld, a
// running sidecar only once its replacement has proven healthy (Rollback
// otherwise).
func Swap(stagedBin, installDir string) error {
	src := filepath.Join(stagedBin, payloadEntry)
	fi, err := os.Stat(src)
	if err != nil {
		return fmt.Errorf("payload lacks %s: %w", payloadEntry, err)
	}
	dst, old, staged := livePath(installDir), oldPath(installDir), stagingPath(installDir)

	os.RemoveAll(staged)
	if fi.IsDir() {
		err = CopyTree(src, staged)
	} else {
		err = CopyFilePreserve(src, staged)
	}
	if err != nil {
		os.RemoveAll(staged)
		return err
	}

	// A leftover from an earlier update. Removing it can only fail when that
	// copy is still executing (Windows), and then the rename below fails too
	// and reports it.
	os.RemoveAll(old)
	hadOld := false
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, old); err != nil {
			os.RemoveAll(staged)
			return err
		}
		hadOld = true
	}
	if err := os.Rename(staged, dst); err != nil {
		if hadOld {
			_ = os.Rename(old, dst) // roll back
		}
		os.RemoveAll(staged)
		return err
	}
	return nil
}

// Rollback undoes a successful Swap: the new entry is removed and .old is
// renamed back into place. It refuses when there is no .old to restore, so a
// second call can never delete the only copy.
func Rollback(installDir string) error {
	dst, old := livePath(installDir), oldPath(installDir)
	if _, err := os.Stat(old); err != nil {
		return fmt.Errorf("nothing to roll back to: %w", err)
	}
	failed := dst + ".failed"
	os.RemoveAll(failed)
	// Rename rather than delete first: on Windows a just-crashed exe can stay
	// locked for a moment, and a rename is still allowed then.
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, failed); err != nil {
			return err
		}
	}
	if err := os.Rename(old, dst); err != nil {
		_ = os.Rename(failed, dst)
		return err
	}
	os.RemoveAll(failed)
	return nil
}

// CleanupOld removes the previous copy a Swap kept (and a .failed left by a
// Rollback whose removal was refused). Nothing to clean is not an error; on
// Windows a copy that is still executing cannot go yet, and that is reported.
func CleanupOld(installDir string) error {
	os.RemoveAll(livePath(installDir) + ".failed")
	if err := os.RemoveAll(oldPath(installDir)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// HasOld reports whether a Swap's previous copy is still present.
func HasOld(installDir string) bool {
	_, err := os.Stat(oldPath(installDir))
	return err == nil
}

// InstalledBinaryVersion asks the installed binary directly. It works despite
// the Windows -H windowsgui subsystem: os/exec wires pipes explicitly, so
// main.go's fmt.Println(sidecarVersion) is capturable.
func InstalledBinaryVersion(installDir string) (string, error) {
	cmd := exec.Command(ExecutableIn(installDir), "--version")
	hideSubprocessWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// CopyTree copies a directory preserving modes and symlinks (the .app payload
// has no symlinks post-extract, but Frameworks in future payloads might).
func CopyTree(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		switch {
		case info.IsDir():
			return os.MkdirAll(target, info.Mode().Perm())
		case info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		default:
			return CopyFilePreserve(path, target)
		}
	})
}

// CopyFilePreserve copies one file, keeping its permission bits.
func CopyFilePreserve(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	fi, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fi.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
