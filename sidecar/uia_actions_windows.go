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
	// Before ANY action (#661; uia_element_guard.go). No generation check:
	// every call runs on the one COM thread, so a snapshot cannot refill the
	// cache between this check and the action.
	elem, err := guardCachedElement(state.cache, elementID, uiaElementPrint)
	if err != nil {
		return nil, err
	}

	result := map[string]any{
		"element_id": elementID,
		"action":     action,
		"success":    false,
	}

	switch action {
	case "click":
		err = actionClick(state, elementID, elem)
	case "double_click":
		err = actionDoubleClick(state, elementID, elem)
	case "right_click":
		err = actionRightClick(state, elementID, elem)
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

// uiaElementPrint reads an element's print the way the snapshot walk reports
// it: the name truncated to the same length, so an over-long name compares
// equal to itself. A dead element reads back empty and so never matches the
// print of one that had a name or a role.
func uiaElementPrint(elem *ole.IDispatch) desktopElementPrint {
	x, y, w, h := uiaElementGetBoundingRect(elem)
	return desktopElementPrint{
		name:   truncateRunes(uiaElementGetPropertyStr(elem, UIA_NamePropertyId), elementNameRunes),
		role:   controlTypeName(uiaElementGetPropertyInt(elem, UIA_ControlTypePropertyId)),
		autoID: uiaElementGetPropertyStr(elem, UIA_AutomationIdPropertyId),
		x:      x, y: y, w: w, h: h,
	}
}

// actionClick activates an element, preferring the UIA Invoke pattern
// (a COM call that fires the control's default action without moving
// the OS cursor). Falls back to the win32Click cursor-move + mouse-event
// path only when Invoke isn't supported by the widget — keeps the
// user's actual cursor where they left it for everything that supports
// the structured COM path (most native Windows controls do).
//
// Invoke acts on the element itself, so what is drawn over it does not
// matter. The mouse fallback does: it is checked first (pointerReachesElement).
func actionClick(state *uiaState, id int, elem *ole.IDispatch) error {
	supported, invokeErr := invokeIfSupported(elem)
	if useMouse, err := mouseFallbackAfterInvoke(supported, invokeErr); !useMouse {
		return err
	}
	x, y, err := pointerReachesElement(state, id, elem)
	if err != nil {
		return err
	}
	win32Click(x, y)
	return nil
}

// actionDoubleClick moves the mouse to the element center and double-clicks.
func actionDoubleClick(state *uiaState, id int, elem *ole.IDispatch) error {
	x, y, err := pointerReachesElement(state, id, elem)
	if err != nil {
		return err
	}
	win32DoubleClick(x, y)
	return nil
}

// actionRightClick moves the mouse to the element center and right-clicks.
func actionRightClick(state *uiaState, id int, elem *ole.IDispatch) error {
	x, y, err := pointerReachesElement(state, id, elem)
	if err != nil {
		return err
	}
	win32RightClick(x, y)
	return nil
}

// pointerReachesElement returns the element's centre, or a refusal when a
// mouse click there would not reach the element's own window (#705). The
// element passed the read-back, but its bounds ignore stacking: another
// window can cover it, and a click at its centre then goes to that window.
//
// Read before the pointer moves: WindowFromPoint hit-tests a point, it does
// not need the cursor there, so a refusal leaves the pointer where it was.
// It is the hit test Windows performs to deliver the click, so a window that
// is transparent to the mouse (an overlay that lets clicks through) is
// skipped exactly as the click would skip it, and does not cause a refusal.
//
// Cost: WindowFromPoint is an in-process user32 call; the
// element's hosting window is a short climb of cross-process UIA property
// reads. Measured by TestUIAPointerCheckCost on the machine that runs it.
func pointerReachesElement(state *uiaState, id int, elem *ole.IDispatch) (int, int, error) {
	x, y, err := elementCenter(elem)
	if err != nil {
		return 0, 0, err
	}
	walker, err := uiaRawViewWalker(state.automation)
	if err != nil {
		return 0, 0, &codedError{code: desktopTargetObscuredCode, err: fmt.Errorf(
			"could not confirm element [%d]'s window is the one under its centre (%v), so nothing was clicked", id, err)}
	}
	defer walker.Release()
	target, _, known := uiaHostingWindow(walker, elem)
	hit := win32RootWindow(win32WindowFromPoint(x, y))
	if why := pointerWindowMismatch(target, known, hit); why != "" {
		return 0, 0, &codedError{code: desktopTargetObscuredCode, err: fmt.Errorf(
			"element [%d] %s at its centre (%d, %d), so nothing was clicked. "+
				"Bring its window to the front with desktop_focus_window, then take a new desktop_snapshot", id, why, x, y)}
	}
	return x, y, nil
}

// elementCenter returns the center coordinates of an element's bounding rectangle.
func elementCenter(elem *ole.IDispatch) (int, int, error) {
	x, y, w, h := uiaElementGetBoundingRect(elem)
	if w == 0 && h == 0 {
		return 0, 0, fmt.Errorf("element has no bounding rectangle (invisible or off-screen)")
	}
	return x + w/2, y + h/2, nil
}
