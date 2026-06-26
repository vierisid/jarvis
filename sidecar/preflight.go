package main

// UnavailableCapability describes a capability that is enabled in config
// but cannot function on this system due to missing dependencies.
type UnavailableCapability struct {
	Name   SidecarCapability `json:"name"`
	Reason string            `json:"reason"`
}

// CheckCapabilities validates each enabled capability against the current
// system. Returns the list of available capabilities and any that are
// unavailable along with a human-readable reason.
func CheckCapabilities(cfg *SidecarConfig) (available []SidecarCapability, unavailable []UnavailableCapability) {
	for _, cap := range cfg.Capabilities {
		reason := ""
		switch cap {
		case CapTerminal:
			reason = checkTerminal(cfg)
		case CapFilesystem, CapSystemInfo:
			// Pure Go — always available
		case CapClipboard:
			reason = checkClipboard()
		case CapFileWatch:
			// Pure-Go polling watcher — always available.
		case CapProcesses:
			reason = checkProcesses()
		case CapNotifications:
			reason = checkNotifications()
		case CapScreenshot:
			reason = checkScreenshot()
		case CapAwareness:
			reason = checkAwareness()
		case CapOCR:
			reason = checkOCR()
		case CapBrowser:
			reason = checkBrowser(cfg)
		case CapDesktop:
			reason = checkDesktop()
		case CapWindows:
			// Native panel windows (webview-backed). The runtime check is
			// effectively "do we have a webview lib at runtime?" which we
			// can't probe statically without trying to spawn a window.
			// Spawning fails gracefully via the RPC layer, so accept here.
		case CapPebble:
			// Native pebble overlay (GDI+/Cocoa/Cairo, per-platform). On
			// non-Windows the implementation is currently stubbed and Spawn()
			// returns an error — the daemon handles that gracefully via the
			// dispatch.  Accept the capability either way so the brain knows
			// it was advertised.
		}
		if reason != "" {
			unavailable = append(unavailable, UnavailableCapability{Name: cap, Reason: reason})
		} else {
			available = append(available, cap)
		}
	}
	return
}
