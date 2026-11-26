//go:build darwin

package main

// C to Go bridge for the notch's window (a file of its own, by the cgo rule
// that a file with //export may not also define C functions).

import "C"

// goNotchHidden is the window saying it went out of sight behind a fullscreen
// video, or came back. It is called on the main thread, from the window's
// timer, so it only puts the word down (notchHidden, notch.go) and takes no
// lock: the service is told on a goroutine.
//
//export goNotchHidden
func goNotchHidden(hidden C.int) {
	notchHidden.Report(hidden != 0)
}
