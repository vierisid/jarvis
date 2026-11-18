//go:build windows

package main

import (
	"os"
	"syscall"
)

// notchFileElsewhere says whether a file's content is kept somewhere else and
// would be downloaded by reading it: a file that OneDrive (or another program
// of its kind) keeps online only. It has a name, a size and a date like any
// other, and reading it makes that program fetch the whole of it over the
// network. Such a file is never opened: the person did not ask for a
// download, and it may be large or on a paid connection.
func notchFileElsewhere(info os.FileInfo) bool {
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok || data == nil {
		return false
	}
	return notchFileAttrsElsewhere(data.FileAttributes)
}
