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
		}
		if reason != "" {
			unavailable = append(unavailable, UnavailableCapability{Name: cap, Reason: reason})
		} else {
			available = append(available, cap)
		}
	}
	return
}
