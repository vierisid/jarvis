//go:build windows

package main

import (
	"fmt"
	"os"
)

// openNoFollow opens path like os.OpenFile, but refuses when path is a
// symlink or any other reparse point (a junction, a mount point), so a
// secret write cannot be redirected to a file the link points at.
//
// Windows has no O_NOFOLLOW: the path is checked with Lstat first. Between
// the check and the open a link could still be put in place; making one
// needs the symlink privilege (admin or Developer Mode), and the folder is
// the user's own profile.
func openNoFollow(path string, flag int, perm os.FileMode) (*os.File, error) {
	if fi, err := os.Lstat(path); err == nil && fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
		return nil, &os.PathError{Op: "open", Path: path, Err: fmt.Errorf("refusing to follow a link (%s)", fi.Mode().Type())}
	}
	return os.OpenFile(path, flag, perm)
}
