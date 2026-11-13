//go:build darwin

package main

// C to Go bridge for hearing which app is in front (a file of its own, by the
// cgo rule that a file with //export may not also define C functions).

/*
#include <stdlib.h>
*/
import "C"

import "unsafe"

//export goNotchWhereFront
func goNotchWhereFront(name, bundle *C.char, pid C.int, png unsafe.Pointer, pngLen C.int) {
	var icon []byte
	if png != nil && pngLen > 0 {
		icon = C.GoBytes(png, pngLen)
	}
	notchWhereFrontChanged(C.GoString(name), C.GoString(bundle), int(pid), icon)
}
