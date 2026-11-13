//go:build windows

package main

// Acting at a place on the screen, and saying what is at a place, on Windows.
// The reading of the request and the arithmetic are in desktop_pointer.go.

import (
	"fmt"
	"syscall"
	"unsafe"

	"github.com/go-ole/go-ole"
)

var procPointerGetSystemMetrics = user32.NewProc("GetSystemMetrics")

const (
	pointerSmCxScreen       = 0 // width of the main display
	pointerSmCyScreen       = 1 // its height
	pointerMouseEventfWheel = 0x0800
	pointerWheelNotch       = 120
)

// mainDisplayPixels is the size of the main display in its own pixels. This
// program is aware of each display's scale, so these are real pixels, the
// same ones the pointer is placed in.
func mainDisplayPixels() (int, int) {
	w, _, _ := procPointerGetSystemMetrics.Call(pointerSmCxScreen)
	h, _, _ := procPointerGetSystemMetrics.Call(pointerSmCyScreen)
	return int(int32(w)), int(int32(h))
}

// pointerPlaceFree refuses a place that is on one of Jarvis's own windows.
// The notch is given a moment first: the sheet that asked whether this very
// action may be done is often still folding back over the place.
func pointerPlaceFree(x, y int) error {
	hit := win32RootWindow(win32WindowFromPoint(x, y))
	for waited := 0; ownOverlayWindow(hit) && waited < 12; waited++ {
		procSleep.Call(150)
		hit = win32RootWindow(win32WindowFromPoint(x, y))
	}
	if ownOverlayWindow(hit) {
		return &codedError{code: desktopPointerRefusedCode, err: fmt.Errorf("%s", pointerUnderNotch("the place", x, y))}
	}
	if ownWindow(hit) {
		return &codedError{code: desktopPointerRefusedCode, err: fmt.Errorf("%s", pointerOnOwnWindow(x, y))}
	}
	// Windows drops a click sent to a window that runs as administrator from
	// a program that does not, the way it drops keys, and says nothing.
	if windowKeyReach(hit) == keysBlocked {
		return &codedError{code: desktopPointerRefusedCode, err: fmt.Errorf(
			"the window at (%d, %d) runs as administrator and Jarvis does not, so Windows would drop the action: nothing was done. "+
				"Jarvis cannot act in that window. Tell the user so; do NOT retry", x, y)}
	}
	return nil
}

// win32Scroll turns the wheel over a place. As pointerPress, the place is
// looked at once more with the pointer there.
func win32Scroll(x, y, notches int) error {
	procSetCursorPos.Call(uintptr(x), uintptr(y))
	procSleep.Call(50)
	if ownWindow(win32RootWindow(win32WindowFromPoint(x, y))) {
		return &codedError{code: desktopPointerRefusedCode, err: fmt.Errorf("%s", pointerOnOwnWindow(x, y))}
	}
	step := int32(pointerWheelNotch)
	if notches < 0 {
		step, notches = -step, -notches
	}
	for i := 0; i < notches; i++ {
		procMouseEvent.Call(pointerMouseEventfWheel, 0, 0, uintptr(uint32(step)), 0)
		procSleep.Call(15)
	}
	return nil
}

// win32Drag presses at one place and lets go at another. The start is looked
// at once more with the pointer there, before the button goes down. Letting go
// over a window that came up meanwhile presses nothing in it: a press is a
// button going down and up on the same thing.
func win32Drag(x, y, toX, toY int) error {
	procSetCursorPos.Call(uintptr(x), uintptr(y))
	procSleep.Call(50)
	if ownWindow(win32RootWindow(win32WindowFromPoint(x, y))) {
		return &codedError{code: desktopPointerRefusedCode, err: fmt.Errorf("%s", pointerOnOwnWindow(x, y))}
	}
	procMouseEvent.Call(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
	procSleep.Call(80)
	for _, step := range pointerDragSteps(x, y, toX, toY) {
		procSetCursorPos.Call(uintptr(step[0]), uintptr(step[1]))
		procSleep.Call(15)
	}
	procSleep.Call(80)
	procMouseEvent.Call(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
	return nil
}

func handlePointerAction(params map[string]any) (*RPCResult, error) {
	req, err := parsePointerRequest(params)
	if err != nil {
		// Read before anything is done: a refusal, not an unknown outcome.
		return nil, &codedError{code: desktopPointerRefusedCode, err: fmt.Errorf("pointer_action refused, nothing was done: %w", err)}
	}
	w, h := mainDisplayPixels()
	if w <= 0 || h <= 0 {
		return nil, &codedError{code: desktopPointerRefusedCode, err: fmt.Errorf("pointer_action refused, nothing was done: the size of the main display could not be read")}
	}
	x, y := pointerPixel(req.FX, w), pointerPixel(req.FY, h)
	if err := pointerPlaceFree(x, y); err != nil {
		return nil, fmt.Errorf("pointer_action refused: %w", err)
	}
	// The window that is there now, as a number: nothing read from the screen
	// goes into this reply.
	result := map[string]any{
		"success": true, "action": req.Action, "screen_x": x, "screen_y": y,
		"window_pid": win32GetWindowPid(win32RootWindow(win32WindowFromPoint(x, y))),
	}
	var acted error
	switch req.Action {
	case "click":
		acted = pointerPress(x, y, "click")
	case "double_click":
		acted = pointerPress(x, y, "double_click")
	case "right_click":
		acted = pointerPress(x, y, "right_click")
	case "scroll_up":
		acted = win32Scroll(x, y, req.Amount)
	case "scroll_down":
		acted = win32Scroll(x, y, -req.Amount)
	case "drag":
		toX, toY := pointerPixel(req.ToFX, w), pointerPixel(req.ToFY, h)
		if err := pointerPlaceFree(toX, toY); err != nil {
			return nil, fmt.Errorf("pointer_action refused: %w", err)
		}
		acted = win32Drag(x, y, toX, toY)
		result["to_screen_x"], result["to_screen_y"] = toX, toY
	}
	if acted != nil {
		// The pointer moved and nothing was pressed or turned.
		return nil, fmt.Errorf("pointer_action refused: %w", acted)
	}
	return &RPCResult{Result: result}, nil
}

func win32WindowTitle(hwnd uintptr) string {
	if hwnd == 0 {
		return ""
	}
	var buf [256]uint16
	procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return truncateRunes(syscall.UTF16ToString(buf[:]), 120)
}

// handleDescribeTarget says what an action would land on, for the person who
// is asked whether it may be done: the window, and the element when there is
// one. It only reads. With `element_id` it is that element of the last read;
// with `fx` and `fy` it is whatever is at that place; with neither it is the
// window in front, which is where typed text and keys go.
//
// What it returns is text from the screen. It is for showing to the person,
// as it is, and for nothing else.
func handleDescribeTarget(params map[string]any) (*RPCResult, error) {
	result := map[string]any{}
	window := func(hwnd uintptr) {
		if hwnd == 0 {
			return
		}
		result["window_title"] = win32WindowTitle(hwnd)
		result["process_name"] = processBaseName(win32GetWindowPid(hwnd))
		if ownWindow(hwnd) {
			result["own"] = true
		}
	}
	element := func(elem *ole.IDispatch) {
		result["element_role"] = controlTypeName(uiaElementGetPropertyInt(elem, UIA_ControlTypePropertyId))
		result["element_name"] = truncateRunes(uiaElementGetPropertyStr(elem, UIA_NamePropertyId), elementNameRunes)
	}

	if id, ok := params["element_id"].(float64); ok {
		_, err := comThread.call(func(state *uiaState) (any, error) {
			elem, _, known := state.cache.get(int(id))
			if !known {
				return nil, nil
			}
			element(elem)
			if walker, werr := uiaRawViewWalker(state.automation); werr == nil {
				defer walker.Release()
				if hwnd, _, ok := uiaHostingWindow(walker, elem); ok {
					window(hwnd)
				}
			}
			return nil, nil
		})
		if err != nil {
			return &RPCResult{Result: map[string]any{}}, nil
		}
		return &RPCResult{Result: result}, nil
	}

	if _, placed := params["fx"].(float64); placed {
		fx, errX := pointerFraction(params, "fx")
		fy, errY := pointerFraction(params, "fy")
		w, h := mainDisplayPixels()
		if errX != nil || errY != nil || w <= 0 || h <= 0 {
			return &RPCResult{Result: result}, nil
		}
		x, y := pointerPixel(fx, w), pointerPixel(fy, h)
		window(win32RootWindow(win32WindowFromPoint(x, y)))
		_, _ = comThread.call(func(state *uiaState) (any, error) {
			if elem, err := uiaElementFromPoint(state.automation, x, y); err == nil && elem != nil {
				defer elem.Release()
				element(elem)
			}
			return nil, nil
		})
		return &RPCResult{Result: result}, nil
	}

	window(win32GetForegroundWindow())
	return &RPCResult{Result: result}, nil
}
