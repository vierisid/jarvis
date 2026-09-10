//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The redirect must take over fd 2 only when nothing is reading it. Replacing
// a pipe would swallow `jarvis --token` failures a script is capturing, which
// is what the terminal-only check this replaced got wrong.
func TestFdIsDevNull(t *testing.T) {
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer null.Close()
	if !fdIsDevNull(int(null.Fd())) {
		t.Errorf("%s: want true", os.DevNull)
	}

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	if fdIsDevNull(int(w.Fd())) {
		t.Error("pipe: want false, a pipe is someone capturing stderr")
	}

	file, err := os.Create(filepath.Join(t.TempDir(), "stderr.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if fdIsDevNull(int(file.Fd())) {
		t.Error("regular file: want false")
	}
}
