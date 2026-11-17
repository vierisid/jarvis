//go:build windows

package main

import (
	"log"
	"sync"

	"golang.org/x/sys/windows"
)

// The web view keeps its data in a folder of its own under the profile's
// roaming application data, and asks Windows where that is without asking
// for it to be made. In a profile that does not have the folder yet, Windows
// answers "path not found", and the web view gives up at once: no window.
//
// Every profile Windows makes has it. A profile that was only pointed at
// does not: a test build's stand-in profile on its first start, where the
// notch's window was refused with "could not create the window" (17 November
// 2026). So the folder is made here, once, before the first web view.
var webviewDataFolderOnce sync.Once

func init() {
	platformBeforeWebview = func() {
		webviewDataFolderOnce.Do(func() {
			if _, err := windows.KnownFolderPath(windows.FOLDERID_RoamingAppData, windows.KF_FLAG_CREATE); err != nil {
				log.Printf("[panels] the folder the web view keeps its data in could not be made: %v", err)
			}
		})
	}
}
