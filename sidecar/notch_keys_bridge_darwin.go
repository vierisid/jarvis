//go:build darwin

package main

// C to Go bridge for the notch's keyboard tap (a file of its own, by the cgo
// rule that a file with //export may not also define C functions).

import "C"

//export goNotchKey
func goNotchKey(kind, mods C.int) C.int {
	if notchTapSeen(int(kind), int(mods)) {
		return 1
	}
	return 0
}
