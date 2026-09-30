package update

import (
	"os"
	"path/filepath"
	"testing"
)

func writeEntry(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, payloadEntry), []byte(body), 0755); err != nil {
		t.Fatal(err)
	}
}

func readEntry(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// A self-update swaps while the old binary is still running and must be able
// to put it back if the new one dies on startup, so Swap keeps .old and
// Rollback restores it byte for byte.
func TestSwapKeepsOldAndRollbackRestoresIt(t *testing.T) {
	install, staged := t.TempDir(), t.TempDir()
	writeEntry(t, install, "old")
	writeEntry(t, staged, "new")

	if err := Swap(staged, install); err != nil {
		t.Fatalf("Swap: %v", err)
	}
	if got := readEntry(t, livePath(install)); got != "new" {
		t.Errorf("live = %q, want new", got)
	}
	if !HasOld(install) || readEntry(t, oldPath(install)) != "old" {
		t.Fatal("Swap did not keep the previous copy as .old")
	}
	if _, err := os.Stat(stagingPath(install)); !os.IsNotExist(err) {
		t.Errorf("staging copy left behind: %v", err)
	}

	if err := Rollback(install); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if got := readEntry(t, livePath(install)); got != "old" {
		t.Errorf("after rollback live = %q, want old", got)
	}
	if HasOld(install) {
		t.Error(".old still present after rollback")
	}
	// A second rollback has nothing to restore and must not delete the live copy.
	if err := Rollback(install); err == nil {
		t.Error("second Rollback succeeded with no .old")
	}
	if got := readEntry(t, livePath(install)); got != "old" {
		t.Errorf("second rollback touched the live copy: %q", got)
	}
}

func TestCleanupOldAfterHealthyStart(t *testing.T) {
	install, staged := t.TempDir(), t.TempDir()
	writeEntry(t, install, "old")
	writeEntry(t, staged, "new")
	if err := Swap(staged, install); err != nil {
		t.Fatalf("Swap: %v", err)
	}
	if err := CleanupOld(install); err != nil {
		t.Fatalf("CleanupOld: %v", err)
	}
	if HasOld(install) {
		t.Error(".old survived CleanupOld")
	}
	if got := readEntry(t, livePath(install)); got != "new" {
		t.Errorf("live = %q, want new", got)
	}
	// Nothing left to clean is fine.
	if err := CleanupOld(install); err != nil {
		t.Errorf("CleanupOld with nothing to clean: %v", err)
	}
}

// A first install has no live copy to rename aside.
func TestSwapIntoEmptyDir(t *testing.T) {
	install, staged := t.TempDir(), t.TempDir()
	writeEntry(t, staged, "new")
	if err := Swap(staged, install); err != nil {
		t.Fatalf("Swap: %v", err)
	}
	if got := readEntry(t, livePath(install)); got != "new" {
		t.Errorf("live = %q, want new", got)
	}
	if HasOld(install) {
		t.Error("Swap invented an .old for a first install")
	}
}

func TestSwapRejectsPayloadWithoutEntry(t *testing.T) {
	install := t.TempDir()
	writeEntry(t, install, "old")
	if err := Swap(t.TempDir(), install); err == nil {
		t.Fatal("Swap accepted an empty payload")
	}
	if got := readEntry(t, livePath(install)); got != "old" {
		t.Errorf("failed Swap touched the live copy: %q", got)
	}
}

// The macOS payload is a directory (Jarvis.app); run the same swap/rollback
// cycle on that shape on every OS.
func TestSwapAndRollbackDirectoryEntry(t *testing.T) {
	install, staged := t.TempDir(), t.TempDir()
	mk := func(root, body string) {
		exe := filepath.Join(root, "Jarvis.app", "Contents", "MacOS", "jarvis")
		if err := os.MkdirAll(filepath.Dir(exe), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(exe, []byte(body), 0755); err != nil {
			t.Fatal(err)
		}
	}
	mk(install, "old")
	mk(staged, "new")
	exe := filepath.Join(install, "Jarvis.app", "Contents", "MacOS", "jarvis")

	if err := swapEntry(staged, install, "Jarvis.app"); err != nil {
		t.Fatalf("swapEntry: %v", err)
	}
	if got := readEntry(t, exe); got != "new" {
		t.Errorf("after swap = %q, want new", got)
	}
	if fi, err := os.Stat(exe); err != nil || fi.Mode().Perm()&0100 == 0 {
		t.Errorf("exec bit lost in the copy: %v %v", fi, err)
	}
	if err := rollbackEntry(install, "Jarvis.app"); err != nil {
		t.Fatalf("rollbackEntry: %v", err)
	}
	if got := readEntry(t, exe); got != "old" {
		t.Errorf("after rollback = %q, want old", got)
	}
}

// A .failed-* left by an earlier rollback (still executing on Windows) must
// not block the next one, and CleanupOld sweeps them.
func TestRollbackWithLeftoverFailedCopy(t *testing.T) {
	install, staged := t.TempDir(), t.TempDir()
	writeEntry(t, install, "old")
	writeEntry(t, staged, "new")
	leftover := livePath(install) + ".failed-1"
	if err := os.WriteFile(leftover, []byte("stale"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := Swap(staged, install); err != nil {
		t.Fatalf("Swap: %v", err)
	}
	if err := Rollback(install); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if got := readEntry(t, livePath(install)); got != "old" {
		t.Errorf("live = %q, want old", got)
	}
	if err := CleanupOld(install); err != nil {
		t.Fatalf("CleanupOld: %v", err)
	}
	if left, _ := filepath.Glob(livePath(install) + ".failed-*"); len(left) != 0 {
		t.Errorf("CleanupOld left %v", left)
	}
}
