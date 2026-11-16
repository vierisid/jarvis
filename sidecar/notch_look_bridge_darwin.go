//go:build darwin

package main

// The callback of the look's mouse tap (notch_look_darwin.go). It lives in a
// file of its own because a file that exports a function to C may not define
// C functions in its preamble.

import "C"

//export goNotchLookMouse
func goNotchLookMouse(kind, x, y C.int) C.int {
	if notchLookMouseSeen(int(kind), int(x), int(y)) {
		return 1
	}
	return 0
}
