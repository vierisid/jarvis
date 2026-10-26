//go:build darwin

package main

// C->Go bridge for macOS notification action taps (separate file per the cgo
// //export-vs-C-definitions rule). Runs on the Cocoa main thread when the user
// taps a notification button or the banner itself; forwards the choice to the
// brain and, for Open Jarvis / View / a banner tap, opens the dashboard
// (#853: before this it only forwarded, and the brain leaves those to us).

import "C"

//export goNotifyAction
func goNotifyAction(id, kind, action *C.char) {
	dispatchNotifyAction(C.GoString(id), C.GoString(kind), C.GoString(action), trayOpenChatDarwin)
}
