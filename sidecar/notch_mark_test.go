package main

import (
	"testing"
	"time"
)

func TestTheSweepBeginsAfterAMomentAndEndsFull(t *testing.T) {
	if got := notchMarkUpTo(0, 200); got != 0 {
		t.Fatalf("at once: %d columns, want 0", got)
	}
	if got := notchMarkUpTo(notchMarkDelay, 200); got != 0 {
		t.Fatalf("at the end of the delay: %d columns, want 0", got)
	}
	if got := notchMarkUpTo(notchMarkDelay+notchMarkSweep, 200); got != 200 {
		t.Fatalf("when the sweep is over: %d columns, want 200", got)
	}
	if got := notchMarkUpTo(time.Hour, 200); got != 200 {
		t.Fatalf("long after: %d columns, want 200", got)
	}
	if got := notchMarkUpTo(time.Second, 0); got != 0 {
		t.Fatalf("a mark with no width: %d columns, want 0", got)
	}
}

func TestTheSweepOnlyEverGoesForwardAndIsFastFirst(t *testing.T) {
	last := 0
	for gone := time.Duration(0); gone <= notchMarkDelay+notchMarkSweep+50*time.Millisecond; gone += 5 * time.Millisecond {
		got := notchMarkUpTo(gone, 400)
		if got < last {
			t.Fatalf("after %v the sweep went back: %d after %d", gone, got, last)
		}
		if got < 0 || got > 400 {
			t.Fatalf("after %v: %d columns of 400", gone, got)
		}
		last = got
	}
	// Halfway through its time it is well past the middle: it eases out.
	if half := notchMarkUpTo(notchMarkDelay+notchMarkSweep/2, 400); half <= 300 {
		t.Fatalf("halfway through the sweep: %d of 400 columns, want more than 300", half)
	}
}

func TestOnlyTheColumnsAskedForAreColoured(t *testing.T) {
	const w, h = 40, 12
	pixels := make([]uint32, w*h)
	colour := notchMarkPixel()
	notchMarkFill(pixels, w, h, 10, 20, 0, colour)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			want := uint32(0)
			if x >= 10 && x < 20 {
				want = colour
			}
			if pixels[y*w+x] != want {
				t.Fatalf("pixel %d,%d is %#x, want %#x", x, y, pixels[y*w+x], want)
			}
		}
	}
}

func TestTheCornersAreRoundedOffAndTheMiddleIsFull(t *testing.T) {
	const w, h = 60, 20
	pixels := make([]uint32, w*h)
	colour := notchMarkPixel()
	notchMarkFill(pixels, w, h, 0, w, 6, colour)
	for _, corner := range [][2]int{{0, 0}, {w - 1, 0}, {0, h - 1}, {w - 1, h - 1}} {
		if pixels[corner[1]*w+corner[0]] != 0 {
			t.Fatalf("the corner %v is coloured", corner)
		}
	}
	for _, inside := range [][2]int{{w / 2, 0}, {0, h / 2}, {w - 1, h / 2}, {w / 2, h - 1}, {w / 2, h / 2}, {6, 6}} {
		if pixels[inside[1]*w+inside[0]] != colour {
			t.Fatalf("the pixel %v inside the mark is clear", inside)
		}
	}
	// The same left and right, top and bottom.
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if (pixels[y*w+x] == 0) != (pixels[y*w+(w-1-x)] == 0) || (pixels[y*w+x] == 0) != (pixels[(h-1-y)*w+x] == 0) {
				t.Fatalf("the mark is lopsided at %d,%d", x, y)
			}
		}
	}
}

func TestAFillThatDoesNotFitDoesNothingAndNeverWritesOutside(t *testing.T) {
	short := make([]uint32, 10)
	notchMarkFill(short, 40, 12, 0, 40, 4, 1)
	for i, p := range short {
		if p != 0 {
			t.Fatalf("a picture that is too small was written to at %d", i)
		}
	}
	const w, h = 8, 4
	pixels := make([]uint32, w*h)
	// Columns outside the picture are held to it; a radius larger than the picture is held to half of it.
	notchMarkFill(pixels, w, h, -50, 500, 1000, 7)
	if pixels[(h/2)*w+w/2] != 7 {
		t.Fatalf("the middle of a small mark is clear")
	}
	notchMarkFill(pixels, 0, 0, 0, 10, 2, 7)
	notchMarkFill(pixels, w, h, 6, 2, 2, 9)
	for _, p := range pixels {
		if p == 9 {
			t.Fatalf("a fill from a later column to an earlier one coloured something")
		}
	}
}

func TestTheColourIsCitronWithItsStrengthInIt(t *testing.T) {
	p := notchMarkPixel()
	a, r, g, b := p>>24, (p>>16)&0xff, (p>>8)&0xff, p&0xff
	if a != notchMarkStrength {
		t.Fatalf("strength %d, want %d", a, notchMarkStrength)
	}
	// A layered window wants every part no larger than the strength.
	if r > a || g > a || b > a {
		t.Fatalf("a part is stronger than the whole: %d %d %d of %d", r, g, b, a)
	}
	// Citron: most green, a little less red, least blue.
	if !(g > r && r > b) {
		t.Fatalf("not citron: %d %d %d", r, g, b)
	}
}

func TestHowLongAMarkStays(t *testing.T) {
	for _, c := range []struct {
		ms   float64
		want time.Duration
	}{
		{0, notchMarkMinStay}, {-5, notchMarkMinStay}, {200, notchMarkMinStay}, {9000, 9 * time.Second},
		{1e9, notchMarkMaxStay},
	} {
		if got := notchMarkStay(c.ms); got != c.want {
			t.Fatalf("asked to stay %v ms: %v, want %v", c.ms, got, c.want)
		}
	}
}

func TestWhatCanBeMarked(t *testing.T) {
	// A line of text inside a window of 1200 by 800 at 100,50.
	if !notchMarkFits(300, 400, 500, 24, 100, 50, 1200, 800) {
		t.Fatalf("a line of text inside the window cannot be marked")
	}
	for name, c := range map[string][4]int{
		"a speck":                 {300, 400, 4, 4},
		"wider than a mark":       {100, 400, notchMarkMaxW + 1, 24},
		"taller than a mark":      {300, 100, 500, notchMarkMaxH + 1},
		"left of the window":      {90, 400, 100, 24},
		"past its right edge":     {1250, 400, 100, 24},
		"above it":                {300, 40, 100, 24},
		"past its lower edge":     {300, 840, 100, 24},
		"with no size":            {300, 400, 0, 24},
		"with a size below zero":  {300, 400, -20, 24},
		"elsewhere on the screen": {5000, 5000, 100, 24},
	} {
		if notchMarkFits(c[0], c[1], c[2], c[3], 100, 50, 1200, 800) {
			t.Fatalf("%s can be marked", name)
		}
	}
}

func TestAWindowThatMovedIsNotTheOneThatWasLookedAt(t *testing.T) {
	if !notchMarkSame(100, 50, 1200, 800, 100, 50, 1200, 800) {
		t.Fatalf("the same window is taken for another")
	}
	if !notchMarkSame(102, 49, 1203, 797, 100, 50, 1200, 800) {
		t.Fatalf("a window a pixel or two off is taken for another")
	}
	for name, c := range map[string][4]int{
		"moved": {140, 50, 1200, 800}, "moved down": {100, 90, 1200, 800}, "made wider": {100, 50, 1300, 800}, "made lower": {100, 50, 1200, 700},
	} {
		if notchMarkSame(c[0], c[1], c[2], c[3], 100, 50, 1200, 800) {
			t.Fatalf("a window that was %s is taken for the one that was looked at", name)
		}
	}
}
