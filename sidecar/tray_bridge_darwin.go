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

//export goTrayOpenAccount
func goTrayOpenAccount() {
	if trayOpenAccountDarwin != nil {
		go trayOpenAccountDarwin()
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
	// WS write off the Cocoa main thread (a stalled brain must not block the
	// run loop), serialized so rapid toggles apply in click order.
	paused := ts.Paused
	trayCtlAsync(func() {
		if trayEmitDarwin != nil {
			trayEmitDarwin("tray.set_pause", map[string]any{"paused": paused})
		}
	})
}

//export goTrayMute
func goTrayMute() {
	ts := getTrayStatus()
	ts.Muted = !ts.Muted
	setTrayStatus(ts)
	// Mic gating tears down audio devices (blocking I/O) and the emit is a WS
	// write — off the Cocoa main thread, serialized so a rapid double-toggle
	// can't interleave and desync the mic from the menu.
	muted := ts.Muted
	trayCtlAsync(func() {
		trayApplyMute(muted) // gate the mic locally (sidecar owns mic control)
		if trayEmitDarwin != nil {
			trayEmitDarwin("tray.set_mute", map[string]any{"muted": muted})
		}
	})
}

//export goTrayWaiting
func goTrayWaiting() {
	// Into the dashboard to review the pending approval (Authority).
	if trayOpenChatDarwin != nil {
		go trayOpenChatDarwin()
	}
}

//export goTrayReopen
func goTrayReopen() {
	// Cocoa main thread (reopen event); the handler opens a panel (mint token +
	// spawn webview), so run it off-thread like the menu actions.
	if trayOnReopenDarwin != nil {
		go trayOnReopenDarwin()
	}
}
