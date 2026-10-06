//go:build linux || darwin

package main

import (
	"fmt"
	"time"
)

// desktop_element_action.go -- the click and type paths on a cached element id,
// shared by Linux and macOS (#712).
//
// #661's read-back was written into each platform's handler, and only the
// Linux copy ever executed: CI runs the sidecar's tests on Linux and only
// compiles darwin. For a change whose whole point is to refuse an action, a
// refusal path that never runs is the kind that silently stops refusing. So
// everything between "an element id arrived" and "dispatch at these
// coordinates" now lives here, compiled and tested on Linux with macOS's own
// budgets (desktop_element_platforms_linux_test.go). What stays per platform
// is the walk (walkDesktopElements), the dispatch (dispatchPointer) and the
// keystroke -- the parts that need the platform's tools to run at all.

// pointerDispatchTimeout bounds one pointer action -- every xdotool, cliclick
// and Quartz invocation that moves or clicks -- and keystrokeTimeout one
// keystroke run (xdotool type, osascript keystroke). With the read-back these
// make up the budget in desktop_element_cache.go.
const (
	pointerDispatchTimeout = 5 * time.Second
	keystrokeTimeout       = 10 * time.Second
)

// daemonRPCTimeout is how long the daemon waits for one RPC before it stops
// waiting and tells the model the action "may have occurred"
// (DEFAULT_RPC_TIMEOUTS.initial in src/sidecar/protocol.ts, 30_000 -- this
// mirrors it; nothing reads it at run time). Every element action has to fit
// inside it, read-back included; TestElementActionsFitTheDaemonTimeout checks.
const daemonRPCTimeout = 30 * time.Second

// readBackPolicy is how long an action's read-back may walk, and what to tell
// the model when that walk fails.
type readBackPolicy struct {
	budget   time.Duration
	slowHint string
}

// macOS's budgets. They live here, not in desktop_darwin.go, so the budget
// arithmetic and the type path's refusal run on Linux with macOS's own values.
//
// jxaWalkTimeout bounds a snapshot's JXA walk and the read-back ahead of a
// click (20s + 5s click = 25s). jxaTypeReadBackTimeout is the read-back ahead
// of a keystroke, where 20s would put the call at 35s, past the daemon's 30s;
// 10s brings it to Linux's 25s. See the budget note in desktop_element_cache.go.
const (
	jxaWalkTimeout         = 20 * time.Second
	jxaTypeReadBackTimeout = 10 * time.Second
)

// jxaTypeSlowHint is what a type read-back that ran out of its shorter budget
// tells the model: the click path has the full 20s, and typing without an
// element_id types wherever the focus is, which is where that click put it.
const jxaTypeSlowHint = ". If this window is slow to read, desktop_click the element first and then call desktop_type without element_id"

var (
	darwinClickReadBack = readBackPolicy{budget: jxaWalkTimeout}
	darwinTypeReadBack  = readBackPolicy{budget: jxaTypeReadBackTimeout, slowHint: jxaTypeSlowHint}
)

// clickElement acts on a cached element id: confirm it (#661), then hand the
// confirmed centre to the platform's dispatchPointer. Every error before
// dispatchPointer is returned before anything moved or clicked.
func clickElement(id int, action string, policy readBackPolicy) (*RPCResult, error) {
	// The actions dispatchPointer performs on Linux and macOS. Checked before
	// the read-back, so an action that cannot run never costs a walk. A switch,
	// not a set: tool-enums.test.ts reads these arms to keep desktop_click's
	// advertised enum equal to what the sidecars accept.
	switch action {
	case "click", "double_click", "right_click", "focus":
	default:
		return nil, fmt.Errorf("action '%s' is not supported on %s (supported: click, double_click, right_click, focus)", action, desktopPlatformName)
	}
	// The rect the element has NOW, confirmed to be the element the snapshot
	// listed, or a refusal before anything is clicked.
	rect, err := resolveDesktopElement(id, policy.budget, policy.slowHint)
	if err != nil {
		return nil, err
	}

	x := toInt(rect["x"]) + toInt(rect["w"])/2
	y := toInt(rect["y"]) + toInt(rect["h"])/2
	if err := dispatchPointer(action, x, y); err != nil {
		return nil, err
	}
	return &RPCResult{Result: map[string]any{"success": true, "action": action, "x": x, "y": y}}, nil
}

// handleClickElementWith is handle_click_element for one platform's policy.
func handleClickElementWith(params map[string]any, policy readBackPolicy) (*RPCResult, error) {
	elemID, ok := params["element_id"].(float64)
	if !ok {
		return nil, fmt.Errorf("missing required parameter: element_id")
	}
	action, _ := params["action"].(string)
	if action == "" {
		action = "click"
	}
	return clickElement(int(elemID), action, policy)
}

// handleTypeTextWith is type_text for one platform: with an element_id it
// clicks that element first -- through the same confirmation, on `policy` --
// and only then hands the text to `keystroke`. A refused click types nothing.
func handleTypeTextWith(params map[string]any, policy readBackPolicy, keystroke func(text string) error) (*RPCResult, error) {
	text, _ := params["text"].(string)
	if text == "" {
		return nil, fmt.Errorf("missing required parameter: text")
	}
	if elemID, ok := params["element_id"].(float64); ok {
		if _, err := clickElement(int(elemID), "click", policy); err != nil {
			return nil, fmt.Errorf("failed to click element before typing: %w", err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err := keystroke(text); err != nil {
		return nil, fmt.Errorf("type_text failed: %w", err)
	}
	return &RPCResult{Result: map[string]any{"success": true}}, nil
}
