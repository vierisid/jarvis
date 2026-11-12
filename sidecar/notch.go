package main

import (
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
)

// The notch: a desktop surface the brain can ask this app to host.
//
// Whether it is hosted is the brain's decision alone. This app advertises
// CapNotch to say it understands notch.*, and hosts nothing until the brain
// sends notch.configure {enabled: true}. The switch lives in memory and does
// not outlive the connection that set it (see connectAndServe): a brain that
// reconnects with the notch off never mentions it, so the state has to fall
// back to off by itself or a stale "on" would survive a brain restart. Turning
// the switch off, by request or by disconnect, also takes the window away.
//
// The reply to notch.configure names the surface this build can show, so the
// brain can tell "accepted, nothing to show" from "ready for notch.spawn".
const (
	notchSurfaceNone   = "none"   // understands the switch, cannot show a window
	notchSurfaceWindow = "window" // can host the notch's window (notch_host.go)
)

// NotchService holds the switch the brain last set, and the panels the window
// is opened through.
type NotchService struct {
	enabled atomic.Bool
	mu      sync.Mutex
	panels  PanelService
}

// notch is the process-wide service. It is safe before any connection exists:
// the zero value is "off, no surface".
var notch = &NotchService{}

// usePanels records the panel service the notch's window is opened through.
// nil means this build or machine has no windows to offer.
func (n *NotchService) usePanels(panels PanelService) {
	n.mu.Lock()
	n.panels = panels
	n.mu.Unlock()
}

// surface names what this app can show right now.
func (n *NotchService) surface() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.panels == nil {
		return notchSurfaceNone
	}
	return notchSurfaceWindow
}

// closeSurface takes the notch's window away if there is one. It reports
// whether a window was closed.
func (n *NotchService) closeSurface() bool {
	n.mu.Lock()
	panels := n.panels
	n.mu.Unlock()
	if panels == nil {
		return false
	}
	err := panels.Close(notchPanelID)
	if err != nil {
		if !errors.Is(err, ErrPanelUnknown) {
			log.Printf("[notch] closing the window: %v", err)
		}
		return false
	}
	log.Printf("[notch] window closed")
	return true
}

// Configure sets the switch and reports whether it changed. Turning it off
// closes the window.
func (n *NotchService) Configure(enabled bool) bool {
	changed := n.enabled.Swap(enabled) != enabled
	if !enabled {
		n.closeSurface()
	}
	return changed
}

// Enabled reports the switch as the brain last set it on this connection.
func (n *NotchService) Enabled() bool {
	return n.enabled.Load()
}

// Reset turns the switch off and says why, if it was on.
func (n *NotchService) Reset(reason string) {
	if n.Configure(false) {
		log.Printf("[notch] switch off (%s)", reason)
	}
}

// notch.configure - the brain tells this app whether to host the notch.
//
//	Params: { "enabled": bool }
//	Result: { "configured": true, "enabled": bool, "surface": "none" | "window" }
func makeNotchConfigureHandler(svc *NotchService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		raw, ok := params["enabled"]
		if !ok {
			return nil, fmt.Errorf("missing required parameter: enabled")
		}
		enabled, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("enabled must be a boolean")
		}
		surface := svc.surface()
		if svc.Configure(enabled) {
			if enabled {
				log.Printf("[notch] switch on (surface: %s)", surface)
			} else {
				log.Printf("[notch] switch off (brain)")
			}
		}
		return &RPCResult{Result: map[string]any{
			"configured": true,
			"enabled":    enabled,
			"surface":    surface,
		}}, nil
	}
}
