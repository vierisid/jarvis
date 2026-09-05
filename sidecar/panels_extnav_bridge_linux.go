//go:build linux

package main

// C→Go bridge for the Linux panel new-window handler (separate file per the cgo
// //export-vs-C-definitions rule; the definitions live in panels_extnav_linux.go).

import "C"

//export goPanelOpenExternal
func goPanelOpenExternal(url *C.char) {
	panelOpenExternal(C.GoString(url))
}
