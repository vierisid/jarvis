//go:build darwin

package main

// The callbacks of the tap that watches what the hands do
// (notch_watch_darwin.go). They live in a file of their own because a file
// that exports a function to C may not define C functions in its preamble.

import "C"

//export goNotchWatchMouse
func goNotchWatchMouse(kind, x, y, mods C.int) {
	macWatchMouse(int(kind), int(x), int(y), int(mods))
}

//export goNotchWatchKey
func goNotchWatchKey(code, letter, mods, repeat C.int) {
	macWatchKey(int(code), int(letter), int(mods), repeat != 0)
}
