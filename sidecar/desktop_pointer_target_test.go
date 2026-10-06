package main

import (
	"errors"
	"strings"
	"testing"
)

// #705 review: a Windows click falls back to the mouse only when the element has
// no Invoke pattern. An Invoke that was sent and failed may have run.
func TestMouseFallbackAfterInvoke(t *testing.T) {
	if use, err := mouseFallbackAfterInvoke(false, errors.New("no pattern")); !use || err != nil {
		t.Errorf("no Invoke pattern: got %v, %v; want the mouse", use, err)
	}
	if use, err := mouseFallbackAfterInvoke(true, nil); use || err != nil {
		t.Errorf("Invoke ran: got %v, %v; want done", use, err)
	}
	use, err := mouseFallbackAfterInvoke(true, errors.New("Invoke failed: timeout"))
	var coded *codedError
	if use || err == nil || errors.As(err, &coded) || !strings.Contains(err.Error(), "may or may not have taken effect") {
		t.Errorf("Invoke failed: got %v, %v; want an uncoded may-have-happened error and no mouse", use, err)
	}
}

// #705: the Windows decision, on every platform (the calls that feed it are
// windows-only and run in uia_element_guard_windows_test.go).
func TestPointerWindowMismatch(t *testing.T) {
	const own, other = uintptr(0x100), uintptr(0x200)
	for _, tc := range []struct {
		name   string
		target uintptr
		known  bool
		hit    uintptr
		want   string // "" = the click reaches the element's window
	}{
		{"its own window is on top", own, true, own, ""},
		{"another window covers it", own, true, other, "covered by another window"},
		{"nothing under the point", own, true, 0, "not under any window"},
		{"its window could not be established", 0, false, own, "no window"},
		{"a window handle without its lookup succeeding", own, false, own, "no window"},
	} {
		got := pointerWindowMismatch(tc.target, tc.known, tc.hit)
		if (tc.want == "") != (got == "") || !strings.Contains(got, tc.want) {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}
