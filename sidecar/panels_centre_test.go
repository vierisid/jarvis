package main

import "testing"

func TestPanelCentredIsInTheMiddleAndNeverOffTheScreen(t *testing.T) {
	x, y := panelCentred(1920, 1080, 420, 132)
	if x != 750 || y != 379 {
		t.Fatalf("got %d,%d", x, y)
	}
	// The same distance from both sides.
	if x != 1920-420-x {
		t.Fatalf("not centred across: %d", x)
	}
	// Above the middle, not at the top.
	if y <= 0 || y >= (1080-132)/2 {
		t.Fatalf("not a little above the middle: %d", y)
	}
	// A window larger than the screen starts at its corner.
	if x, y = panelCentred(300, 100, 420, 132); x != 0 || y != 0 {
		t.Fatalf("off the screen: %d,%d", x, y)
	}
}
