//go:build linux

package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// #712: macOS's half of #661, run where CI runs tests. The click and type
// paths are shared with Linux now (desktop_element_action.go); what makes them
// macOS's is the policy -- the JXA walk's budgets and the slow-window hint --
// and the shape of what the JXA walk returns. Both are exercised here. What is
// still macOS-only, and untested anywhere, is the JXA script itself against a
// real System Events and the cliclick/Quartz dispatch.

// jxaElement is an element as the JXA walk writes it (walkDarwinTree): JSON
// numbers decode to float64, and AX positions and sizes can be fractional.
func jxaElement(name, role string, x, y, w, h float64) map[string]any {
	return map[string]any{
		"id": 0, "name": name, "control_type": role, "automation_id": "",
		"enabled": true, "focusable": true,
		"rect": map[string]any{"x": x, "y": y, "w": w, "h": h},
	}
}

// fakeJXAWalk replaces the walk with one that answers like the JXA walk and
// records the budget each call was given.
func fakeJXAWalk(t *testing.T, elems func() []any, fail func() error) *[]time.Duration {
	t.Helper()
	var budgets []time.Duration
	walk := walkDesktopElements
	t.Cleanup(func() { walkDesktopElements = walk })
	walkDesktopElements = func(pid, depth int, budget time.Duration) ([]any, error) {
		budgets = append(budgets, budget)
		if fail != nil {
			if err := fail(); err != nil {
				return nil, err
			}
		}
		return elems(), nil
	}
	return &budgets
}

func TestMacOSTypeReadBackRefusesBeforeTyping(t *testing.T) {
	s := fakeDesktop(t) // the pointer dispatch here is Linux's, recorded
	var current []any
	budgets := fakeJXAWalk(t, func() []any { return current }, nil)

	current = []any{jxaElement("To", "AXTextField", 100.5, 200, 300, 24)}
	elementCache.fill(current, 4242, 5)
	id := float64(desktopElementIDStride * int(elementCache.generation()))

	// The field was replaced by another control at the same index.
	current = []any{jxaElement("Password", "AXSecureTextField", 100.5, 200, 300, 24)}
	typed := 0
	_, err := handleTypeTextWith(map[string]any{"element_id": id, "text": "hunter2"}, darwinTypeReadBack,
		func(string) error { typed++; return nil })

	var coded *codedError
	if !errors.As(err, &coded) || coded.code != desktopStaleElementCode {
		t.Fatalf("got %v, want a %s refusal", err, desktopStaleElementCode)
	}
	if typed != 0 {
		t.Fatalf("typed %d times after a refused click", typed)
	}
	if acted := s.pointerCalls(); len(acted) != 0 {
		t.Errorf("the pointer moved: %q", acted)
	}
	// The read-back ahead of a keystroke got macOS's 10s, not the click's 20s.
	if len(*budgets) != 1 || (*budgets)[0] != 10*time.Second {
		t.Errorf("read-back budgets %v, want exactly one of 10s", *budgets)
	}
}

func TestMacOSTypeReadBackThatOverrunsSaysHowToProceed(t *testing.T) {
	fakeDesktop(t)
	elems := []any{jxaElement("To", "AXTextField", 100, 200, 300, 24)}
	fakeJXAWalk(t, func() []any { return elems }, func() error { return errors.New("signal: killed") })
	elementCache.fill(elems, 4242, 5)
	id := float64(desktopElementIDStride * int(elementCache.generation()))

	typed := 0
	_, err := handleTypeTextWith(map[string]any{"element_id": id, "text": "x"}, darwinTypeReadBack,
		func(string) error { typed++; return nil })
	if err == nil || !strings.Contains(err.Error(), jxaTypeSlowHint) {
		t.Fatalf("got %v, want the slow-window hint", err)
	}
	if typed != 0 {
		t.Fatalf("typed after the read-back failed")
	}
}

func TestMacOSClickConfirmsJXAElementsAndDispatchesTheConfirmedCentre(t *testing.T) {
	s := fakeDesktop(t)
	elems := []any{jxaElement("OK", "AXButton", 100.6, 200.2, 80, 30)}
	budgets := fakeJXAWalk(t, func() []any { return elems }, nil)
	elementCache.fill(elems, 4242, 5)
	id := float64(desktopElementIDStride * int(elementCache.generation()))

	res, err := handleClickElementWith(map[string]any{"element_id": id}, darwinClickReadBack)
	if err != nil {
		t.Fatalf("an unchanged JXA element was refused: %v", err)
	}
	// Fractional AX coordinates truncate the same way on both walks, and the
	// click goes to the centre of the rect the read-back confirmed.
	if m := res.Result.(map[string]any); m["x"] != 140 || m["y"] != 215 {
		t.Errorf("clicked at (%v, %v), want (140, 215)", m["x"], m["y"])
	}
	if acted := s.pointerCalls(); len(acted) != 1 {
		t.Errorf("pointer calls %q, want one", acted)
	}
	if len(*budgets) != 1 || (*budgets)[0] != 20*time.Second {
		t.Errorf("click read-back budgets %v, want exactly one of 20s", *budgets)
	}

	// A whole-pixel move is a move.
	elems = []any{jxaElement("OK", "AXButton", 101.6, 200.2, 80, 30)}
	if _, err := handleClickElementWith(map[string]any{"element_id": id}, darwinClickReadBack); err == nil ||
		!strings.Contains(err.Error(), "has moved") {
		t.Fatalf("got %v, want a moved refusal", err)
	}
}

func TestElementActionsFitTheDaemonTimeout(t *testing.T) {
	// Read-back + pointer action (+ keystroke) per platform and path. 25s
	// leaves the daemon's 30s a margin; past 30s the daemon tells the model a
	// refused or finished action "may have occurred", and it retries.
	for _, tc := range []struct {
		name  string
		total time.Duration
	}{
		{"linux click", linuxReadBack.budget + pointerDispatchTimeout},
		{"linux type", linuxReadBack.budget + pointerDispatchTimeout + keystrokeTimeout},
		{"macOS click", darwinClickReadBack.budget + pointerDispatchTimeout},
		{"macOS type", darwinTypeReadBack.budget + pointerDispatchTimeout + keystrokeTimeout},
	} {
		if tc.total > 25*time.Second || 25*time.Second >= daemonRPCTimeout {
			t.Errorf("%s takes up to %v, over the 25s budget under the daemon's %v", tc.name, tc.total, daemonRPCTimeout)
		}
	}
}

func TestUnsupportedActionIsRefusedWithoutAWalk(t *testing.T) {
	fakeDesktop(t)
	elems := []any{jxaElement("OK", "AXButton", 100, 200, 80, 30)}
	budgets := fakeJXAWalk(t, func() []any { return elems }, nil)
	// A live id, so the only thing standing between it and a walk is the action check.
	elementCache.fill(elems, 4242, 5)
	id := float64(desktopElementIDStride * int(elementCache.generation()))
	_, err := handleClickElementWith(map[string]any{"element_id": id, "action": "invoke"}, darwinClickReadBack)
	if err == nil || !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("got %v, want an unsupported-action refusal", err)
	}
	if len(*budgets) != 0 {
		t.Errorf("walked %d times for an action that cannot run", len(*budgets))
	}
}
