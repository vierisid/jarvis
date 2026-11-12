package main

import (
	"math"
	"sort"
)

// notchCoverage writes, for every pixel of a w by h image, how much of that
// pixel the polygons cover between them: 0 for none, 255 for all. It is what
// gives the notch a smooth edge on a system where a window can only be cut
// along whole pixels.
//
// The method is plain: sixteen sample lines through each pixel row, and along
// each line the exact horizontal overlap of every filled span with every
// pixel. Sixteen lines give seventeen levels on an edge that runs nearly
// level, which is where the notch's bottom corners end; four left visible
// steps there.
//
// Where polygons overlap they are one shape, not a hole: a span is filled
// while the line is inside any of them. That needs every polygon to turn the
// same way, which notchOutlines sees to.
func notchCoverage(dst []uint8, w, h int, polygons [][]notchVertex) {
	for i := range dst {
		dst[i] = 0
	}
	if w <= 0 || h <= 0 || len(dst) < w*h {
		return
	}
	const samples = 16
	// Only the rows the outline reaches need work. The notch is a few dozen
	// rows of a window that is hundreds tall, and this runs on every frame of
	// a size change.
	top, bottom, any := 0.0, 0.0, false
	for _, pts := range polygons {
		if len(pts) < 3 {
			continue
		}
		for _, p := range pts {
			if !any {
				top, bottom, any = p.Y, p.Y, true
			}
			top, bottom = math.Min(top, p.Y), math.Max(bottom, p.Y)
		}
	}
	if !any {
		return
	}
	firstRow, lastRow := int(math.Floor(top)), int(math.Ceil(bottom))
	if firstRow < 0 {
		firstRow = 0
	}
	if lastRow > h-1 {
		lastRow = h - 1
	}
	type crossing struct {
		x   float64
		dir int
	}
	acc := make([]float32, w)
	xs := make([]crossing, 0, 32)
	for y := firstRow; y <= lastRow; y++ {
		for i := range acc {
			acc[i] = 0
		}
		touched := false
		for s := 0; s < samples; s++ {
			sy := float64(y) + (float64(s)+0.5)/samples
			xs = xs[:0]
			for _, pts := range polygons {
				if len(pts) < 3 {
					continue
				}
				for i := range pts {
					a, b := pts[i], pts[(i+1)%len(pts)]
					if (a.Y <= sy) == (b.Y <= sy) {
						continue
					}
					dir := 1
					if a.Y > b.Y {
						dir = -1
					}
					xs = append(xs, crossing{a.X + (sy-a.Y)*(b.X-a.X)/(b.Y-a.Y), dir})
				}
			}
			if len(xs) < 2 {
				continue
			}
			sort.Slice(xs, func(i, j int) bool { return xs[i].x < xs[j].x })
			inside, from := 0, 0.0
			for _, c := range xs {
				before := inside
				inside += c.dir
				if before == 0 && inside != 0 {
					from = c.x
					continue
				}
				if before == 0 || inside != 0 {
					continue
				}
				x0, x1 := from, c.x
				if x1 <= 0 || x0 >= float64(w) {
					continue
				}
				if x0 < 0 {
					x0 = 0
				}
				if x1 > float64(w) {
					x1 = float64(w)
				}
				first, last := int(x0), int(x1)
				if last >= w {
					last = w - 1
				}
				for px := first; px <= last; px++ {
					lo, hi := float64(px), float64(px+1)
					if x0 > lo {
						lo = x0
					}
					if x1 < hi {
						hi = x1
					}
					if hi > lo {
						acc[px] += float32(hi - lo)
						touched = true
					}
				}
			}
		}
		if !touched {
			continue
		}
		row := dst[y*w : (y+1)*w]
		for px, v := range acc {
			if v <= 0 {
				continue
			}
			c := v * 255 / samples
			if c >= 254.5 {
				row[px] = 255
			} else {
				row[px] = uint8(c + 0.5)
			}
		}
	}
}
