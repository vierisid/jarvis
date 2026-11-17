package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func notchFilesWrite(t *testing.T, dir, name string, age time.Duration) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("SECRET CONTENT that must never be told"), 0o600); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
}

func TestNotchFilesTellsNamesKindsAndCountsAndNothingOfWhatIsInAFile(t *testing.T) {
	dir := t.TempDir()
	notchFilesWrite(t, dir, "Budget Q4.xlsx", 2*time.Hour)
	notchFilesWrite(t, dir, "Pitch.pptx", time.Hour)
	notchFilesWrite(t, dir, "notes.txt", 3*time.Hour)
	notchFilesWrite(t, dir, "Chrome.lnk", time.Minute)
	notchFilesWrite(t, dir, "desktop.ini", time.Minute)
	notchFilesWrite(t, dir, "~$Budget Q4.xlsx", time.Minute)
	notchFilesWrite(t, dir, ".hidden", time.Minute)
	if err := os.Mkdir(filepath.Join(dir, "Clients"), 0o700); err != nil {
		t.Fatal(err)
	}
	// What is inside a folder is not looked at.
	notchFilesWrite(t, filepath.Join(dir, "Clients"), "inside.pdf", time.Minute)

	got := notchFilesIn("desktop", dir)
	if !got.Reached || got.Files != 3 || got.Folders != 1 || got.Shortcuts != 1 {
		t.Fatalf("counts: reached %v, files %d, folders %d, shortcuts %d", got.Reached, got.Files, got.Folders, got.Shortcuts)
	}
	if got.Kinds["sheet"] != 1 || got.Kinds["slides"] != 1 || got.Kinds["document"] != 1 || got.Kinds["pdf"] != 0 {
		t.Fatalf("kinds: %v", got.Kinds)
	}
	// The newest first; a shortcut, and what the system keeps for itself, are never named.
	var names []string
	for _, seen := range got.Recent {
		names = append(names, seen.Name)
		if seen.Changed == 0 {
			t.Fatalf("%q has no date", seen.Name)
		}
	}
	want := []string{"Clients", "Pitch.pptx", "Budget Q4.xlsx", "notes.txt"}
	if len(names) != len(want) {
		t.Fatalf("named %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("named %v, want %v", names, want)
		}
	}
}

func TestNotchFilesNamesOnlyTheNewestFew(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < notchFilesNamed+4; i++ {
		notchFilesWrite(t, dir, string(rune('a'+i))+".pdf", time.Duration(i)*time.Minute)
	}
	got := notchFilesIn("documents", dir)
	if got.Files != notchFilesNamed+4 || len(got.Recent) != notchFilesNamed || got.Recent[0].Name != "a.pdf" {
		t.Fatalf("files %d, named %d, first %q", got.Files, len(got.Recent), got.Recent[0].Name)
	}
}

func TestNotchFilesAFolderThatIsNotThereIsNotReachedAndNothingBreaks(t *testing.T) {
	got := notchFilesIn("desktop", filepath.Join(t.TempDir(), "no such folder"))
	if got.Reached || got.Files != 0 || got.Recent == nil || got.Kinds == nil {
		t.Fatalf("got %+v", got)
	}
}

func TestNotchFilesLooksWhereTheDesktopReallyIsAndNeverInABlockedFolder(t *testing.T) {
	home, drive := t.TempDir(), t.TempDir()
	// A cloud drive has taken the desktop over: the one in the home folder is empty.
	for _, dir := range []string{filepath.Join(home, "Desktop"), filepath.Join(drive, "Desktop"), filepath.Join(home, "Documents")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	notchFilesWrite(t, filepath.Join(drive, "Desktop"), "Pitch.pptx", time.Minute)
	notchFilesWrite(t, filepath.Join(home, "Documents"), "Contract.pdf", time.Minute)
	env := func(key string) string {
		if key == "OneDrive" {
			return drive
		}
		return ""
	}
	roots := notchFileRoots(home, env, "windows")
	if roots["desktop"][0] != filepath.Join(drive, "Desktop") || roots["downloads"][0] != filepath.Join(home, "Downloads") {
		t.Fatalf("roots: %v", roots)
	}
	places := notchFilesLook(roots, nil)
	if len(places) != 3 || places[0].Place != "desktop" || places[0].Files != 1 || places[1].Files != 1 || places[2].Reached {
		t.Fatalf("places: %+v", places)
	}
	// The person blocked their documents: that folder is not looked into at all.
	blocked := func(dir string) bool { return dir == filepath.Join(home, "Documents") }
	places = notchFilesLook(roots, blocked)
	if places[1].Reached || places[1].Files != 0 || len(places[1].Recent) != 0 {
		t.Fatalf("a blocked folder was looked into: %+v", places[1])
	}
	// On a Mac there is no cloud drive to ask about: the home folder is where it is.
	mac := notchFileRoots(home, env, "darwin")
	if len(mac["desktop"]) != 1 || mac["desktop"][0] != filepath.Join(home, "Desktop") {
		t.Fatalf("mac roots: %v", mac)
	}
}

func TestNotchFileNameIsOneLineAndNotLongerThanALine(t *testing.T) {
	long := ""
	for i := 0; i < 300; i++ {
		long += "x"
	}
	if got := notchFileName("a\nb\tc"); got != "a b c" {
		t.Fatalf("got %q", got)
	}
	if got := notchFileName(long); len([]rune(got)) != notchFileNameMost {
		t.Fatalf("length %d", len([]rune(got)))
	}
}
