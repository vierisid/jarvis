//go:build windows

package main

// Where the desktop, the documents and the downloads are, as Windows itself
// keeps it. A person can move any of them (to another drive, into a cloud
// drive), and the folder of that name in their home is then not the one they
// use. Windows knows, whatever this program's environment says.

import "golang.org/x/sys/windows"

func init() {
	platformNotchKnownFolders = func() map[string]string {
		out := map[string]string{}
		for place, id := range map[string]*windows.KNOWNFOLDERID{
			"desktop": windows.FOLDERID_Desktop, "documents": windows.FOLDERID_Documents, "downloads": windows.FOLDERID_Downloads,
		} {
			// Not created when it is missing, and not checked: whether it is there is found out by looking in it.
			if dir, err := windows.KnownFolderPath(id, windows.KF_FLAG_DONT_VERIFY); err == nil && dir != "" {
				out[place] = dir
			}
		}
		return out
	}
}
