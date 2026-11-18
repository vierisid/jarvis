//go:build !windows

package main

import "os"

// notchFileElsewhere says whether a file's content is kept somewhere else and
// would be downloaded by reading it. On a Mac a file that iCloud keeps online
// only is a hidden stand-in with another name, which is never listed.
func notchFileElsewhere(info os.FileInfo) bool { return false }
