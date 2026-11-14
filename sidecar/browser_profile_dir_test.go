package main

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestBrowserProfileDirIsKeptForGoodOnlyWithTheNotchOn(t *testing.T) {
	home, temp := filepath.FromSlash("/home/sam"), filepath.FromSlash("/tmp")
	old := filepath.Join(temp, "jarvis-chrome-profile")
	kept := filepath.Join(home, ".jarvis", "browser", "jarvis-chrome-profile")
	exists := map[string]bool{}
	there := func(dir string) bool { return exists[dir] }
	var moved [][2]string
	move := func(from, to string) error {
		moved = append(moved, [2]string{from, to})
		delete(exists, from)
		exists[to] = true
		return nil
	}

	// With the notch off: where it always was, and nothing is touched.
	exists[old] = true
	if got := browserProfileDirFor("jarvis-chrome-profile", false, home, temp, there, move); got != old || len(moved) != 0 {
		t.Errorf("notch off: got %q, moved %v", got, moved)
	}
	// With the notch on: a profile in the temporary folder is moved once, sign-ins and all.
	if got := browserProfileDirFor("jarvis-chrome-profile", true, home, temp, there, move); got != kept {
		t.Errorf("first time with the notch on: got %q, want %q", got, kept)
	}
	if len(moved) != 1 || moved[0] != [2]string{old, kept} {
		t.Errorf("moved %v, want the old profile moved once", moved)
	}
	// After that it is simply there.
	if got := browserProfileDirFor("jarvis-chrome-profile", true, home, temp, there, move); got != kept || len(moved) != 1 {
		t.Errorf("second time: got %q, moved %v", got, moved)
	}
	// A new machine with no profile anywhere starts in the kept place.
	exists = map[string]bool{}
	moved = nil
	if got := browserProfileDirFor("jarvis-chrome-profile", true, home, temp, there, move); got != kept || len(moved) != 0 {
		t.Errorf("no profile yet: got %q, moved %v", got, moved)
	}
	// One that cannot be moved is used where it is: a sign-in is never lost to tidiness.
	exists[old] = true
	stuck := func(string, string) error { return errors.New("the file is in use") }
	if got := browserProfileDirFor("jarvis-chrome-profile", true, home, temp, there, stuck); got != old {
		t.Errorf("a profile that cannot be moved: got %q, want it used where it is", got)
	}
	// And with no home folder to keep it in, the temporary one is all there is.
	if got := browserProfileDirFor("jarvis-chrome-profile", true, "", temp, there, move); got != old {
		t.Errorf("no home: got %q", got)
	}
}
