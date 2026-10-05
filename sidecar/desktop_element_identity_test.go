package main

import (
	"errors"
	"strings"
	"testing"
)

// The comparison every platform's action path runs (#661). Windows calls it
// non-positional and cannot be exercised on the Linux runner, so its half of
// the contract is pinned here, where it runs everywhere.
func TestDesktopElementChange(t *testing.T) {
	snap := desktopElementPrint{name: "Cancel", role: "push button", x: 100, y: 400, w: 80, h: 30}
	moved := snap
	moved.x = 600
	resized := snap
	resized.h = 31
	renamed := snap
	renamed.name = "Delete account"
	recast := snap
	recast.role = "link"

	for _, tc := range []struct {
		name       string
		live       desktopElementPrint
		positional bool
		want       string
	}{
		{"unchanged, positional", snap, true, ""},
		{"unchanged, live element", snap, false, ""},
		{"moved, positional", moved, true, "has moved"},
		{"resized, positional", resized, true, "has moved"},
		// Windows acts on the live COM element and reads its bounds at click
		// time, so a window that moved has not re-targeted the id.
		{"moved, live element", moved, false, ""},
		{"renamed, positional", renamed, true, "is a different element now"},
		{"renamed, live element", renamed, false, "is a different element now"},
		{"recast, live element", recast, false, "is a different element now"},
	} {
		if got := desktopElementChange(snap, tc.live, tc.positional); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestDesktopElementRefusalsAreCodedAndActionable(t *testing.T) {
	for name, err := range map[string]error{
		"not cached": desktopElementNotCached(3),
		"stale":      desktopElementStale(3, "has moved"),
		"superseded": desktopElementSuperseded(3),
	} {
		var coded *codedError
		if !errors.As(err, &coded) || coded.code != desktopStaleElementCode {
			t.Errorf("%s: %v is not a %s refusal", name, err, desktopStaleElementCode)
		}
		msg := err.Error()
		for _, want := range []string{"[3]", "nothing was done", "desktop_snapshot"} {
			if !strings.Contains(msg, want) {
				t.Errorf("%s: %q does not mention %q", name, msg, want)
			}
		}
	}
}
