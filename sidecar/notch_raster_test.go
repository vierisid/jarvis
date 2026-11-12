package main

import "testing"

func TestNotchCoverageOfASquareIsSolidInsideAndEmptyOutside(t *testing.T) {
	const w, h = 20, 20
	dst := make([]uint8, w*h)
	notchCoverage(dst, w, h, []notchPoint{{4, 4}, {12, 4}, {12, 12}, {4, 12}})
	at := func(x, y int) uint8 { return dst[y*w+x] }
	if at(8, 8) != 255 || at(4, 4) != 255 || at(11, 11) != 255 {
		t.Fatalf("inside the square should be solid: centre=%d corner=%d far corner=%d", at(8, 8), at(4, 4), at(11, 11))
	}
	if at(3, 8) != 0 || at(12, 8) != 0 || at(8, 3) != 0 || at(8, 12) != 0 || at(0, 0) != 0 {
		t.Fatalf("outside the square should be empty: %d %d %d %d", at(3, 8), at(12, 8), at(8, 3), at(8, 12))
	}
}

// The point of the whole exercise: an edge that is not on a pixel boundary
// gives in-between values, where a region cut would give all or nothing.
func TestNotchCoverageSoftensASlantedEdge(t *testing.T) {
	const w, h = 40, 40
	dst := make([]uint8, w*h)
	notchCoverage(dst, w, h, []notchPoint{{5, 5}, {35, 5}, {20, 35}})
	partial, solid := 0, 0
	for _, c := range dst {
		switch {
		case c == 255:
			solid++
		case c > 0:
			partial++
		}
	}
	if solid < 200 {
		t.Fatalf("the triangle's inside should be solid, got %d solid pixels", solid)
	}
	if partial < 40 {
		t.Fatalf("a slanted edge should produce partly covered pixels, got %d", partial)
	}
}

// Total coverage equals the polygon's area, whatever the shape. A right
// triangle with legs of 20 has area 200.
func TestNotchCoverageAddsUpToTheArea(t *testing.T) {
	const w, h = 30, 30
	dst := make([]uint8, w*h)
	notchCoverage(dst, w, h, []notchPoint{{5, 5}, {25, 5}, {5, 25}})
	sum := 0
	for _, c := range dst {
		sum += int(c)
	}
	area := float64(sum) / 255
	if area < 196 || area > 204 {
		t.Fatalf("coverage adds up to %.1f pixels, want about 200", area)
	}
}

func TestNotchCoverageClipsWhatLiesOutsideTheImage(t *testing.T) {
	const w, h = 10, 10
	dst := make([]uint8, w*h)
	// The notch's top edge sits above the window, like the real outline.
	notchCoverage(dst, w, h, []notchPoint{{-5, -2}, {15, -2}, {15, 5}, {-5, 5}})
	if dst[0] != 255 || dst[4*w+9] != 255 {
		t.Fatalf("rows 0 to 4 should be solid edge to edge: %d %d", dst[0], dst[4*w+9])
	}
	if dst[5*w] != 0 {
		t.Fatalf("row 5 should be empty, got %d", dst[5*w])
	}
	// Degenerate input must not panic and must leave the image empty.
	notchCoverage(dst, w, h, []notchPoint{{1, 1}, {2, 2}})
	for _, c := range dst {
		if c != 0 {
			t.Fatal("two points are not a shape: the image should be empty")
		}
	}
}
