package main

import (
	"math"
	"testing"
)

func TestNotchCoverageOfASquareIsSolidInsideAndEmptyOutside(t *testing.T) {
	const w, h = 20, 20
	dst := make([]uint8, w*h)
	notchCoverage(dst, w, h, [][]notchVertex{{{4, 4}, {12, 4}, {12, 12}, {4, 12}}})
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
	notchCoverage(dst, w, h, [][]notchVertex{{{5, 5}, {35, 5}, {20, 35}}})
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
	notchCoverage(dst, w, h, [][]notchVertex{{{5, 5}, {25, 5}, {5, 25}}})
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
	notchCoverage(dst, w, h, [][]notchVertex{{{-5, -2}, {15, -2}, {15, 5}, {-5, 5}}})
	if dst[0] != 255 || dst[4*w+9] != 255 {
		t.Fatalf("rows 0 to 4 should be solid edge to edge: %d %d", dst[0], dst[4*w+9])
	}
	if dst[5*w] != 0 {
		t.Fatalf("row 5 should be empty, got %d", dst[5*w])
	}
	// Degenerate input must not panic and must leave the image empty.
	notchCoverage(dst, w, h, [][]notchVertex{{{1, 1}, {2, 2}}})
	for _, c := range dst {
		if c != 0 {
			t.Fatal("two points are not a shape: the image should be empty")
		}
	}
}

// An edge half way across a pixel column must leave that column half covered.
// With points on whole pixels only, this could not be said at all.
func TestNotchCoverageHonoursFractionsOfAPixel(t *testing.T) {
	const w, h = 20, 12
	dst := make([]uint8, w*h)
	notchCoverage(dst, w, h, [][]notchVertex{{{4.5, 2}, {12.25, 2}, {12.25, 8.5}, {4.5, 8.5}}})
	at := func(x, y int) int { return int(dst[y*w+x]) }
	near := func(got, want int) bool { return got >= want-2 && got <= want+2 }
	if !near(at(4, 5), 128) || !near(at(12, 5), 64) {
		t.Fatalf("left column %d (want about 128), right column %d (want about 64)", at(4, 5), at(12, 5))
	}
	if !near(at(8, 8), 128) {
		t.Fatalf("bottom row %d, want about 128", at(8, 8))
	}
	if at(8, 5) != 255 || at(3, 5) != 0 || at(13, 5) != 0 || at(8, 9) != 0 {
		t.Fatalf("inside %d, left of it %d, right of it %d, below it %d", at(8, 5), at(3, 5), at(13, 5), at(8, 9))
	}
}

// The reason for all of it: a round corner must come out round. Every pixel
// of a quarter circle is compared with the true area the circle covers there.
func TestNotchCoverageOfARoundCornerFollowsTheCircle(t *testing.T) {
	const w, h, r = 24, 24, 16.0
	// The corner the notch has at its bottom left: centre (r, 0), sweeping
	// from the left side down to the bottom.
	pts := []notchVertex{{r, 0}, {0, 0}}
	const steps = 20
	for i := 1; i <= steps; i++ {
		a := math.Pi - (math.Pi/2)*float64(i)/steps
		pts = append(pts, notchVertex{r + r*math.Cos(a), r * math.Sin(a)})
	}
	dst := make([]uint8, w*h)
	notchCoverage(dst, w, h, [][]notchVertex{pts})
	worst := 0.0
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			// True coverage by fine sampling of the circle itself.
			in := 0
			for sy := 0; sy < 16; sy++ {
				for sx := 0; sx < 16; sx++ {
					px, py := float64(x)+(float64(sx)+0.5)/16, float64(y)+(float64(sy)+0.5)/16
					if px <= r && (px-r)*(px-r)+py*py <= r*r {
						in++
					}
				}
			}
			want := float64(in) / 256
			got := float64(dst[y*w+x]) / 255
			worst = math.Max(worst, math.Abs(got-want))
		}
	}
	// Measured: 0.02 as built. With the same points moved onto whole pixels
	// it is 0.42, which is the polygon look this replaced, and with four
	// sample lines instead of sixteen it is 0.056. Both fail here.
	if worst > 1.0/32 {
		t.Fatalf("the corner strays from the circle by %.3f of a pixel's coverage at worst", worst)
	}
}

// Two shapes that overlap are one silhouette. Filled by counting crossings
// alone, the part they share would come out as a hole.
func TestNotchCoverageJoinsOverlappingShapes(t *testing.T) {
	const w, h = 40, 20
	dst := make([]uint8, w*h)
	left := []notchVertex{{2, 2}, {22, 2}, {22, 12}, {2, 12}}
	right := []notchVertex{{16, 2}, {36, 2}, {36, 12}, {16, 12}}
	notchCoverage(dst, w, h, [][]notchVertex{left, right})
	at := func(x, y int) uint8 { return dst[y*w+x] }
	if at(19, 6) != 255 {
		t.Fatalf("where the two shapes overlap should be solid, got %d", at(19, 6))
	}
	if at(5, 6) != 255 || at(30, 6) != 255 || at(38, 6) != 0 || at(19, 14) != 0 {
		t.Fatalf("left %d, right %d, beyond %d, below %d", at(5, 6), at(30, 6), at(38, 6), at(19, 14))
	}
	sum := 0
	for _, c := range dst {
		sum += int(c)
	}
	// 34 wide by 10 tall, not 20x10 twice.
	if area := float64(sum) / 255; area < 338 || area > 342 {
		t.Fatalf("the joined shape covers %.1f pixels, want 340", area)
	}
}

// Shapes apart from each other are each drawn, with nothing between them.
func TestNotchCoverageDrawsShapesThatAreApart(t *testing.T) {
	const w, h = 60, 12
	dst := make([]uint8, w*h)
	body := []notchVertex{{20, -2}, {40, -2}, {40, 8}, {20, 8}}
	bump := []notchVertex{{4, -2}, {12, -2}, {8, 4}}
	notchCoverage(dst, w, h, [][]notchVertex{body, bump})
	at := func(x, y int) uint8 { return dst[y*w+x] }
	if at(30, 4) != 255 || at(8, 0) == 0 || at(16, 2) != 0 {
		t.Fatalf("body %d, bump %d, between them %d", at(30, 4), at(8, 0), at(16, 2))
	}
}
