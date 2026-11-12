package main

import (
	"fmt"
	"log"
	"sync/atomic"
)

// The notch: a desktop surface the brain can ask this app to host.
//
// Whether it is hosted is the brain's decision alone. This app advertises
// CapNotch to say it understands notch.*, and hosts nothing until the brain
// sends notch.configure {enabled: true}. The switch lives in memory and does
// not outlive the connection that set it (see connectAndServe): a brain that
// reconnects with the notch off never mentions it, so the state has to fall
// back to off by itself or a stale "on" would survive a brain restart.
//
// This build has no window yet. notchSurface says so in the reply, so the
// brain can tell "accepted, nothing to show" from "showing".
const notchSurface = "none"

// NotchService holds the switch the brain last set.
type NotchService struct {
	enabled atomic.Bool
}

// notch is the process-wide service. It is safe before any connection exists:
// the zero value is "off".
var notch = &NotchService{}

// Configure sets the switch and reports whether it changed.
func (n *NotchService) Configure(enabled bool) bool {
	return n.enabled.Swap(enabled) != enabled
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
//	Result: { "configured": true, "enabled": bool, "surface": "none" }
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
		if svc.Configure(enabled) {
			if enabled {
				log.Printf("[notch] switch on (surface: %s)", notchSurface)
			} else {
				log.Printf("[notch] switch off (brain)")
			}
		}
		return &RPCResult{Result: map[string]any{
			"configured": true,
			"enabled":    enabled,
			"surface":    notchSurface,
		}}, nil
	}
}
