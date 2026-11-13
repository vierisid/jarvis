package main

import (
	"strings"
	"testing"
)

func TestParsePointerRequest(t *testing.T) {
	req, err := parsePointerRequest(map[string]any{"fx": 0.5, "fy": 0.25})
	if err != nil || req.Action != "click" || req.FX != 0.5 || req.FY != 0.25 || req.Amount != 3 {
		t.Errorf("a place alone is a click there: got %+v, %v", req, err)
	}
	req, err = parsePointerRequest(map[string]any{"action": "drag", "fx": 0.1, "fy": 0.2, "to_fx": 0.9, "to_fy": 1.0})
	if err != nil || req.ToFX != 0.9 || req.ToFY != 1.0 {
		t.Errorf("a drag has an end: got %+v, %v", req, err)
	}
	req, err = parsePointerRequest(map[string]any{"action": "scroll_down", "fx": 0.0, "fy": 0.0, "amount": 5.0})
	if err != nil || req.Amount != 5 {
		t.Errorf("a scroll has an amount: got %+v, %v", req, err)
	}
	for name, params := range map[string]map[string]any{
		"no place":               {"action": "click"},
		"half a place":           {"fx": 0.5},
		"a place off the screen": {"fx": 1.2, "fy": 0.5},
		"a place before it":      {"fx": 0.5, "fy": -0.1},
		"pixels, not fractions":  {"fx": 640.0, "fy": 360.0},
		"a place as text":        {"fx": "0.5", "fy": 0.5},
		"an invented action":     {"action": "smash", "fx": 0.5, "fy": 0.5},
		"a drag with no end":     {"action": "drag", "fx": 0.5, "fy": 0.5},
		"a drag ending off it":   {"action": "drag", "fx": 0.5, "fy": 0.5, "to_fx": 0.5, "to_fy": 2.0},
		"no scroll at all":       {"action": "scroll_up", "fx": 0.5, "fy": 0.5, "amount": 0.0},
		"an endless scroll":      {"action": "scroll_up", "fx": 0.5, "fy": 0.5, "amount": 5000.0},
		"half a notch":           {"action": "scroll_up", "fx": 0.5, "fy": 0.5, "amount": 2.5},
	} {
		if _, err := parsePointerRequest(params); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
}

func TestPointerPixelIsAlwaysOnTheDisplay(t *testing.T) {
	for _, c := range []struct {
		fraction float64
		size     int
		want     int
	}{
		{0, 2560, 0}, {0.5, 2560, 1280}, {1, 2560, 2559}, {0.999999, 1440, 1439}, {0.25, 1440, 360}, {0.5, 0, 0}, {0.5, 1, 0},
	} {
		if got := pointerPixel(c.fraction, c.size); got != c.want {
			t.Errorf("pointerPixel(%v, %d) = %d, want %d", c.fraction, c.size, got, c.want)
		}
	}
}

func TestPointerDragStepsEndWhereTold(t *testing.T) {
	path := pointerDragSteps(100, 100, 400, 50)
	if len(path) < 5 {
		t.Fatalf("a drag is made of moves in between, got %d", len(path))
	}
	if last := path[len(path)-1]; last != [2]int{400, 50} {
		t.Errorf("it ends at %v, want (400, 50)", last)
	}
	for i := 1; i < len(path); i++ {
		if path[i][0] < path[i-1][0] || path[i][1] > path[i-1][1] {
			t.Errorf("it must go one way all the way: %v then %v", path[i-1], path[i])
		}
	}
	if still := pointerDragSteps(7, 7, 7, 7); still[len(still)-1] != [2]int{7, 7} {
		t.Errorf("a drag to where it is stays there: %v", still)
	}
}

func TestPointerOnOwnWindowSaysNothingWasDone(t *testing.T) {
	if text := pointerOnOwnWindow(3, 4); !strings.Contains(text, "(3, 4)") || !strings.Contains(text, "nothing was done") {
		t.Errorf("got %s", text)
	}
}
