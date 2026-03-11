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
	elem := state.cache.get(elementID)
	if elem == nil {
		return nil, fmt.Errorf("element %d not found in cache — run desktop_snapshot first", elementID)
	}

	result := map[string]any{
		"element_id": elementID,
		"action":     action,
		"success":    false,
	}

	var err error

	switch action {
	case "click":
		err = actionClick(elem)
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

// actionClick moves the mouse to the element center and performs a left click.
func actionClick(elem *ole.IDispatch) error {
	x, y, err := elementCenter(elem)
	if err != nil {
		// Fallback: try invoke pattern
		if invokeErr := patternInvoke(elem); invokeErr == nil {
			return nil
		}
		return err
	}
	win32Click(x, y)
	return nil
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
