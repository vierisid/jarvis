//go:build !windows

package main

import (
	"os"
	"syscall"
)

// openNoFollow opens path like os.OpenFile, but fails with ELOOP if path is
// a symlink, so secret writes cannot be redirected to attacker-planted
// symlinks.
func openNoFollow(path string, flag int, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flag|syscall.O_NOFOLLOW, perm)
}
