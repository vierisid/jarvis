//go:build !windows && !darwin && !linux

package main

import "fmt"

func startHotkeyListener(keyspec string, onFire func()) (func(), error) {
	return nil, fmt.Errorf("global hotkeys not supported on this platform")
}
