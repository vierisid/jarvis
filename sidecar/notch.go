package main

import (
	"encoding/json"
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

// A message between the brain and the notch's page may be this long, as JSON
// text. A line of the notch is a few hundred bytes; this is room for a sheet.
const notchMessageMax = 64 * 1024

// NotchService holds the switch the brain last set, the panels the window is
// opened through, and the two ends of the line between the brain and the
// notch's page.
//
// That line runs through this app because this app's connection to the brain
// is the one that is signed in for good and comes back by itself. A page that
// talked to the brain directly would hang on a session that ends after twelve
// hours. This app carries the messages and reads none of them: what they say
// is between the brain and the page.
type NotchService struct {
	enabled atomic.Bool
	mu      sync.Mutex
	panels  PanelService
	toPage  func(script string) // runs a script in the page; nil while no page is up
	toBrain func(text string)   // sends the brain one message; nil while not connected
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

// attachPage records how to run a script in the notch's page. The window calls
// it when the page's functions are bound, and detachPage before the web view
// goes away.
func (n *NotchService) attachPage(run func(script string)) {
	n.mu.Lock()
	n.toPage = run
	n.mu.Unlock()
}

// detachPage returns only when no message is on its way into the page, so the
// web view can be destroyed after it.
func (n *NotchService) detachPage() {
	n.mu.Lock()
	n.toPage = nil
	n.mu.Unlock()
}

// OnMessage sets where the page's messages go. nil while no brain is connected.
func (n *NotchService) OnMessage(send func(text string)) {
	n.mu.Lock()
	n.toBrain = send
	n.mu.Unlock()
}

// Push hands the page one message from the brain. The page receives it as the
// argument of window.__notch_receive.
func (n *NotchService) Push(message any) error {
	if message == nil {
		return fmt.Errorf("missing required parameter: message")
	}
	raw, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("the message is not JSON: %w", err)
	}
	if len(raw) > notchMessageMax {
		return fmt.Errorf("the message is %d bytes, the limit is %d", len(raw), notchMessageMax)
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.toPage == nil {
		return fmt.Errorf("the notch's page is not up")
	}
	n.toPage(notchReceiveScript(raw))
	return nil
}

// notchReceiveScript is the script that hands the page one message. raw is
// JSON as encoding/json writes it: every character that could end a script or
// a line early is escaped, so it can stand in the script as it is.
func notchReceiveScript(raw []byte) string {
	return "window.__notch_receive&&window.__notch_receive(" + string(raw) + ");"
}

// fromPage takes one message from the page for the brain. It must be JSON
// text; nothing else about it is looked at.
func (n *NotchService) fromPage(text string) error {
	if len(text) > notchMessageMax {
		return fmt.Errorf("the message is %d bytes, the limit is %d", len(text), notchMessageMax)
	}
	if !json.Valid([]byte(text)) {
		return fmt.Errorf("the message is not JSON")
	}
	n.mu.Lock()
	send := n.toBrain
	n.mu.Unlock()
	if send == nil {
		return fmt.Errorf("no brain is connected")
	}
	send(text)
	return nil
}

// notch.push - the brain hands the notch's page one message.
//
//	Params: { "message": any JSON value }
//	Result: { "pushed": true }
func makeNotchPushHandler(svc *NotchService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		if !svc.Enabled() {
			return nil, fmt.Errorf("the notch is off: notch.configure {enabled: true} comes first")
		}
		if err := svc.Push(params["message"]); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"pushed": true}}, nil
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
