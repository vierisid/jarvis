//go:build linux

package main

// C->Go bridge for the shared GTK main loop (separate file per the cgo
// //export-vs-C-definitions rule: gtk_main_linux.go defines C functions in its
// preamble). Both run on the loop's thread.

import "C"

import "unsafe"

//export goGTKInvoke
func goGTKInvoke(token C.ulonglong) {
	if v, ok := gtkInvokeFuncs.LoadAndDelete(uint64(token)); ok {
		if fn, ok := v.(func()); ok && fn != nil {
			fn()
		}
	}
}

//export goGTKWindowDestroyed
func goGTKWindowDestroyed(window unsafe.Pointer) {
	gtkWindowsMu.Lock()
	fns := gtkWindows[window]
	delete(gtkWindows, window)
	gtkWindowsMu.Unlock()
	for _, fn := range fns {
		fn()
	}
}
