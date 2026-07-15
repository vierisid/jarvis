//go:build windows

// uia_actions_windows.go — High-level action dispatch for desktop automation.
//
// Maps action strings (click, invoke, toggle, set_value, etc.) to the
// appropriate UIAutomation pattern call or mouse event.

package main

import (
	"fmt"

	"github.com/go-ole/go-ole"
)

// uiaPerformAction executes an action on a cached element.
func uiaPerformAction(state *uiaState, elementID int, action, value string) (map[string]any, error) {
	return uiaPerformActionMode(state, elementID, action, value, false)
}

// uiaPerformActionMode is uiaPerformAction with an explicit background flag.
// In background mode, actions must not steal focus or move the real cursor:
// UIA pattern calls (which never do) are preferred, and the coordinate
// fallback uses PostMessage instead of SetCursorPos+mouse_event. When neither
// is possible the result carries background_unavailable so the caller can
// honestly downgrade to a foreground action with the user's notice.
func uiaPerformActionMode(state *uiaState, elementID int, action, value string, background bool) (map[string]any, error) {
	elem := state.cache.get(elementID)
	if elem == nil {
		return nil, fmt.Errorf("element %d is not in the current element cache — every desktop_snapshot invalidates all previous ids, so only ids from the MOST RECENT snapshot/find_element are valid; take a fresh desktop_snapshot and use an id from that result", elementID)
	}

	result := map[string]any{
		"element_id": elementID,
		"action":     action,
		"success":    false,
	}

	var err error

	switch action {
	case "click":
		if background {
			err = actionClickBackground(elem, result)
		} else {
			err = actionClick(elem)
		}
	case "double_click":
		err = actionDoubleClick(elem)
	case "right_click":
		err = actionRightClick(elem)
	case "invoke":
		err = patternInvoke(elem)
	case "toggle":
		err = patternToggle(elem)
		if err == nil {
			state, _ := patternGetToggleState(elem)
			toggleNames := map[int]string{0: "Off", 1: "On", 2: "Indeterminate"}
			result["toggle_state"] = toggleNames[state]
		}
	case "set_value":
		if value == "" {
			return nil, fmt.Errorf("set_value action requires a 'value' parameter")
		}
		err = patternSetValue(elem, value)
	case "get_value":
		var val string
		val, err = patternGetValue(elem)
		if err == nil {
			result["value"] = val
		}
	case "expand":
		err = patternExpand(elem)
	case "collapse":
		err = patternCollapse(elem)
	case "select":
		err = patternSelectItem(elem)
	case "scroll_into_view":
		err = patternScrollIntoView(elem)
	case "focus":
		err = uiaElementSetFocus(elem)
	default:
		return nil, fmt.Errorf("unsupported action: %s (supported: click, double_click, right_click, invoke, toggle, set_value, get_value, expand, collapse, select, scroll_into_view, focus)", action)
	}

	if err != nil {
		return nil, err
	}

	result["success"] = true
	return result, nil
}

// actionClick activates an element, preferring the UIA Invoke pattern
// (a COM call that fires the control's default action without moving
// the OS cursor). Falls back to the win32Click cursor-move + mouse-event
// path only when Invoke isn't supported by the widget — keeps the
// user's actual cursor where they left it for everything that supports
// the structured COM path (most native Windows controls do).
func actionClick(elem *ole.IDispatch) error {
	if err := patternInvoke(elem); err == nil {
		return nil
	}
	x, y, err := elementCenter(elem)
	if err != nil {
		return err
	}
	win32Click(x, y)
	return nil
}

// actionClickBackground is actionClick for ghost mode: UIA Invoke first (never
// touches the cursor/focus), else a PostMessage click. It annotates result with
// how it was delivered; when the element has no Invoke pattern AND no layout
// box for a PostMessage target, it sets background_unavailable so the caller
// can downgrade honestly rather than silently steal focus.
func actionClickBackground(elem *ole.IDispatch, result map[string]any) error {
	if err := patternInvoke(elem); err == nil {
		result["delivery"] = "invoke"
		return nil
	}
	x, y, err := elementCenter(elem)
	if err != nil {
		result["background_unavailable"] = true
		return fmt.Errorf("cannot click in the background: the element supports neither the Invoke pattern nor a clickable point — retry without background to use a foreground click (this will briefly move the cursor)")
	}
	if postMessageClick(x, y) {
		result["delivery"] = "post_message"
		return nil
	}
	result["background_unavailable"] = true
	return fmt.Errorf("cannot click in the background: no window accepted a posted click at the element — retry without background to use a foreground click")
}

// actionDoubleClick moves the mouse to the element center and double-clicks.
func actionDoubleClick(elem *ole.IDispatch) error {
	x, y, err := elementCenter(elem)
	if err != nil {
		return err
	}
	win32DoubleClick(x, y)
	return nil
}

// actionRightClick moves the mouse to the element center and right-clicks.
func actionRightClick(elem *ole.IDispatch) error {
	x, y, err := elementCenter(elem)
	if err != nil {
		return err
	}
	win32RightClick(x, y)
	return nil
}

// elementCenter returns the center coordinates of an element's bounding rectangle.
func elementCenter(elem *ole.IDispatch) (int, int, error) {
	x, y, w, h := uiaElementGetBoundingRect(elem)
	if w == 0 && h == 0 {
		return 0, 0, fmt.Errorf("element has no bounding rectangle (invisible or off-screen)")
	}
	return x + w/2, y + h/2, nil
}
