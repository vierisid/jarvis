package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestSaveCaptureToFileIsPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX modes do not apply")
	}
	captureDir := filepath.Join(t.TempDir(), "captures")
	got, err := saveCaptureToFile(captureDir, []byte("png"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(got); info.Mode().Perm() != 0600 {
		t.Errorf("capture mode = %o, want 0600", info.Mode().Perm())
	}
	if info, _ := os.Stat(captureDir); info.Mode().Perm() != 0700 {
		t.Errorf("capture dir mode = %o, want 0700", info.Mode().Perm())
	}
	if info, _ := os.Stat(filepath.Dir(got)); info.Mode().Perm() != 0700 {
		t.Errorf("date dir mode = %o, want 0700", info.Mode().Perm())
	}
}

func TestPruneCapturesOlderThan(t *testing.T) {
	captureDir := filepath.Join(t.TempDir(), "captures")
	now := time.Now()
	old, err := saveCaptureToFile(captureDir, []byte("old"), now.Add(-72*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := saveCaptureToFile(captureDir, []byte("fresh"), now)
	if err != nil {
		t.Fatal(err)
	}
	// The file name carries the timestamp; retention keys off mtime, so age it.
	stale := now.Add(-72 * time.Hour)
	if err := os.Chtimes(old, stale, stale); err != nil {
		t.Fatal(err)
	}

	files, dirs, err := pruneCapturesOlderThan(captureDir, 48*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if files != 1 || dirs != 1 {
		t.Errorf("pruned files=%d dirs=%d, want 1 and 1", files, dirs)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Error("old capture should be gone")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("fresh capture should remain")
	}

	// Disabled TTL is a no-op; a missing dir is not an error.
	if f, _, err := pruneCapturesOlderThan(captureDir, 0); err != nil || f != 0 {
		t.Errorf("ttl 0 should be a no-op, got files=%d err=%v", f, err)
	}
	if _, _, err := pruneCapturesOlderThan(filepath.Join(captureDir, "missing"), time.Hour); err != nil {
		t.Errorf("missing dir should not error: %v", err)
	}
}
