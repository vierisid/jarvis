//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A junction (mklink /J) needs no privilege on Windows, unlike a symlink, so
// it is the bypass an attacker would actually reach for. Go 1.23+ stops
// reporting junctions as symlinks unless winsymlink=0 is set (main.go), which
// is what this test pins.
func TestJunctionIntoBlockedDirIsBlocked(t *testing.T) {
	base := t.TempDir()
	secret := filepath.Join(base, "secret")
	if err := os.MkdirAll(secret, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secret, "key"), []byte("k"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "docs", "k")
	if err := os.MkdirAll(filepath.Dir(link), 0700); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, secret).CombinedOutput()
	if err != nil {
		t.Fatalf("mklink /J: %v: %s", err, out)
	}
	list := []string{secret}
	if !isBlockedPath(filepath.Join(link, "key"), list) {
		t.Error("read through a junction must be blocked")
	}
	if !isBlockedPath(filepath.Join(link, "new-file"), list) {
		t.Error("new file under a junction must be blocked")
	}
}

func TestCaseFoldingOnDisk(t *testing.T) {
	base := t.TempDir()
	blocked := filepath.Join(base, "Secret")
	if err := os.MkdirAll(blocked, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(blocked, "key"), []byte("k"), 0600); err != nil {
		t.Fatal(err)
	}
	// Both sides exist on disk, so EvalSymlinks returns on-disk casing for
	// each and the fold must still agree.
	if !isBlockedPath(filepath.Join(base, "SECRET", "KEY"), []string{filepath.Join(base, "secret")}) {
		t.Error("case variants of an existing blocked dir must match")
	}
}
