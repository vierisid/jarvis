//go:build !windows

package main

import "syscall"

// oNoFollow makes os.OpenFile fail with ELOOP if the target is a symlink,
// so secret writes cannot be redirected to attacker-planted symlinks.
const oNoFollow = syscall.O_NOFOLLOW
