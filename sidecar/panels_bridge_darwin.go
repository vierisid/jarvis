//go:build darwin

package main

// C→Go bridge for macOS panel window-close notifications (separate file per the
// cgo //export-vs-C-definitions rule — panels_darwin.go defines C functions in
// its preamble). Called from the NSWindowWillCloseNotification block on the main
// thread when the user closes a panel window.

import "C"

//export goPanelClosed
func goPanelClosed(token C.ulonglong) {
	if v, ok := panelCloseFuncs.LoadAndDelete(uint64(token)); ok {
		if fn, ok := v.(func()); ok && fn != nil {
			fn()
		}
	}
}
