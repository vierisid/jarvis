package main

import "sort"

// notchCoverage writes, for every pixel of a w by h image, how much of that
// pixel the polygon covers: 0 for none, 255 for all. It is what gives the
// notch a smooth edge on a system where a window can only be cut along whole
// pixels.
//
// The method is plain: four sample lines through each pixel row, and along
// each line the exact horizontal overlap of every filled span with every
// pixel. Even-odd filling, which is right for a simple outline.
func notchCoverage(dst []uint8, w, h int, pts []notchPoint) {
	for i := range dst {
		dst[i] = 0
	}
	if w <= 0 || h <= 0 || len(dst) < w*h || len(pts) < 3 {
		return
	}
	const samples = 4
	acc := make([]float32, w)
	xs := make([]float64, 0, 16)
	for y := 0; y < h; y++ {
		for i := range acc {
			acc[i] = 0
		}
		touched := false
		for s := 0; s < samples; s++ {
			sy := float64(y) + (float64(s)+0.5)/samples
			xs = xs[:0]
			for i := range pts {
				a, b := pts[i], pts[(i+1)%len(pts)]
				ay, by := float64(a.Y), float64(b.Y)
				if (ay <= sy) == (by <= sy) {
					continue
				}
				ax, bx := float64(a.X), float64(b.X)
				xs = append(xs, ax+(sy-ay)*(bx-ax)/(by-ay))
			}
			if len(xs) < 2 {
				continue
			}
			sort.Float64s(xs)
			for i := 0; i+1 < len(xs); i += 2 {
				x0, x1 := xs[i], xs[i+1]
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
