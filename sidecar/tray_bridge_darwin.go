//go:build darwin

package main

// C→Go bridge for the macOS tray (separate file per the cgo //export-vs-C-
// definitions rule). Called on the main thread when the "Close" menu item fires.

import "C"

//export goTrayClose
func goTrayClose() {
	// Runs on the Cocoa main thread; do the shutdown (client.Stop closes the WS +
	// services) off-thread so we don't block the run loop. Cancelling the context
	// makes the ctx-watcher quit NSApp.
	if trayOnCloseDarwin != nil {
		go trayOnCloseDarwin()
	}
}

//export goTrayOpenChat
func goTrayOpenChat() {
	if trayOpenChatDarwin != nil {
		go trayOpenChatDarwin()
	}
}

//export goTrayOpenSettings
func goTrayOpenSettings() {
	if trayOpenSettingsDarwin != nil {
		go trayOpenSettingsDarwin()
	}
}

//export goTrayOpenLogs
func goTrayOpenLogs() {
	if trayOpenLogsDarwin != nil {
		go trayOpenLogsDarwin()
	}
}

//export goTrayPause
func goTrayPause() {
	ts := getTrayStatus()
	ts.Paused = !ts.Paused
	setTrayStatus(ts) // triggers trayRefresh → menu/icon rebuild
	if trayEmitDarwin != nil {
		trayEmitDarwin("tray.set_pause", map[string]any{"paused": ts.Paused})
	}
}

//export goTrayMute
func goTrayMute() {
	ts := getTrayStatus()
	ts.Muted = !ts.Muted
	setTrayStatus(ts)
	trayApplyMute(ts.Muted) // gate the mic locally (sidecar owns mic control)
	if trayEmitDarwin != nil {
		trayEmitDarwin("tray.set_mute", map[string]any{"muted": ts.Muted})
	}
}

//export goTrayWaiting
func goTrayWaiting() {
	// Into the dashboard to review the pending approval (Authority).
	if trayOpenChatDarwin != nil {
		go trayOpenChatDarwin()
	}
}
