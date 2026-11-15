package main

// The ink of a look: the line a person draws round a thing.
//
// It is a marker, not a pen: one soft colour, the same strength where the line
// crosses itself as anywhere else, and nothing darker inside it. So the sheet
// keeps, for every pixel, the most any piece of the line has covered it, and
// the colour is laid on from that.
//
// The sheet is drawn into a window that lets every click through and dims
// nothing. Only the pixels a new piece of line touched are painted again.
//
// No platform calls: tested on every platform.

import (
	"bytes"
	"image"
	"image/png"
	"math"
)

// The marker's colour (the notch's citron) and how strong it is at its middle.
const (
	notchInkR, notchInkG, notchInkB = 0xD6, 0xFF, 0x5C
	notchInkStrength                = 0.46
	// Half the marker's width, at a display scale of 100%.
	notchInkRadius = 5.0
)

// notchInk is a sheet as large as the part of the screen it covers.
type notchInk struct {
	w, h  int
	cover []uint8
}

func newNotchInk(w, h int) *notchInk {
	if w < 0 {
		w = 0
	}
	if h < 0 {
		h = 0
	}
	return &notchInk{w: w, h: h, cover: make([]uint8, w*h)}
}

// stroke lays down the piece of line from a to b, r pixels to each side, and
// reports the rectangle of the sheet it touched (empty when it missed it).
func (k *notchInk) stroke(ax, ay, bx, by, r float64) lookRect {
	x0 := int(math.Floor(math.Min(ax, bx) - r - 1))
	y0 := int(math.Floor(math.Min(ay, by) - r - 1))
	x1 := int(math.Ceil(math.Max(ax, bx) + r + 1))
	y1 := int(math.Ceil(math.Max(ay, by) + r + 1))
	x0, y0 = max(x0, 0), max(y0, 0)
	x1, y1 = min(x1, k.w), min(y1, k.h)
	if x1 <= x0 || y1 <= y0 {
		return lookRect{}
	}
	dx, dy := bx-ax, by-ay
	length2 := dx*dx + dy*dy
	for y := y0; y < y1; y++ {
		py := float64(y) + 0.5
		row := y * k.w
		for x := x0; x < x1; x++ {
			px := float64(x) + 0.5
			// How far this pixel is from the piece of line.
			t := 0.0
			if length2 > 0 {
				t = ((px-ax)*dx + (py-ay)*dy) / length2
				t = math.Max(0, math.Min(1, t))
			}
			ex, ey := px-(ax+t*dx), py-(ay+t*dy)
			d := math.Sqrt(ex*ex + ey*ey)
			// Full inside the marker, fading over the last pixel of its edge.
			c := r + 0.5 - d
			if c <= 0 {
				continue
			}
			if c > 1 {
				c = 1
			}
			if v := uint8(c*255 + 0.5); v > k.cover[row+x] {
				k.cover[row+x] = v
			}
		}
	}
	return lookRect{x0, y0, x1 - x0, y1 - y0}
}

// paint writes one rectangle of the sheet as pixels a layered window shows:
// 0xAARRGGBB with the colour already multiplied by its own strength.
func (k *notchInk) paint(pixels []uint32, r lookRect) {
	if len(pixels) < k.w*k.h {
		return
	}
	x0, y0 := max(r.X, 0), max(r.Y, 0)
	x1, y1 := min(r.X+r.W, k.w), min(r.Y+r.H, k.h)
	for y := y0; y < y1; y++ {
		row := y * k.w
		for x := x0; x < x1; x++ {
			pixels[row+x] = notchInkPixel(k.cover[row+x])
		}
	}
}

// notchInkPixel is the marker's colour over one pixel that is covered so much.
func notchInkPixel(cover uint8) uint32 {
	if cover == 0 {
		return 0
	}
	a := float64(cover) / 255 * notchInkStrength
	return uint32(a*255+0.5)<<24 | uint32(a*notchInkR+0.5)<<16 | uint32(a*notchInkG+0.5)<<8 | uint32(a*notchInkB+0.5)
}

// clear wipes the whole sheet.
func (k *notchInk) clear() {
	for i := range k.cover {
		k.cover[i] = 0
	}
}

// lookUnion is the smallest rectangle that holds both. An empty one counts
// for nothing.
func lookUnion(a, b lookRect) lookRect {
	if a.empty() {
		return b
	}
	if b.empty() {
		return a
	}
	x0, y0 := min(a.X, b.X), min(a.Y, b.Y)
	x1, y1 := max(a.X+a.W, b.X+b.W), max(a.Y+a.H, b.Y+b.H)
	return lookRect{x0, y0, x1 - x0, y1 - y0}
}

// The tag's colours: the notch's own black, and its ink.
const (
	notchTagFill = 0xFF111214
	notchTagInk  = 0x00EEF1F4
)

// notchTagPill fills a w by h sheet with the tag's shape: a dark rounded
// plate, solid inside and soft along its edge, clear outside.
func notchTagPill(pixels []uint32, w, h int, radius float64) {
	if w <= 0 || h <= 0 || len(pixels) < w*h {
		return
	}
	radius = math.Min(radius, math.Min(float64(w), float64(h))/2)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			px, py := float64(x)+0.5, float64(y)+0.5
			// How far outside the plate's straight core this pixel is.
			ox := math.Max(math.Max(radius-px, px-(float64(w)-radius)), 0)
			oy := math.Max(math.Max(radius-py, py-(float64(h)-radius)), 0)
			c := radius + 0.5 - math.Sqrt(ox*ox+oy*oy)
			switch {
			case c <= 0:
				pixels[y*w+x] = 0
			case c >= 1:
				pixels[y*w+x] = notchTagFill
			default:
				a := uint32(c*255 + 0.5)
				pixels[y*w+x] = a<<24 | (0x11*a/255)<<16 | (0x12*a/255)<<8 | (0x14 * a / 255)
			}
		}
	}
}

// notchTagPlace is where the tag goes: above what was circled, on its left
// edge; under it when there is no room above; and always inside the screen.
func notchTagPlace(bounds lookRect, w, h int, screen lookRect, gap int) (x, y int) {
	x, y = bounds.X, bounds.Y-h-gap
	if y < screen.Y {
		y = bounds.Y + bounds.H + gap
	}
	if y+h > screen.Y+screen.H {
		y = screen.Y + screen.H - h
	}
	if x+w > screen.X+screen.W {
		x = screen.X + screen.W - w
	}
	return max(x, screen.X), max(y, screen.Y)
}

// lookShot is a copy of a display: its pixels as Windows keeps them (blue,
// green, red and a fourth byte, row after row from the top) and where its top
// left corner is on the screen.
type lookShot struct {
	pixels []byte
	w, h   int
	x, y   int
}

// Cut gives a part of the copy as a PNG. The part is in screen pixels; what
// of it lies outside the copy is left out. Nil when nothing is left.
func (s *lookShot) Cut(part lookRect) []byte {
	if s == nil || len(s.pixels) < s.w*s.h*4 {
		return nil
	}
	x0, y0 := max(part.X-s.x, 0), max(part.Y-s.y, 0)
	x1, y1 := min(part.X+part.W-s.x, s.w), min(part.Y+part.H-s.y, s.h)
	if x1 <= x0 || y1 <= y0 {
		return nil
	}
	img := image.NewNRGBA(image.Rect(0, 0, x1-x0, y1-y0))
	for y := y0; y < y1; y++ {
		src := s.pixels[(y*s.w+x0)*4 : (y*s.w+x1)*4]
		dst := img.Pix[(y-y0)*img.Stride:]
		for i := 0; i+3 < len(src); i += 4 {
			dst[i], dst[i+1], dst[i+2], dst[i+3] = src[i+2], src[i+1], src[i], 0xFF
		}
	}
	var out bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&out, img); err != nil {
		return nil
	}
	return out.Bytes()
}
