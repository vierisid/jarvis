package main

import "fmt"

// desktop_pointer_target.go -- whether a click at an element's centre would
// reach the element's own window (#705), as a decision with no platform calls
// in it, so it runs on every platform. Windows feeds it window handles; Linux
// compares owning pids from xdotool (pointerTargetMismatch in desktop_linux.go).

// mouseFallbackAfterInvoke decides what a Windows click does after trying the
// Invoke pattern: done when Invoke ran; the mouse only when the element has no
// Invoke pattern, so nothing was attempted. A failed Invoke CALL may already
// have run the control's action -- the provider timed out, or the action
// closed the window it lived in -- so it is reported as it is, an uncoded
// error the daemon reads as "may have occurred", and never followed by a mouse
// click or by a refusal that would tell the model nothing happened.
func mouseFallbackAfterInvoke(supported bool, invokeErr error) (useMouse bool, err error) {
	switch {
	case !supported:
		return true, nil
	case invokeErr != nil:
		return false, fmt.Errorf("the Invoke action was sent and failed, so it may or may not have taken effect: %w", invokeErr)
	}
	return false, nil
}

// pointerWindowMismatch says why a mouse click at the element's centre would
// not be delivered to the element's window, or "" when it would.
//
//   - target is the top-level window hosting the element (uiaHostingWindow),
//     and targetKnown whether it could be established at all;
//   - hit is the top-level window WindowFromPoint names at the centre -- the
//     window Windows' own hit test, the one that delivers the click, picks,
//     skipping windows that are transparent to the mouse.
//
// The comparison is on windows, not processes: content hosted in another
// process (WebView2, a UWP frame) is still inside the element's window, and
// that is not an overlay.
//
// The mouse capture is deliberately NOT consulted, although the recorder
// (clickAttribution) uses it: there it is read the moment a real click
// happened, and says where that click went. Read ahead of a synthesized click
// it is not that: on the Windows 11 machine this was developed on, the
// foreground thread reported a capture window with no menu open and no button
// down, and checking it refused clicks the hit test said would land.
func pointerWindowMismatch(target uintptr, targetKnown bool, hit uintptr) string {
	switch {
	case !targetKnown || target == 0:
		return "has no window that could be established"
	case hit == 0:
		return "is not under any window"
	case hit != target:
		return fmt.Sprintf("is covered by another window (%#x, not its own %#x)", hit, target)
	}
	return ""
}
