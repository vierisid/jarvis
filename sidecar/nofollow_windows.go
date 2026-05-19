//go:build windows

package main

// Windows does not have O_NOFOLLOW; symlink-redirection hardening relies on
// filesystem ACLs there. Use 0 so the flag is a no-op.
const oNoFollow = 0
