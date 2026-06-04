package main

import "testing"

func TestNormalizeRegionRect(t *testing.T) {
	cases := []struct {
		name                       string
		x0, y0, x1, y1             int
		wantX, wantY, wantW, wantH int
	}{
		{"already ordered", 10, 20, 110, 220, 10, 20, 100, 200},
		{"reversed x", 110, 20, 10, 220, 10, 20, 100, 200},
		{"reversed y", 10, 220, 110, 20, 10, 20, 100, 200},
		{"reversed both", 110, 220, 10, 20, 10, 20, 100, 200},
		{"negative origin", -30, -40, 70, 60, -30, -40, 100, 100},
		{"zero area", 50, 50, 50, 50, 50, 50, 0, 0},
	}
	for _, c := range cases {
		x, y, w, h := normalizeRegionRect(c.x0, c.y0, c.x1, c.y1)
		if x != c.wantX || y != c.wantY || w != c.wantW || h != c.wantH {
			t.Errorf("%s: got (%d,%d,%d,%d), want (%d,%d,%d,%d)",
				c.name, x, y, w, h, c.wantX, c.wantY, c.wantW, c.wantH)
		}
	}
}

func TestRegionDragTooSmall(t *testing.T) {
	cases := []struct {
		w, h int
		want bool
	}{
		{0, 0, true},
		{5, 100, true},
		{100, 5, true},
		{regionMinDragPx, regionMinDragPx, false},
		{6, 6, false},
		{200, 200, false},
	}
	for _, c := range cases {
		if got := regionDragTooSmall(c.w, c.h); got != c.want {
			t.Errorf("regionDragTooSmall(%d,%d) = %v, want %v", c.w, c.h, got, c.want)
		}
	}
}
