//go:build !windows

package main

// The look is built for Windows so far (notch_look_windows.go): the watch on
// the pointer, the ink and the reading of what is inside a line are each a
// platform's own. Elsewhere it has no hands, so the pen is never armed and
// the pointer is never watched.
func platformNotchLookHands(l *NotchLook) lookHands { return nil }

// platformNotchWindowRead reads the window the person is in. Not built here yet.
func platformNotchWindowRead() (map[string]any, error) {
	return nil, errNotchLookNotHere
}
