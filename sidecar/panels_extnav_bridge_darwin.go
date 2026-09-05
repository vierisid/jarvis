//go:build darwin

package main

// C→Go bridge for the macOS panel new-window handler (separate file per the cgo
// //export-vs-C-definitions rule; the ObjC lives in panels_extnav_darwin.go).

import "C"

//export goPanelOpenExternal
func goPanelOpenExternal(url *C.char) {
	panelOpenExternal(C.GoString(url))
}
