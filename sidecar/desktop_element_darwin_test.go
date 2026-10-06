//go:build darwin

package main

import (
	"errors"
	"testing"
	"time"
)

// #712: the one line of macOS wiring the Linux tests cannot reach -- that the
// darwin handlers hand the shared path macOS's own policies. CI only vets this
// file (sidecar-build-darwin); it runs on a Mac with `go test -run
// TestDarwinHandlersUseMacOSReadBack .` and needs no Accessibility permission,
// because the walk is replaced and the element id is refused before any
// pointer or keystroke.
func TestDarwinHandlersUseMacOSReadBack(t *testing.T) {
	var budgets []time.Duration
	walk := walkDesktopElements
	t.Cleanup(func() { walkDesktopElements = walk })
	walkDesktopElements = func(pid, depth int, budget time.Duration) ([]any, error) {
		budgets = append(budgets, budget)
		return nil, errors.New("synthetic walk failure")
	}
	elementCache.fill([]any{map[string]any{"name": "OK", "control_type": "AXButton",
		"rect": map[string]any{"x": 1.0, "y": 1.0, "w": 10.0, "h": 10.0}}}, 1, 5)
	id := float64(desktopElementIDStride * int(elementCache.generation()))

	if _, err := handleClickElement(map[string]any{"element_id": id}); err == nil {
		t.Fatal("click went ahead after a failed read-back")
	}
	if _, err := handleTypeText(map[string]any{"element_id": id, "text": "x"}); err == nil {
		t.Fatal("type went ahead after a failed read-back")
	}
	if len(budgets) != 2 || budgets[0] != jxaWalkTimeout || budgets[1] != jxaTypeReadBackTimeout {
		t.Fatalf("read-back budgets %v, want [%v %v]", budgets, jxaWalkTimeout, jxaTypeReadBackTimeout)
	}
}
