package main

// Where Jarvis's own browser keeps its profile.
//
// It was the system's temporary folder. A profile is where a sign-in lives,
// and a temporary folder is the one place Windows and every cleaning tool feel
// free to empty. For a browser that only ever looked things up that did not
// matter. For mail it does: the person signs in to Gmail once inside this
// browser (Google gives no permission for mail any other way), and a sign-in
// that is swept away one night means Jarvis goes quiet about mail and nobody
// knows why.
//
// So with the notch on, which is what reads mail this way, the profile is kept
// under the person's own folder: ~/.jarvis/browser/<name>. A profile that is
// already in the temporary folder is moved there once, sign-ins and all. If it
// cannot be moved (another disk, a file in use) it is used where it is, and
// nothing is lost.
//
// With the notch off the profile stays where it always was.

import (
	"os"
	"path/filepath"
)

// browserProfileDirFor decides the folder. name is the profile's folder name
// (browserProfileName); keep is whether to keep it for good; there says
// whether a folder exists; move moves one.
func browserProfileDirFor(name string, keep bool, home, temp string, there func(string) bool, move func(from, to string) error) string {
	old := filepath.Join(temp, name)
	if !keep || home == "" {
		return old
	}
	kept := filepath.Join(home, ".jarvis", "browser", name)
	if there(kept) {
		return kept
	}
	if there(old) {
		if err := move(old, kept); err != nil {
			return old
		}
	}
	return kept
}

// browserProfileDir is the folder for the browser at exe, as things stand now.
func browserProfileDir(exe string) string {
	there := func(dir string) bool {
		info, err := os.Stat(dir)
		return err == nil && info.IsDir()
	}
	move := func(from, to string) error {
		if err := os.MkdirAll(filepath.Dir(to), 0o700); err != nil {
			return err
		}
		return os.Rename(from, to)
	}
	return browserProfileDirFor(browserProfileName(exe), notchWhere.On(), homeDir(), os.TempDir(), there, move)
}
