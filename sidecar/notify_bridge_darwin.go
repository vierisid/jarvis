//go:build darwin

package main

// C→Go bridge for macOS notification action taps (separate file per the cgo
// //export-vs-C-definitions rule). Runs on the Cocoa main thread when the user
// taps a notification button; forwards the choice to the brain.

import "C"

//export goNotifyAction
func goNotifyAction(id, kind, action *C.char) {
	notifyEmitAction(C.GoString(id), C.GoString(kind), C.GoString(action))
}
